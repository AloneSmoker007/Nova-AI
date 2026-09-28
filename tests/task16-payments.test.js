import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import express from "express";
import pg from "pg";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, "..");

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SECRET_A = "tenant-a-payment-webhook-secret";
const SECRET_B = "tenant-b-payment-webhook-secret";

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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sign(secret, raw) {
  return crypto.createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex");
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

describe("Task16 payments/OCR routes and payment webhook security", { skip }, () => {
  let runMigrations = null;
  let dbPool = null;
  let child = null;
  let childOutput = "";
  let childBase = "";
  let localBase = "";
  let localServer = null;
  let ownerToken = "";
  const derived = derivedDbUrl(integrationUrl, "task16");

  async function seedPayment(tenantId, externalId, status = "pending") {
    const r = await dbPool.query(
      `INSERT INTO payments (tenant_id, provider, provider_payment_id, amount_minor, currency, status)
       VALUES ($1, 'stripe', $2, 1500, 'USD', $3) RETURNING id`,
      [tenantId, externalId, status],
    );
    return r.rows[0].id;
  }

  async function paymentStatus(tenantId, externalId) {
    const r = await dbPool.query(
      "SELECT status FROM payments WHERE tenant_id = $1 AND provider = 'stripe' AND provider_payment_id = $2",
      [tenantId, externalId],
    );
    return r.rows[0]?.status ?? null;
  }

  async function eventCount(tenantId, eventId) {
    const r = await dbPool.query(
      "SELECT count(*)::int AS count FROM payment_webhook_events WHERE tenant_id = $1 AND event_id = $2",
      [tenantId, eventId],
    );
    return r.rows[0].count;
  }

  function webhookCall(base, urlTenant, bodyObj, secret) {
    const raw = JSON.stringify(bodyObj);
    return fetch(`${base}/api/payments/webhook/${urlTenant}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nova-payment-signature": secret ? sign(secret, raw) : "",
      },
      body: raw,
    });
  }

  before(async () => {
    process.env.DATABASE_URL = derived.url;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));

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
    await dbPool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, status)
       VALUES ($1, 'owner-a@example.com', $2, 'owner', 'active')`,
      [TENANT_A, bcrypt.hashSync("Sup3r-secret-pass!", 4)],
    );

    // The spawned real entrypoint and the in-process app see the same env:
    // PAYMENT_WEBHOOK_SECRET is the legacy shared secret (still present so the
    // pre-fix code path can be exercised) and PAYMENT_WEBHOOK_SECRETS is the
    // per-tenant secret map.
    const childEnv = {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: derived.url,
      GEMINI_API_KEY: "test-gemini-key",
      WEBHOOK_VERIFY_TOKEN: "test-verify-token",
      META_APP_SECRET: "test-meta-secret",
      CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789abcdef",
      PAYMENT_WEBHOOK_SECRET: SECRET_A,
      PAYMENT_WEBHOOK_SECRETS: JSON.stringify({ [TENANT_A]: SECRET_A, [TENANT_B]: SECRET_B }),
    };
    process.env.PAYMENT_WEBHOOK_SECRET = childEnv.PAYMENT_WEBHOOK_SECRET;
    process.env.PAYMENT_WEBHOOK_SECRETS = childEnv.PAYMENT_WEBHOOK_SECRETS;

    // --- real entrypoint (src/bootstrap.js) on its own port ---
    const port = await getFreePort();
    childBase = `http://127.0.0.1:${port}`;
    childEnv.PORT = String(port);
    child = spawn(process.execPath, ["src/bootstrap.js"], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      childOutput += d;
    });
    child.stderr.on("data", (d) => {
      childOutput += d;
    });

    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`${childBase}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, `real entrypoint did not become ready. output:\n${childOutput}`);

    // --- in-process app with ONLY the Task16 routes mounted (isolates the
    //     webhook authentication behaviour from the route-ordering defect) ---
    const { registerTask16Routes } = await import("../src/task16.routes.js");
    const localApp = express();
    localApp.use(
      express.json({
        limit: "100kb",
        verify: (req, res, buffer) => {
          req.rawBody = Buffer.from(buffer);
        },
      }),
    );
    registerTask16Routes(localApp);
    localServer = await new Promise((resolve) => {
      const srv = localApp.listen(0, "127.0.0.1", () => resolve(srv));
    });
    localBase = `http://127.0.0.1:${localServer.address().port}`;

    // --- login for the authenticated API round trip ---
    const loginRes = await fetch(`${childBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner-a@example.com", password: "Sup3r-secret-pass!" }),
    });
    const loginBody = await readJson(loginRes);
    assert.equal(loginRes.status, 200, `login failed: ${JSON.stringify(loginBody)}`);
    ownerToken = loginBody.token;
  });

  after(async () => {
    if (localServer) await new Promise((r) => localServer.close(r));
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    if (dbPool) await dbPool.end();
  });

  it("GET /api/payments/:paymentId is reachable (401 without auth, not the terminal 404)", async () => {
    const res = await fetch(`${childBase}/api/payments/11111111-1111-4111-8111-1111111111a1`);
    const body = await readJson(res);
    assert.notEqual(res.status, 404, "route is shadowed by the terminal 404 handler");
    assert.notEqual(body?.message, "Route not found");
    assert.equal(res.status, 401);
  });

  it("POST /api/payments is reachable (401 without auth, not the terminal 404)", async () => {
    const res = await fetch(`${childBase}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 404, "route is shadowed by the terminal 404 handler");
    assert.equal(res.status, 401);
  });

  it("PATCH /api/payments/:paymentId/status is reachable (401 without auth)", async () => {
    const res = await fetch(`${childBase}/api/payments/11111111-1111-4111-8111-1111111111a1/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    assert.notEqual(res.status, 404, "route is shadowed by the terminal 404 handler");
    assert.equal(res.status, 401);
  });

  it("POST /api/payments/webhook/:tenantId is reachable (403 unsigned, not the terminal 404)", async () => {
    const res = await webhookCall(childBase, TENANT_A, { tenantId: TENANT_A }, null);
    assert.notEqual(res.status, 404, "webhook route is shadowed by the terminal 404 handler");
    assert.equal(res.status, 403);
  });

  it("OCR routes are reachable (401 without auth, not the terminal 404)", async () => {
    for (const [method, url, body] of [
      ["GET", `${childBase}/api/ocr/documents`, null],
      ["GET", `${childBase}/api/ocr/documents/11111111-1111-4111-8111-1111111111a1`, null],
      ["POST", `${childBase}/api/ocr/extract`, ""],
    ]) {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body,
      });
      assert.notEqual(res.status, 404, `${method} ${url} is shadowed by the terminal 404 handler`);
      assert.equal(res.status, 401);
    }
  });

  it("payment API round trip: create, read, list and legal status updates work", async () => {
    const auth = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };

    const createRes = await fetch(`${childBase}/api/payments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        provider: "stripe",
        providerPaymentId: "pay_roundtrip_1",
        amountMinor: 1500,
        currency: "USD",
        customerName: "Acme",
        description: "round trip",
      }),
    });
    const createBody = await readJson(createRes);
    assert.equal(createRes.status, 201, JSON.stringify(createBody));
    const payment = createBody.data;
    assert.equal(payment.status, "pending");

    const getRes = await fetch(`${childBase}/api/payments/${payment.id}`, { headers: auth });
    const getBody = await readJson(getRes);
    assert.equal(getRes.status, 200);
    assert.equal(getBody.data.provider_payment_id, "pay_roundtrip_1");

    const listRes = await fetch(`${childBase}/api/payments?status=pending`, { headers: auth });
    const listBody = await readJson(listRes);
    assert.equal(listRes.status, 200);
    assert.ok(listBody.data.some((row) => row.id === payment.id));

    const paidRes = await fetch(`${childBase}/api/payments/${payment.id}/status`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "paid" }),
    });
    const paidBody = await readJson(paidRes);
    assert.equal(paidRes.status, 200);
    const paid = paidBody.data;
    assert.equal(paid.status, "paid");
    assert.ok(paid.paid_at, "paid_at must be stamped on the transition to paid");

    const refundedRes = await fetch(`${childBase}/api/payments/${payment.id}/status`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "refunded" }),
    });
    const refundedBody = await readJson(refundedRes);
    assert.equal(refundedRes.status, 200);
    assert.equal(refundedBody.data.status, "refunded");

    // refunded is terminal: reversing it must be rejected.
    const reverseRes = await fetch(`${childBase}/api/payments/${payment.id}/status`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "pending" }),
    });
    assert.equal(reverseRes.status, 400);
    assert.equal(await paymentStatus(TENANT_A, "pay_roundtrip_1"), "refunded");
  });

  it("SECURITY: a webhook authenticated for tenant A cannot create/mutate tenant B's payment (HTTP)", async () => {
    await seedPayment(TENANT_B, "pay_forge_http", "pending");
    const body = {
      tenantId: TENANT_B,
      provider: "stripe",
      providerPaymentId: "pay_forge_http",
      status: "paid",
      eventId: "evt_forge_http_1",
    };

    // Signed with tenant A's secret while claiming tenant B in body and URL.
    const res = await webhookCall(childBase, TENANT_B, body, SECRET_A);
    assert.equal(res.status, 403, "tenant A's credentials must not authenticate tenant B's events");
    assert.equal(await paymentStatus(TENANT_B, "pay_forge_http"), "pending", "tenant B's payment must not change");
    assert.equal(await eventCount(TENANT_B, "evt_forge_http_1"), 0, "no idempotency record may be written");
  });

  it("rejects a webhook whose body tenant disagrees with the URL tenant", async () => {
    await seedPayment(TENANT_B, "pay_mismatch", "pending");
    const body = {
      tenantId: TENANT_B,
      provider: "stripe",
      providerPaymentId: "pay_mismatch",
      status: "paid",
      eventId: "evt_mismatch_1",
    };
    const res = await webhookCall(childBase, TENANT_A, body, SECRET_A);
    assert.equal(res.status, 400);
    assert.equal(await paymentStatus(TENANT_B, "pay_mismatch"), "pending");
  });

  it("applies a correctly signed tenant A webhook exactly once and treats replays as duplicates", async () => {
    await seedPayment(TENANT_A, "pay_hook_ok", "pending");
    const body = {
      tenantId: TENANT_A,
      provider: "stripe",
      providerPaymentId: "pay_hook_ok",
      status: "paid",
      eventId: "evt_hook_ok_1",
    };

    const first = await webhookCall(childBase, TENANT_A, body, SECRET_A);
    const firstBody = await readJson(first);
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.data.status, "paid");
    assert.notEqual(firstBody.data.duplicate, true);

    const replay = await webhookCall(childBase, TENANT_A, body, SECRET_A);
    const replayBody = await readJson(replay);
    assert.equal(replay.status, 200);
    assert.equal(replayBody.data.duplicate, true);

    assert.equal(await paymentStatus(TENANT_A, "pay_hook_ok"), "paid");
    assert.equal(await eventCount(TENANT_A, "evt_hook_ok_1"), 1);
  });

  it("SECURITY: a webhook authenticated for tenant A cannot mutate tenant B's payment (mounted Task16 routes)", async () => {
    await seedPayment(TENANT_B, "pay_forge_local", "pending");
    const body = {
      tenantId: TENANT_B,
      provider: "stripe",
      providerPaymentId: "pay_forge_local",
      status: "paid",
      eventId: "evt_forge_local_1",
    };

    const res = await webhookCall(localBase, TENANT_B, body, SECRET_A);
    assert.equal(res.status, 403, "tenant A's signing secret must not verify tenant B's webhook");
    assert.equal(await paymentStatus(TENANT_B, "pay_forge_local"), "pending");
    assert.equal(await eventCount(TENANT_B, "evt_forge_local_1"), 0);
  });

  it("a webhook authenticated for tenant A still applies to tenant A's payment (mounted Task16 routes)", async () => {
    await seedPayment(TENANT_A, "pay_legit_local", "pending");
    const body = {
      tenantId: TENANT_A,
      provider: "stripe",
      providerPaymentId: "pay_legit_local",
      status: "paid",
      eventId: "evt_legit_local_1",
    };

    const res = await webhookCall(localBase, TENANT_A, body, SECRET_A);
    const resBody = await readJson(res);
    assert.equal(res.status, 200, JSON.stringify(resBody));
    assert.equal(await paymentStatus(TENANT_A, "pay_legit_local"), "paid");
    assert.equal(await eventCount(TENANT_A, "evt_legit_local_1"), 1);
  });
});
