import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip = integrationUrl && allowReset ? false : "Set MIGRATION_TEST_DATABASE_URL and MIGRATION_TEST_ALLOW_RESET=1";

describe("Automation executor fencing", { skip }, () => {
  let dbPool;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    const { runMigrations } = await import("../src/database/migrate.js");
    ({ dbPool } = await import("../src/config/database.js"));
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    await runMigrations();
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  it("rejects a stale executor token after a newer claim", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const oldToken = randomUUID();
    const newToken = randomUUID();

    await dbPool.query("INSERT INTO tenants (id,name) VALUES ($1,'executor-fence')", [tenantId]);
    await dbPool.query(
      "INSERT INTO users (id,tenant_id,email,password_hash,role,status) VALUES ($1,$2,$3,'unused','owner','active')",
      [userId, tenantId, `${tenantId}@example.test`],
    );
    await dbPool.query(
      "INSERT INTO automation_workflows (id,tenant_id,name,trigger_type,trigger_config,definition,created_by,status) VALUES ($1,$2,'fence','manual','{}','{}',$3,'active')",
      [workflowId, tenantId, userId],
    );
    await dbPool.query(
      "INSERT INTO automation_runs (id,tenant_id,workflow_id,status,context,next_run_at,executor_token,executor_lease_until) VALUES ($1,$2,$3,'running','{}',NOW(),$4,NOW()-INTERVAL '1 second')",
      [runId, tenantId, workflowId, oldToken],
    );

    const takeover = await dbPool.query(
      "UPDATE automation_runs SET executor_token=$3, executor_lease_until=NOW()+INTERVAL '15 minutes', updated_at=NOW() WHERE tenant_id=$1 AND id=$2 AND status='running' AND executor_lease_until<NOW() RETURNING executor_token",
      [tenantId, runId, newToken],
    );
    assert.equal(takeover.rowCount, 1);
    assert.equal(takeover.rows[0].executor_token, newToken);

    const staleWrite = await dbPool.query(
      "UPDATE automation_runs SET status='completed',executor_token=NULL,executor_lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND status='running' AND executor_token=$3",
      [tenantId, runId, oldToken],
    );
    assert.equal(staleWrite.rowCount, 0);

    const current = await dbPool.query(
      "SELECT status,executor_token FROM automation_runs WHERE tenant_id=$1 AND id=$2",
      [tenantId, runId],
    );
    assert.equal(current.rows[0].status, "running");
    assert.equal(current.rows[0].executor_token, newToken);
  });
});
