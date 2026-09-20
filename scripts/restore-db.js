import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("NOVA-BACKUP-V1\n");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

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
  const pgRestore = spawn("pg_restore", ["--no-owner", "--no-acl", "--dbname", target], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  pgRestore.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  await pipeline(encrypted, decipher, pgRestore.stdin);
  const exitCode = await new Promise((resolve, reject) => {
    pgRestore.on("error", reject);
    pgRestore.on("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`pg_restore failed (${exitCode}): ${stderr.slice(-2000)}`);
  console.log("Restore completed successfully.");
}

restore().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
