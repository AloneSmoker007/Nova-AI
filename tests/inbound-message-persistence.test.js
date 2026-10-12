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
});
