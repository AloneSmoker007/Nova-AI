import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1 to run this test";

describe("handoff summary privacy (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let persistInboundMessage;
  let handoffConversation;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage } = await import("../src/services/message-persistence.service.js"));
    ({ handoffConversation } = await import("../src/services/handoff.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  it("omits deleted message text from a newly generated handoff summary", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const phoneNumberId = "provider-" + randomUUID();
    const waId = "1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "handoff-deleted-" + tenantId,
    ]);
    const number = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, phoneNumberId, "+15550000007"],
    );
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'owner', 'active')`,
      [userId, tenantId, `handoff-${userId}@example.test`, "test-only-password-hash"],
    );

    const first = await persistInboundMessage({
      tenantId,
      whatsappNumberId: number.rows[0].id,
      waId,
      profileName: "Handoff privacy test",
      whatsappMessageId: "wamid-" + randomUUID(),
      messageType: "text",
      body: "DELETED_PRIVATE_TEXT_7f42",
      receivedAt: new Date("2026-10-13T10:00:00.000Z"),
    });
    const second = await persistInboundMessage({
      tenantId,
      whatsappNumberId: number.rows[0].id,
      waId,
      profileName: "Handoff privacy test",
      whatsappMessageId: "wamid-" + randomUUID(),
      messageType: "text",
      body: "ACTIVE_MESSAGE_SHOULD_REMAIN",
      receivedAt: new Date("2026-10-13T10:01:00.000Z"),
    });

    assert.equal(first.conversationId, second.conversationId, "the two messages must share a conversation");

    await dbPool.query(
      `UPDATE messages SET deleted_at=NOW(), status='deleted'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, first.messageId],
    );

    const result = await handoffConversation(tenantId, first.conversationId, userId, "privacy regression");
    assert.doesNotMatch(result.summary, /DELETED_PRIVATE_TEXT_7f42/);
    assert.match(result.summary, /ACTIVE_MESSAGE_SHOULD_REMAIN/);

    const saved = await dbPool.query(
      "SELECT summary FROM conversation_ai_summaries WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1",
      [tenantId, first.conversationId],
    );
    assert.equal(saved.rowCount, 1);
    assert.doesNotMatch(saved.rows[0].summary, /DELETED_PRIVATE_TEXT_7f42/);
    assert.match(saved.rows[0].summary, /ACTIVE_MESSAGE_SHOULD_REMAIN/);
  });
});
