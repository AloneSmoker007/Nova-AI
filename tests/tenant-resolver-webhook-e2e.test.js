import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * P0-1 regression, webhook end-to-end leg:
 * the real `POST /webhook` inbound path must reach
 * `resolveTenantByPhoneNumberId` successfully and durably ingest the message
 * for the CORRECT tenant — against a real PostgreSQL with the real migration
 * chain and the real server process (no mocks of database behavior).
 *
 * Run (dedicated database; the server process applies migrations on boot):
 *
 *   WEBHOOK_E2E_TEST_DATABASE_URL=postgresql://user@host:5432/nova_webhook_e2e \
 *   MIGRATION_TEST_ALLOW_RESET=1 \
 *   node --test tests/tenant-resolver-webhook-e2e.test.js
 *
 * WEBHOOK_E2E_TEST_DATABASE_URL falls back to MIGRATION_TEST_DATABASE_URL.
 */

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, "..");

const integrationUrl =
  process.env.WEBHOOK_E2E_TEST_DATABASE_URL ||
  process.env.MIGRATION_TEST_DATABASE_URL ||
  "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";

const skip = integrationUrl
  ? false
  : "Set WEBHOOK_E2E_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("static guard: resolver query references only migrated columns", () => {
  it("never selects whatsapp_numbers.phone_number or tenants.slug", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/services/tenant.service.js"),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /wn\.phone_number\b/,
      "whatsapp_numbers.phone_number does not exist in any migration; use display_phone_number",
    );
    assert.doesNotMatch(
      source,
      /t\.slug\b/,
      "tenants.slug does not exist in any migration; do not select it",
    );
  });
});

describe("webhook inbound path resolves tenants against real PostgreSQL", { skip }, () => {
  let db = null;
  let child = null;
  let baseUrl = "";

  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NUMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const NUMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const PHONE_NUMBER_ID_A = "111111111111111";
  const PHONE_NUMBER_ID_B = "222222222222222";
  const UNKNOWN_PHONE_NUMBER_ID = "999999999999999";

  const META_APP_SECRET = "webhook-e2e-test-secret";
  const WEBHOOK_VERIFY_TOKEN = "webhook-e2e-verify-token";
  const CREDENTIAL_KEY = crypto.randomBytes(32).toString("base64");

  function webhookBody(phoneNumberId, messageId, text) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: "E2E Customer" }, wa_id: "15550001234" }],
                messages: [
                  {
                    from: "15550001234",
                    id: messageId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  function signedFetch(body) {
    const payload = JSON.stringify(body);
    const signature =
      "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(payload).digest("hex");
    return fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
  }

  async function waitForServer(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) return;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`server did not become healthy on port ${port} within ${timeoutMs}ms`);
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  }

  before(async () => {
    db = new Client({ connectionString: integrationUrl });
    await db.connect();

    if (allowReset) {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
    } else {
      const existing = await db.query(
        "SELECT to_regclass('public.schema_migrations') AS present",
      );
      assert.equal(
        existing.rows[0].present,
        null,
        "this test needs a fresh database; set MIGRATION_TEST_ALLOW_RESET=1 to reset it",
      );
    }

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Boot the real server. It applies the full migration chain on startup
    // (startServer runs runMigrations when DATABASE_URL is set).
    child = spawn(process.execPath, [path.join(repoRoot, "src/bootstrap.js")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: integrationUrl,
        PORT: String(port),
        NODE_ENV: "development",
        GEMINI_API_KEY: "webhook-e2e-dummy-key",
        WEBHOOK_VERIFY_TOKEN,
        META_APP_SECRET,
        CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY,
        JWT_SECRET: "webhook-e2e-jwt-secret",
        // no REDIS_URL on purpose: the durable inbox dispatch falls back to
        // inline processing, which must not affect webhook ingestion results.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});

    await waitForServer(port);

    // Seed two tenants so cross-resolution can be disproved.
    await db.query("INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')", [
      TENANT_A,
      "webhook-e2e-a",
    ]);
    await db.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, status)
       VALUES ($1, $2, $3, '+15550000001', 'Nova A', 'active')`,
      [NUMBER_A, TENANT_A, PHONE_NUMBER_ID_A],
    );
    await db.query("INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')", [
      TENANT_B,
      "webhook-e2e-b",
    ]);
    await db.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, status)
       VALUES ($1, $2, $3, '+15550000002', 'Nova B', 'active')`,
      [NUMBER_B, TENANT_B, PHONE_NUMBER_ID_B],
    );
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (db) {
      await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
        [TENANT_A, TENANT_B],
      ]);
      await db.end();
    }
  });

  it("rejects a webhook with an invalid Meta signature before any processing", async () => {
    const payload = JSON.stringify(webhookBody(PHONE_NUMBER_ID_A, "wamid.e2e.bad", "hi"));
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body: payload,
    });
    assert.equal(res.status, 403);
  });

  it("webhook/inbound path reaches the resolver and durably ingests for tenant A", async () => {
    const res = await signedFetch(
      webhookBody(PHONE_NUMBER_ID_A, "wamid.e2e.message.a1", "hello from customer"),
    );
    assert.equal(res.status, 200);

    const stored = await db.query(
      "SELECT tenant_id, whatsapp_number_id, phone_number_id, body FROM webhook_messages WHERE whatsapp_message_id = $1",
      ["wamid.e2e.message.a1"],
    );
    assert.equal(stored.rows.length, 1, "message must be durably ingested");
    assert.equal(stored.rows[0].tenant_id, TENANT_A);
    assert.equal(stored.rows[0].whatsapp_number_id, NUMBER_A);
    assert.equal(stored.rows[0].phone_number_id, PHONE_NUMBER_ID_A);
    assert.equal(stored.rows[0].body, "hello from customer");
  });

  it("tenant A's phone_number_id never resolves to tenant B (and vice versa)", async () => {
    const res = await signedFetch(
      webhookBody(PHONE_NUMBER_ID_B, "wamid.e2e.message.b1", "hello from other customer"),
    );
    assert.equal(res.status, 200);

    const stored = await db.query(
      "SELECT tenant_id, whatsapp_number_id FROM webhook_messages WHERE whatsapp_message_id = $1",
      ["wamid.e2e.message.b1"],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].tenant_id, TENANT_B);
    assert.equal(stored.rows[0].whatsapp_number_id, NUMBER_B);

    const leak = await db.query(
      "SELECT COUNT(*)::int AS n FROM webhook_messages WHERE phone_number_id = $1 AND tenant_id = $2",
      [PHONE_NUMBER_ID_A, TENANT_B],
    );
    assert.equal(leak.rows[0].n, 0, "tenant A traffic must never land under tenant B");
  });

  it("unknown phone_number_id fails safely: 200 to Meta, nothing ingested", async () => {
    const res = await signedFetch(
      webhookBody(UNKNOWN_PHONE_NUMBER_ID, "wamid.e2e.message.unknown", "ghost message"),
    );
    assert.equal(res.status, 200);

    const stored = await db.query(
      "SELECT COUNT(*)::int AS n FROM webhook_messages WHERE whatsapp_message_id = $1",
      ["wamid.e2e.message.unknown"],
    );
    assert.equal(stored.rows[0].n, 0, "unknown phone_number_id must not create rows");
  });

  it("replays are idempotent at the durable inbox (no duplicate rows)", async () => {
    const res = await signedFetch(
      webhookBody(PHONE_NUMBER_ID_A, "wamid.e2e.message.a1", "hello from customer"),
    );
    assert.equal(res.status, 200);

    const stored = await db.query(
      "SELECT COUNT(*)::int AS n FROM webhook_messages WHERE whatsapp_message_id = $1",
      ["wamid.e2e.message.a1"],
    );
    assert.equal(stored.rows[0].n, 1, "replayed message must not duplicate");
  });
});
