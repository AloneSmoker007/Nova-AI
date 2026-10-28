import crypto from "node:crypto";
import { dbPool, isDatabaseConfigured } from "../config/database.js";
import { logger } from "../config/logger.js";

const REFRESH_TOKEN_BYTES = 48;
const REFRESH_TOKEN_TTL_DAYS = 7;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }
}

function hashToken(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Refresh token is required");
  }

  return crypto.createHash("sha256").update(raw).digest("hex");
}

function validateIdentity(userId, tenantId) {
  return (
    typeof userId === "string" &&
    userId.trim() !== "" &&
    typeof tenantId === "string" &&
    tenantId.trim() !== ""
  );
}

export async function issueRefreshToken(userId, tenantId, expectedTokenVersion = null) {
  assertDatabase();

  if (!validateIdentity(userId, tenantId)) {
    throw new Error("User and tenant identifiers are required");
  }
  if (expectedTokenVersion !== null && (!Number.isInteger(expectedTokenVersion) || expectedTokenVersion < 0)) {
    throw new Error("Invalid account token version");
  }

  const rawToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);

  const issued = await dbPool.query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, token_version)
     SELECT id, tenant_id, $3, NOW() + INTERVAL '${REFRESH_TOKEN_TTL_DAYS} days', token_version
     FROM users
     WHERE id=$1 AND tenant_id=$2 AND status='active'
       AND ($4::integer IS NULL OR token_version=$4)
     RETURNING id`,
    [userId.trim(), tenantId.trim(), tokenHash, expectedTokenVersion],
  );
  if (issued.rowCount !== 1) throw new Error("Invalid credentials");

  return rawToken;
}

export async function rotateRefreshToken(rawToken) {
  assertDatabase();

  const tokenHash = hashToken(rawToken);
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, user_id, tenant_id, expires_at, revoked_at, token_version
       FROM refresh_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );

    const row = result.rows[0];

    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    // Expiry takes precedence over replay detection. Old revoked token rows may
    // remain until retention cleanup; replaying an expired token must not revoke
    // the user's currently active sessions.
    if (new Date(row.expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      return null;
    }

    const account = await client.query(
      "SELECT token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [row.user_id, row.tenant_id],
    );
    // Never upgrade a pre-change refresh credential into a post-change
    // session. Check before replay handling so an obsolete credential cannot
    // revoke sessions created after the password/role change.
    if (!account.rows[0] || row.token_version !== account.rows[0].token_version) {
      await client.query(
        "UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, NOW()) WHERE id=$1 AND tenant_id=$2",
        [row.id, row.tenant_id],
      );
      await client.query("COMMIT");
      return null;
    }

    // A revoked token still inside its validity window indicates possible
    // token theft/reuse, so retain all-sessions revocation for that case.
    if (row.revoked_at) {
      logger.warn(
        { userId: row.user_id, tenantId: row.tenant_id },
        "Refresh token reuse detected — revoking all sessions",
      );

      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
        [row.user_id, row.tenant_id],
      );
      await client.query(
        `UPDATE users
         SET token_version = token_version + 1
         WHERE id = $1 AND tenant_id = $2`,
        [row.user_id, row.tenant_id],
      );

      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [row.id, row.tenant_id],
    );

    const newRaw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const newHash = hashToken(newRaw);

    await client.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, token_version)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${REFRESH_TOKEN_TTL_DAYS} days', $4)`,
      [row.user_id, row.tenant_id, newHash, row.token_version],
    );

    await client.query("COMMIT");

    return {
      refreshToken: newRaw,
      userId: row.user_id,
      tenantId: row.tenant_id,
      tokenVersion: row.token_version,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeRefreshToken(rawToken) {
  assertDatabase();

  const tokenHash = hashToken(rawToken);
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT user_id, tenant_id, revoked_at, expires_at, token_version
       FROM refresh_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    const row = result.rows[0];

    // A replayed/expired token is not valid logout authority. In particular,
    // never let an old stolen refresh token terminate sessions created later.
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query("COMMIT");
      return false;
    }

    const account = await client.query(
      "SELECT token_version FROM users WHERE id=$1 AND tenant_id=$2",
      [row.user_id, row.tenant_id],
    );
    if (!account.rows[0] || row.token_version !== account.rows[0].token_version) {
      await client.query("COMMIT");
      return false;
    }

    // Logout terminates all sessions for this account. Bumping token_version
    // makes every already-issued access JWT fail requireAuth immediately.
    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, NOW())
       WHERE user_id = $1 AND tenant_id = $2`,
      [row.user_id, row.tenant_id],
    );
    await client.query(
      `UPDATE users
       SET token_version = token_version + 1
       WHERE id = $1 AND tenant_id = $2`,
      [row.user_id, row.tenant_id],
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeAllUserTokens(userId, tenantId) {
  assertDatabase();

  if (!validateIdentity(userId, tenantId)) {
    throw new Error("User and tenant identifiers are required");
  }

  await dbPool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [userId.trim(), tenantId.trim()],
  );
}
