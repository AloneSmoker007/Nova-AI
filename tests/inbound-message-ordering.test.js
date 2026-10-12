import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("inbound message ordering (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let persistInboundMessage = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage } = await import("../src/services/message-persistence.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);

    const tenantId = randomUUID();
    const whatsappNumberId = randomUUID();
    const phoneNumberId = String(1_550_000_000 + Math.floor(Math.random() * 99_999_999));

    await dbPool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')",
      [tenantId, "message-ordering-" + tenantId],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, access_token_encrypted, status)
       VALUES ($1, $2, $3, '+15550001111', 'Ordering Test', 'test-only-encrypted-token', 'active')`,
      [whatsappNumberId, tenantId, phoneNumberId],
    );

    context = { tenantId, whatsappNumberId };
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  let context = null;

  it("does not move last_message_at backwards when distinct inbound events arrive out of order", async () => {
    const { tenantId, whatsappNumberId } = context;
    const contact = "1555" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
    const base = Date.now() - 24 * 60 * 60 * 1000;
    const newestReceivedAt = new Date(base + 10 * 60 * 1000);
    const olderReceivedAt = new Date(base);

    const newest = await persistInboundMessage({
      tenantId,
      whatsappNumberId,
      waId: contact,
      profileName: "Message Order Test",
      whatsappMessageId: "wamid-order-new-" + randomUUID(),
      body: "newer event arrived first",
      receivedAt: newestReceivedAt,
    });
    assert.equal(newest.duplicate, false);

    const late = await persistInboundMessage({
      tenantId,
      whatsappNumberId,
      waId: contact,
      profileName: "Message Order Test",
      whatsappMessageId: "wamid-order-late-" + randomUUID(),
      body: "older event arrived late",
      receivedAt: olderReceivedAt,
    });
    assert.equal(late.duplicate, false);
    assert.equal(late.conversationId, newest.conversationId);

    const conversation = await dbPool.query(
      "SELECT last_message_at, unread_count FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, newest.conversationId],
    );
    assert.equal(
      new Date(conversation.rows[0].last_message_at).getTime(),
      newestReceivedAt.getTime(),
      "late-arriving messages must not regress conversation activity time",
    );
    assert.equal(conversation.rows[0].unread_count, 2);
  });

  it("duplicate replay of an old inbound event preserves the newest activity timestamp and unread count", async () => {
    const { tenantId, whatsappNumberId } = context;
    const contact = "1555" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
    const newestReceivedAt = new Date(Date.now() - 60 * 60 * 1000);
    const duplicateId = "wamid-order-duplicate-" + randomUUID();

    const newest = await persistInboundMessage({
      tenantId,
      whatsappNumberId,
      waId: contact,
      whatsappMessageId: "wamid-order-current-" + randomUUID(),
      body: "current message",
      receivedAt: newestReceivedAt,
    });
    await persistInboundMessage({
      tenantId,
      whatsappNumberId,
      waId: contact,
      whatsappMessageId: duplicateId,
      body: "older message",
      receivedAt: new Date(newestReceivedAt.getTime() - 30 * 60 * 1000),
    });

    const replay = await persistInboundMessage({
      tenantId,
      whatsappNumberId,
      waId: contact,
      whatsappMessageId: duplicateId,
      body: "older message",
      receivedAt: new Date(newestReceivedAt.getTime() - 90 * 60 * 1000),
    });
    assert.equal(replay.duplicate, true);

    const conversation = await dbPool.query(
      "SELECT last_message_at, unread_count FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, newest.conversationId],
    );
    assert.equal(new Date(conversation.rows[0].last_message_at).getTime(), newestReceivedAt.getTime());
    assert.equal(conversation.rows[0].unread_count, 2, "a duplicate replay must not increment unread count");
    const messages = await dbPool.query(
      "SELECT count(*)::int AS count FROM messages WHERE tenant_id=$1 AND conversation_id=$2",
      [tenantId, newest.conversationId],
    );
    assert.equal(messages.rows[0].count, 2, "each provider message ID is persisted once");
  });
});
