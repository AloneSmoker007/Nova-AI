import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1 to run this test";

describe("automation webhook external-effect reconciliation (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let createWorkflow;
  let setWorkflowStatus;
  let startWorkflowRun;
  let processDueWorkflowRuns;
  let listUnknownWorkflowWebhookEffects;
  let resolveUnknownWorkflowWebhookEffect;
  let tenantId;
  let userId;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    process.env.AUTOMATION_WEBHOOK_ALLOWLIST = "automation.test";
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({
      createWorkflow,
      setWorkflowStatus,
      startWorkflowRun,
      processDueWorkflowRuns,
      listUnknownWorkflowWebhookEffects,
      resolveUnknownWorkflowWebhookEffect,
    } = await import("../src/services/automation.service.js"));

    assert.ok(dbPool, "dbPool must use the integration PostgreSQL URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
    assert.ok(migrated.applied.includes("031_automation_webhook_effects.sql"));

    tenantId = randomUUID();
    userId = randomUUID();
    await dbPool.query("INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')", [
      tenantId,
      "webhook-effects-" + tenantId,
    ]);
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'owner', 'active')`,
      [userId, tenantId, `effects-${userId}@example.test`, "test-only-password-hash"],
    );
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function createRun(name) {
    const workflow = await createWorkflow({
      tenantId,
      createdBy: userId,
      name: `${name}-${randomUUID()}`,
      triggerType: "manual",
      definition: {
        steps: [{
          action: "webhook",
          url: `https://automation.test/${name}`,
          method: "POST",
          body: { event: name, request: "explicit configured body only" },
        }],
      },
    });
    await setWorkflowStatus(tenantId, workflow.id, "active");
    const run = await startWorkflowRun({ tenantId, workflowId: workflow.id });
    assert.ok(run);
    return { workflow, run };
  }

  it("does not resend a webhook when the remote effect succeeded but the run cursor must be replayed", async () => {
    const { run } = await createRun("success-replay");
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: options.body, key: options.headers["idempotency-key"] });
      return { ok: true, status: 202 };
    };

    try {
      await processDueWorkflowRuns(1);
      let stored = await dbPool.query(
        "SELECT status, current_step FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [tenantId, run.id],
      );
      assert.equal(stored.rows[0].status, "completed");
      assert.equal(stored.rows[0].current_step, 1);
      assert.equal(calls.length, 1);

      const effect = await dbPool.query(
        "SELECT status, attempt_count, request_sha256 FROM automation_webhook_effects WHERE tenant_id=$1 AND run_id=$2 AND step_index=0",
        [tenantId, run.id],
      );
      assert.equal(effect.rows[0].status, "succeeded");
      assert.equal(effect.rows[0].attempt_count, 1);
      assert.match(effect.rows[0].request_sha256, /^[a-f0-9]{64}$/);
      assert.equal(calls[0].key, run.id + ":0");

      // Simulate a crash after the effect ledger committed but before the
      // automation_runs cursor transition became durable.
      await dbPool.query(
        `UPDATE automation_runs
         SET status='queued', current_step=0, next_run_at=NOW(), completed_at=NULL,
             executor_token=NULL, executor_lease_until=NULL, attempts=0
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, run.id],
      );
      await processDueWorkflowRuns(1);

      stored = await dbPool.query(
        "SELECT status, current_step FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [tenantId, run.id],
      );
      assert.equal(stored.rows[0].status, "completed");
      assert.equal(stored.rows[0].current_step, 1);
      assert.equal(calls.length, 1, "the already-succeeded external effect must not be sent a second time");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parks ambiguous network outcomes until an owner explicitly reconciles them", async () => {
    const { run } = await createRun("ambiguous-outcome");
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("socket closed after request dispatch");
    };

    try {
      await processDueWorkflowRuns(1);
      let stored = await dbPool.query(
        "SELECT status, current_step, last_error FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [tenantId, run.id],
      );
      assert.equal(stored.rows[0].status, "failed");
      assert.equal(stored.rows[0].current_step, 0);
      assert.match(stored.rows[0].last_error, /owner\/admin reconciliation required/);
      assert.equal(calls, 1);

      const unknown = await dbPool.query(
        `SELECT id, status, attempt_count, last_error_code
         FROM automation_webhook_effects WHERE tenant_id=$1 AND run_id=$2 AND step_index=0`,
        [tenantId, run.id],
      );
      assert.equal(unknown.rows[0].status, "unknown");
      assert.equal(unknown.rows[0].attempt_count, 1);
      assert.equal(unknown.rows[0].last_error_code, "request_error");

      const visible = await listUnknownWorkflowWebhookEffects(tenantId);
      assert.ok(visible.some((effect) => effect.id === unknown.rows[0].id));
      assert.equal("request_sha256" in visible[0], false, "review endpoint should not expose request payload or hash by default");

      await processDueWorkflowRuns(1);
      assert.equal(calls, 1, "failed runs with ambiguous effects must never auto-resend");

      const resolution = await resolveUnknownWorkflowWebhookEffect({
        tenantId,
        effectId: unknown.rows[0].id,
        resolvedBy: userId,
        outcome: "not_sent",
        reason: "Checked receiver audit log; this request was not accepted.",
      });
      assert.equal(resolution.status, "retry_authorized");
      assert.equal(resolution.outcome, "not_sent");

      globalThis.fetch = async () => {
        calls += 1;
        return { ok: true, status: 200 };
      };
      await processDueWorkflowRuns(1);

      stored = await dbPool.query(
        "SELECT status, current_step FROM automation_runs WHERE tenant_id=$1 AND id=$2",
        [tenantId, run.id],
      );
      assert.equal(stored.rows[0].status, "completed");
      assert.equal(stored.rows[0].current_step, 1);
      assert.equal(calls, 2, "a new send is permitted only after an explicit audited not-sent resolution");

      const finalEffect = await dbPool.query(
        `SELECT status, attempt_count, resolved_by, resolution_reason, resolved_at
         FROM automation_webhook_effects WHERE tenant_id=$1 AND run_id=$2 AND step_index=0`,
        [tenantId, run.id],
      );
      assert.equal(finalEffect.rows[0].status, "succeeded");
      assert.equal(finalEffect.rows[0].attempt_count, 2);
      assert.equal(finalEffect.rows[0].resolved_by, userId);
      assert.match(finalEffect.rows[0].resolution_reason, /receiver audit log/);
      assert.ok(finalEffect.rows[0].resolved_at);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
