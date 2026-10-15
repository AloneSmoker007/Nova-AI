import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1 to run this test";

describe("AI usage reservation ownership and orphan reconciliation (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let persistInboundMessage;
  let ingestWebhookMessage;
  let reserveAiUsage;
  let commitAiUsage;
  let releaseAiUsage;
  let reconcileExpiredAiUsageReservations;
  let saveCopilotDraft;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ persistInboundMessage } = await import("../src/services/message-persistence.service.js"));
    ({ ingestWebhookMessage } = await import("../src/services/webhook-inbox.service.js"));
    ({
      reserveAiUsage,
      commitAiUsage,
      releaseAiUsage,
      reconcileExpiredAiUsageReservations,
    } = await import("../src/services/usage.service.js"));
    ({ saveCopilotDraft } = await import("../src/services/handoff.service.js"));

    assert.ok(dbPool, "dbPool must use the migration test database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
    assert.ok(migrated.applied.includes("032_ai_usage_reservation_fencing.sql"));
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedMessage() {
    const tenantId = randomUUID();
    const whatsappNumberId = "1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    const waId = "1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    const whatsappMessageId = "wamid-reservation-" + randomUUID();

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "usage-reservation-" + tenantId,
    ]);
    const number = await dbPool.query(
      `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, whatsappNumberId, "+15550000009"],
    );
    const message = await persistInboundMessage({
      tenantId,
      whatsappNumberId: number.rows[0].id,
      waId,
      profileName: "Reservation fencing test",
      whatsappMessageId,
      messageType: "text",
      body: "Test AI reservation ownership",
      receivedAt: new Date(),
    });

    return { tenantId, numberId: number.rows[0].id, whatsappNumberId, waId, whatsappMessageId, message };
  }

  async function reserveFor(seed) {
    return reserveAiUsage({
      tenantId: seed.tenantId,
      conversationId: seed.message.conversationId,
      messageId: seed.message.messageId,
      whatsappMessageId: seed.whatsappMessageId,
      type: "ai_message",
    });
  }

  it("prevents a second worker releasing another reservation and fences retries after lease expiry", async () => {
    const seed = await seedMessage();
    const first = await reserveFor(seed);
    assert.equal(first.allowed, true);
    assert.equal(first.duplicate, false);
    assert.ok(first.reservationToken);
    assert.equal(first.eventKey, "ai_message:" + seed.whatsappMessageId);

    const concurrent = await reserveFor(seed);
    assert.equal(concurrent.allowed, true);
    assert.equal(concurrent.inProgress, true);
    assert.equal(concurrent.reservationToken, undefined);

    const wrongOwner = await releaseAiUsage({
      tenantId: seed.tenantId,
      eventKey: first.eventKey,
      reservationToken: randomUUID(),
      type: "ai_message",
    });
    assert.equal(wrongOwner.released, false);

    await dbPool.query(
      "UPDATE usage_events SET reservation_lease_until=NOW()-INTERVAL '1 second' WHERE tenant_id=$1 AND event_key=$2",
      [seed.tenantId, first.eventKey],
    );
    const reclaimed = await reserveFor(seed);
    assert.equal(reclaimed.allowed, true);
    assert.equal(reclaimed.reclaimed, true);
    assert.ok(reclaimed.reservationToken);
    assert.notEqual(reclaimed.reservationToken, first.reservationToken);

    const staleOwner = await releaseAiUsage({
      tenantId: seed.tenantId,
      eventKey: first.eventKey,
      reservationToken: first.reservationToken,
      type: "ai_message",
    });
    assert.equal(staleOwner.released, false);

    const currentOwner = await releaseAiUsage({
      tenantId: seed.tenantId,
      eventKey: first.eventKey,
      reservationToken: reclaimed.reservationToken,
      type: "ai_message",
    });
    assert.equal(currentOwner.released, true);

    const rows = await dbPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE tenant_id=$1 AND event_key=$2",
      [seed.tenantId, first.eventKey],
    );
    assert.equal(rows.rows[0].count, 0);
  });

  it("committed successful usage cannot be released by the old owner token", async () => {
    const seed = await seedMessage();
    const reservation = await reserveFor(seed);
    assert.ok(reservation.reservationToken);

    const committed = await commitAiUsage({
      tenantId: seed.tenantId,
      eventKey: reservation.eventKey,
      reservationToken: reservation.reservationToken,
      type: "ai_message",
    });
    assert.equal(committed.committed, true);

    const release = await releaseAiUsage({
      tenantId: seed.tenantId,
      eventKey: reservation.eventKey,
      reservationToken: reservation.reservationToken,
      type: "ai_message",
    });
    assert.equal(release.released, false);

    const row = await dbPool.query(
      "SELECT reservation_status, reservation_token, reservation_lease_until FROM usage_events WHERE tenant_id=$1 AND event_key=$2",
      [seed.tenantId, reservation.eventKey],
    );
    assert.deepEqual(row.rows[0], {
      reservation_status: "committed",
      reservation_token: null,
      reservation_lease_until: null,
    });

    const retry = await reserveFor(seed);
    assert.equal(retry.allowed, true);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.committed, true);
    assert.equal(retry.reservationToken, undefined);
  });

  it("reconciles persisted Copilot/OCR outcomes and releases orphaned reservations", async () => {
    const seed = await seedMessage();
    const userId = randomUUID();
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'owner', 'active')`,
      [userId, seed.tenantId, `usage-reconcile-${userId}@example.test`, "test-only-password-hash"],
    );

    const copilot = await reserveAiUsage({
      tenantId: seed.tenantId,
      conversationId: seed.message.conversationId,
      type: "copilot_draft",
    });
    const ocr = await reserveAiUsage({ tenantId: seed.tenantId, type: "ocr_document" });
    assert.ok(copilot.reservationToken);
    assert.ok(ocr.reservationToken);

    await saveCopilotDraft(
      seed.tenantId,
      seed.message.conversationId,
      userId,
      "Recovered persisted draft",
      copilot.eventKey,
    );
    await dbPool.query(
      `INSERT INTO ocr_documents
         (tenant_id, filename, mime_type, extracted_text, model, created_by, usage_event_key)
       VALUES ($1, $2, 'application/pdf', $3, 'test-model', $4, $5)`,
      [seed.tenantId, "usage-reconcile.pdf", "Recognized text", userId, ocr.eventKey],
    );
    await dbPool.query(
      `UPDATE usage_events
       SET reservation_lease_until=NOW()-INTERVAL '1 second'
       WHERE tenant_id=$1 AND event_key IN ($2, $3)`,
      [seed.tenantId, copilot.eventKey, ocr.eventKey],
    );

    const finalized = await reconcileExpiredAiUsageReservations();
    assert.ok(finalized.committed >= 2);

    const committedRows = await dbPool.query(
      `SELECT event_key, reservation_status, reservation_token, reservation_lease_until
       FROM usage_events
       WHERE tenant_id=$1 AND event_key IN ($2, $3)
       ORDER BY event_key`,
      [seed.tenantId, copilot.eventKey, ocr.eventKey],
    );
    assert.equal(committedRows.rowCount, 2);
    assert.ok(committedRows.rows.every((row) =>
      row.reservation_status === "committed" &&
      row.reservation_token === null &&
      row.reservation_lease_until === null
    ));

    const orphanCopilot = await reserveAiUsage({
      tenantId: seed.tenantId,
      conversationId: seed.message.conversationId,
      type: "copilot_draft",
    });
    const orphanOcr = await reserveAiUsage({ tenantId: seed.tenantId, type: "ocr_document" });
    await dbPool.query(
      `UPDATE usage_events
       SET reservation_lease_until=NOW()-INTERVAL '1 second'
       WHERE tenant_id=$1 AND event_key IN ($2, $3)`,
      [seed.tenantId, orphanCopilot.eventKey, orphanOcr.eventKey],
    );
    const released = await reconcileExpiredAiUsageReservations();
    assert.ok(released.released >= 2);
    const orphanRows = await dbPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE tenant_id=$1 AND event_key IN ($2, $3)",
      [seed.tenantId, orphanCopilot.eventKey, orphanOcr.eventKey],
    );
    assert.equal(orphanRows.rows[0].count, 0);
  });

  it("releases expired AI reservations only when the durable message reached DEAD_LETTER without a response", async () => {
    const seed = await seedMessage();
    const inbox = await ingestWebhookMessage({
      message: {
        id: seed.whatsappMessageId,
        phoneNumberId: seed.whatsappNumberId,
        from: seed.waId,
        type: "text",
        text: { body: "Test AI reservation ownership" },
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
      tenant: {
        tenantId: seed.tenantId,
        whatsappNumberId: seed.numberId,
        phoneNumberId: seed.whatsappNumberId,
      },
    });
    assert.ok(inbox.id);

    const reservation = await reserveFor(seed);
    assert.ok(reservation.reservationToken);

    await dbPool.query(
      `UPDATE usage_events
       SET reservation_lease_until=NOW()-INTERVAL '1 second'
       WHERE tenant_id=$1 AND event_key=$2`,
      [seed.tenantId, reservation.eventKey],
    );
    await dbPool.query(
      `UPDATE webhook_messages
       SET state='DEAD_LETTER', generated_response=NULL, completed_at=NULL
       WHERE tenant_id=$1 AND whatsapp_message_id=$2`,
      [seed.tenantId, seed.whatsappMessageId],
    );

    const result = await reconcileExpiredAiUsageReservations();
    assert.ok(result.released >= 1);

    const remaining = await dbPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE tenant_id=$1 AND event_key=$2",
      [seed.tenantId, reservation.eventKey],
    );
    assert.equal(remaining.rows[0].count, 0);
  });
});
