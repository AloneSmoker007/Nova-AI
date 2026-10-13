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
  let persistOutboundMessage;
  let ingestWebhookMessage;
  let claimInboxMessage;
  let runRetentionCleanup;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage, persistOutboundMessage } = await import("../src/services/message-persistence.service.js"));
    ({ ingestWebhookMessage, claimInboxMessage } = await import("../src/services/webhook-inbox.service.js"));
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
    const firstNumber = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, "provider-" + randomUUID(), "+15550000001"],
    );
    const secondNumber = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, "provider-" + randomUUID(), "+15550000002"],
    );

    return {
      tenantId,
      firstNumberId: firstNumber.rows[0].id,
      secondNumberId: secondNumber.rows[0].id,
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

  it("does not requeue a canonical provider message after completed inbox retention cleanup", async () => {
    const tenantId = randomUUID();
    const phoneNumberId = "1" + String(Date.now()).slice(-9);
    const waId = "15551234567";
    const whatsappMessageId = "wamid-retention-" + randomUUID();
    const body = "Already processed message";

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "inbox-retention-replay-" + tenantId,
    ]);
    const number = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, phoneNumberId, "+15550000003"],
    );
    await persistInboundMessage({
      tenantId,
      whatsappNumberId: number.rows[0].id,
      waId,
      profileName: "Retention Test",
      whatsappMessageId,
      messageType: "text",
      body,
      receivedAt: new Date(),
    });

    // Simulate the previously completed inbox item after 31 days. Canonical
    // messages are deliberately retained after the inbox's 30-day retention.
    await dbPool.query(
      `INSERT INTO webhook_messages (
         tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id,
         wa_id, body, received_at, state, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '31 days',
               'COMPLETED', NOW() - INTERVAL '31 days')`,
      [tenantId, number.rows[0].id, phoneNumberId, whatsappMessageId, waId, body],
    );

    const previousRetention = process.env.RETENTION_WEBHOOK_COMPLETED_DAYS;
    try {
      process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = "30";
      const cleanup = await runRetentionCleanup();
      assert.ok(cleanup.webhookMessages >= 1, "the old completed inbox row should be removed by retention");
    } finally {
      if (previousRetention === undefined) delete process.env.RETENTION_WEBHOOK_COMPLETED_DAYS;
      else process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = previousRetention;
    }

    const oldRow = await dbPool.query(
      "SELECT id FROM webhook_messages WHERE tenant_id=$1 AND whatsapp_message_id=$2",
      [tenantId, whatsappMessageId],
    );
    assert.equal(oldRow.rowCount, 0, "retention must remove the old inbox payload while leaving canonical message history");

    const replay = await ingestWebhookMessage({
      message: {
        id: whatsappMessageId,
        phoneNumberId,
        from: waId,
        profileName: "Retention Test",
        text: { body },
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
      tenant: { tenantId, whatsappNumberId: number.rows[0].id, phoneNumberId },
    });

    assert.equal(replay.state, "COMPLETED", "the replay must enter inbox as terminal");
    assert.ok(replay.completed_at, "the terminal replay must have completion timestamp");

    const claim = await claimInboxMessage(replay.id, tenantId);
    assert.equal(claim.claimed, false, "a retained canonical message must not become eligible for processing");

    const state = await dbPool.query(
      "SELECT state, completed_at FROM webhook_messages WHERE tenant_id=$1 AND id=$2",
      [tenantId, replay.id],
    );
    assert.equal(state.rows[0].state, "COMPLETED");
    assert.ok(state.rows[0].completed_at);
  });


  it("keeps activity timestamps monotonic for late inbound, delayed outbound repair and duplicate replay", async () => {
    const { tenantId, firstNumberId } = await seedTenantAndNumbers();
    const waId = "1555" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
    const newestReceivedAt = new Date(Date.now() - 60 * 60 * 1000);
    const olderReceivedAt = new Date(newestReceivedAt.getTime() - 30 * 60 * 1000);
    const olderMessageId = "wamid-order-older-" + randomUUID();

    const newest = await persistInboundMessage({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId,
      profileName: "Ordering Test",
      whatsappMessageId: "wamid-order-newest-" + randomUUID(),
      body: "newest event first",
      receivedAt: newestReceivedAt,
    });
    const older = await persistInboundMessage({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId,
      profileName: "Ordering Test",
      whatsappMessageId: olderMessageId,
      body: "older event arrived late",
      receivedAt: olderReceivedAt,
    });
    assert.equal(newest.duplicate, false);
    assert.equal(older.duplicate, false);
    assert.equal(older.conversationId, newest.conversationId);

    await persistOutboundMessage({
      tenantId,
      conversationId: newest.conversationId,
      whatsappMessageId: "wamid-order-outbound-" + randomUUID(),
      body: "delayed outbound history repair",
      sentAt: new Date(olderReceivedAt.getTime() - 60 * 1000),
    });

    const replay = await persistInboundMessage({
      tenantId,
      whatsappNumberId: firstNumberId,
      waId,
      profileName: "Ordering Test",
      whatsappMessageId: olderMessageId,
      body: "older event arrived late",
      receivedAt: new Date(olderReceivedAt.getTime() - 60 * 60 * 1000),
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.messageId, older.messageId);

    const conversation = await dbPool.query(
      "SELECT last_message_at, unread_count FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, newest.conversationId],
    );
    assert.equal(
      new Date(conversation.rows[0].last_message_at).getTime(),
      newestReceivedAt.getTime(),
      "late inbound and outbound history must not regress the newest activity timestamp",
    );
    assert.equal(conversation.rows[0].unread_count, 2, "a duplicate replay must not increment unread count");

    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM messages WHERE tenant_id=$1 AND conversation_id=$2",
      [tenantId, newest.conversationId],
    );
    assert.equal(count.rows[0].count, 3, "two inbound provider IDs and one outbound provider ID remain unique");
  });

});
