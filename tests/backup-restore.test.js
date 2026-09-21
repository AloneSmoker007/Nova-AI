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
  assert.match(source, /--single-transaction/);
  assert.match(source, /--exit-on-error/);
});

test("backup scripts do not pass DATABASE_URL directly to database CLI arguments", async () => {
  const backup = await fs.readFile(new URL("../scripts/backup-db.js", import.meta.url), "utf8");
  const restore = await fs.readFile(new URL("../scripts/restore-db.js", import.meta.url), "utf8");
  assert.doesNotMatch(backup, /--dbname.*DATABASE_URL/);
  assert.doesNotMatch(restore, /--dbname.*target/);
  assert.match(backup, /PGPASSWORD/);
  assert.match(restore, /PGPASSWORD/);
});
