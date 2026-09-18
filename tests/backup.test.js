import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const backup = await import("../src/services/backup.service.js");

test("backup envelope encrypts and authenticates tenant snapshot data", () => {
  const snapshot = {
    snapshotVersion: "v1",
    tenantId: "tenant-1",
    rowCount: 2,
    tenants: [{ id: "tenant-1", name: "Test" }],
    tables: { messages: [{ id: "message-1", text: "hello", status: "deleted" }] },
  };

  const encrypted = backup.__private__.encryptBackupPayload(snapshot);
  assert.notEqual(encrypted.toString("utf8").includes("hello"), true);

  const restored = backup.__private__.decryptBackupPayload(encrypted);
  assert.deepEqual(restored, snapshot);

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => backup.__private__.decryptBackupPayload(tampered), /authentication failed|Invalid backup envelope/);
});

test("restore ordering places referenced parent tables before children", () => {
  const order = backup.__private__.topologicalOrder(
    ["messages", "conversations", "contacts"],
    [
      { parent_table: "contacts", child_table: "conversations" },
      { parent_table: "conversations", child_table: "messages" },
    ],
  );

  assert.ok(order.indexOf("contacts") < order.indexOf("conversations"));
  assert.ok(order.indexOf("conversations") < order.indexOf("messages"));
});

test("restore ordering remains deterministic for unrelated tables", () => {
  const order = backup.__private__.topologicalOrder(
    ["z_table", "a_table", "m_table"],
    [],
  );
  assert.deepEqual(order, ["a_table", "m_table", "z_table"]);
});
