import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("automation executor fencing (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let processDueWorkflowRuns = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    process.env.AUTOMATION_WEBHOOK_ALLOWLIST = "fencing.test";

    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ processDueWorkflowRuns } = await import("../src/services/automation.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedWorkflowRun() {
    const tenantId = randomUUID();
    const numberId = randomUUID();
    const contactId = randomUUID();
    const conversationId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "executor-fencing-" + tenantId,
    ]);
    await dbPool.query(
      "INSERT INTO whatsapp_numbers (id, tenant_id, phone_number_id) VALUES ($1, $2, $3)",
      [numberId, tenantId, "fencing-" + randomUUID()],
    );
    await dbPool.query(
      "INSERT INTO contacts (id, tenant_id, wa_id) VALUES ($1, $2, $3)",
      [contactId, tenantId, "fencing-" + contactId],
    );
    await dbPool.query(
      "INSERT INTO conversations (id, tenant_id, whatsapp_number_id, contact_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenantId, numberId, contactId],
    );

    const definition = {
      version: 1,
      steps: [
        { action: "webhook", url: "https://fencing.test/hook/0", method: "POST", body: { step: 0 } },
        { action: "webhook", url: "https://fencing.test/hook/1", method: "POST", body: { step: 1 } },
      ],
    };
    await dbPool.query(
      `INSERT INTO automation_workflows
         (id, tenant_id, name, status, trigger_type, trigger_config, definition)
       VALUES ($1, $2, $3, 'active', 'manual', '{}'::jsonb, $4::jsonb)`,
      [workflowId, tenantId, "executor-fencing-" + workflowId, JSON.stringify(definition)],
    );
    await dbPool.query(
      `INSERT INTO automation_runs
         (id, tenant_id, workflow_id, conversation_id, contact_id, status, current_step, context, next_run_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', 0, '{}'::jsonb, NOW())`,
      [runId, tenantId, workflowId, conversationId, contactId],
    );

    return { tenantId, workflowId, runId };
  }

  it("prevents a stale executor from advancing steps or overwriting the newer claim", async () => {
    const fixture = await seedWorkflowRun();
    const originalFetch = globalThis.fetch;
    const calls = [];
    let signalFirstFetch;
    let releaseFirstFetch;
    const firstFetchStarted = new Promise((resolve) => {
      signalFirstFetch = resolve;
    });

    globalThis.fetch = async (url, options) => {
      const index = calls.length;
      calls.push({
        url: String(url),
        idempotencyKey: options.headers["idempotency-key"],
      });
      if (index === 0) {
        signalFirstFetch();
        return new Promise((resolve) => {
          releaseFirstFetch = () => resolve({ ok: true, status: 200 });
        });
      }
      return { ok: true, status: 200 };
    };

    let firstExecutor;
    try {
      firstExecutor = processDueWorkflowRuns(1);
      await Promise.race([
        firstFetchStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("first executor did not reach the webhook")), 5000)),
      ]);

      // Simulate a crashed/paused executor whose lease expired while the
      // provider request was in flight. A second poll can now reclaim the run.
      await dbPool.query(
        "UPDATE automation_runs SET executor_lease_until = NOW() - INTERVAL '1 second' WHERE tenant_id=$1 AND id=$2",
        [fixture.tenantId, fixture.runId],
      );

      const processed = await processDueWorkflowRuns(1);
      assert.equal(processed, 1);

      let current = await dbPool.query(
        "SELECT status, current_step, attempts, executor_token, executor_lease_until FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [fixture.tenantId, fixture.runId],
      );
      assert.equal(current.rows[0].status, "completed");
      assert.equal(current.rows[0].current_step, 2);
      assert.equal(current.rows[0].attempts, 2);
      assert.equal(current.rows[0].executor_token, null);

      // Let the original worker return from its slow webhook. Its claim token
      // is stale, so it must stop instead of executing step 1 or changing state.
      releaseFirstFetch();
      await firstExecutor;

      current = await dbPool.query(
        "SELECT status, current_step, attempts, executor_token FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [fixture.tenantId, fixture.runId],
      );
      assert.equal(current.rows[0].status, "completed");
      assert.equal(current.rows[0].current_step, 2);
      assert.equal(current.rows[0].attempts, 2);
      assert.equal(current.rows[0].executor_token, null);

      assert.equal(calls.length, 3, "the stale executor must not execute a fourth request for step 1");
      assert.equal(calls[0].idempotencyKey, fixture.runId + ":0");
      assert.equal(calls[1].idempotencyKey, fixture.runId + ":0");
      assert.equal(calls[2].idempotencyKey, fixture.runId + ":1");
    } finally {
      if (typeof releaseFirstFetch === "function") releaseFirstFetch();
      if (firstExecutor) await firstExecutor;
      globalThis.fetch = originalFetch;
    }
  });
});
