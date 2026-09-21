import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(testsDirectory, "../database");
const MIGRATION_FILE_PATTERN = /^\d+_.+\.sql$/;

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";

const skip = integrationUrl
  ? false
  : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("PostgreSQL migration chain 001-021", { skip }, () => {
  let runMigrations = null;
  let compareMigrationFilenames = null;
  let dbPool = null;
  let resolveTenantByPhoneNumberId = null;
  let expectedFilenames = [];

  before(async () => {
    // config/database.js reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = integrationUrl;

    ({ runMigrations, compareMigrationFilenames } = await import(
      "../src/database/migrate.js"
    ));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ resolveTenantByPhoneNumberId } = await import("../src/services/tenant.service.js"));

    assert.ok(dbPool, "dbPool must be configured from MIGRATION_TEST_DATABASE_URL");

    const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
    expectedFilenames = entries
      .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareMigrationFilenames);

    assert.ok(expectedFilenames.length >= 21, "expected the full 001-021 chain on disk");

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
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  it("applies every migration exactly once in numeric order", async () => {
    const result = await runMigrations();
    assert.equal(result.configured, true);
    assert.deepEqual(result.applied, expectedFilenames);

    const recorded = await dbPool.query("SELECT filename FROM schema_migrations ORDER BY id ASC");
    assert.deepEqual(
      recorded.rows.map((row) => row.filename),
      expectedFilenames,
    );
  });

  it("is a no-op when the migration chain is run a second time", async () => {
    const result = await runMigrations();
    assert.equal(result.configured, true);
    assert.deepEqual(result.applied, []);

    const recorded = await dbPool.query("SELECT count(*)::int AS count FROM schema_migrations");
    assert.equal(recorded.rows[0].count, expectedFilenames.length);
  });

  it("creates uq_users_tenant_id exactly once", async () => {
    const result = await dbPool.query(
      "SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'uq_users_tenant_id'",
    );
    assert.equal(result.rows[0].count, 1);
  });

  it("resolves every composite foreign key and uses column-list SET NULL", async () => {
    const unvalidated = await dbPool.query(
      "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated",
    );
    assert.equal(unvalidated.rows[0].count, 0, "every foreign key must be validated");

    const automationKeys = await dbPool.query(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('fk_automation_runs_workflow', 'fk_whatsapp_deliveries_automation_run')
       ORDER BY conname`,
    );
    assert.deepEqual(
      automationKeys.rows.map((row) => row.conname),
      ["fk_automation_runs_workflow", "fk_whatsapp_deliveries_automation_run"],
    );

    const setNull = await dbPool.query(
      `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE contype = 'f' AND confdeltype = 'n'
       ORDER BY 1, 2`,
    );
    assert.ok(setNull.rows.length > 0, "expected the composite SET NULL foreign keys to exist");
    for (const row of setNull.rows) {
      assert.match(
        row.definition,
        /ON DELETE SET NULL \([a-z_]+\)/,
        `${row.table_name}.${row.conname} must set only the nullable column to NULL`,
      );
    }
  });

  it("creates the 016 scheduler index and the 017 partial dispatch index", async () => {
    const result = await dbPool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_automation_runs_due', 'idx_automation_runs_dispatch')`,
    );
    const byName = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));

    assert.match(
      byName.get("idx_automation_runs_due") ?? "",
      /tenant_id, status, next_run_at, created_at/,
      "016 must keep its scheduler index",
    );
    assert.match(
      byName.get("idx_automation_runs_dispatch") ?? "",
      /WHERE/,
      "017 must create the partial dispatch index",
    );
    assert.match(byName.get("idx_automation_runs_dispatch") ?? "", /next_run_at/);
  });

  it("preserves tenant_id when a referenced conversation is deleted", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const numberId = "22222222-2222-4222-8222-222222222222";
    const contactId = "33333333-3333-4333-8333-333333333333";
    const conversationId = "44444444-4444-4444-8444-444444444444";
    const inboxId = "55555555-5555-4555-8555-555555555555";

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "migration-test",
    ]);
    await dbPool.query(
      "INSERT INTO whatsapp_numbers (id, tenant_id, phone_number_id) VALUES ($1, $2, $3)",
      [numberId, tenantId, "1234567890"],
    );
    const resolvedTenant = await resolveTenantByPhoneNumberId("1234567890");
    assert.equal(resolvedTenant?.tenantId, tenantId);
    assert.equal(resolvedTenant?.whatsappNumberId, numberId);
    assert.equal(resolvedTenant?.phoneNumberId, "1234567890");

    await dbPool.query("INSERT INTO contacts (id, tenant_id, wa_id) VALUES ($1, $2, $3)", [
      contactId,
      tenantId,
      "1234567",
    ]);
    await dbPool.query(
      "INSERT INTO conversations (id, tenant_id, whatsapp_number_id, contact_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenantId, numberId, contactId],
    );
    await dbPool.query(
      `INSERT INTO webhook_messages
         (id, tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id, wa_id, body, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [inboxId, tenantId, numberId, "1234567890", "wamid.migration-test", "1234567", "hello"],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_deliveries
         (tenant_id, inbox_message_id, conversation_id, recipient_wa_id, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, inboxId, conversationId, "1234567", "hello"],
    );

    await dbPool.query("DELETE FROM conversations WHERE tenant_id = $1 AND id = $2", [
      tenantId,
      conversationId,
    ]);

    const delivery = await dbPool.query(
      "SELECT tenant_id, conversation_id FROM whatsapp_deliveries WHERE tenant_id = $1",
      [tenantId],
    );
    assert.equal(delivery.rows.length, 1);
    assert.equal(delivery.rows[0].tenant_id, tenantId, "tenant_id must survive the delete");
    assert.equal(delivery.rows[0].conversation_id, null, "only conversation_id may be nulled");

    // Deleting the tenant exercises the full cascade plus every SET NULL action.
    await dbPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  });
});


