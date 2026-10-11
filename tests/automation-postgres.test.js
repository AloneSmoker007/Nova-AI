import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

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
const CONTACT_A = "77777777-7777-4777-8777-777777777777";
const CONTACT_B = "88888888-8888-4888-8888-888888888888";
const CONVERSATION_A = "99999999-9999-4999-8999-999999999999";
const CONVERSATION_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Automation SQL regressions against real PostgreSQL", { skip }, () => {
  let dbPool;
  let runMigrations;
  let createWorkflow;
  let setWorkflowStatus;
  let startWorkflowRun;
  let processDueWorkflowRuns;

  before(async () => {
    // Set this before importing the database/configuration modules.
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({
      createWorkflow,
      setWorkflowStatus,
      startWorkflowRun,
      processDueWorkflowRuns,
    } = await import("../src/services/automation.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");

    if (allowReset) {
      await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await dbPool.query("CREATE SCHEMA public");
    } else {
      const existing = await dbPool.query("SELECT to_regclass('public.schema_migrations') AS present");
      assert.equal(existing.rows[0].present, null, "use a fresh database or set MIGRATION_TEST_ALLOW_RESET=1");
    }

    const migrated = await runMigrations();
    assert.equal(migrated.configured, true, "the full migration chain must apply");

    await dbPool.query(
      `INSERT INTO tenants (id, name, status) VALUES
        ($1, 'Automation Tenant A', 'active'),
        ($2, 'Automation Tenant B', 'active')`,
      [TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status) VALUES
        ($1, $3, 'automation-a@example.test', 'not-a-real-password-hash', 'owner', 'active'),
        ($2, $4, 'automation-b@example.test', 'not-a-real-password-hash', 'owner', 'active')`,
      [USER_A, USER_B, TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
        (id, tenant_id, phone_number_id, display_phone_number, status) VALUES
        ($1, $3, 'automation-number-a', '+15550000001', 'active'),
        ($2, $4, 'automation-number-b', '+15550000002', 'active')`,
      [NUMBER_A, NUMBER_B, TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO contacts (id, tenant_id, wa_id) VALUES
        ($1, $3, '15551230001'),
        ($2, $4, '15551230002')`,
      [CONTACT_A, CONTACT_B, TENANT_A, TENANT_B],
    );
    await dbPool.query(
      `INSERT INTO conversations (id, tenant_id, whatsapp_number_id, contact_id, status) VALUES
        ($1, $3, $5, $7, 'active'),
        ($2, $4, $6, $8, 'active')`,
      [CONVERSATION_A, CONVERSATION_B, TENANT_A, TENANT_B, NUMBER_A, NUMBER_B, CONTACT_A, CONTACT_B],
    );
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function makeWorkflow({ tenantId = TENANT_A, userId = USER_A, name, steps = [], activate = true }) {
    const workflow = await createWorkflow({
      tenantId,
      createdBy: userId,
      name,
      triggerType: "message_received",
      definition: { steps },
    });
    if (activate) return setWorkflowStatus(tenantId, workflow.id, "active");
    return workflow;
  }

  async function finishRun(tenantId, runId) {
    await dbPool.query(
      "UPDATE automation_runs SET status='completed', completed_at=NOW() WHERE tenant_id=$1 AND id=$2",
      [tenantId, runId],
    );
  }

  it("persists trigger_key, binding the eighth INSERT expression", async () => {
    const workflow = await makeWorkflow({ name: "persist-trigger-key" });
    const run = await startWorkflowRun({
      tenantId: TENANT_A,
      workflowId: workflow.id,
      triggerKey: "message_received:trigger-key-persist",
    });

    assert.ok(run, "an active workflow must create a run");
    const stored = await dbPool.query(
      "SELECT trigger_key FROM automation_runs WHERE tenant_id=$1 AND id=$2",
      [TENANT_A, run.id],
    );
    assert.equal(stored.rows[0].trigger_key, "message_received:trigger-key-persist");
    await finishRun(TENANT_A, run.id);
  });

  it("deduplicates the same non-null trigger key for the same workflow", async () => {
    const workflow = await makeWorkflow({ name: "deduplicate-trigger-key" });
    const args = {
      tenantId: TENANT_A,
      workflowId: workflow.id,
      triggerKey: "message_received:trigger-key-idempotent",
    };
    const first = await startWorkflowRun(args);
    const replay = await startWorkflowRun(args);

    assert.ok(first);
    assert.equal(replay, null, "a duplicate trigger key must not create another run");
    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM automation_runs WHERE tenant_id=$1 AND workflow_id=$2 AND trigger_key=$3",
      [TENANT_A, workflow.id, args.triggerKey],
    );
    assert.equal(count.rows[0].count, 1);
    await finishRun(TENANT_A, first.id);
  });

  it("scopes trigger-key idempotency to tenant and workflow", async () => {
    const workflowA1 = await makeWorkflow({ name: "trigger-scope-a1" });
    const workflowA2 = await makeWorkflow({ name: "trigger-scope-a2" });
    const workflowB = await makeWorkflow({ tenantId: TENANT_B, userId: USER_B, name: "trigger-scope-b" });
    const triggerKey = "message_received:shared-message-key";

    const runs = await Promise.all([
      startWorkflowRun({ tenantId: TENANT_A, workflowId: workflowA1.id, triggerKey }),
      startWorkflowRun({ tenantId: TENANT_A, workflowId: workflowA2.id, triggerKey }),
      startWorkflowRun({ tenantId: TENANT_B, workflowId: workflowB.id, triggerKey }),
    ]);
    assert.ok(runs.every(Boolean), "the same key must be allowed for distinct tenant/workflow scopes");
    for (const [index, run] of runs.entries()) {
      await finishRun(index === 2 ? TENANT_B : TENANT_A, run.id);
    }
  });

  it("allows multiple runs when trigger_key is null", async () => {
    const workflow = await makeWorkflow({ name: "null-trigger-key" });
    const args = { tenantId: TENANT_A, workflowId: workflow.id, triggerKey: null };
    const first = await startWorkflowRun(args);
    const second = await startWorkflowRun(args);

    assert.ok(first && second);
    assert.notEqual(first.id, second.id, "NULL trigger keys must retain PostgreSQL partial-index semantics");
    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM automation_runs WHERE tenant_id=$1 AND workflow_id=$2 AND trigger_key IS NULL",
      [TENANT_A, workflow.id],
    );
    assert.equal(count.rows[0].count, 2);
    await finishRun(TENANT_A, first.id);
    await finishRun(TENANT_A, second.id);
  });

  it("does not start a workflow that is not active", async () => {
    const workflow = await makeWorkflow({ name: "inactive-workflow", activate: false });
    const run = await startWorkflowRun({ tenantId: TENANT_A, workflowId: workflow.id, triggerKey: "inactive-key" });
    assert.equal(run, null);
    const count = await dbPool.query(
      "SELECT count(*)::int AS count FROM automation_runs WHERE tenant_id=$1 AND workflow_id=$2",
      [TENANT_A, workflow.id],
    );
    assert.equal(count.rows[0].count, 0);
  });

  it("queues one delivery and safely replays the same run/step without a duplicate", async () => {
    const workflow = await makeWorkflow({
      name: "delivery-idempotent",
      steps: [{ action: "send_message", body: "Atomic delivery regression test" }],
    });
    const run = await startWorkflowRun({
      tenantId: TENANT_A,
      workflowId: workflow.id,
      conversationId: CONVERSATION_A,
      contactId: CONTACT_A,
      context: {},
    });
    assert.ok(run);

    await processDueWorkflowRuns(20);
    let result = await dbPool.query(
      "SELECT status, last_error FROM automation_runs WHERE tenant_id=$1 AND id=$2",
      [TENANT_A, run.id],
    );
    assert.equal(result.rows[0].status, "completed");
    assert.equal(result.rows[0].last_error, null, "the delivery INSERT must not raise SQLSTATE 42P10");

    let deliveries = await dbPool.query(
      "SELECT id, automation_step, body FROM whatsapp_deliveries WHERE tenant_id=$1 AND automation_run_id=$2",
      [TENANT_A, run.id],
    );
    assert.equal(deliveries.rows.length, 1);
    assert.equal(deliveries.rows[0].automation_step, 0);
    assert.equal(deliveries.rows[0].body, "Atomic delivery regression test");

    // Rewind the durable run to simulate a replay of the same workflow step.
    // The unique partial index must turn this into already-queued behavior.
    await dbPool.query(
      `UPDATE automation_runs
          SET status='queued', current_step=0, next_run_at=NULL, completed_at=NULL, last_error=NULL
        WHERE tenant_id=$1 AND id=$2`,
      [TENANT_A, run.id],
    );
    await processDueWorkflowRuns(20);

    result = await dbPool.query(
      "SELECT status, last_error FROM automation_runs WHERE tenant_id=$1 AND id=$2",
      [TENANT_A, run.id],
    );
    assert.equal(result.rows[0].status, "completed");
    assert.equal(result.rows[0].last_error, null, "replay must not be recorded as a failed run");

    deliveries = await dbPool.query(
      "SELECT id FROM whatsapp_deliveries WHERE tenant_id=$1 AND automation_run_id=$2",
      [TENANT_A, run.id],
    );
    assert.equal(deliveries.rows.length, 1, "a replay must not enqueue a duplicate delivery");
  });

  it("keeps distinct workflow steps as distinct deliveries", async () => {
    const workflow = await makeWorkflow({
      name: "delivery-step-isolation",
      steps: [
        { action: "send_message", body: "First step" },
        { action: "send_message", body: "Second step" },
      ],
    });
    const run = await startWorkflowRun({
      tenantId: TENANT_A,
      workflowId: workflow.id,
      conversationId: CONVERSATION_A,
      contactId: CONTACT_A,
    });
    assert.ok(run);

    await processDueWorkflowRuns(20);
    const deliveries = await dbPool.query(
      "SELECT automation_step, body FROM whatsapp_deliveries WHERE tenant_id=$1 AND automation_run_id=$2 ORDER BY automation_step",
      [TENANT_A, run.id],
    );
    assert.deepEqual(
      deliveries.rows.map((row) => [row.automation_step, row.body]),
      [[0, "First step"], [1, "Second step"]],
    );
  });

  it("rejects a cross-tenant conversation reference at the database boundary", async () => {
    const workflow = await makeWorkflow({ name: "cross-tenant-run-rejected" });
    await assert.rejects(
      startWorkflowRun({
        tenantId: TENANT_A,
        workflowId: workflow.id,
        conversationId: CONVERSATION_B,
        contactId: CONTACT_B,
      }),
      (error) => error.code === "23503",
    );
  });

  it("does not collide same-step deliveries belonging to different tenants", async () => {
    const workflowA = await makeWorkflow({
      tenantId: TENANT_A,
      userId: USER_A,
      name: "tenant-delivery-a",
      steps: [{ action: "send_message", body: "Tenant A delivery" }],
    });
    const workflowB = await makeWorkflow({
      tenantId: TENANT_B,
      userId: USER_B,
      name: "tenant-delivery-b",
      steps: [{ action: "send_message", body: "Tenant B delivery" }],
    });
    const [runA, runB] = await Promise.all([
      startWorkflowRun({
        tenantId: TENANT_A,
        workflowId: workflowA.id,
        conversationId: CONVERSATION_A,
        contactId: CONTACT_A,
      }),
      startWorkflowRun({
        tenantId: TENANT_B,
        workflowId: workflowB.id,
        conversationId: CONVERSATION_B,
        contactId: CONTACT_B,
      }),
    ]);
    assert.ok(runA && runB);

    await processDueWorkflowRuns(20);
    const result = await dbPool.query(
      `SELECT tenant_id, automation_step, body
         FROM whatsapp_deliveries
        WHERE (tenant_id=$1 AND automation_run_id=$2)
           OR (tenant_id=$3 AND automation_run_id=$4)
        ORDER BY tenant_id`,
      [TENANT_A, runA.id, TENANT_B, runB.id],
    );
    assert.deepEqual(
      result.rows.map((row) => [row.tenant_id, row.automation_step, row.body]),
      [[TENANT_A, 0, "Tenant A delivery"], [TENANT_B, 0, "Tenant B delivery"]],
    );
  });
});
