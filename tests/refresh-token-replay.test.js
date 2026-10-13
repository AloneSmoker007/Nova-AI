import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("refresh-token replay protection and retention (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let rotateRefreshToken = null;
  let runRetentionCleanup = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    ({ rotateRefreshToken } = await import("../src/services/refresh-token.service.js"));
    ({ runRetentionCleanup } = await import("../src/services/retention.service.js"));

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  function hashToken(raw) {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  async function seedUser() {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const email = `refresh-token-${userId}@example.test`;

    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "refresh-token-" + tenantId,
    ]);
    await dbPool.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'owner', 'active')`,
      [userId, tenantId, email, "test-only-password-hash"],
    );

    return { tenantId, userId };
  }

  async function insertToken({ userId, tenantId, rawToken, expiresSql, revokedSql = "NULL" }) {
    await dbPool.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, $3, ${expiresSql}, ${revokedSql})`,
      [userId, tenantId, hashToken(rawToken)],
    );
  }

  async function revokedAt(rawToken) {
    const result = await dbPool.query(
      "SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1",
      [hashToken(rawToken)],
    );
    return result.rows[0]?.revoked_at ?? null;
  }

  it("expired revoked-token replay does not revoke a user's fresh active session", async () => {
    const { tenantId, userId } = await seedUser();
    const expiredRevokedToken = "expired-revoked-" + randomUUID();
    const freshActiveToken = "fresh-active-" + randomUUID();

    await insertToken({
      userId,
      tenantId,
      rawToken: expiredRevokedToken,
      expiresSql: "NOW() - INTERVAL '1 day'",
      revokedSql: "NOW() - INTERVAL '1 day'",
    });
    await insertToken({
      userId,
      tenantId,
      rawToken: freshActiveToken,
      expiresSql: "NOW() + INTERVAL '7 days'",
    });

    assert.equal(await rotateRefreshToken(expiredRevokedToken), null);
    assert.equal(
      await revokedAt(freshActiveToken),
      null,
      "replaying an expired token must not revoke any currently active session",
    );
  });

  it("unexpired revoked-token reuse still revokes the user's active sessions", async () => {
    const { tenantId, userId } = await seedUser();
    const unexpiredRevokedToken = "unexpired-revoked-" + randomUUID();
    const freshActiveToken = "active-to-revoke-" + randomUUID();

    await insertToken({
      userId,
      tenantId,
      rawToken: unexpiredRevokedToken,
      expiresSql: "NOW() + INTERVAL '1 day'",
      revokedSql: "NOW() - INTERVAL '1 minute'",
    });
    await insertToken({
      userId,
      tenantId,
      rawToken: freshActiveToken,
      expiresSql: "NOW() + INTERVAL '7 days'",
    });

    assert.equal(await rotateRefreshToken(unexpiredRevokedToken), null);
    assert.ok(
      await revokedAt(freshActiveToken),
      "reuse of a revoked token that is still within its validity window must revoke active sessions",
    );
  });

  it("retention removes only refresh-token records long past expiry", async () => {
    const { tenantId, userId } = await seedUser();
    const oldExpiredToken = "old-expired-" + randomUUID();
    const recentExpiredToken = "recent-expired-" + randomUUID();
    const originalRetention = process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS;

    try {
      process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS = "30";
      await insertToken({
        userId,
        tenantId,
        rawToken: oldExpiredToken,
        expiresSql: "NOW() - INTERVAL '40 days'",
        revokedSql: "NOW() - INTERVAL '40 days'",
      });
      await insertToken({
        userId,
        tenantId,
        rawToken: recentExpiredToken,
        expiresSql: "NOW() - INTERVAL '1 day'",
        revokedSql: "NOW() - INTERVAL '1 day'",
      });

      const counts = await runRetentionCleanup();
      assert.ok(counts.expiredRefreshTokens >= 1);

      const oldRow = await dbPool.query(
        "SELECT id FROM refresh_tokens WHERE token_hash = $1",
        [hashToken(oldExpiredToken)],
      );
      const recentRow = await dbPool.query(
        "SELECT id FROM refresh_tokens WHERE token_hash = $1",
        [hashToken(recentExpiredToken)],
      );
      assert.equal(oldRow.rowCount, 0, "records expired for more than 30 days should be pruned");
      assert.equal(recentRow.rowCount, 1, "recently expired records remain during the cleanup grace period");
    } finally {
      if (originalRetention === undefined) delete process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS;
      else process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS = originalRetention;
    }
  });
});
