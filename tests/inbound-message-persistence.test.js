import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1 to run this test";

describe("inbound message idempotency and identity (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let persistInboundMessage;
  let ingestWebhookMessage;
  let findUndispatchedMessages;
  let runRetentionCleanup;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage } = await import("../src/services/message-persistence.service.js"));
    ({ ingestWebhookMessage, findUndispatchedMessages } = await import("../src/services/webhook-inbox.service.js"));
    ({ runRetentionCleanup } = await import("../src/services/retention.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedTenantAndNumbers() {
    const tenantId = randomUUID();
    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "inbound-idempotency-" + tenantId,
    ]);
    const makeProviderNumberId = () =>
      String(BigInt("0x" + randomUUID().replaceAll("-", "")) % 900000000000000n + 100000000000000n);
    const firstPhoneNumberId = makeProviderNumberId();
    const secondPhoneNumberId = makeProviderNumberId();
    const firstNumber = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id, phone_number_id`,
      [tenantId, firstPhoneNumberId, "+15550000001"],
    );
    const secondNumber = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id, phone_number_id`,
      [tenantId, secondPhoneNumberId, "+15550000002"],
    );

    return {
      tenantId,
      firstNumberId: firstNumber.rows[0].id,
      firstPhoneNumberId: firstNumber.rows[0].phone_number_id,
      secondNumberId: secondNumber.rows[0].id,
      secondPhoneNumberId: secondNumber.rows[0].phone_number_id,
    };
  }

  function input({ tenantId, whatsappNumberId, waId, whatsappMessageId, body }) {
    return {
      tenantId,
      whatsappNumberId,
      waId,
      profileName: "Test Customer",
      whatsappMessageId,
      messageType: "text",
      body,
      receivedAt: new Date("2026-10-12T05:00:00.000Z"),
    };
  }

  it("duplicate retries return the canonical message, conversation and contact IDs", async () => {
    const { tenantId, firstNumberId } = await seedTenantAndNumbers();
    const whatsappMessageId = "wamid-" + randomUUID();
    const payload = input({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId: "15551234567",
      whatsappMessageId,
      body: "Hello Nova",
    });

    const first = await persistInboundMessage(payload);
    const duplicate = await persistInboundMessage(payload);

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.identityConflict, false);
    assert.equal(duplicate.messageId, first.messageId);
    assert.equal(duplicate.conversationId, first.conversationId);
    assert.equal(duplicate.contactId, first.contactId);

    const counts = await dbPool.query(
      `SELECT
         (SELECT count(*)::int FROM contacts WHERE tenant_id=$1) AS contacts,
         (SELECT count(*)::int FROM conversations WHERE tenant_id=$1) AS conversations,
         (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2) AS messages`,
      [tenantId, whatsappMessageId],
    );
    assert.equal(counts.rows[0].contacts, 1);
    assert.equal(counts.rows[0].conversations, 1);
    assert.equal(counts.rows[0].messages, 1);
  });

  it("same message ID with a different sender, number or body is rejected without side effects", async () => {
    const { tenantId, firstNumberId, secondNumberId } = await seedTenantAndNumbers();
    const whatsappMessageId = "wamid-" + randomUUID();
    const original = input({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId: "15551234567",
      whatsappMessageId,
      body: "Original trusted message",
    });
    const first = await persistInboundMessage(original);

    const collisions = [
      input({
        ...original,
        waId: "15557654321",
        body: "Impersonated sender payload",
      }),
      input({
        ...original,
        body: "Mutated body under the same provider ID",
      }),
      input({
        ...original,
        whatsappNumberId: secondNumberId,
      }),
    ];

    for (const collisionInput of collisions) {
      const collision = await persistInboundMessage(collisionInput);
      assert.equal(collision.duplicate, true);
      assert.equal(collision.identityConflict, true);
      assert.equal(collision.messageId, first.messageId);
      assert.equal(collision.conversationId, first.conversationId);
      assert.equal(collision.contactId, first.contactId);
    }

    const counts = await dbPool.query(
      `SELECT
         (SELECT count(*)::int FROM contacts WHERE tenant_id=$1) AS contacts,
         (SELECT count(*)::int FROM conversations WHERE tenant_id=$1) AS conversations,
         (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2) AS messages`,
      [tenantId, whatsappMessageId],
    );
    assert.equal(counts.rows[0].contacts, 1, "collision attempts must not persist another contact");
    assert.equal(counts.rows[0].conversations, 1, "collision attempts must not persist another conversation");
    assert.equal(counts.rows[0].messages, 1, "the canonical message row must remain unique and unchanged");
  });
  it("does not reprocess a WhatsApp message when its completed inbox row was pruned by retention", async () => {
    const {
      tenantId,
      firstNumberId,
      firstPhoneNumberId,
    } = await seedTenantAndNumbers();
    const whatsappMessageId = "wamid-retention-" + randomUUID();
    const waId = "15551234567";
    const body = "Already handled before inbox retention";

    const canonical = await persistInboundMessage(input({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId,
      whatsappMessageId,
      body,
    }));
    assert.equal(canonical.duplicate, false);

    const tenant = {
      tenantId,
      whatsappNumberId: firstNumberId,
      phoneNumberId: firstPhoneNumberId,
    };
    const message = {
      id: whatsappMessageId,
      phoneNumberId: firstPhoneNumberId,
      from: waId,
      text: { body },
      timestamp: String(Math.floor(Date.now() / 1000)),
    };

    // Simulate the previously completed durable-inbox row, now old enough for
    // the configured 30-day retention cleanup to remove its payload/idempotency
    // row while the canonical messages-table row is still retained.
    const originalInbox = await ingestWebhookMessage({ message, tenant });
    assert.equal(originalInbox.state, "COMPLETED");
    await dbPool.query(
      `UPDATE webhook_messages
       SET completed_at = NOW() - INTERVAL '31 days'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, originalInbox.id],
    );
    const beforeCleanup = await dbPool.query(
      "SELECT id FROM webhook_messages WHERE tenant_id=$1 AND whatsapp_message_id=$2",
      [tenantId, whatsappMessageId],
    );
    assert.equal(beforeCleanup.rowCount, 1);

    const originalRetentionDays = process.env.RETENTION_WEBHOOK_COMPLETED_DAYS;
    try {
      process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = "30";
      const cleanup = await runRetentionCleanup();
      assert.ok(cleanup.webhookMessages >= 1);
    } finally {
      if (originalRetentionDays === undefined) delete process.env.RETENTION_WEBHOOK_COMPLETED_DAYS;
      else process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = originalRetentionDays;
    }

    const pruned = await dbPool.query(
      "SELECT id FROM webhook_messages WHERE tenant_id=$1 AND whatsapp_message_id=$2",
      [tenantId, whatsappMessageId],
    );
    assert.equal(pruned.rowCount, 0, "retention should prune the completed inbox payload row");

    const replay = await ingestWebhookMessage({ message, tenant });
    assert.equal(replay.state, "COMPLETED", "a canonical inbound message makes the late replay terminal");
    assert.ok(replay.completed_at, "the replay should have a completion timestamp immediately");
    const pending = await findUndispatchedMessages(50);
    assert.ok(
      !pending.some((row) => row.id === replay.id),
      "the late replay must not be placed back into queue/worker recovery",
    );

    const counts = await dbPool.query(
      `SELECT
         (SELECT count(*)::int FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2) AS messages,
         (SELECT count(*)::int FROM contacts WHERE tenant_id=$1 AND wa_id=$3) AS contacts,
         (SELECT count(*)::int FROM conversations WHERE tenant_id=$1 AND contact_id=$4) AS conversations`,
      [tenantId, whatsappMessageId, waId, canonical.contactId],
    );
    assert.equal(counts.rows[0].messages, 1);
    assert.equal(counts.rows[0].contacts, 1);
    assert.equal(counts.rows[0].conversations, 1);
  });


});
