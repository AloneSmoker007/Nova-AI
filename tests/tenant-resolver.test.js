import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDirectory, "..");
const tenantServicePath = path.resolve(repoRoot, "src/services/tenant.service.js");

// Real PostgreSQL integration, matching the harness contract used by
// tests/migration-postgres.test.js. Nothing here mocks the database: every
// assertion runs against a live server and the real migrated schema.
const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";

const skip = integrationUrl
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const TENANT_PAUSED = "33333333-3333-4333-8333-333333333333";

const NUMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NUMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NUMBER_A_DISABLED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NUMBER_PAUSED_TENANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const PHONE_A = "15550000001";
const PHONE_B = "15550000002";
const PHONE_A_DISABLED = "15550000003";
const PHONE_PAUSED_TENANT = "15550000004";

describe("Tenant resolver schema fix (A-5.15A-X-001)", { skip }, () => {
  let runMigrations = null;
  let dbPool = null;
  let resolveTenantByPhoneNumberId = null;

  before(async () => {
    // config/database.js reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = integrationUrl;

    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ resolveTenantByPhoneNumberId } = await import("../src/services/tenant.service.js"));

    assert.ok(dbPool, "dbPool must be configured from MIGRATION_TEST_DATABASE_URL");
    assert.equal(typeof resolveTenantByPhoneNumberId, "function");

    if (allowReset) {
      await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await dbPool.query("CREATE SCHEMA public");
    } else {
      const existing = await dbPool.query(
        "SELECT to_regclass('public.schema_migrations') AS present",
      );
      assert.equal(
        existing.rows[0].present,
        null,
        "this test needs a fresh database; set MIGRATION_TEST_ALLOW_RESET=1 to reset it",
      );
    }

    const result = await runMigrations();
    assert.equal(result.configured, true, "the full migration chain must apply cleanly");

    await dbPool.query(
      `INSERT INTO tenants (id, name, status) VALUES
         ($1, 'Tenant Alpha', 'active'),
         ($2, 'Tenant Beta',  'active'),
         ($3, 'Tenant Paused', 'paused')`,
      [TENANT_A, TENANT_B, TENANT_PAUSED],
    );

    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, access_token_encrypted, status)
       VALUES
         ($1, $5,  $8,  '+15550000001', 'Alpha Line', 'token-alpha',          'active'),
         ($2, $6,  $9,  '+15550000002', 'Beta Line',  'token-beta',           'active'),
         ($3, $5,  $10, '+15550000003', 'Alpha Old',  'token-alpha-disabled', 'disabled'),
         ($4, $7,  $11, '+15550000004', 'Paused Line','token-paused',         'active')`,
      [
        NUMBER_A,
        NUMBER_B,
        NUMBER_A_DISABLED,
        NUMBER_PAUSED_TENANT,
        TENANT_A,
        TENANT_B,
        TENANT_PAUSED,
        PHONE_A,
        PHONE_B,
        PHONE_A_DISABLED,
        PHONE_PAUSED_TENANT,
      ],
    );
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  describe("resolver against the real migrated schema", () => {
    it("resolves the owning tenant for a known active phone_number_id", async () => {
      const tenant = await resolveTenantByPhoneNumberId(PHONE_A);

      assert.ok(tenant, "a known active number must resolve");
      assert.equal(tenant.tenantId, TENANT_A);
      assert.equal(tenant.whatsappNumberId, NUMBER_A);
      assert.equal(tenant.phoneNumberId, PHONE_A);
      assert.equal(tenant.tenantName, "Tenant Alpha");
      assert.equal(tenant.displayName, "Alpha Line");
      assert.equal(tenant.accessTokenEncrypted, "token-alpha");
      assert.equal(
        tenant.phoneNumber,
        "+15550000001",
        "phoneNumber must be sourced from whatsapp_numbers.display_phone_number",
      );
    });

    it("resolves Tenant A and Tenant B to distinct tenants (no cross-tenant bleed)", async () => {
      const tenantA = await resolveTenantByPhoneNumberId(PHONE_A);
      const tenantB = await resolveTenantByPhoneNumberId(PHONE_B);

      assert.ok(tenantA && tenantB);
      assert.notEqual(tenantA.tenantId, tenantB.tenantId);
      assert.equal(tenantA.tenantId, TENANT_A);
      assert.equal(tenantB.tenantId, TENANT_B);
      assert.equal(tenantA.whatsappNumberId, NUMBER_A);
      assert.equal(tenantB.whatsappNumberId, NUMBER_B);
      assert.equal(tenantA.accessTokenEncrypted, "token-alpha");
      assert.equal(tenantB.accessTokenEncrypted, "token-beta");
    });

    it("never resolves one tenant's phone number to another tenant", async () => {
      const expected = [
        [PHONE_A, TENANT_A, NUMBER_A],
        [PHONE_B, TENANT_B, NUMBER_B],
      ];

      for (const [phone, wantTenantId, wantNumberId] of expected) {
        const tenant = await resolveTenantByPhoneNumberId(phone);
        assert.ok(tenant, `${phone} must resolve`);
        assert.equal(tenant.tenantId, wantTenantId, `${phone} must not resolve to another tenant`);
        assert.equal(tenant.whatsappNumberId, wantNumberId);
      }
    });

    it("returns null for an unknown phone_number_id", async () => {
      const tenant = await resolveTenantByPhoneNumberId("99999999999");
      assert.equal(tenant, null, "an unknown number must fail closed with null");
    });

    it("returns null for a deactivated whatsapp number", async () => {
      const tenant = await resolveTenantByPhoneNumberId(PHONE_A_DISABLED);
      assert.equal(tenant, null, "a non-active whatsapp_numbers.status must fail closed");
    });

    it("returns null when the owning tenant is not active", async () => {
      const tenant = await resolveTenantByPhoneNumberId(PHONE_PAUSED_TENANT);
      assert.equal(tenant, null, "a non-active tenants.status must fail closed");
    });

    it("rejects malformed phone_number_id input instead of querying with it", async () => {
      const hostile = [
        "' OR 1=1--",
        "15550000001' UNION SELECT 1--",
        "1; DROP TABLE tenants;--",
        "12345; SELECT pg_sleep(5)",
        "abc",
        "",
        "1234",
        "1".repeat(31),
        null,
        undefined,
        12345,
        {},
      ];

      for (const input of hostile) {
        const tenant = await resolveTenantByPhoneNumberId(input);
        assert.equal(
          tenant,
          null,
          `input ${String(input)} must be rejected, got ${JSON.stringify(tenant)}`,
        );
      }
    });

    it("prepares and runs the shipped resolver SQL with no undefined column", async () => {
      const source = await fs.readFile(tenantServicePath, "utf8");

      // Pull the exact SQL string out of the service so this assertion proves
      // the query that actually ships, instead of a re-typed copy that goes stale.
      const match = /dbPool\.query\(\s*`([\s\S]*?)`\s*,\s*\[\s*phoneNumberId\s*\],?\s*\)/.exec(source);
      assert.ok(match, "could not locate the resolver SQL in tenant.service.js");
      const sql = match[1];

      // PREPARE resolves every referenced column against the real catalog.
      // A nonexistent column raises 42703 here.
      const client = await dbPool.connect();
      try {
        await client.query("DEALLOCATE ALL");
        await client.query(`PREPARE tenant_resolver_schema_check(text) AS ${sql}`);
        await client.query("DEALLOCATE ALL");

        // Then execute the shipped statement for real against seeded data.
        const result = await client.query(sql, [PHONE_A]);
        assert.equal(result.rows.length, 1, "the shipped SQL must resolve exactly one row");
        assert.equal(result.rows[0].tenant_id, TENANT_A);
      } finally {
        client.release();
      }
    });

    it("selects only columns that exist in the migrated schema", async () => {
      const columns = async (table) => {
        const result = await dbPool.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        );
        return new Set(result.rows.map((row) => row.column_name));
      };

      const tenantColumns = await columns("tenants");
      const numberColumns = await columns("whatsapp_numbers");

      // The columns the fixed resolver relies on.
      for (const column of [
        "id",
        "tenant_id",
        "phone_number_id",
        "display_phone_number",
        "display_name",
        "access_token_encrypted",
        "status",
      ]) {
        assert.ok(numberColumns.has(column), `whatsapp_numbers.${column} must exist`);
      }
      for (const column of ["id", "name", "status"]) {
        assert.ok(tenantColumns.has(column), `tenants.${column} must exist`);
      }

      // The columns the pre-fix resolver wrongly assumed.
      assert.equal(numberColumns.has("phone_number"), false, "whatsapp_numbers.phone_number must not exist");
      assert.equal(tenantColumns.has("slug"), false, "tenants.slug must not exist");
    });

    it("keeps phone_number_id globally unique — the isolation invariant", async () => {
      // LIMIT 1 without ORDER BY is only safe because phone_number_id is
      // globally UNIQUE. Assert the invariant explicitly so a future migration
      // that drops it fails loudly instead of making resolution nondeterministic.
      const constraints = await dbPool.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'public.whatsapp_numbers'::regclass
            AND contype = 'u'`,
      );

      const coversPhoneNumberId = constraints.rows.find((row) =>
        /UNIQUE \(phone_number_id\)/.test(row.definition),
      );
      assert.ok(
        coversPhoneNumberId,
        `expected a UNIQUE (phone_number_id) constraint, saw ${JSON.stringify(constraints.rows.map((r) => r.definition))}`,
      );

      // Behavioural proof: a second tenant cannot claim Tenant A's number.
      const client = await dbPool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(
          client.query(
            `INSERT INTO whatsapp_numbers (id, tenant_id, phone_number_id)
             VALUES (gen_random_uuid(), $1, $2)`,
            [TENANT_B, PHONE_A],
          ),
          (error) => error.code === "23505",
          "Tenant B must not be able to claim Tenant A's phone_number_id",
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("no longer references the nonexistent columns in tenant.service.js", async () => {
      const source = await fs.readFile(tenantServicePath, "utf8");

      assert.doesNotMatch(source, /\bwn\.phone_number\b/, "wn.phone_number must not be referenced");
      assert.doesNotMatch(source, /\bt\.slug\b/, "t.slug must not be referenced");
      assert.doesNotMatch(source, /\btenant_slug\b/, "tenant_slug must not be referenced");
      assert.match(source, /wn\.display_phone_number/, "the real column must be selected");
      assert.match(source, /t\.status AS tenant_status/, "tenant status must still be selected");
    });
  });

  describe("inbound webhook path reaches the tenant resolver", () => {
    const WEBHOOK_SECRET = "test-meta-app-secret-0001";
    const PORT = Number(process.env.TENANT_RESOLVER_TEST_PORT || 55433);

    let child = null;
    const childOutput = [];

    const buildPayload = (phoneNumberId, messageId) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-TEST",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: "Test Contact" }, wa_id: "15551234567" }],
                messages: [
                  {
                    from: "15551234567",
                    id: messageId,
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello from the webhook test" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const sign = (payload) =>
      `sha256=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")}`;

    const postWebhook = async (phoneNumberId, messageId) => {
      const payload = buildPayload(phoneNumberId, messageId);
      const body = JSON.stringify(payload);
      return fetch(`http://127.0.0.1:${PORT}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
        body,
      });
    };

    const waitForServer = async (port, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const reachable = await new Promise((resolve) => {
          const socket = net.connect({ host: "127.0.0.1", port }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on("error", () => resolve(false));
          socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (reachable) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `server did not start listening on port ${port}\n--- server output ---\n${childOutput.join("")}`,
      );
    };

    before(async () => {
      child = spawn(process.execPath, ["src/bootstrap.js"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(PORT),
          DATABASE_URL: integrationUrl,
          META_APP_SECRET: WEBHOOK_SECRET,
          // Keep the test hermetic: no Redis worker, no outbound Gemini calls.
          REDIS_URL: "",
          GEMINI_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => childOutput.push(chunk.toString()));
      child.stderr.on("data", (chunk) => childOutput.push(chunk.toString()));

      await waitForServer(PORT);
    });

    after(() => {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    });

    it("ingests an inbound webhook under the owning tenant resolved from phone_number_id", async () => {
      const messageId = "wamid.TENANT-RESOLVER-TEST-A";
      const response = await postWebhook(PHONE_A, messageId);

      assert.equal(response.status, 200, "a valid signed webhook must be accepted");

      const stored = await dbPool.query(
        `SELECT tenant_id, whatsapp_number_id, phone_number_id, wa_id
           FROM webhook_messages
          WHERE whatsapp_message_id = $1`,
        [messageId],
      );

      assert.equal(stored.rows.length, 1, "the webhook must be durably ingested exactly once");
      assert.equal(stored.rows[0].tenant_id, TENANT_A, "must be ingested under the owning tenant");
      assert.equal(stored.rows[0].whatsapp_number_id, NUMBER_A);
      assert.equal(stored.rows[0].phone_number_id, PHONE_A);
      assert.equal(stored.rows[0].wa_id, "15551234567");
    });

    it("does not attribute a webhook to a different tenant", async () => {
      const messageId = "wamid.TENANT-RESOLVER-TEST-B";
      const response = await postWebhook(PHONE_B, messageId);

      assert.equal(response.status, 200);

      const stored = await dbPool.query(
        "SELECT tenant_id, whatsapp_number_id FROM webhook_messages WHERE whatsapp_message_id = $1",
        [messageId],
      );

      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].tenant_id, TENANT_B, "Tenant B's number must not resolve as Tenant A");
      assert.notEqual(stored.rows[0].tenant_id, TENANT_A);
      assert.equal(stored.rows[0].whatsapp_number_id, NUMBER_B);
    });

    it("drops an inbound webhook for an unknown phone_number_id without ingesting anything", async () => {
      const messageId = "wamid.TENANT-RESOLVER-TEST-UNKNOWN";
      // Meta expects 2xx for authentic-but-unprocessable traffic so it does not retry.
      const response = await postWebhook("99999999999", messageId);

      assert.equal(response.status, 200);

      const stored = await dbPool.query(
        "SELECT count(*)::int AS count FROM webhook_messages WHERE whatsapp_message_id = $1",
        [messageId],
      );
      assert.equal(stored.rows[0].count, 0, "an unknown number must not be ingested under any tenant");
    });

    it("rejects a webhook whose signature does not match", async () => {
      const payload = buildPayload(PHONE_A, "wamid.TENANT-RESOLVER-TEST-BADSIG");
      const body = JSON.stringify(payload);

      const response = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign("tampered") },
        body,
      });

      assert.equal(response.status, 403);
    });
  });
});
