import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("backup utility uses authenticated encryption and atomic partial files", async () => {
  const source = await fs.readFile(new URL("../scripts/backup-db.js", import.meta.url), "utf8");
  assert.match(source, /aes-256-gcm/);
  assert.match(source, /\.partial/);
  assert.match(source, /getAuthTag/);
  assert.match(source, /BACKUP_RETENTION_DAYS/);
});

test("restore utility refuses to proceed without explicit overwrite confirmation", async () => {
  const source = await fs.readFile(new URL("../scripts/restore-db.js", import.meta.url), "utf8");
  assert.match(source, /RESTORE_ALLOW_OVERWRITE !== "YES"/);
  assert.match(source, /setAuthTag/);
  assert.match(source, /pg_restore/);
});

test("backup scripts do not pass DATABASE_URL directly to database CLI arguments", async () => {
  const backup = await fs.readFile(new URL("../scripts/backup-db.js", import.meta.url), "utf8");
  const restore = await fs.readFile(new URL("../scripts/restore-db.js", import.meta.url), "utf8");
  assert.doesNotMatch(backup, /--dbname.*DATABASE_URL/);
  assert.doesNotMatch(restore, /--dbname.*target/);
  assert.match(backup, /PGPASSWORD/);
  assert.match(restore, /PGPASSWORD/);
});

test("restore authenticates the entire encrypted dump before pg_restore can start", async () => {
  const source = await fs.readFile(new URL("../scripts/restore-db.js", import.meta.url), "utf8");

  const verifyStart = source.indexOf(
    "await pipeline(\n      encrypted,\n      decipher,",
  );
  const restoreSpawn = source.indexOf('spawn("pg_restore"');
  const restoreInput = source.indexOf(
    "await pipeline(fs.createReadStream(verifiedDumpPath), pgRestore.stdin)",
  );

  assert.ok(verifyStart >= 0, "encrypted bytes must be fully decrypted into a verification stream");
  assert.ok(restoreSpawn > verifyStart, "pg_restore must not spawn before GCM authentication completes");
  assert.ok(restoreInput > restoreSpawn, "pg_restore must only read the already verified temporary dump");
  assert.match(source, /fs\.createWriteStream\(verifiedDumpPath, \{ flags: "wx", mode: 0o600 \}\)/);
  assert.match(source, /await fsp\.rm\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.match(source, /finally \{[\s\S]*?await fsp\.rm\(tempDir/);
  assert.doesNotMatch(
    source,
    /pipeline\(encrypted,\s*decipher,\s*pgRestore\.stdin\)/,
    "unauthenticated plaintext must never be piped directly into pg_restore",
  );
});
