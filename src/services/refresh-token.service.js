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

export async function issueRefreshToken(userId, tenantId) {
  assertDatabase();

  if (!validateIdentity(userId, tenantId)) {
    throw new Error("User and tenant identifiers are required");
  }

  const rawToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);

  await dbPool.query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${REFRESH_TOKEN_TTL_DAYS} days')`,
    [userId.trim(), tenantId.trim(), tokenHash],
  );

  return rawToken;
}

export async function rotateRefreshToken(rawToken) {
  assertDatabase();

  const tokenHash = hashToken(rawToken);
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, user_id, tenant_id, expires_at, revoked_at
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

      await client.query("COMMIT");
      return null;
    }

    if (new Date(row.expires_at) < new Date()) {
      await client.query("ROLLBACK");
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
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${REFRESH_TOKEN_TTL_DAYS} days')`,
      [row.user_id, row.tenant_id, newHash],
    );

    await client.query("COMMIT");

    return {
      refreshToken: newRaw,
      userId: row.user_id,
      tenantId: row.tenant_id,
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

  await dbPool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
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
