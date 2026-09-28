import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

const TENANT_A = "33333333-3333-4333-8333-333333333333";
const TENANT_B = "44444444-4444-4444-8444-444444444444";

// Canonical payment state machine. Only these single-step transitions are
// legal: nothing may skip pending -> ... -> paid -> refunded, and nothing may
// leave the terminal state refunded or walk backwards through paid.
const LEGAL = new Set([
  "pending>paid",
  "pending>failed",
  "pending>cancelled",
  "paid>refunded",
  "failed>pending",
  "cancelled>pending",
]);

function derivedDbUrl(base, suffix) {
  const match = /^(postgres(?:ql)?:\/\/[^/]+)\/(.+)$/.exec(base);
  assert.ok(match, "MIGRATION_TEST_DATABASE_URL must contain a database name");
  const server = match[1];
  const dbName = match[2].split("?")[0];
  assert.match(dbName, /^[a-z0-9_]+$/, "unexpected database name");
  const derived = `${dbName}_${suffix}`;
  assert.match(derived, /^[a-z0-9_]+$/);
  return { url: `${server}/${derived}`, name: derived, server };
}

async function ensureDatabase(server, name) {
  const admin = new pg.Client({ connectionString: `${server}/postgres` });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.end();
  }
}

describe("payment webhook idempotency, transitions, locking and tenant isolation", { skip }, () => {
  let runMigrations = null;
  let dbPool = null;
  let payment = null;
  const derived = derivedDbUrl(integrationUrl, "hooks");

  async function seedPayment(tenantId, externalId, status = "pending") {
    const r = await dbPool.query(
      `INSERT INTO payments (tenant_id, provider, provider_payment_id, amount_minor, currency, status, paid_at)
       VALUES ($1, 'stripe', $2, 1500, 'USD', $3, CASE WHEN $3 IN ('paid','refunded') THEN NOW() ELSE NULL END)
       RETURNING id, status, paid_at`,
      [tenantId, externalId, status],
    );
    return r.rows[0];
  }

  async function getPaymentRow(tenantId, externalId) {
    const r = await dbPool.query(
      "SELECT id, status, paid_at FROM payments WHERE tenant_id = $1 AND provider = 'stripe' AND provider_payment_id = $2",
      [tenantId, externalId],
    );
    return r.rows[0] || null;
  }

  async function eventRows(tenantId, eventId) {
    const r = await dbPool.query(
      "SELECT id, processed_at FROM payment_webhook_events WHERE tenant_id = $1 AND event_id = $2",
      [tenantId, eventId],
    );
    return r.rows;
  }

  function webhookEvent(tenantId, externalId, status, eventId) {
    return payment.applyPaymentWebhook({
      tenantId,
      provider: "stripe",
      providerPaymentId: externalId,
      status,
      eventId,
      signatureValid: true,
    });
  }

  before(async () => {
    process.env.DATABASE_URL = derived.url;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    payment = await import("../src/services/payment.service.js");

    await ensureDatabase(derived.server, derived.name);

    if (allowReset) {
      await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await dbPool.query("CREATE SCHEMA public");
    }

    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')", [
      TENANT_A,
      TENANT_B,
    ]);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  it("the legal status set is exactly the schema CHECK constraint vocabulary (019 + 021)", async () => {
    const defs = await dbPool.query(
      `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE contype = 'c'
         AND conname IN ('payments_status_check', 'payment_webhook_events_status_check')
       ORDER BY 1`,
    );
    const byTable = new Map(defs.rows.map((row) => [row.table_name, row.definition]));

    const expected = ["cancelled", "failed", "paid", "pending", "refunded"];
    for (const table of ["payments", "payment_webhook_events"]) {
      const definition = byTable.get(table) || "";
      assert.match(definition, /status/, `${table} status CHECK constraint is missing`);
      const statuses = [...definition.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]).sort();
      assert.deepEqual(statuses, expected, `${table} status CHECK vocabulary drifted`);
    }

    // The service must accept exactly that vocabulary everywhere.
    for (const status of expected) {
      await payment.listPayments(TENANT_A, { status });
    }
    await assert.rejects(() => payment.listPayments(TENANT_A, { status: "bogus" }), /Invalid payment status/);
    await assert.rejects(
      () => payment.updatePaymentStatus(TENANT_A, "11111111-1111-4111-8111-111111111111", "bogus"),
      /Invalid payment status/,
    );
    await assert.rejects(
      () => webhookEvent(TENANT_A, "missing-payment", "bogus", "evt_bogus_status"),
      /Invalid payment status/,
    );
  });

  it("enforces the full legal transition matrix and never skips or reverses illegally", async () => {
    const states = ["pending", "paid", "failed", "refunded", "cancelled"];
    let seed = 0;
    for (const from of states) {
      for (const to of states) {
        if (from === to) continue;
        seed += 1;
        const externalId = `pay_matrix_${from}_${to}`;
        await seedPayment(TENANT_A, externalId, from);
        const legal = LEGAL.has(`${from}>${to}`);
        const paymentId = (await getPaymentRow(TENANT_A, externalId)).id;
        if (legal) {
          const updated = await payment.updatePaymentStatus(TENANT_A, paymentId, to);
          assert.equal(updated.status, to, `${from} -> ${to} must be legal`);
          if (to === "paid") assert.ok(updated.paid_at, "paid_at must be stamped");
          if (from === "paid" && to === "refunded") assert.ok(updated.paid_at, "paid_at must survive a refund");
        } else {
          await assert.rejects(
            () => payment.updatePaymentStatus(TENANT_A, paymentId, to),
            /Invalid payment status transition/,
            `${from} -> ${to} must be rejected (illegal skip or reversal)`,
          );
          assert.equal(await paymentStatusOf(externalId), from, `${from} -> ${to} must not change state`);
        }
      }
    }

    // Same-state updates are idempotent no-ops (duplicate provider events).
    for (const state of states) {
      const externalId = `pay_matrix_noop_${state}`;
      await seedPayment(TENANT_A, externalId, state);
      const row = await getPaymentRow(TENANT_A, externalId);
      const updated = await payment.updatePaymentStatus(TENANT_A, row.id, state);
      assert.equal(updated.status, state);
    }

    async function paymentStatusOf(externalId) {
      return (await getPaymentRow(TENANT_A, externalId)).status;
    }
  });

  it("the webhook path enforces the same transition rules and keeps the event record only on success", async () => {
    await seedPayment(TENANT_A, "pay_hook_legal", "pending");
    const applied = await webhookEvent(TENANT_A, "pay_hook_legal", "paid", "evt_hook_legal_1");
    assert.equal(applied.status, "paid");

    // illegal reversal via webhook: rejected, state unchanged, no idempotency record
    await assert.rejects(
      () => webhookEvent(TENANT_A, "pay_hook_legal", "failed", "evt_hook_illegal_1"),
      /Invalid payment status transition/,
    );
    assert.equal((await getPaymentRow(TENANT_A, "pay_hook_legal")).status, "paid");
    assert.equal((await eventRows(TENANT_A, "evt_hook_illegal_1")).length, 0, "rejected events must roll back atomically");

    // illegal skip via webhook on a fresh payment
    await seedPayment(TENANT_A, "pay_hook_skip", "pending");
    await assert.rejects(
      () => webhookEvent(TENANT_A, "pay_hook_skip", "refunded", "evt_hook_skip_1"),
      /Invalid payment status transition/,
    );
    assert.equal((await getPaymentRow(TENANT_A, "pay_hook_skip")).status, "pending");
    assert.equal((await eventRows(TENANT_A, "evt_hook_skip_1")).length, 0);
  });

  it("a replayed webhook event is applied exactly once", async () => {
    await seedPayment(TENANT_A, "pay_replay", "pending");
    const first = await webhookEvent(TENANT_A, "pay_replay", "paid", "evt_replay_1");
    assert.equal(first.status, "paid");
    const paidAt = (await getPaymentRow(TENANT_A, "pay_replay")).paid_at;

    for (let i = 0; i < 3; i += 1) {
      const replay = await webhookEvent(TENANT_A, "pay_replay", "paid", "evt_replay_1");
      assert.equal(replay.duplicate, true);
    }

    const row = await getPaymentRow(TENANT_A, "pay_replay");
    assert.equal(row.status, "paid");
    assert.equal(row.paid_at?.toISOString(), paidAt?.toISOString(), "replays must not touch the payment");
    const events = await eventRows(TENANT_A, "evt_replay_1");
    assert.equal(events.length, 1, "exactly one idempotency record");
    assert.ok(events[0].processed_at, "the applied event must be marked processed");
  });

  it("two concurrent identical webhook events apply exactly one", async () => {
    for (let round = 0; round < 3; round += 1) {
      const externalId = `pay_conc_ident_${round}`;
      await seedPayment(TENANT_A, externalId, "pending");
      const eventId = `evt_conc_ident_${round}`;

      const results = await Promise.all([
        webhookEvent(TENANT_A, externalId, "paid", eventId),
        webhookEvent(TENANT_A, externalId, "paid", eventId),
      ]);

      const duplicates = results.filter((r) => r?.duplicate === true);
      const appliedRows = results.filter((r) => r && r.duplicate !== true && r.status === "paid");
      assert.equal(duplicates.length, 1, `round ${round}: exactly one duplicate`);
      assert.equal(appliedRows.length, 1, `round ${round}: exactly one applied`);
      assert.equal((await eventRows(TENANT_A, eventId)).length, 1);
      assert.equal((await getPaymentRow(TENANT_A, externalId)).status, "paid");
    }
  });

  it("concurrent conflicting transitions: the illegal one is rejected under the row lock", async () => {
    for (let round = 0; round < 3; round += 1) {
      const externalId = `pay_conc_conflict_${round}`;
      await seedPayment(TENANT_A, externalId, "paid");

      const settled = await Promise.allSettled([
        webhookEvent(TENANT_A, externalId, "refunded", `evt_conc_legal_${round}`),
        webhookEvent(TENANT_A, externalId, "failed", `evt_conc_illegal_${round}`),
      ]);

      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, `round ${round}: exactly one transition may apply`);
      assert.equal(rejected.length, 1, `round ${round}: the conflicting transition must be rejected`);
      assert.match(rejected[0].reason.message, /Invalid payment status transition/);
      assert.equal(fulfilled[0].value.status, "refunded", "the legal transition must win deterministically");
      assert.equal((await getPaymentRow(TENANT_A, externalId)).status, "refunded");
    }
  });

  it("updatePaymentStatus serializes concurrent transitions via FOR UPDATE", async () => {
    const seeded = await seedPayment(TENANT_A, "pay_conc_update", "pending");
    const settled = await Promise.allSettled([
      payment.updatePaymentStatus(TENANT_A, seeded.id, "paid"),
      payment.updatePaymentStatus(TENANT_A, seeded.id, "failed"),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent transition may win");
    assert.equal(rejected.length, 1, "the losing transition must see the new state and be rejected");
    assert.match(rejected[0].reason.message, /Invalid payment status transition/);
    const final = (await getPaymentRow(TENANT_A, "pay_conc_update")).status;
    assert.equal(final, fulfilled[0].value.status);
    assert.ok(final === "paid" || final === "failed");
  });

  it("state change and idempotency record are atomic (rejected events leave no trace)", async () => {
    await seedPayment(TENANT_A, "pay_atomic", "pending");

    // 'refunded' is illegal while pending: the whole transaction must roll back.
    await assert.rejects(
      () => webhookEvent(TENANT_A, "pay_atomic", "refunded", "evt_atomic_1"),
      /Invalid payment status transition/,
    );
    assert.equal((await eventRows(TENANT_A, "evt_atomic_1")).length, 0, "the idempotency insert must roll back too");
    assert.equal((await getPaymentRow(TENANT_A, "pay_atomic")).status, "pending");

    // Advance the payment so the very same event becomes legal, then retry it:
    // the earlier rejection must not have consumed the event id.
    const atomicId = (await getPaymentRow(TENANT_A, "pay_atomic")).id;
    const paid = await payment.updatePaymentStatus(TENANT_A, atomicId, "paid");
    assert.equal(paid.status, "paid");
    const applied = await webhookEvent(TENANT_A, "pay_atomic", "refunded", "evt_atomic_1");
    assert.equal(applied.status, "refunded");

    // And from now on the same event is a duplicate.
    const replay = await webhookEvent(TENANT_A, "pay_atomic", "refunded", "evt_atomic_1");
    assert.equal(replay.duplicate, true);
    assert.equal((await eventRows(TENANT_A, "evt_atomic_1")).length, 1);
  });

  it("a webhook event for tenant A can never be applied to tenant B's payment", async () => {
    await seedPayment(TENANT_B, "pay_cross_tenant", "pending");

    const result = await webhookEvent(TENANT_A, "pay_cross_tenant", "paid", "evt_cross_tenant_1");
    assert.equal(result, null, "tenant A has no such payment");
    assert.equal((await getPaymentRow(TENANT_B, "pay_cross_tenant")).status, "pending", "tenant B must not change");
    assert.equal((await eventRows(TENANT_A, "evt_cross_tenant_1")).length, 0);
    assert.equal((await eventRows(TENANT_B, "evt_cross_tenant_1")).length, 0);

    // Idempotency keys are tenant-scoped: the same event id may legitimately
    // exist once per tenant without colliding.
    await seedPayment(TENANT_A, "pay_same_evt_a", "pending");
    await seedPayment(TENANT_B, "pay_same_evt_b", "pending");
    const a = await webhookEvent(TENANT_A, "pay_same_evt_a", "paid", "evt_shared_id");
    const b = await webhookEvent(TENANT_B, "pay_same_evt_b", "paid", "evt_shared_id");
    assert.equal(a.status, "paid");
    assert.equal(b.status, "paid");
    assert.equal((await eventRows(TENANT_A, "evt_shared_id")).length, 1);
    assert.equal((await eventRows(TENANT_B, "evt_shared_id")).length, 1);
  });
});
