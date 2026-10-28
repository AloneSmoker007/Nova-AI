import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";

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
  let rotateRefreshToken;
  let revokeRefreshToken;
  let stopBackgroundServices;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ generateToken } = await import("../src/services/auth.service.js"));
    ({ requireAuth } = await import("../src/middleware/auth.js"));
    ({ issueRefreshToken, rotateRefreshToken, revokeRefreshToken } = await import("../src/services/refresh-token.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
    assert.ok(migrated.applied.includes("029_user_access_token_version.sql"));
  });

  after(async () => {
    if (stopBackgroundServices) await stopBackgroundServices();
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

  for (const credential of ["password_hash", "role"]) {
    it(`${credential} changes prevent old refresh tokens from renewing access`, async () => {
      const user = await seedUser();
      const oldRefresh = await issueRefreshToken(user.id, user.tenant_id);
      const newValue = credential === "role" ? "agent" : "changed-test-password-hash";
      await dbPool.query(
        `UPDATE users SET ${credential}=$3 WHERE id=$1 AND tenant_id=$2`,
        [user.id, user.tenant_id, newValue],
      );

      const renewed = await rotateRefreshToken(oldRefresh);
      assert.equal(renewed, null, "a credential change must require fresh authentication, not just invalidate one access JWT");
    });
  }

  it("refresh issuance rejects a stale login version and fresh authentication can rotate normally", async () => {
    const user = await seedUser();
    await dbPool.query("UPDATE users SET password_hash='changed-password' WHERE id=$1", [user.id]);
    await assert.rejects(
      issueRefreshToken(user.id, user.tenant_id, user.token_version),
      /Invalid credentials/,
    );
    const fresh = await issueRefreshToken(user.id, user.tenant_id, 1);
    const rotated = await rotateRefreshToken(fresh);
    assert.ok(rotated?.refreshToken);
    assert.equal(rotated.tokenVersion, 1);
    const next = await rotateRefreshToken(rotated.refreshToken);
    assert.ok(next?.refreshToken);
    assert.equal(next.tokenVersion, 1, "rotation must preserve the credential version");
    await dbPool.query("UPDATE users SET password_hash='another-password-change' WHERE id=$1", [user.id]);
    assert.equal(await rotateRefreshToken(next.refreshToken), null, "descendants must not survive a later credential change");
  });

  it("authentication rejects expired, forged, cross-tenant and suspended identities", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const valid = generateToken(user);
    assert.equal((await authenticate(valid)).nextCalled, true);
    const parts = valid.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    const originalExpiry = process.env.JWT_EXPIRES_IN;
    let expired;
    try {
      process.env.JWT_EXPIRES_IN = "-1s";
      expired = generateToken(user);
    } finally {
      if (originalExpiry === undefined) delete process.env.JWT_EXPIRES_IN;
      else process.env.JWT_EXPIRES_IN = originalExpiry;
    }
    for (const token of ["", "invalid.token", parts.join("."), expired, generateToken({ ...user, tenant_id: other.tenant_id })]) {
      const denied = await authenticate(token);
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.nextCalled, false);
    }
    await dbPool.query("UPDATE users SET status='suspended' WHERE id=$1", [user.id]);
    assert.equal((await authenticate(valid)).statusCode, 401);
    await dbPool.query("UPDATE users SET status='active' WHERE id=$1", [user.id]);
    await dbPool.query("UPDATE tenants SET status='suspended' WHERE id=$1", [user.tenant_id]);
    assert.equal((await authenticate(valid)).statusCode, 401);
  });

  it("obsolete refresh and logout credentials cannot revoke fresh or other-tenant sessions", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const stale = await issueRefreshToken(user.id, user.tenant_id);
    const otherRefresh = await issueRefreshToken(other.id, other.tenant_id);
    await dbPool.query("UPDATE users SET password_hash='changed-password' WHERE id=$1", [user.id]);
    const fresh = await issueRefreshToken(user.id, user.tenant_id, 1);

    assert.equal(await revokeRefreshToken(stale), false);
    assert.equal(await rotateRefreshToken(stale), null);
    assert.equal(await rotateRefreshToken(stale), null, "replaying an obsolete token must not bump the current version");
    assert.ok((await rotateRefreshToken(fresh))?.refreshToken);
    assert.ok((await rotateRefreshToken(otherRefresh))?.refreshToken);
    const versions = await dbPool.query(
      "SELECT id, token_version FROM users WHERE id=ANY($1::uuid[])", [[user.id, other.id]],
    );
    const byId = new Map(versions.rows.map((row) => [row.id, row.token_version]));
    assert.equal(byId.get(user.id), 1);
    assert.equal(byId.get(other.id), 0);
  });

  it("migration revokes unversioned legacy refresh credentials instead of upgrading them", async () => {
    const user = await seedUser();
    const client = await dbPool.connect();
    try {
      await client.query("BEGIN");
      // Recreate the pre-035 refresh schema inside a rollback-only transaction.
      await client.query("ALTER TABLE refresh_tokens DROP COLUMN token_version");
      const legacy = await client.query(
        `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW()+INTERVAL '1 day') RETURNING id`,
        [user.id, user.tenant_id, "legacy-synthetic-" + randomUUID()],
      );
      const sql = await readFile(new URL("../database/035_refresh_token_version_fencing.sql", import.meta.url), "utf8");
      await client.query(sql);
      const migrated = await client.query(
        "SELECT revoked_at, token_version FROM refresh_tokens WHERE id=$1", [legacy.rows[0].id],
      );
      assert.ok(migrated.rows[0].revoked_at);
      assert.equal(migrated.rows[0].token_version, -1, "legacy replay must not share the fresh account's credential version");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the real refresh handler rejects a credential change between rotation and access-token signing", async () => {
    const realListen = express.application.listen;
    express.application.listen = () => ({
      on() { return this; },
      close(callback) { callback?.(); },
    });
    let app;
    try {
      const appModule = await import("../src/index.js");
      app = appModule.default;
      stopBackgroundServices = appModule.stopBackgroundServices;
      await appModule.appStartupPromise;
    } finally {
      express.application.listen = realListen;
    }
    // Await recovery before schema-sensitive assertions, and leave the pool
    // available to this test file's after hook.
    await stopBackgroundServices();
    const handler = app._router.stack.find((layer) =>
      layer.route?.path === "/api/auth/refresh" && layer.route.methods.post,
    ).route.stack.at(-1).handle;
    const user = await seedUser();
    const refresh = await issueRefreshToken(user.id, user.tenant_id);
    const originalQuery = dbPool.query;
    let injected = false;
    dbPool.query = async function (sql, params) {
      if (!injected && typeof sql === "string" && sql.includes("SELECT id, tenant_id, email, role, status, token_version")) {
        injected = true;
        await originalQuery.call(this, "UPDATE users SET password_hash='racing-password-change' WHERE id=$1", [user.id]);
      }
      return originalQuery.call(this, sql, params);
    };
    const result = { statusCode: null, body: null };
    const response = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; },
    };
    try {
      await handler({ body: { refreshToken: refresh }, log: { error() {} } }, response);
    } finally {
      dbPool.query = originalQuery;
    }
    assert.equal(injected, true, "exercise the post-rotation account lookup");
    assert.equal(result.statusCode, 401);
    assert.equal(result.body?.token, undefined, "no upgraded access JWT may escape the route");
    assert.equal(result.body?.refreshToken, undefined);

    const fresh = await issueRefreshToken(user.id, user.tenant_id, 1);
    await handler({ body: { refreshToken: fresh }, log: { error() {} } }, response);
    assert.equal(result.statusCode, 200, "fresh authentication must remain usable");
    assert.equal((await authenticate(result.body.token)).nextCalled, true);
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
