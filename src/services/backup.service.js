import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { dbPool } from "../config/database.js";
import { uploadBackup } from "./google-drive.service.js";

const gzip = promisify(zlib.gzip);
const MAX_BYTES = Number(process.env.BACKUP_MAX_BYTES || 50 * 1024 * 1024);
function key() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("BACKUP_ENCRYPTION_KEY is not configured");
  const value = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (value.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to 32 bytes");
  return value;
}
function encrypt(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from("NOVA-BACKUP-1\0"), iv, cipher.getAuthTag(), body]);
}
async function tenantTables() {
  const result = await dbPool.query("SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name=$2 GROUP BY table_name ORDER BY table_name", ["public", "tenant_id"]);
  return result.rows.map((row) => row.table_name);
}
export async function createTenantBackup(tenantId) {
  const inserted = await dbPool.query("INSERT INTO tenant_backups (tenant_id,filename,status) VALUES ($1,$2,$3) RETURNING id", [tenantId, "pending-" + tenantId + ".nova-backup", "UPLOADING"]);
  const backupId = inserted.rows[0].id;
  try {
    const tables = await tenantTables();
    const snapshot = { version: 1, createdAt: new Date().toISOString(), tenantId, tables: {} };
    for (const table of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
      const result = await dbPool.query("SELECT * FROM \"" + table + "\" WHERE tenant_id=$1", [tenantId]);
      snapshot.tables[table] = result.rows;
    }
    const compressed = await gzip(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    const encrypted = encrypt(compressed);
    if (encrypted.length > MAX_BYTES) throw new Error("Encrypted backup exceeds configured maximum size");
    const sha256 = crypto.createHash("sha256").update(encrypted).digest("hex");
    const filename = "nova-" + tenantId + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".nova-backup";
    const uploaded = await uploadBackup(tenantId, filename, encrypted, sha256);
    await dbPool.query("UPDATE tenant_backups SET drive_file_id=$2,drive_folder_id=$3,filename=$4,size_bytes=$5,sha256=$6,status=$7,completed_at=NOW(),error_message=NULL WHERE id=$1 AND tenant_id=$8", [backupId, uploaded.fileId, uploaded.folderId, filename, encrypted.length, sha256, "COMPLETED", tenantId]);
    return { id: backupId, filename, sizeBytes: encrypted.length, sha256, driveFileId: uploaded.fileId };
  } catch (error) {
    await dbPool.query("UPDATE tenant_backups SET status=$2,error_message=$3 WHERE id=$1 AND tenant_id=$4", [backupId, "FAILED", error.message.slice(0, 1000), tenantId]);
    throw error;
  }
}
export async function listBackups(tenantId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const result = await dbPool.query("SELECT id,filename,size_bytes,sha256,status,started_at,completed_at,error_message,drive_file_id FROM tenant_backups WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT $2", [tenantId, safeLimit]);
  return result.rows;
}