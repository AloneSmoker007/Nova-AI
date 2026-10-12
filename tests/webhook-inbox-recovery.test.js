import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1 to run this test";

describe("durable webhook inbox lease recovery fencing (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let recoverExpiredLeases;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ recoverExpiredLeases } = await import("../src/services/webhook-inbox.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedExpiredProcessingMessage() {
    const tenantId = randomUUID();
    const leaseToken = randomUUID();
    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "inbox-recovery-" + tenantId,
    ]);
    const number = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, "provider-" + randomUUID(), "+15550000000"],
    );
    const message = await dbPool.query(
      `INSERT INTO webhook_messages (
         tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id,
         wa_id, body, received_at, state, attempts, lease_until, lease_token
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'PROCESSING', 1,
               NOW() - INTERVAL '1 second', $7)
       RETURNING id`,
      [
        tenantId,
        number.rows[0].id,
        "provider-" + randomUUID(),
        "wamid-" + randomUUID(),
        "15551234567",
        "lease fencing test",
        leaseToken,
      ],
    );

    return { tenantId, inboxId: message.rows[0].id, leaseToken };
  }

  it("does not recover a lease renewed concurrently, but recovers it after it truly expires", async () => {
    const { tenantId, inboxId, leaseToken } = await seedExpiredProcessingMessage();
    const heartbeatClient = await dbPool.connect();

    try {
      await heartbeatClient.query("BEGIN");
      const locked = await heartbeatClient.query(
        "SELECT id FROM webhook_messages WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, inboxId],
      );
      assert.equal(locked.rowCount, 1);

      // Simulate the active worker's heartbeat extending an apparently expired
      // lease while holding the row lock. Recovery sees the old committed row
      // unless it uses SKIP LOCKED + lease compare-and-swap.
      await heartbeatClient.query(
        `UPDATE webhook_messages
         SET lease_until = NOW() + INTERVAL '5 minutes'
         WHERE tenant_id=$1 AND id=$2 AND lease_token=$3::uuid`,
        [tenantId, inboxId, leaseToken],
      );

      const recoveryPromise = recoverExpiredLeases(10);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await heartbeatClient.query("COMMIT");

      const recoveredDuringHeartbeat = await recoveryPromise;
      assert.ok(
        !recoveredDuringHeartbeat.some((row) => row.id === inboxId),
        "recovery must skip the row locked by the concurrent lease renewal",
      );

      const fresh = await dbPool.query(
        `SELECT state, lease_token, lease_until
         FROM webhook_messages WHERE tenant_id=$1 AND id=$2`,
        [tenantId, inboxId],
      );
      assert.equal(fresh.rows[0].state, "PROCESSING");
      assert.equal(fresh.rows[0].lease_token, leaseToken);
      assert.ok(new Date(fresh.rows[0].lease_until).getTime() > Date.now());

      await dbPool.query(
        "UPDATE webhook_messages SET lease_until=NOW()-INTERVAL '1 second' WHERE tenant_id=$1 AND id=$2",
        [tenantId, inboxId],
      );
      const actuallyExpired = await recoverExpiredLeases(10);
      assert.ok(actuallyExpired.some((row) => row.id === inboxId));

      const retried = await dbPool.query(
        "SELECT state, lease_token, lease_until FROM webhook_messages WHERE tenant_id=$1 AND id=$2",
        [tenantId, inboxId],
      );
      assert.equal(retried.rows[0].state, "RETRY_WAIT");
      assert.equal(retried.rows[0].lease_token, null);
      assert.equal(retried.rows[0].lease_until, null);
    } finally {
      await heartbeatClient.query("ROLLBACK").catch(() => undefined);
      heartbeatClient.release();
    }
  });
});
