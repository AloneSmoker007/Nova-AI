import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset ? false : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1";

describe("Automation PostgreSQL integration", { skip }, () => {
  let dbPool;
  let automation;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    const { runMigrations } = await import("../src/database/migrate.js");
    ({ dbPool } = await import("../src/config/database.js"));
    automation = await import("../src/services/automation.service.js");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seed() {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const numberId = randomUUID();
    const contactId = randomUUID();
    const conversationId = randomUUID();

    await dbPool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [tenantId, "automation-it"]);
    await dbPool.query(
      "INSERT INTO users (id,tenant_id,email,password_hash,role,status) VALUES ($1,$2,$3,$4,'owner','active')",
      [userId, tenantId, `${tenantId}@example.test`, "not-used"],
    );
    await dbPool.query(
      "INSERT INTO whatsapp_numbers (id,tenant_id,phone_number_id) VALUES ($1,$2,$3)",
      [numberId, tenantId, `9${String(Date.now()).slice(-9)}`],
    );
    await dbPool.query(
      "INSERT INTO contacts (id,tenant_id,wa_id) VALUES ($1,$2,$3)",
      [contactId, tenantId, "15550001111"],
    );
    await dbPool.query(
      "INSERT INTO conversations (id,tenant_id,whatsapp_number_id,contact_id) VALUES ($1,$2,$3,$4)",
      [conversationId, tenantId, numberId, contactId],
    );
    return { tenantId, userId, conversationId };
  }

  it("creates a workflow run with a stable trigger key", async () => {
    const { tenantId, userId, conversationId } = await seed();
    const workflow = await automation.createWorkflow({
      tenantId,
      createdBy: userId,
      name: "send welcome",
      triggerType: "manual",
      definition: { steps: [{ action: "send_message", body: "Welcome" }] },
    });
    await automation.setWorkflowStatus(tenantId, workflow.id, "active");

    const first = await automation.startWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      conversationId,
      triggerKey: "manual:test-1",
      context: { test: true },
    });
    const duplicate = await automation.startWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      conversationId,
      triggerKey: "manual:test-1",
      context: { test: true },
    });

    assert.ok(first);
    assert.equal(duplicate, null);
  });

  it("executes send_message into a tenant-scoped durable delivery row", async () => {
    const { tenantId, userId, conversationId } = await seed();
    const workflow = await automation.createWorkflow({
      tenantId,
      createdBy: userId,
      name: "send durable",
      triggerType: "manual",
      definition: { steps: [{ action: "send_message", body: "Hello from automation" }] },
    });
    await automation.setWorkflowStatus(tenantId, workflow.id, "active");
    const run = await automation.startWorkflowRun({
      tenantId,
      workflowId: workflow.id,
      conversationId,
    });
    assert.ok(run);

    const processed = await automation.processDueWorkflowRuns();
    assert.equal(processed, 1);

    const delivery = await dbPool.query(
      "SELECT tenant_id,conversation_id,automation_run_id,automation_step,inbox_message_id,state,recipient_wa_id,body FROM whatsapp_deliveries WHERE tenant_id=$1 AND automation_run_id=$2",
      [tenantId, run.id],
    );
    assert.equal(delivery.rowCount, 1);
    assert.equal(delivery.rows[0].tenant_id, tenantId);
    assert.equal(delivery.rows[0].conversation_id, conversationId);
    assert.equal(delivery.rows[0].automation_run_id, run.id);
    assert.equal(delivery.rows[0].automation_step, 0);
    assert.equal(delivery.rows[0].inbox_message_id, null);
    assert.equal(delivery.rows[0].state, "PENDING");
    assert.equal(delivery.rows[0].recipient_wa_id, "15550001111");
  });
});
