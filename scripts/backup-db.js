import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("NOVA-BACKUP-V1\n");
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("BACKUP_ENCRYPTION_KEY is required");
  let key;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9_-]{43}$/.test(raw)) key = Buffer.from(raw, "base64url");
  else throw new Error("BACKUP_ENCRYPTION_KEY must be 32-byte base64url or 64-character hex");
  if (key.length !== KEY_LENGTH) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function runPgDump(outputPath) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--dbname", url], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`pg_dump failed to start: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (${code}): ${stderr.slice(-2000)}`)));
  });
}

async function pruneBackups(outputDir) {
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("BACKUP_RETENTION_DAYS must be between 1 and 3650");
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await fsp.readdir(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".backup.enc")) continue;
    const filePath = path.join(outputDir, entry.name);
    const stat = await fsp.stat(filePath);
    if (stat.mtimeMs < cutoff) {
      await fsp.rm(filePath, { force: true });
      await fsp.rm(`${filePath}.json`, { force: true });
    }
  }
}

async function createBackup() {
  const key = getKey();
  const outputDir = path.resolve(process.env.BACKUP_DIR || "./backups");
  await fsp.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(outputDir, `nova-${timestamp}.backup.enc`);
  const tempPath = `${finalPath}.partial`;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });

  const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--dbname", process.env.DATABASE_URL], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
    output.write(MAGIC);
    output.write(iv);
    await pipeline(child.stdout, cipher, output);
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (exitCode !== 0) throw new Error(`pg_dump failed (${exitCode}): ${stderr.slice(-2000)}`);
    await fsp.appendFile(tempPath, cipher.getAuthTag(), { mode: 0o600 });
    await fsp.rename(tempPath, finalPath);
    const stat = await fsp.stat(finalPath);
    const manifest = {
      format: "NOVA-BACKUP-V1",
      createdAt: new Date().toISOString(),
      file: path.basename(finalPath),
      bytes: stat.size,
      encrypted: true,
      algorithm: "aes-256-gcm",
      databaseDumpFormat: "postgres-custom",
    };
    await fsp.writeFile(`${finalPath}.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await pruneBackups(outputDir);
    console.log(JSON.stringify(manifest));
  } catch (error) {
    child.kill("SIGTERM");
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

createBackup().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
