import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "ci-access-token-revocation-secret-32chars";
process.env.JWT_ISSUER = "nova-ai";
process.env.JWT_AUDIENCE = "nova-ai-api";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("access-token revocation and credential-version fencing (PostgreSQL)", { skip }, () => {
  let dbPool;
  let runMigrations;
  let generateToken;
  let requireAuth;
  let issueRefreshToken;
  let revokeRefreshToken;
  let hashToken;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ generateToken } = await import("../src/services/auth.service.js"));
    ({ requireAuth } = await import("../src/middleware/auth.js"));
    ({ issueRefreshToken, revokeRefreshToken } = await import("../src/services/refresh-token.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
    assert.ok(migrated.applied.includes("029_user_access_token_version.sql"));
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedUser() {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "token-version-" + tenantId,
    ]);
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'owner', 'active')`,
      [userId, tenantId, `token-version-${userId}@example.test`, "test-only-password-hash"],
    );
    const result = await dbPool.query(
      "SELECT id, tenant_id, role, status, token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [userId, tenantId],
    );
    return result.rows[0];
  }

  async function authenticate(token) {
    const result = { statusCode: null, body: null, nextCalled: false };
    const response = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; },
    };
    await requireAuth(
      { headers: { authorization: `Bearer ${token}` } },
      response,
      () => { result.nextCalled = true; },
    );
    return result;
  }

  it("logout revokes all refresh tokens and immediately invalidates already-issued access JWTs", async () => {
    const user = await seedUser();
    const accessToken = generateToken(user);
    const refreshToken1 = await issueRefreshToken(user.id, user.tenant_id);
    const refreshToken2 = await issueRefreshToken(user.id, user.tenant_id);

    assert.equal((await authenticate(accessToken)).nextCalled, true);
    assert.equal(await revokeRefreshToken(refreshToken1), true);

    const account = await dbPool.query(
      "SELECT token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal(account.rows[0].token_version, 1);

    const refreshRows = await dbPool.query(
      "SELECT revoked_at FROM refresh_tokens WHERE user_id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal(refreshRows.rowCount, 2);
    assert.ok(refreshRows.rows.every((row) => row.revoked_at));

    const rejected = await authenticate(accessToken);
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.nextCalled, false);

    assert.equal(await revokeRefreshToken("unknown-" + randomUUID()), false);
    assert.equal(typeof refreshToken2, "string");

    // Start a fresh session, then replay the now-revoked token from the
    // previous session. That replay must not invalidate this later session.
    const freshRefreshToken = await issueRefreshToken(user.id, user.tenant_id);
    const freshUserResult = await dbPool.query(
      "SELECT id, tenant_id, role, status, token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    const freshAccessToken = generateToken(freshUserResult.rows[0]);
    assert.equal((await authenticate(freshAccessToken)).nextCalled, true);
    assert.equal(await revokeRefreshToken(refreshToken1), false, "revoked refresh token must not authorize logout again");

    assert.equal(typeof freshRefreshToken, "string");
    const activeSessions = await dbPool.query(
      "SELECT count(*)::int AS count FROM refresh_tokens WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
      [user.id, user.tenant_id],
    );
    assert.equal(activeSessions.rows[0].count, 1, "replaying an old revoked token must not revoke a newer session");
    assert.equal((await authenticate(freshAccessToken)).nextCalled, true);
    const finalVersion = await dbPool.query(
      "SELECT token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal(finalVersion.rows[0].token_version, 1);
  });

  it("role and password changes bump the token version and reject old access JWTs", async () => {
    const user = await seedUser();
    const oldAccessToken = generateToken(user);
    assert.equal((await authenticate(oldAccessToken)).nextCalled, true);

    await dbPool.query(
      "UPDATE users SET role='admin' WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    const afterRoleChange = await dbPool.query(
      "SELECT id, tenant_id, role, status, token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal(afterRoleChange.rows[0].token_version, 1);
    assert.equal((await authenticate(oldAccessToken)).statusCode, 401);

    const adminAccessToken = generateToken(afterRoleChange.rows[0]);
    assert.equal((await authenticate(adminAccessToken)).nextCalled, true);

    await dbPool.query(
      "UPDATE users SET password_hash='new-test-password-hash' WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal((await authenticate(adminAccessToken)).statusCode, 401);

    const afterPasswordChange = await dbPool.query(
      "SELECT token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [user.id, user.tenant_id],
    );
    assert.equal(afterPasswordChange.rows[0].token_version, 2);
  });
});
