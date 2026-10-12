import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const NUMBER_A = "55555555-5555-4555-8555-555555555555";
const NUMBER_B = "66666666-6666-4666-8666-666666666666";

describe("webhook dead-letter operations (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let listDeadLetterMessages = null;
  let requeueDeadLetterMessage = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({
      listDeadLetterMessages,
      requeueDeadLetterMessage,
    } = await import("../src/services/webhook-inbox.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    if (allowReset) {
      await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await dbPool.query("CREATE SCHEMA public");
    } else {
      const existing = await dbPool.query("SELECT to_regclass('public.schema_migrations') AS present");
      assert.equal(existing.rows[0].present, null, "use a fresh database or set MIGRATION_TEST_ALLOW_RESET=1");
    }

    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);

    await dbPool.query(
      `INSERT INTO tenants (id, name, status) VALUES
        ($1, 'Dead Letter Tenant A', 'active'),
        ($2, 'Dead Letter Tenant B', 'active')`,
      [TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status) VALUES
        ($1, $3, 'deadletter-a@example.test', 'test-only-hash', 'owner', 'active'),
        ($2, $4, 'deadletter-b@example.test', 'test-only-hash', 'owner', 'active')`,
      [USER_A, USER_B, TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, status) VALUES
         ($1, $3, '15550000101', '+15550000101', 'active'),
         ($2, $4, '15550000102', '+15550000102', 'active')`,
      [NUMBER_A, NUMBER_B, TENANT_A, TENANT_B],
    );
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedInbox({
    tenantId = TENANT_A,
    numberId = NUMBER_A,
    messageId = "wamid-dead-" + randomUUID(),
    state = "DEAD_LETTER",
    attempts = 5,
    manualRetryCount = 0,
    generatedResponse = null,
    providerMessageId = null,
  } = {}) {
    const phoneNumberId = tenantId === TENANT_A ? "15550000101" : "15550000102";
    const result = await dbPool.query(
      `INSERT INTO webhook_messages (
         tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id,
         wa_id, profile_name, message_type, body, received_at, state, attempts,
         last_error, generated_response, provider_message_id, manual_retry_count
       )
       VALUES ($1, $2, $3, $4, '15551230001', 'Dead Letter Test', 'text',
         'A customer request that needs inspection', NOW(), $5, $6,
         'simulated processing failure', $7, $8, $9)
       RETURNING id`,
      [
        tenantId,
        numberId,
        phoneNumberId,
        messageId,
        state,
        attempts,
        generatedResponse,
        providerMessageId,
        manualRetryCount,
      ],
    );
    return result.rows[0].id;
  }

  it("lists dead letters only for the caller's tenant and clamps the page size", async () => {
    const inboxA1 = await seedInbox({ tenantId: TENANT_A });
    await seedInbox({ tenantId: TENANT_B });
    await seedInbox({ tenantId: TENANT_A, state: "COMPLETED" });

    const results = await listDeadLetterMessages(TENANT_A, 5000);
    assert.ok(results.length >= 1);
    assert.ok(results.length <= 100, "page size is capped");
    assert.ok(results.every((row) => row.id !== null));
    assert.ok(results.some((row) => row.id === inboxA1));
    assert.ok(
      results.every((row) => row.whatsapp_message_id.startsWith("wamid-dead-")),
      "only dead-letter rows should be returned",
    );
    const tenantBRows = await dbPool.query(
      "SELECT id FROM webhook_messages WHERE tenant_id=$1 AND state='DEAD_LETTER'",
      [TENANT_B],
    );
    assert.ok(tenantBRows.rows.every((row) => !results.some((item) => item.id === row.id)));
  });

  it("requeues a dead letter with an audit reason while preserving idempotent send state", async () => {
    const inboxId = await seedInbox({
      generatedResponse: "Previously generated reply",
      providerMessageId: "wamid.provider-already-accepted",
    });
    const reason = "Provider response was verified; reconcile durable inbox state";

    const result = await requeueDeadLetterMessage(inboxId, TENANT_A, USER_A, reason);
    assert.ok(result);
    assert.equal(result.state, "RETRY_WAIT");
    assert.equal(result.attempts, 0);
    assert.equal(result.manual_retry_count, 1);
    assert.equal(result.last_manual_retry_by, USER_A);
    assert.equal(result.last_manual_retry_reason, reason);
    assert.ok(result.last_manual_retry_at);

    const stored = await dbPool.query(
      `SELECT state, attempts, available_at, queue_dispatched_at, last_error,
              generated_response, provider_message_id, manual_retry_count,
              last_manual_retry_by, last_manual_retry_reason
       FROM webhook_messages WHERE tenant_id=$1 AND id=$2`,
      [TENANT_A, inboxId],
    );
    assert.equal(stored.rows[0].state, "RETRY_WAIT");
    assert.equal(stored.rows[0].attempts, 0);
    assert.equal(stored.rows[0].queue_dispatched_at, null, "the recovery loop must redispatch the row");
    assert.equal(stored.rows[0].last_error, null);
    assert.equal(stored.rows[0].generated_response, "Previously generated reply");
    assert.equal(
      stored.rows[0].provider_message_id,
      "wamid.provider-already-accepted",
      "provider correlation must survive a manual retry to avoid a duplicate send",
    );
    assert.equal(stored.rows[0].manual_retry_count, 1);

    assert.equal(
      await requeueDeadLetterMessage(inboxId, TENANT_A, USER_A, "second replay"),
      null,
      "the same row cannot be replayed again until it becomes dead-letter again",
    );
  });

  it("rejects cross-tenant message access, cross-tenant actors and retry-cap bypass", async () => {
    const inboxA = await seedInbox({ tenantId: TENANT_A });
    const inboxB = await seedInbox({ tenantId: TENANT_B });

    assert.equal(await requeueDeadLetterMessage(inboxB, TENANT_A, USER_A, "wrong tenant"), null);
    assert.equal(await requeueDeadLetterMessage(inboxA, TENANT_A, USER_B, "wrong actor"), null);

    const capped = await seedInbox({ tenantId: TENANT_A, manualRetryCount: 10 });
    assert.equal(
      await requeueDeadLetterMessage(capped, TENANT_A, USER_A, "retry cap test"),
      null,
      "the 10-manual-retry cap cannot be bypassed",
    );

    const tenantAStillDeadLetter = await dbPool.query(
      "SELECT state, manual_retry_count FROM webhook_messages WHERE tenant_id=$1 AND id=$2",
      [TENANT_A, inboxA],
    );
    assert.equal(tenantAStillDeadLetter.rows[0].state, "DEAD_LETTER");
    assert.equal(tenantAStillDeadLetter.rows[0].manual_retry_count, 0);
  });

  it("requires a non-empty operator reason within the configured bound", async () => {
    const inboxId = await seedInbox();
    await assert.rejects(
      () => requeueDeadLetterMessage(inboxId, TENANT_A, USER_A, ""),
      /Invalid manual retry reason/,
    );
    await assert.rejects(
      () => requeueDeadLetterMessage(inboxId, TENANT_A, USER_A, "x".repeat(501)),
      /Invalid manual retry reason/,
    );
    const row = await dbPool.query(
      "SELECT state FROM webhook_messages WHERE tenant_id=$1 AND id=$2",
      [TENANT_A, inboxId],
    );
    assert.equal(row.rows[0].state, "DEAD_LETTER", "invalid operator input must not mutate the inbox row");
  });
});
