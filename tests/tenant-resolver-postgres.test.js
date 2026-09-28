import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * P0-1 regression: `resolveTenantByPhoneNumberId` must run against the schema
 * that the database/ migration chain actually creates.
 *
 * The bug this guards against: the resolver selected `whatsapp_numbers.phone_number`
 * and `tenants.slug`, neither of which exists in any migration. The whole query
 * aborted with `column ... does not exist`, so every webhook tenant lookup failed
 * in production.
 *
 * This test reuses the existing PostgreSQL integration infrastructure
 * (tests/migration-postgres.test.js): it applies the real migrations with
 * `runMigrations()` and then exercises the real resolver.
 *
 * Point it at a DEDICATED database, because tests/migration-postgres.test.js
 * resets `public` and these files may run concurrently:
 *
 *   TENANT_RESOLVER_TEST_DATABASE_URL=postgresql://user@host:5432/nova_tenant_resolver_test \
 *   MIGRATION_TEST_ALLOW_RESET=1 \
 *   node --test tests/tenant-resolver-postgres.test.js
 *
 * TENANT_RESOLVER_TEST_DATABASE_URL falls back to MIGRATION_TEST_DATABASE_URL
 * when only one integration database is available.
 */
const integrationUrl =
  process.env.TENANT_RESOLVER_TEST_DATABASE_URL ||
  process.env.MIGRATION_TEST_DATABASE_URL ||
  "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";

const skip = integrationUrl
  ? false
  : "Set TENANT_RESOLVER_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("P0-1 tenant resolver against the migrated PostgreSQL schema", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let resolveTenantByPhoneNumberId = null;

  const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const NUMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const NUMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const PHONE_NUMBER_ID_A = "111111111111111";
  const PHONE_NUMBER_ID_B = "222222222222222";
  const DISPLAY_PHONE_A = "+15550000001";
  const DISPLAY_PHONE_B = "+15550000002";

  before(async () => {
    // config/database.js reads DATABASE_URL when it is first imported.
    process.env.DATABASE_URL = integrationUrl;

    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ resolveTenantByPhoneNumberId } = await import(
      "../src/services/tenant.service.js"
    ));

    assert.ok(dbPool, "dbPool must be configured from the integration URL");
    assert.ok(
      typeof resolveTenantByPhoneNumberId === "function",
      "the resolver under test must be importable",
    );

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

    // Apply the actual migration chain: this is the schema source of truth.
    const result = await runMigrations();
    assert.equal(result.configured, true);
    assert.ok(result.applied.length > 0, "expected the migration chain to apply");

    await dbPool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')",
      [TENANT_A, "tenant-resolver-a"],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, access_token_encrypted, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [NUMBER_A, TENANT_A, PHONE_NUMBER_ID_A, DISPLAY_PHONE_A, "Nova A", "cipher-a"],
    );

    await dbPool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')",
      [TENANT_B, "tenant-resolver-b"],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, display_name, access_token_encrypted, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [NUMBER_B, TENANT_B, PHONE_NUMBER_ID_B, DISPLAY_PHONE_B, "Nova B", "cipher-b"],
    );
  });

  after(async () => {
    if (!dbPool) return;
    await dbPool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      [TENANT_A, TENANT_B],
    ]);
    await dbPool.end();
  });

  it("has no tenants.slug and no whatsapp_numbers.phone_number in the migrated schema", async () => {
    const result = await dbPool.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'tenants' AND column_name = 'slug')
           OR (table_name = 'whatsapp_numbers' AND column_name = 'phone_number'))`,
    );
    assert.deepEqual(
      result.rows,
      [],
      "the resolver must not depend on columns the migrations never create",
    );
  });

  it("exposes the migrated phone number column as display_phone_number", async () => {
    const result = await dbPool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'whatsapp_numbers'
       ORDER BY column_name`,
    );
    const columns = result.rows.map((row) => row.column_name);
    assert.ok(
      columns.includes("display_phone_number"),
      "whatsapp_numbers.display_phone_number must exist in the migrated schema",
    );
  });

  it("resolves a tenant from the migrated schema (P0-1 regression)", async () => {
    const tenant = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_A);

    assert.ok(tenant, "resolver must find the tenant for a known phone_number_id");
    assert.equal(tenant.tenantId, TENANT_A);
    assert.equal(tenant.tenantName, "tenant-resolver-a");
    assert.equal(tenant.whatsappNumberId, NUMBER_A);
    assert.equal(tenant.phoneNumberId, PHONE_NUMBER_ID_A);
    assert.equal(tenant.accessTokenEncrypted, "cipher-a");
    assert.equal(tenant.displayName, "Nova A");
  });

  it("maps whatsapp_numbers.display_phone_number onto the resolver's phoneNumber", async () => {
    const tenant = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_A);

    assert.ok(tenant, "resolver must return a tenant");
    assert.equal(
      tenant.phoneNumber,
      DISPLAY_PHONE_A,
      "phoneNumber must come from display_phone_number, the real column",
    );

    const other = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_B);
    assert.ok(other, "resolver must return a tenant for the second number");
    assert.equal(other.phoneNumber, DISPLAY_PHONE_B);
  });

  it("returns tenantSlug as null instead of selecting a non-existent tenants.slug", async () => {
    const tenant = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_A);

    assert.ok(tenant, "resolver must return a tenant");
    assert.equal(
      tenant.tenantSlug,
      null,
      "tenants has no slug column, so tenantSlug must be an explicit null",
    );
  });

  it("preserves tenant isolation between two tenants", async () => {
    const a = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_A);
    const b = await resolveTenantByPhoneNumberId(PHONE_NUMBER_ID_B);

    assert.ok(a && b, "both tenants must resolve");
    assert.notEqual(a.tenantId, b.tenantId);
    assert.notEqual(a.whatsappNumberId, b.whatsappNumberId);
    assert.equal(a.tenantId, TENANT_A);
    assert.equal(b.tenantId, TENANT_B);
    assert.equal(a.accessTokenEncrypted, "cipher-a");
    assert.equal(b.accessTokenEncrypted, "cipher-b");
  });

  it("returns null for an unknown phone_number_id", async () => {
    assert.equal(await resolveTenantByPhoneNumberId("999999999999999"), null);
  });

  it("refuses malformed phone_number_id values without touching the database", async () => {
    for (const value of [
      null,
      undefined,
      42,
      {},
      [],
      "",
      "abc",
      "1234",
      "1".repeat(31),
      "12345678901234a",
      " 111111111111111",
      "111111111111111 ",
    ]) {
      assert.equal(
        await resolveTenantByPhoneNumberId(value),
        null,
        `resolver must reject ${JSON.stringify(value)}`,
      );
    }
  });

  it("does not resolve a disabled whatsapp number", async () => {
    const tenantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const numberId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    const phoneNumberId = "333333333333333";

    await dbPool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')",
      [tenantId, "tenant-resolver-disabled-number"],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, status)
       VALUES ($1, $2, $3, $4, 'disabled')`,
      [numberId, tenantId, phoneNumberId, "+15550000003"],
    );

    assert.equal(await resolveTenantByPhoneNumberId(phoneNumberId), null);

    await dbPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  });

  it("does not resolve a suspended tenant", async () => {
    const tenantId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const numberId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
    const phoneNumberId = "444444444444444";

    await dbPool.query(
      "INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'suspended')",
      [tenantId, "tenant-resolver-suspended"],
    );
    await dbPool.query(
      `INSERT INTO whatsapp_numbers
         (id, tenant_id, phone_number_id, display_phone_number, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [numberId, tenantId, phoneNumberId, "+15550000004"],
    );

    assert.equal(await resolveTenantByPhoneNumberId(phoneNumberId), null);

    await dbPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  });
});
