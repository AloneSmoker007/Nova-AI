import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("NOVA-BACKUP-V1\n");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function postgresEnv(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DATABASE_URL must use PostgreSQL");
  const env = { ...process.env };
  env.PGHOST = parsed.hostname;
  env.PGPORT = parsed.port || "5432";
  env.PGUSER = decodeURIComponent(parsed.username);
  env.PGPASSWORD = decodeURIComponent(parsed.password);
  env.PGDATABASE = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.searchParams.has("sslmode")) env.PGSSLMODE = parsed.searchParams.get("sslmode");
  delete env.DATABASE_URL;
  return env;
}

function getKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("BACKUP_ENCRYPTION_KEY is required");
  const key = /^[a-fA-F0-9]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : /^[A-Za-z0-9_-]{43}$/.test(raw)
      ? Buffer.from(raw, "base64url")
      : null;
  if (!key || key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

async function restore() {
  const backupPath = process.argv[2];
  const target = process.env.RESTORE_TARGET_DATABASE_URL;
  if (!backupPath || !target) throw new Error("Usage: npm run db:restore -- <encrypted-backup>; RESTORE_TARGET_DATABASE_URL is required");
  if (process.env.RESTORE_ALLOW_OVERWRITE !== "YES") {
    throw new Error("Restore is destructive-capable. Set RESTORE_ALLOW_OVERWRITE=YES explicitly after verifying the target database.");
  }

  const stat = await fsp.stat(backupPath);
  if (stat.size <= MAGIC.length + IV_LENGTH + TAG_LENGTH) throw new Error("Backup file is too small");
  const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
  const handle = await fsp.open(backupPath, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported backup format");
  const iv = header.subarray(MAGIC.length);
  const tag = Buffer.alloc(TAG_LENGTH);
  const tagHandle = await fsp.open(backupPath, "r");
  try {
    await tagHandle.read(tag, 0, TAG_LENGTH, stat.size - TAG_LENGTH);
  } finally {
    await tagHandle.close();
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  const encrypted = fs.createReadStream(backupPath, {
    start: MAGIC.length + IV_LENGTH,
    end: stat.size - TAG_LENGTH - 1,
  });
  // AES-GCM authentication is not finalized until the encrypted stream ends.
  // Never pipe unauthenticated plaintext into pg_restore: it can apply SQL
  // while the decipher is still waiting to verify the final authentication tag.
  // First decrypt completely to a private temporary file. pipeline() rejects
  // on a bad tag, so pg_restore is never started for an unauthenticated backup.
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nova-restore-"));
  const verifiedDumpPath = path.join(tempDir, "verified.dump");

  try {
    await pipeline(
      encrypted,
      decipher,
      fs.createWriteStream(verifiedDumpPath, { flags: "wx", mode: 0o600 }),
    );

    const pgRestore = spawn("pg_restore", ["--no-owner", "--no-acl"], {
      env: postgresEnv(target),
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    pgRestore.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const restoreExit = new Promise((resolve) => {
      pgRestore.once("error", (error) => resolve({ error }));
      pgRestore.once("close", (code) => resolve({ code }));
    });

    try {
      await pipeline(fs.createReadStream(verifiedDumpPath), pgRestore.stdin);
    } catch (error) {
      pgRestore.kill("SIGTERM");
      await restoreExit;
      throw error;
    }

    const result = await restoreExit;
    if (result.error) throw new Error(`pg_restore failed to start: ${result.error.message}`);
    if (result.code !== 0) throw new Error(`pg_restore failed (${result.code}): ${stderr.slice(-2000)}`);
    console.log("Restore completed successfully.");
  } finally {
    // The dump is sensitive plaintext. Remove it on success and every failure,
    // including GCM authentication failure and pg_restore errors.
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

restore().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
