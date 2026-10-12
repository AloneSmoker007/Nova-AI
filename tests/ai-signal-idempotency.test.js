import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("AI signal idempotency (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let recordAiSignal = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ recordAiSignal } = await import("../src/services/advanced-ai.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedMessage() {
    const tenantId = randomUUID();
    const numberId = randomUUID();
    const contactId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const phoneNumberId = "signal-" + randomUUID();

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "ai-signal-" + tenantId,
    ]);
    await dbPool.query(
      "INSERT INTO whatsapp_numbers (id, tenant_id, phone_number_id) VALUES ($1, $2, $3)",
      [numberId, tenantId, phoneNumberId],
    );
    await dbPool.query("INSERT INTO contacts (id, tenant_id, wa_id) VALUES ($1, $2, $3)", [
      contactId,
      tenantId,
      "signal-" + contactId,
    ]);
    await dbPool.query(
      "INSERT INTO conversations (id, tenant_id, whatsapp_number_id, contact_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenantId, numberId, contactId],
    );
    await dbPool.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, whatsapp_message_id, direction, message_type, "text", status)
       VALUES ($1, $2, $3, $4, 'inbound', 'text', 'price please', 'received')`,
      [messageId, tenantId, conversationId, "wamid.signal." + messageId],
    );

    return { tenantId, conversationId, messageId };
  }

  const firstSignal = {
    intent: "information",
    sentiment: "neutral",
    priority: 1,
    detectedLanguage: "english",
    preferredLanguage: "english",
    negotiationRequested: false,
    competitorComparisonRequested: false,
  };

  it("retries reuse one durable signal row and refresh its analysis", async () => {
    const { tenantId, conversationId, messageId } = await seedMessage();
    const first = await recordAiSignal(tenantId, conversationId, messageId, firstSignal);
    assert.ok(first?.id);

    const retriedSignal = {
      intent: "sales",
      sentiment: "positive",
      priority: 2,
      detectedLanguage: "roman-urdu",
      preferredLanguage: "roman-urdu",
      negotiationRequested: true,
      competitorComparisonRequested: true,
    };
    const retried = await recordAiSignal(tenantId, conversationId, messageId, retriedSignal);

    assert.equal(retried.id, first.id, "a retry must preserve the signal row identity");
    assert.equal(retried.intent, retriedSignal.intent);
    assert.equal(retried.sentiment, retriedSignal.sentiment);
    assert.equal(retried.priority, retriedSignal.priority);
    assert.equal(retried.detected_language, retriedSignal.detectedLanguage);
    assert.equal(retried.preferred_language, retriedSignal.preferredLanguage);
    assert.equal(retried.negotiation_requested, true);
    assert.equal(retried.competitor_comparison_requested, true);

    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM conversation_ai_signals WHERE tenant_id=$1 AND message_id=$2",
      [tenantId, messageId],
    );
    assert.equal(count.rows[0].count, 1, "only one signal row may exist per tenant/message");
  });

  it("different messages in the same conversation keep distinct signals", async () => {
    const fixture = await seedMessage();
    const secondMessageId = randomUUID();
    await dbPool.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, whatsapp_message_id, direction, message_type, "text", status)
       VALUES ($1, $2, $3, $4, 'inbound', 'text', 'please book', 'received')`,
      [
        secondMessageId,
        fixture.tenantId,
        fixture.conversationId,
        "wamid.signal." + secondMessageId,
      ],
    );

    const first = await recordAiSignal(
      fixture.tenantId,
      fixture.conversationId,
      fixture.messageId,
      firstSignal,
    );
    const second = await recordAiSignal(
      fixture.tenantId,
      fixture.conversationId,
      secondMessageId,
      { ...firstSignal, intent: "booking" },
    );

    assert.notEqual(first.id, second.id);
    assert.equal(second.intent, "booking");
    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM conversation_ai_signals WHERE tenant_id=$1 AND conversation_id=$2",
      [fixture.tenantId, fixture.conversationId],
    );
    assert.equal(count.rows[0].count, 2);
  });
});
