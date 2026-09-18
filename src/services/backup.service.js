import crypto from "node:crypto";
import axios from "axios";
import { dbPool } from "../config/database.js";
import { encryptSecret, decryptSecret } from "./secrets.service.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SNAPSHOT_VERSION = "v1";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BACKUP_BYTES = Number(process.env.MAX_BACKUP_BYTES || 200 * 1024 * 1024);
const BACKUP_FOLDER_NAME = "Nova-AI Backups";

const EXCLUDED_TABLES = new Set([
  "schema_migrations",
  "google_drive_connections",
  "google_drive_oauth_states",
  "tenant_backups",
  "refresh_tokens",
  "processed_messages",
  "webhook_messages",
  "whatsapp_deliveries",
]);

function requireGoogleConfig() {
  const values = {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim(),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim(),
  };
  if (!values.clientId || !values.clientSecret || !values.redirectUri) {
    throw new Error("Google Drive backup is not configured");
  }
  if (!/^https:\/\//.test(values.redirectUri) && process.env.NODE_ENV === "production") {
    throw new Error("GOOGLE_REDIRECT_URI must use HTTPS in production");
  }
  return values;
}

function hashState(state) {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

function safeIdentifier(identifier) {
  return '"' + String(identifier).replaceAll('"', '""') + '"';
}

function encryptBackupPayload(payload) {
  const keyText = process.env.BACKUP_ENCRYPTION_KEY?.trim() || process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!keyText) throw new Error("BACKUP_ENCRYPTION_KEY or CREDENTIAL_ENCRYPTION_KEY is not configured");

  let key;
  if (/^[a-fA-F0-9]{64}$/.test(keyText)) key = Buffer.from(keyText, "hex");
  else key = Buffer.from(keyText, "base64");
  if (key.length !== 32) throw new Error("Backup encryption key must decode to exactly 32 bytes");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(JSON.stringify({
    version: SNAPSHOT_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }), "utf8");
}

function decryptBackupPayload(buffer) {
  const keyText = process.env.BACKUP_ENCRYPTION_KEY?.trim() || process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!keyText) throw new Error("BACKUP_ENCRYPTION_KEY or CREDENTIAL_ENCRYPTION_KEY is not configured");
  const key = /^[a-fA-F0-9]{64}$/.test(keyText) ? Buffer.from(keyText, "hex") : Buffer.from(keyText, "base64");
  if (key.length !== 32) throw new Error("Backup encryption key must decode to exactly 32 bytes");

  let envelope;
  try { envelope = JSON.parse(Buffer.from(buffer).toString("utf8")); } catch { throw new Error("Invalid backup envelope"); }
  if (envelope?.version !== SNAPSHOT_VERSION || envelope?.algorithm !== "aes-256-gcm") throw new Error("Unsupported backup envelope");

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw new Error("Backup authentication failed");
  }
}

export function buildOAuthAuthorizationUrl(state) {
  const { clientId, redirectUri } = requireGoogleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    scope: DRIVE_SCOPE,
    state,
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function beginGoogleDriveConnection(tenantId) {
  if (!dbPool) throw new Error("Database is not configured");
  const state = crypto.randomBytes(32).toString("base64url");
  const stateHash = hashState(state);
  await dbPool.query(
    "DELETE FROM google_drive_oauth_states WHERE tenant_id = $1 OR expires_at < NOW()",
    [tenantId],
  );
  await dbPool.query(
    "INSERT INTO google_drive_oauth_states (tenant_id, state_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')",
    [tenantId, stateHash],
  );
  return { authorizationUrl: buildOAuthAuthorizationUrl(state) };
}

async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = requireGoogleConfig();
  const response = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });
  if (!response.data?.refresh_token) throw new Error("Google did not return a refresh token; reconnect the Drive account");
  return response.data;
}

export async function completeGoogleDriveConnection({ state, code }) {
  if (!dbPool) throw new Error("Database is not configured");
  if (typeof state !== "string" || state.length < 20 || typeof code !== "string" || !code) {
    throw new Error("Invalid Google OAuth callback");
  }

  const stateHash = hashState(state);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT id, tenant_id FROM google_drive_oauth_states WHERE state_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE",
      [stateHash],
    );
    if (result.rowCount !== 1) throw new Error("Expired or invalid Google OAuth state");

    const tokenData = await exchangeCode(code);
    const encrypted = encryptSecret(tokenData.refresh_token);

    await client.query(
      `INSERT INTO google_drive_connections (tenant_id, refresh_token_encrypted, status, updated_at)
       VALUES ($1, $2, 'active', NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         status = 'active',
         last_error = NULL,
         updated_at = NOW()`,
      [result.rows[0].tenant_id, encrypted],
    );
    await client.query("UPDATE google_drive_oauth_states SET used_at = NOW() WHERE id = $1", [result.rows[0].id]);
    await client.query("COMMIT");
    return { tenantId: result.rows[0].tenant_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getConnection(tenantId) {
  const result = await dbPool.query(
    "SELECT tenant_id, refresh_token_encrypted, drive_root_folder_id, status FROM google_drive_connections WHERE tenant_id = $1",
    [tenantId],
  );
  return result.rows[0] || null;
}

async function getAccessToken(tenantId) {
  const connection = await getConnection(tenantId);
  if (!connection || connection.status !== "active") throw new Error("Google Drive is not connected");

  const { clientId, clientSecret } = requireGoogleConfig();
  const refreshToken = decryptSecret(connection.refresh_token_encrypted);
  try {
    const response = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    });
    return response.data.access_token;
  } catch (error) {
    const status = error.response?.status;
    if (status === 400 || status === 401) {
      await dbPool.query(
        "UPDATE google_drive_connections SET status = 'error', last_error = $2, updated_at = NOW() WHERE tenant_id = $1",
        [tenantId, "Google refresh token rejected"],
      );
    }
    throw new Error("Google Drive authorization failed");
  }
}

async function driveRequest(tenantId, config) {
  const token = await getAccessToken(tenantId);
  try {
    return await axios({ ...config, headers: { ...(config.headers || {}), Authorization: `Bearer ${token}` }, timeout: config.timeout || 30_000 });
  } catch (error) {
    if (error.response?.status === 401) {
      await dbPool.query(
        "UPDATE google_drive_connections SET status = 'error', last_error = $2, updated_at = NOW() WHERE tenant_id = $1",
        [tenantId, "Google Drive access token rejected"],
      );
    }
    throw error;
  }
}

async function ensureBackupFolder(tenantId) {
  const connection = await getConnection(tenantId);
  if (connection?.drive_root_folder_id) return connection.drive_root_folder_id;

  const response = await driveRequest(tenantId, {
    method: "POST",
    url: `${DRIVE_API}/files`,
    params: { fields: "id,name,mimeType" },
    data: {
      name: BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { novaBackupRoot: "true", novaTenantId: tenantId },
    },
  });
  const folderId = response.data?.id;
  if (!folderId) throw new Error("Google Drive folder creation failed");

  await dbPool.query(
    "UPDATE google_drive_connections SET drive_root_folder_id = $2, updated_at = NOW() WHERE tenant_id = $1",
    [tenantId, folderId],
  );
  return folderId;
}

async function getTenantTables(client) {
  const result = await client.query(`
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    GROUP BY c.table_schema, c.table_name
    ORDER BY c.table_name
  `);
  return result.rows
    .map((row) => row.table_name)
    .filter((table) => !EXCLUDED_TABLES.has(table));
}

async function createTenantSnapshot(tenantId) {
  if (!dbPool) throw new Error("Database is not configured");
  const client = await dbPool.connect();
  try {
    const tenantResult = await client.query(
      "SELECT * FROM tenants WHERE id = $1",
      [tenantId],
    );
    if (tenantResult.rowCount !== 1) throw new Error("Tenant not found");

    const tables = await getTenantTables(client);
    const data = { tenants: tenantResult.rows, tables: {} };
    let rowCount = tenantResult.rowCount;

    for (const table of tables) {
      const result = await client.query(
        `SELECT * FROM ${safeIdentifier(table)} WHERE tenant_id = $1`,
        [tenantId],
      );
      if (result.rows.length) {
        data.tables[table] = result.rows;
        rowCount += result.rows.length;
      }
    }

    return {
      snapshot: {
        snapshotVersion: SNAPSHOT_VERSION,
        createdAt: new Date().toISOString(),
        tenantId,
        rowCount,
        tables: data.tables,
        tenants: data.tenants,
      },
      rowCount,
    };
  } finally {
    client.release();
  }
}

function makeBackupName(backupId) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  return `nova-${backupId}-${stamp}.nova-backup`;
}

async function uploadResumable(tenantId, name, body, folderId) {
  const init = await driveRequest(tenantId, {
    method: "POST",
    url: `${DRIVE_UPLOAD_API}/files`,
    params: { uploadType: "resumable", fields: "id,name,size,md5Checksum" },
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "application/octet-stream",
      "x-upload-content-length": String(body.length),
    },
    data: { name, parents: [folderId], mimeType: "application/octet-stream", appProperties: { novaBackup: "true" } },
  });
  const sessionUrl = init.headers.location;
  if (!sessionUrl) throw new Error("Google Drive upload session was not created");

  const response = await axios.put(sessionUrl, body, {
    headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
    maxBodyLength: MAX_BACKUP_BYTES + 1024 * 1024,
    timeout: 120_000,
  });
  return response.data;
}

export async function createTenantBackup(tenantId) {
  if (!dbPool) throw new Error("Database is not configured");
  const inserted = await dbPool.query(
    "INSERT INTO tenant_backups (tenant_id, kind, status) VALUES ($1, 'full', 'running') RETURNING id",
    [tenantId],
  );
  const backupId = inserted.rows[0].id;

  try {
    const { snapshot, rowCount } = await createTenantSnapshot(tenantId);
    const encrypted = encryptBackupPayload(snapshot);
    if (encrypted.length > MAX_BACKUP_BYTES) throw new Error("Backup exceeds configured maximum size");

    const sha256 = crypto.createHash("sha256").update(encrypted).digest("hex");
    const folderId = await ensureBackupFolder(tenantId);
    const name = makeBackupName(backupId);
    const uploaded = await uploadResumable(tenantId, name, encrypted, folderId);
    if (!uploaded?.id) throw new Error("Google Drive did not return a file ID");

    await dbPool.query(
      `UPDATE tenant_backups
       SET status = 'completed', drive_file_id = $2, drive_file_name = $3,
           row_count = $4, byte_size = $5, sha256 = $6, completed_at = NOW(), error_code = NULL, error_message = NULL
       WHERE id = $1 AND tenant_id = $7`,
      [backupId, uploaded.id, name, rowCount, encrypted.length, sha256, tenantId],
    );
    await dbPool.query(
      "UPDATE google_drive_connections SET last_backup_at = NOW(), last_error = NULL, updated_at = NOW() WHERE tenant_id = $1",
      [tenantId],
    );
    return { id: backupId, fileId: uploaded.id, fileName: name, rowCount, byteSize: encrypted.length, sha256 };
  } catch (error) {
    await dbPool.query(
      "UPDATE tenant_backups SET status = 'failed', error_code = $2, error_message = $3, completed_at = NOW() WHERE id = $1 AND tenant_id = $4",
      [backupId, "BACKUP_FAILED", error.message.slice(0, 500), tenantId],
    );
    await dbPool.query(
      "UPDATE google_drive_connections SET last_error = $2, updated_at = NOW() WHERE tenant_id = $1",
      [tenantId, error.message.slice(0, 500)],
    ).catch(() => {});
    throw error;
  }
}

async function downloadBackup(tenantId, backupId) {
  const result = await dbPool.query(
    "SELECT id, drive_file_id, byte_size, sha256 FROM tenant_backups WHERE id = $1 AND tenant_id = $2 AND status = 'completed'",
    [backupId, tenantId],
  );
  const backup = result.rows[0];
  if (!backup?.drive_file_id) throw new Error("Backup not found");

  const response = await driveRequest(tenantId, {
    method: "GET",
    url: `${DRIVE_API}/files/${encodeURIComponent(backup.drive_file_id)}`,
    params: { alt: "media" },
    responseType: "arraybuffer",
    timeout: 120_000,
  });
  const body = Buffer.from(response.data);
  if (backup.byte_size && body.length !== Number(backup.byte_size)) throw new Error("Backup size verification failed");
  if (backup.sha256 && crypto.createHash("sha256").update(body).digest("hex") !== backup.sha256) throw new Error("Backup checksum verification failed");
  return body;
}

async function getRestoreOrder(client) {
  const result = await client.query(`
    SELECT
      tc.table_name AS child_table,
      ccu.table_name AS parent_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_schema = 'public'
  `);
  return result.rows;
}

function topologicalOrder(tables, relations) {
  const tableSet = new Set(tables);
  const graph = new Map(tables.map((table) => [table, new Set()]));
  const indegree = new Map(tables.map((table) => [table, 0]));
  for (const relation of relations) {
    if (!tableSet.has(relation.child_table) || !tableSet.has(relation.parent_table) || relation.child_table === relation.parent_table) continue;
    const children = graph.get(relation.parent_table);
    if (!children.has(relation.child_table)) {
      children.add(relation.child_table);
      indegree.set(relation.child_table, indegree.get(relation.child_table) + 1);
    }
  }
  const queue = tables.filter((table) => indegree.get(table) === 0).sort();
  const ordered = [];
  while (queue.length) {
    const table = queue.shift();
    ordered.push(table);
    for (const child of graph.get(table) || []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
    queue.sort();
  }
  for (const table of tables) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

export async function inspectTenantBackup(tenantId, backupId) {
  const body = await downloadBackup(tenantId, backupId);
  const snapshot = decryptBackupPayload(body);
  if (snapshot?.snapshotVersion !== SNAPSHOT_VERSION || snapshot?.tenantId !== tenantId) {
    throw new Error("Backup tenant or version mismatch");
  }
  return {
    snapshotVersion: snapshot.snapshotVersion,
    createdAt: snapshot.createdAt,
    tenantId: snapshot.tenantId,
    rowCount: snapshot.rowCount,
    tables: Object.fromEntries(Object.entries(snapshot.tables || {}).map(([name, rows]) => [name, rows.length])),
  };
}

export async function restoreTenantBackup(tenantId, backupId) {
  const body = await downloadBackup(tenantId, backupId);
  const snapshot = decryptBackupPayload(body);
  if (snapshot?.snapshotVersion !== SNAPSHOT_VERSION || snapshot?.tenantId !== tenantId) {
    throw new Error("Backup tenant or version mismatch");
  }

  const client = await dbPool.connect();
  let insertedRows = 0;
  try {
    await client.query("BEGIN");
    const tenant = snapshot.tenants?.[0];
    if (!tenant?.id || tenant.id !== tenantId) throw new Error("Backup tenant record is invalid");

    await client.query(
      `INSERT INTO tenants (id, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [tenant.id, tenant.name, tenant.status, tenant.created_at, tenant.updated_at],
    );

    const relations = await getRestoreOrder(client);
    const tables = Object.keys(snapshot.tables || {}).filter((table) => /^[a-z_][a-z0-9_]*$/.test(table) && !EXCLUDED_TABLES.has(table));
    const order = topologicalOrder(tables, relations);

    for (const table of order) {
      const rows = snapshot.tables[table] || [];
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => /^[a-z_][a-z0-9_]*$/.test(column));
        if (!columns.length) continue;
        const values = columns.map((column) => row[column]);
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        const sql = `INSERT INTO ${safeIdentifier(table)} (${columns.map(safeIdentifier).join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING`;
        const result = await client.query(sql, values);
        insertedRows += result.rowCount || 0;
      }
    }

    await client.query("COMMIT");
    return { backupId, tenantId, insertedRows, mode: "additive" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listTenantBackups(tenantId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const result = await dbPool.query(
    `SELECT id, kind, status, drive_file_id, drive_file_name, snapshot_version, row_count, byte_size, sha256, started_at, completed_at, error_code
     FROM tenant_backups WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [tenantId, safeLimit],
  );
  return result.rows;
}

export async function getGoogleDriveStatus(tenantId) {
  const connection = await getConnection(tenantId);
  if (!connection) return { connected: false, status: "not_connected", lastBackupAt: null, lastError: null };
  return {
    connected: connection.status === "active",
    status: connection.status,
    lastBackupAt: connection.last_backup_at,
    lastError: connection.last_error,
  };
}

export async function disconnectGoogleDrive(tenantId) {
  const connection = await getConnection(tenantId);
  if (!connection) return { disconnected: false };
  try {
    const refreshToken = decryptSecret(connection.refresh_token_encrypted);
    const { clientId, clientSecret } = requireGoogleConfig();
    await axios.post("https://oauth2.googleapis.com/revoke", new URLSearchParams({
      token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }), { headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 15_000 });
  } catch {
    // Local revocation is still performed even if Google's revoke endpoint is unavailable.
  }
  await dbPool.query(
    "UPDATE google_drive_connections SET status = 'revoked', refresh_token_encrypted = $2, updated_at = NOW() WHERE tenant_id = $1",
    [tenantId, encryptSecret("revoked")],
  );
  return { disconnected: true };
}

export const __private__ = {
  encryptBackupPayload,
  decryptBackupPayload,
  topologicalOrder,
  hashState,
};
