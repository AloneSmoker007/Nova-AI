import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { after, before, describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Regression suite for the payment-webhook tenant-isolation security fix.
//
// Exercises the REAL application entry point (src/index.js) over real HTTP and
// a real PostgreSQL database. Proves the cross-tenant authentication hole is
// closed: each webhook is authenticated with the TARGET tenant's own signing key
// (PAYMENT_WEBHOOK_SECRETS JSON map), failing closed on missing/malformed/unknown
// configuration and never falling back to the legacy shared secret.
//
// Harness contracts borrowed from existing suites:
//   - tests/task16-route-behavior.test.js : real app import + HTTP
//   - tests/tenant-resolver.test.js       : real-PostgreSQL reset/migrate/seed
// ---------------------------------------------------------------------------

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

// Tenant UUIDs (satisfy payment.service.js UUID validator: version 1-5, variant 89ab).
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_TENANT = "33333333-3333-4333-8333-333333333333";

// Clearly-fake, high-entropy test secrets (>= 32 chars). Not real credentials.
const SECRET_A = `A_${"a1b2c3d4".repeat(8)}`; // 66 chars
const SECRET_B = `B_${"e5f6a7b8".repeat(8)}`; // 66 chars
const LEGACY_SECRET = `L_${"0f1e2d3c".repeat(8)}`; // 66 chars

const ALL_KEYS = JSON.stringify({ [TENANT_A]: SECRET_A, [TENANT_B]: SECRET_B });

function sign(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

let app;
let server;
let baseUrl;
let dbPool;
let runMigrations;
let stopBackgroundServices;

function fakeServer() {
  return {
    on() { return this; },
    once() { return this; },
    close(cb) { if (typeof cb === "function") cb(); return this; },
    address() { return { port: 0, address: "127.0.0.1", family: "IPv4" }; },
    unref() { return this; },
    ref() { return this; },
  };
}

before(async () => {
  // This hook is declared outside the skipped describe block, so return early
  // when the explicit PostgreSQL integration-test prerequisites are absent.
  // In particular, never import the app or access a null dbPool in the mocked
  // npm test suite, and never reset a database without MIGRATION_TEST_ALLOW_RESET=1.
  if (skip) return;

  // Set required env (dev-mode only warns otherwise) and the DB target BEFORE
  // any module import.
  process.env.DATABASE_URL = integrationUrl;
  process.env.GEMINI_API_KEY ||= "test-gemini-key";
  process.env.WEBHOOK_VERIFY_TOKEN ||= "test-verify-token";
  process.env.META_APP_SECRET ||= "test-meta-secret";
  process.env.CREDENTIAL_ENCRYPTION_KEY ||= "0".repeat(64);

  ({ runMigrations } = await import("../src/database/migrate.js"));
  ({ dbPool } = await import("../src/config/database.js"));

  // Reset the schema BEFORE importing the app: src/index.js runs
  // startServer() at module scope, which calls runMigrations() and
  // process.exit(1)s on failure — so the public schema must exist first.
  if (allowReset) {
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
  } else {
    const existing = await dbPool.query("SELECT to_regclass('public.schema_migrations') AS present");
    assert.equal(existing.rows[0].present, null, "needs a fresh database; set MIGRATION_TEST_ALLOW_RESET=1");
    await dbPool.query("CREATE SCHEMA IF NOT EXISTS public");
  }

  // Import the real composed app with its module-scope listen suppressed, and
  // keep it suppressed so startServer()'s app.listen(PORT) cannot bind a stray
  // port. Serve the real app ourselves via http.createServer(app).
  express.application.listen = function suppressed() { return fakeServer(); };
  const appModule = await import("../src/index.js");
  ({ default: app, stopBackgroundServices } = appModule);
  await appModule.appStartupPromise;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The migration chain is applied (startServer's runMigrations and/or ours are
  // serialized by the migrate advisory lock); awaiting ours guarantees the
  // schema is complete before seeding.
  const migrated = await runMigrations();
  assert.equal(migrated.configured, true, "the migration chain must apply");

  await dbPool.query(
    `INSERT INTO tenants (id, name, status) VALUES ($1,'Tenant A','active'), ($2,'Tenant B','active')`,
    [TENANT_A, TENANT_B],
  );
  await dbPool.query(
    `INSERT INTO payments (tenant_id, provider, provider_payment_id, amount_minor, currency, status) VALUES
       ($1,'stripe','pay-a-accept',   1000,'USD','pending'),
       ($1,'stripe','pay-a-replay',   1000,'USD','pending'),
       ($1,'stripe','pay-a-retention',1000,'USD','pending'),
       ($1,'stripe','pay-a-legal',    1000,'USD','pending'),
       ($1,'stripe','pay-a-illegal',  1000,'USD','paid'),
       ($1,'stripe','pay-a-mismatch', 1000,'USD','pending'),
       ($1,'stripe','pay-a-xtarget',  1000,'USD','pending'),
       ($2,'stripe','pay-b-target',   2000,'USD','pending'),
       ($2,'stripe','pay-b-check',    2000,'USD','pending'),
       ($2,'stripe','pay-b-xtarget',  2000,'USD','pending')`,
    [TENANT_A, TENANT_B],
  );
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  // The app starts its own queue worker, inbox recovery and retention work.
  // Release these before the shared DB pool, and close that pool only once.
  if (stopBackgroundServices) await stopBackgroundServices({ closeDatabase: true });
  else if (dbPool) await dbPool.end();
});

function rawJson(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function sendRaw(tenantId, raw, signatureHex) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", "Content-Length": raw.length };
    if (signatureHex) headers["x-nova-payment-signature"] = signatureHex;
    const req = http.request(`${baseUrl}/api/payments/webhook/${tenantId}`, { method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

// Sign bodyObj's exact JSON bytes with `secret` and POST to the given URL tenant.
function signedWebhook(tenantId, bodyObj, secret) {
  const raw = rawJson(bodyObj);
  return sendRaw(tenantId, raw, sign(secret, raw));
}

function paymentBody(tenantId, providerPaymentId, status, eventId) {
  return { tenantId, provider: "stripe", providerPaymentId, status, eventId };
}

async function paymentStatus(tenantId, providerPaymentId) {
  const r = await dbPool.query(
    "SELECT status FROM payments WHERE tenant_id=$1 AND provider='stripe' AND provider_payment_id=$2",
    [tenantId, providerPaymentId],
  );
  return r.rows[0]?.status ?? null;
}

async function eventCount(tenantId, eventId) {
  const r = await dbPool.query(
    "SELECT count(*)::int AS n FROM payment_webhook_events WHERE tenant_id=$1 AND provider='stripe' AND event_id=$2",
    [tenantId, eventId],
  );
  return r.rows[0].n;
}

async function eventKeyCount(tenantId, eventId) {
  const r = await dbPool.query(
    "SELECT count(*)::int AS n FROM payment_webhook_event_keys WHERE tenant_id=$1 AND provider='stripe' AND event_id=$2",
    [tenantId, eventId],
  );
  return r.rows[0].n;
}

describe("payment webhook tenant isolation (real app + PostgreSQL)", { skip }, () => {
  it("1. correctly signed event for Tenant A is accepted and mutates only Tenant A", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    const res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-accept-1"), SECRET_A);
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-accept"), "paid", "Tenant A payment must be marked paid");
    assert.equal(await paymentStatus(TENANT_B, "pay-b-check"), "pending", "Tenant B must be untouched");
  });

  it("2. Tenant A's key cannot authenticate an event targeting Tenant B", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    // Body + URL target Tenant B, but signed with Tenant A's key.
    const res = await signedWebhook(TENANT_B, paymentBody(TENANT_B, "pay-b-target", "paid", "evt-cross-b1"), SECRET_A);
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${res.body}`);
    assert.equal(await paymentStatus(TENANT_B, "pay-b-target"), "pending", "Tenant B payment must be unchanged");
    assert.equal(await eventCount(TENANT_B, "evt-cross-b1"), 0, "no unauthorized event record may be created");
  });

  it("3. Tenant B's key cannot authenticate an event targeting Tenant A", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    const res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-xtarget", "paid", "evt-cross-a1"), SECRET_B);
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${res.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-xtarget"), "pending", "Tenant A payment must be unchanged");
    assert.equal(await eventCount(TENANT_A, "evt-cross-a1"), 0, "no unauthorized event record may be created");
  });

  it("4. missing key, unknown tenant, invalid signature, malformed tenant id, malformed config all fail closed", async () => {
    // Unknown tenant (valid UUID, not configured).
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    let res = await signedWebhook(UNKNOWN_TENANT, paymentBody(UNKNOWN_TENANT, "pay-x", "paid", "evt-unk"), SECRET_A);
    assert.equal(res.status, 403, `unknown tenant -> 403, got ${res.status}`);

    // Missing key (Tenant A has no configured key).
    process.env.PAYMENT_WEBHOOK_SECRETS = JSON.stringify({ [TENANT_B]: SECRET_B });
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-miss"), SECRET_A);
    assert.equal(res.status, 403, `missing key -> 403, got ${res.status}`);

    // Invalid key (too short -> invalid config fails closed).
    process.env.PAYMENT_WEBHOOK_SECRETS = JSON.stringify({ [TENANT_A]: "short" });
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-short"), SECRET_A);
    assert.equal(res.status, 403, `short/invalid key -> 403, got ${res.status}`);

    // Invalid signature (correct key configured, wrong signature).
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-badsig"), SECRET_B);
    assert.equal(res.status, 403, `invalid signature -> 403, got ${res.status}`);

    // Malformed tenant identifier.
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    res = await sendRaw("not-a-uuid", rawJson(paymentBody("not-a-uuid", "pay-x", "paid", "evt-badtid")), sign(SECRET_A, rawJson(paymentBody("not-a-uuid", "pay-x", "paid", "evt-badtid"))));
    assert.equal(res.status, 403, `malformed tenant id -> 403, got ${res.status}`);

    // Malformed configuration: invalid JSON, and non-object JSON.
    process.env.PAYMENT_WEBHOOK_SECRETS = "{ this is not json";
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-badcfg1"), SECRET_A);
    assert.equal(res.status, 403, `malformed JSON config -> 403, got ${res.status}`);

    process.env.PAYMENT_WEBHOOK_SECRETS = "[1,2,3]";
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-badcfg2"), SECRET_A);
    assert.equal(res.status, 403, `array config -> 403, got ${res.status}`);

    // Absent config.
    delete process.env.PAYMENT_WEBHOOK_SECRETS;
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-nocfg"), SECRET_A);
    assert.equal(res.status, 403, `absent config -> 403, got ${res.status}`);
  });

  it("5. the legacy shared secret alone cannot authenticate the endpoint", async () => {
    // A per-tenant key exists, but the request is signed with the legacy secret.
    process.env.PAYMENT_WEBHOOK_SECRET = LEGACY_SECRET;
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    let res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-legacy1"), LEGACY_SECRET);
    assert.equal(res.status, 403, `legacy secret with per-tenant key configured -> 403, got ${res.status}`);

    // Even with NO per-tenant keys, the legacy secret must not authorize.
    process.env.PAYMENT_WEBHOOK_SECRETS = JSON.stringify({});
    res = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-legacy2"), LEGACY_SECRET);
    assert.equal(res.status, 403, `legacy secret with empty config -> 403, got ${res.status}`);
    assert.equal(await eventCount(TENANT_A, "evt-legacy1"), 0);
    assert.equal(await eventCount(TENANT_A, "evt-legacy2"), 0);
  });

  it("6. a body tenant different from the URL tenant is rejected", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    // URL is Tenant A and the signature is valid for A, but the body claims Tenant B.
    const res = await signedWebhook(TENANT_A, paymentBody(TENANT_B, "pay-a-mismatch", "paid", "evt-mismatch"), SECRET_A);
    assert.equal(res.status, 400, `body/URL tenant mismatch -> 400, got ${res.status} ${res.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-mismatch"), "pending", "no payment may be mutated");
    assert.equal(await eventCount(TENANT_A, "evt-mismatch"), 0, "no event record for a rejected request");
    assert.equal(await eventCount(TENANT_B, "evt-mismatch"), 0);
  });

  it("7. invalid, oversized, and malformed requests fail safely (never 404/500)", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    // Missing signature.
    let res = await sendRaw(TENANT_A, rawJson(paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-nosig")), undefined);
    assert.equal(res.status, 403, `no signature -> 403, got ${res.status}`);
    assert.doesNotMatch(res.body, /Route not found/, "must reach the webhook handler, not the terminal 404");

    // Malformed signature (not 64-hex).
    const raw = rawJson(paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-badfmt"));
    res = await sendRaw(TENANT_A, raw, "zz-not-hex");
    assert.equal(res.status, 403, `malformed signature -> 403, got ${res.status}`);

    // Oversized body (> 64KB) with a valid signature must still be rejected.
    const big = rawJson({ ...paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-big"), pad: "x".repeat(70 * 1024) });
    assert.ok(big.length > 64 * 1024, "oversized payload must exceed 64KB");
    res = await sendRaw(TENANT_A, big, sign(SECRET_A, big));
    assert.equal(res.status, 403, `oversized -> 403, got ${res.status}`);

    for (const r of [res]) {
      assert.notEqual(r.status, 404, "must not fall through to the terminal 404");
      assert.notEqual(r.status, 500, "must fail safely, not with a server error");
    }
  });

  it("8. replaying a previously accepted event does not apply the transition twice", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    const body = paymentBody(TENANT_A, "pay-a-replay", "paid", "evt-replay-1");
    const first = await signedWebhook(TENANT_A, body, SECRET_A);
    assert.equal(first.status, 200, `first application -> 200, got ${first.status} ${first.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-replay"), "paid");

    const second = await signedWebhook(TENANT_A, body, SECRET_A);
    assert.equal(second.status, 200, `replay -> 200 (idempotent), got ${second.status}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-replay"), "paid", "payment must not be re-applied");
    assert.equal(await eventCount(TENANT_A, "evt-replay-1"), 1, "exactly one event record for the idempotent event");
  });

  it("9. event dedupe survives detailed-event retention cleanup", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    const body = paymentBody(TENANT_A, "pay-a-retention", "paid", "evt-retention-long-lived");
    const first = await signedWebhook(TENANT_A, body, SECRET_A);
    assert.equal(first.status, 200, `initial event -> 200, got ${first.status} ${first.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-retention"), "paid");
    assert.equal(await eventCount(TENANT_A, "evt-retention-long-lived"), 1);
    assert.equal(await eventKeyCount(TENANT_A, "evt-retention-long-lived"), 1);

    // Simulate the normal 90-day detail-row retention deletion while preserving
    // the minimal idempotency tombstone. The same valid body/signature must not
    // re-apply a stale event after its detailed row is gone.
    await dbPool.query(
      "DELETE FROM payment_webhook_events WHERE tenant_id=$1 AND provider='stripe' AND event_id=$2",
      [TENANT_A, "evt-retention-long-lived"],
    );
    assert.equal(await eventCount(TENANT_A, "evt-retention-long-lived"), 0);
    assert.equal(await eventKeyCount(TENANT_A, "evt-retention-long-lived"), 1);

    const replay = await signedWebhook(TENANT_A, body, SECRET_A);
    assert.equal(replay.status, 200, `expired detail replay -> idempotent 200, got ${replay.status} ${replay.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-retention"), "paid");
    assert.equal(await eventCount(TENANT_A, "evt-retention-long-lived"), 0, "replay must not recreate expired detail data");
    assert.equal(await eventKeyCount(TENANT_A, "evt-retention-long-lived"), 1, "the permanent idempotency key must remain");
  });

  it("10. legal and illegal payment status transitions still behave correctly", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    // Legal: pending -> paid.
    const legal = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-legal", "paid", "evt-legal-1"), SECRET_A);
    assert.equal(legal.status, 200, `legal transition -> 200, got ${legal.status} ${legal.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-legal"), "paid");

    // Illegal: paid -> pending (pay-a-illegal is already 'paid').
    const illegal = await signedWebhook(TENANT_A, paymentBody(TENANT_A, "pay-a-illegal", "pending", "evt-illegal-1"), SECRET_A);
    assert.equal(illegal.status, 400, `illegal transition -> 400, got ${illegal.status} ${illegal.body}`);
    assert.equal(await paymentStatus(TENANT_A, "pay-a-illegal"), "paid", "illegal transition must not change the payment");
    assert.equal(await eventCount(TENANT_A, "evt-illegal-1"), 0, "rejected transition must not leave an event record");
  });

  it("11. the real app entry point reaches the webhook route (not the terminal 404)", async () => {
    process.env.PAYMENT_WEBHOOK_SECRETS = ALL_KEYS;
    const res = await sendRaw(TENANT_A, rawJson(paymentBody(TENANT_A, "pay-a-accept", "paid", "evt-reach")), undefined);
    assert.notEqual(res.status, 404, "the webhook route must be reachable");
    assert.doesNotMatch(res.body, /Route not found/, "must be answered by the webhook handler");
    assert.equal(res.status, 403, "the handler answers 403 for an unsigned request");
  });
});
