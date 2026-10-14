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
  let runRetentionCleanup;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage } = await import("../src/services/message-persistence.service.js"));
    ({ handoffConversation } = await import("../src/services/handoff.service.js"));
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

  it("retention cleanup prunes stale memory, AI signals, summaries, and copilot drafts", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const phoneNumberId = "provider-" + randomUUID();
    const waId = "1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    const original = {
      memory: process.env.RETENTION_AI_MEMORY_DAYS,
      signals: process.env.RETENTION_AI_SIGNALS_DAYS,
      summaries: process.env.RETENTION_AI_SUMMARIES_DAYS,
      drafts: process.env.RETENTION_AI_DRAFTS_DAYS,
    };

    try {
      process.env.RETENTION_AI_MEMORY_DAYS = "7";
      process.env.RETENTION_AI_SIGNALS_DAYS = "7";
      process.env.RETENTION_AI_SUMMARIES_DAYS = "7";
      process.env.RETENTION_AI_DRAFTS_DAYS = "7";

      await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
        tenantId,
        "ai-retention-" + tenantId,
      ]);
      const number = await dbPool.query(
        `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, phoneNumberId, "+15550000008"],
      );
      await dbPool.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'owner', 'active')`,
        [userId, tenantId, `retention-${userId}@example.test`, "test-only-password-hash"],
      );
      const message = await persistInboundMessage({
        tenantId,
        whatsappNumberId: number.rows[0].id,
        waId,
        profileName: "AI retention test",
        whatsappMessageId: "wamid-" + randomUUID(),
        messageType: "text",
        body: "Retain canonical message independently from AI artifacts",
        receivedAt: new Date(),
      });

      await dbPool.query(
        `INSERT INTO contact_ai_memory
           (tenant_id, contact_id, memory_key, memory_value, updated_at, last_confirmed_at)
         VALUES ($1, $2, 'old-preference', 'old value', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')`,
        [tenantId, message.contactId],
      );
      await dbPool.query(
        `INSERT INTO conversation_ai_signals
           (tenant_id, conversation_id, message_id, intent, created_at)
         VALUES ($1, $2, $3, 'general', NOW() - INTERVAL '8 days')`,
        [tenantId, message.conversationId, message.messageId],
      );
      await dbPool.query(
        `INSERT INTO conversation_ai_summaries
           (tenant_id, conversation_id, summary, created_at)
         VALUES ($1, $2, 'old summary', NOW() - INTERVAL '8 days')`,
        [tenantId, message.conversationId],
      );
      await dbPool.query(
        `INSERT INTO ai_copilot_drafts
           (tenant_id, conversation_id, author_user_id, draft, status, updated_at)
         VALUES ($1, $2, $3, 'old draft', 'discarded', NOW() - INTERVAL '8 days')`,
        [tenantId, message.conversationId, userId],
      );

      const counts = await runRetentionCleanup();
      assert.ok(counts.aiMemory >= 1);
      assert.ok(counts.aiSignals >= 1);
      assert.ok(counts.aiSummaries >= 1);
      assert.ok(counts.aiDrafts >= 1);

      const remaining = await dbPool.query(
        `SELECT
           (SELECT count(*)::int FROM contact_ai_memory WHERE tenant_id=$1) AS memory,
           (SELECT count(*)::int FROM conversation_ai_signals WHERE tenant_id=$1) AS signals,
           (SELECT count(*)::int FROM conversation_ai_summaries WHERE tenant_id=$1) AS summaries,
           (SELECT count(*)::int FROM ai_copilot_drafts WHERE tenant_id=$1) AS drafts`,
        [tenantId],
      );
      assert.deepEqual(remaining.rows[0], { memory: 0, signals: 0, summaries: 0, drafts: 0 });
    } finally {
      for (const [key, value] of Object.entries({
        RETENTION_AI_MEMORY_DAYS: original.memory,
        RETENTION_AI_SIGNALS_DAYS: original.signals,
        RETENTION_AI_SUMMARIES_DAYS: original.summaries,
        RETENTION_AI_DRAFTS_DAYS: original.drafts,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

});
