import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// P0-WS-A delivery reliability regression suite (real PostgreSQL).
//
// Gates exactly like tests/migration-postgres.test.js:
//   MIGRATION_TEST_DATABASE_URL + MIGRATION_TEST_ALLOW_RESET=1
//
// Covers the confirmed outbound-delivery defects:
//   1. attempt_count cap enforcement
//   2. duplicate WhatsApp send fan-out bound
//   3. lease-token fencing (stale workers cannot act)
//   4. compare-and-set on lease token + attempt
//   5. monotonic delivery states
//   6. stale-claim recovery races (live lease steal)
//   9. crash recovery / duplicate prevention end to end

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";

const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("WhatsApp delivery reliability (PostgreSQL)", { skip }, () => {
  let svc = null;
  let dbPool = null;
  let runMigrations = null;

  before(async () => {
    // config/database.js reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = integrationUrl;

    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    svc = await import("../src/services/whatsapp-delivery.service.js");

    assert.ok(dbPool, "dbPool must be configured from MIGRATION_TEST_DATABASE_URL");

    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const result = await runMigrations();
    assert.equal(result.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedDelivery() {
    const tenantId = randomUUID();
    const numberId = randomUUID();
    const contactId = randomUUID();
    const conversationId = randomUUID();
    const inboxId = randomUUID();
    const phoneNumberId = String(2000000000 + Math.floor(Math.random() * 999999999));

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      `ws-a-${tenantId}`,
    ]);
    await dbPool.query(
      "INSERT INTO whatsapp_numbers (id, tenant_id, phone_number_id) VALUES ($1, $2, $3)",
      [numberId, tenantId, phoneNumberId],
    );
    await dbPool.query("INSERT INTO contacts (id, tenant_id, wa_id) VALUES ($1, $2, $3)", [
      contactId,
      tenantId,
      "15550001111",
    ]);
    await dbPool.query(
      "INSERT INTO conversations (id, tenant_id, whatsapp_number_id, contact_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenantId, numberId, contactId],
    );
    await dbPool.query(
      `INSERT INTO webhook_messages
         (id, tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id, wa_id, body, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [inboxId, tenantId, numberId, phoneNumberId, `wamid.inbound.${inboxId}`, "15550001111", "hello"],
    );

    const delivery = await svc.prepareDelivery({
      tenantId,
      inboxMessageId: inboxId,
      conversationId,
      recipientWaId: "15550001111",
      body: "hello there",
    });

    return { tenantId, inboxId, conversationId, phoneNumberId, delivery };
  }

  // Time-warp: make the row fully stale (retry window elapsed AND lease expired).
  async function warpStale(deliveryId) {
    await dbPool.query(
      `UPDATE whatsapp_deliveries
       SET last_attempt_at = NOW() - INTERVAL '2 hours',
           lease_until = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [deliveryId],
    );
  }

  // Time-warp: retry window elapsed but the lease is still live.
  async function warpAttemptOnly(deliveryId) {
    await dbPool.query(
      `UPDATE whatsapp_deliveries
       SET last_attempt_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [deliveryId],
    );
  }

  it("exports a bounded delivery attempt maximum", () => {
    assert.equal(svc.MAX_DELIVERY_ATTEMPTS, 5);
  });

  it("attempt_count is capped: a delivery is claimable at most MAX times and reports exhausted", async () => {
    const { delivery, tenantId } = await seedDelivery();
    let claims = 0;
    let stopReason = null;

    for (let i = 0; i < 10; i++) {
      const claim = await svc.claimDelivery(delivery.id, tenantId);
      if (!claim.claimed) {
        stopReason = claim.reason;
        break;
      }
      claims += 1;
      // Simulated ambiguous send: the worker dies with an unknown outcome and
      // the delivery subsystem owns the retry.
      await svc.markDeliveryUnknown(
        delivery.id,
        tenantId,
        claim.leaseToken,
        new Error("simulated ambiguous send"),
        claim.delivery.attempt_count,
      );
      await warpStale(delivery.id);
    }

    assert.equal(claims, 5, "delivery must be claimable exactly MAX_DELIVERY_ATTEMPTS times");
    assert.equal(stopReason, "exhausted");

    const row = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(row.attempt_count, 5);
  });

  it("two concurrent claimers: exactly one wins, both on fresh and on stale rows", async () => {
    const { delivery, tenantId } = await seedDelivery();

    const first = await Promise.all([
      svc.claimDelivery(delivery.id, tenantId),
      svc.claimDelivery(delivery.id, tenantId),
    ]);
    assert.equal(
      first.filter((claim) => claim.claimed).length,
      1,
      "exactly one concurrent claimer may win a PENDING delivery",
    );

    await warpStale(delivery.id);
    const second = await Promise.all([
      svc.claimDelivery(delivery.id, tenantId),
      svc.claimDelivery(delivery.id, tenantId),
    ]);
    assert.equal(
      second.filter((claim) => claim.claimed).length,
      1,
      "exactly one concurrent claimer may win a stale SENDING delivery",
    );

    const row = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(row.attempt_count, 2, "each winning claim increments attempt_count exactly once");
  });

  it("a stale worker cannot act after a newer worker claimed (lease-token fencing)", async () => {
    const { delivery, tenantId } = await seedDelivery();

    const first = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(first.claimed, true);
    await warpStale(delivery.id);

    const second = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(second.claimed, true);
    assert.notEqual(second.leaseToken, first.leaseToken);

    // The stale worker (first lease) must not be able to act at all.
    await assert.rejects(
      () =>
        svc.markDeliverySent(
          delivery.id,
          tenantId,
          first.leaseToken,
          "wamid.stale-complete",
          first.delivery.attempt_count,
        ),
      /lease is no longer valid/,
    );
    assert.equal(
      await svc.markDeliveryFailed(
        delivery.id,
        tenantId,
        first.leaseToken,
        new Error("stale failure"),
        first.delivery.attempt_count,
      ),
      null,
    );
    assert.equal(
      await svc.markDeliveryUnknown(
        delivery.id,
        tenantId,
        first.leaseToken,
        new Error("stale unknown"),
        first.delivery.attempt_count,
      ),
      null,
    );

    const row = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(row.state, "SENDING", "the stale worker must not change the newer worker's state");
    assert.equal(row.lease_token, second.leaseToken);
    assert.equal(row.attempt_count, 2);

    // The current owner completes normally.
    const done = await svc.markDeliverySent(
      delivery.id,
      tenantId,
      second.leaseToken,
      "wamid.fresh-complete",
      second.delivery.attempt_count,
    );
    assert.equal(done.state, "SENT");
  });

  it("worker mutations are compare-and-set on lease token AND attempt", async () => {
    const { delivery, tenantId } = await seedDelivery();
    const claim = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(claim.claimed, true);

    const wrongAttempt = claim.delivery.attempt_count + 1;

    // A worker whose attempt view is stale must not complete the delivery.
    await assert.rejects(
      () =>
        svc.markDeliverySent(delivery.id, tenantId, claim.leaseToken, "wamid.cas-sent", wrongAttempt),
      /lease is no longer valid/,
    );
    assert.equal(
      await svc.markDeliveryFailed(
        delivery.id,
        tenantId,
        claim.leaseToken,
        new Error("cas fail"),
        wrongAttempt,
      ),
      null,
    );
    assert.equal(
      await svc.markDeliveryUnknown(
        delivery.id,
        tenantId,
        claim.leaseToken,
        new Error("cas unknown"),
        wrongAttempt,
      ),
      null,
    );

    const untouched = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(untouched.state, "SENDING");
    assert.equal(untouched.provider_message_id, null);

    // The exact claim (lease token + attempt) is accepted.
    const done = await svc.markDeliverySent(
      delivery.id,
      tenantId,
      claim.leaseToken,
      "wamid.cas-ok",
      claim.delivery.attempt_count,
    );
    assert.equal(done.state, "SENT");
  });

  it("a live lease cannot be stolen even when the retry window elapsed", async () => {
    const { delivery, tenantId } = await seedDelivery();
    const first = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(first.claimed, true);
    assert.ok(first.delivery.lease_until, "claim must set a lease deadline");

    // Retry window elapsed but the lease is still valid: the worker is alive.
    await warpAttemptOnly(delivery.id);

    const steal = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(steal.claimed, false, "an unexpired lease must never be re-claimable");
    assert.equal(steal.reason, "in_flight");

    // Once the lease genuinely expires, recovery reclaims exactly once.
    await warpStale(delivery.id);
    const recovered = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.delivery.attempt_count, 2);
  });

  it("states are monotonic: sent never regresses to failed/pending and failed never resurrects", async () => {
    const sent = await seedDelivery();
    const sentClaim = await svc.claimDelivery(sent.delivery.id, sent.tenantId);
    const sentRow = await svc.markDeliverySent(
      sent.delivery.id,
      sent.tenantId,
      sentClaim.leaseToken,
      "wamid.mono-1",
      sentClaim.delivery.attempt_count,
    );
    assert.equal(sentRow.state, "SENT");

    // A late/rogue "failed" status callback must not regress SENT.
    const afterFailed = await svc.markDeliveryStatus({
      tenantId: sent.tenantId,
      phoneNumberId: sent.phoneNumberId,
      providerMessageId: "wamid.mono-1",
      callbackData: sent.delivery.delivery_key,
      status: "failed",
      timestamp: Math.floor(Date.now() / 1000),
      errors: [{ code: 1, title: "late failure" }],
    });
    assert.equal(afterFailed.state, "SENT", "SENT must never regress to FAILED");
    assert.equal(afterFailed.error_code, null, "a regressive failure must not write error fields");

    // Forward progress still works: sent -> delivered -> read.
    const afterDelivered = await svc.markDeliveryStatus({
      tenantId: sent.tenantId,
      phoneNumberId: sent.phoneNumberId,
      providerMessageId: "wamid.mono-1",
      callbackData: sent.delivery.delivery_key,
      status: "delivered",
      timestamp: Math.floor(Date.now() / 1000),
    });
    assert.equal(afterDelivered.state, "DELIVERED");

    // DELIVERED must never regress to FAILED either.
    const deliveredRegression = await svc.markDeliveryStatus({
      tenantId: sent.tenantId,
      phoneNumberId: sent.phoneNumberId,
      providerMessageId: "wamid.mono-1",
      callbackData: sent.delivery.delivery_key,
      status: "failed",
      timestamp: Math.floor(Date.now() / 1000),
      errors: [{ code: 2, title: "late failure 2" }],
    });
    assert.equal(deliveredRegression.state, "DELIVERED");

    // FAILED is absorbing: it must never resurrect to sent.
    const failed = await seedDelivery();
    const failedClaim = await svc.claimDelivery(failed.delivery.id, failed.tenantId);
    await svc.markDeliveryFailed(
      failed.delivery.id,
      failed.tenantId,
      failedClaim.leaseToken,
      new Error("definitive failure"),
      failedClaim.delivery.attempt_count,
    );
    const resurrect = await svc.markDeliveryStatus({
      tenantId: failed.tenantId,
      phoneNumberId: failed.phoneNumberId,
      providerMessageId: "wamid.mono-2",
      callbackData: failed.delivery.delivery_key,
      status: "sent",
      timestamp: Math.floor(Date.now() / 1000),
    });
    assert.equal(resurrect.state, "FAILED", "FAILED must never resurrect to sent");

    // A SENT delivery must never be claimable again.
    const requeue = await svc.claimDelivery(sent.delivery.id, sent.tenantId);
    assert.equal(requeue.claimed, false);
    assert.equal(requeue.reason, "completed");
  });

  it("an exhausted delivery is finalized as FAILED and leaves the recovery scan", async () => {
    const { delivery, tenantId } = await seedDelivery();

    for (let i = 0; i < 5; i++) {
      const claim = await svc.claimDelivery(delivery.id, tenantId);
      assert.equal(claim.claimed, true);
      await svc.markDeliveryUnknown(
        delivery.id,
        tenantId,
        claim.leaseToken,
        new Error("simulated ambiguous send"),
        claim.delivery.attempt_count,
      );
      await warpStale(delivery.id);
    }

    const finalized = await svc.failExhaustedDeliveries(50);
    assert.ok(
      finalized.some((row) => row.id === delivery.id),
      "the exhausted delivery must be finalized",
    );

    const row = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(row.state, "FAILED");
    assert.equal(row.attempt_count, 5);

    const recoverable = await svc.findRecoverableDeliveries(50);
    assert.ok(
      !recoverable.some((row2) => row2.id === delivery.id),
      "an exhausted delivery must not appear in the recovery scan",
    );

    const claim = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "failed");
  });

  it("crash recovery and duplicate prevention end to end", async () => {
    const { delivery, tenantId, inboxId, conversationId } = await seedDelivery();

    // Attempt 1: the worker claims and crashes before recording anything.
    const first = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(first.claimed, true);
    assert.equal(first.delivery.attempt_count, 1);

    // Duplicate webhook re-ingest must not create a second delivery row.
    const duplicate = await svc.prepareDelivery({
      tenantId,
      inboxMessageId: inboxId,
      conversationId,
      recipientWaId: "15550001111",
      body: "hello there",
    });
    assert.equal(duplicate.id, delivery.id, "duplicate prepare must reuse the delivery row");

    // While the lease is live nobody else may act on it.
    const busy = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(busy.claimed, false);

    // Crash recovery: once stale, the recovery scan finds it and re-claims once.
    await warpStale(delivery.id);
    const recoverable = await svc.findRecoverableDeliveries(50);
    assert.ok(recoverable.some((row) => row.id === delivery.id));

    const second = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(second.claimed, true);
    assert.equal(second.delivery.attempt_count, 2);

    const done = await svc.markDeliverySent(
      delivery.id,
      tenantId,
      second.leaseToken,
      "wamid.recovered-1",
      second.delivery.attempt_count,
    );
    assert.equal(done.state, "SENT");
    assert.equal(done.provider_message_id, "wamid.recovered-1");

    // After the send is recorded there must be no further sends, ever.
    const after = await svc.findRecoverableDeliveries(50);
    assert.ok(!after.some((row) => row.id === delivery.id));
    const third = await svc.claimDelivery(delivery.id, tenantId);
    assert.equal(third.claimed, false);
    assert.equal(third.reason, "completed");

    const row = await svc.getDelivery(delivery.id, tenantId);
    assert.equal(row.attempt_count, 2);
    assert.equal(row.provider_message_id, "wamid.recovered-1");
  });
});
