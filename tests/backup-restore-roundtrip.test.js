import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const enabled = Boolean(integrationUrl) &&
  process.env.MIGRATION_TEST_ALLOW_RESET === "1" &&
  process.env.NOVA_BACKUP_TEST_ALLOW_CREATE_DATABASES === "YES";

const root = fileURLToPath(new URL("../", import.meta.url));

function databaseUrl(name) {
  const url = new URL(integrationUrl);
  url.pathname = "/" + name;
  return url.toString();
}

function runScript(script, environment, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

async function assertTargetEmpty(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query("SELECT to_regclass('public.gate_backup_probe') AS table_name");
    assert.equal(result.rows[0].table_name, null, "failed decryption must not mutate the target");
  } finally {
    await client.end();
  }
}

test("encrypted PostgreSQL backup, tamper rejection, and verified restore (isolated)", {
  skip: enabled ? false : "Requires isolated PG, reset consent, and NOVA_BACKUP_TEST_ALLOW_CREATE_DATABASES=YES",
}, async () => {
  const endpoint = new URL(integrationUrl);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname),
    "backup smoke test must only connect to a local throwaway PostgreSQL service",
  );

  const identifier = randomBytes(6).toString("hex");
  const sourceName = "nova_gate_src_" + identifier;
  const targetName = "nova_gate_dst_" + identifier;
  const sourceUrl = databaseUrl(sourceName);
  const targetUrl = databaseUrl(targetName);
  const key = randomBytes(32).toString("hex");
  const directory = await mkdtemp(path.join(tmpdir(), "nova-gate-backup-"));
  const admin = new Client({ connectionString: databaseUrl("postgres") });
  await admin.connect();

  let sourceCreated = false;
  let targetCreated = false;
  try {
    await admin.query("CREATE DATABASE " + sourceName);
    sourceCreated = true;
    await admin.query("CREATE DATABASE " + targetName);
    targetCreated = true;

    const source = new Client({ connectionString: sourceUrl });
    await source.connect();
    try {
      await source.query("CREATE TABLE gate_backup_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
      await source.query("INSERT INTO gate_backup_probe (id, payload) VALUES ($1, $2)", [7, "isolated-backup-roundtrip"]);
    } finally {
      await source.end();
    }

    const childEnv = {
      ...process.env,
      BACKUP_ENCRYPTION_KEY: key,
      BACKUP_DIR: directory,
      DATABASE_URL: sourceUrl,
      RESTORE_TARGET_DATABASE_URL: targetUrl,
      RESTORE_ALLOW_OVERWRITE: "YES",
    };

    const backedUp = runScript("scripts/backup-db.js", childEnv);
    assert.equal(backedUp.status, 0, "pg_dump + encryption must succeed: " + backedUp.stderr);
    const manifest = JSON.parse(backedUp.stdout.trim());
    assert.equal(manifest.encrypted, true);
    assert.equal(manifest.algorithm, "aes-256-gcm");

    const files = await readdir(directory);
    const backupName = files.find((name) => name.endsWith(".backup.enc"));
    assert.ok(backupName, "encrypted backup artifact must be present");
    const backupPath = path.join(directory, backupName);
    const encrypted = await readFile(backupPath);
    assert.ok(encrypted.length > 100);
    assert.equal(encrypted.subarray(0, 15).toString("utf8"), "NOVA-BACKUP-V1\n");

    const wrongKey = runScript("scripts/restore-db.js", {
      ...childEnv, BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    }, [backupPath]);
    assert.notEqual(wrongKey.status, 0, "wrong key must reject backup before pg_restore");
    await assertTargetEmpty(targetUrl);

    const modified = Buffer.from(encrypted);
    modified[modified.length - 1] ^= 1;
    const corruptedPath = path.join(directory, "corrupted.backup.enc");
    await writeFile(corruptedPath, modified, { mode: 0o600 });
    const tampered = runScript("scripts/restore-db.js", childEnv, [corruptedPath]);
    assert.notEqual(tampered.status, 0, "authentication-tag tampering must be rejected");
    await assertTargetEmpty(targetUrl);

    const restored = runScript("scripts/restore-db.js", childEnv, [backupPath]);
    assert.equal(restored.status, 0, "verified pg_restore must succeed: " + restored.stderr);

    const target = new Client({ connectionString: targetUrl });
    await target.connect();
    try {
      const rows = await target.query("SELECT id, payload FROM gate_backup_probe");
      assert.deepEqual(rows.rows, [{ id: 7, payload: "isolated-backup-roundtrip" }]);
    } finally {
      await target.end();
    }
  } finally {
    if (targetCreated) await admin.query("DROP DATABASE IF EXISTS " + targetName + " WITH (FORCE)");
    if (sourceCreated) await admin.query("DROP DATABASE IF EXISTS " + sourceName + " WITH (FORCE)");
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
