import crypto from "node:crypto";
import { dbPool, isDatabaseConfigured } from "../config/database.js";
import logger from "../config/logger.js";

const REFRESH_TOKEN_TTL_DAYS = 7;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(userId, tenantId) {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }

  const rawToken = crypto.randomBytes(48).toString("base64url");
  const tokenHash = hashToken(rawToken);

  const result = await dbPool.query(
    `
      INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '1 day' * $4)
      RETURNING id, expires_at
    `,
    [userId, tenantId, tokenHash, REFRESH_TOKEN_TTL_DAYS],
  );

  return {
    refreshToken: rawToken,
    expiresAt: result.rows[0].expires_at,
  };
}

export async function revokeAllUserTokens(userId) {
  if (!isDatabaseConfigured() || !dbPool || !userId) return;

  await dbPool.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
    `,
    [userId],
  );
  logger.warn({ userId }, "Revoked all refresh tokens for user (potential token theft/reuse detected or forced logout)");
}

export async function rotateRefreshToken(rawToken) {
  if (!isDatabaseConfigured() || !dbPool || typeof rawToken !== "string" || !rawToken.trim()) {
    return null;
  }

  const tokenHash = hashToken(rawToken.trim());
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT id, user_id, tenant_id, expires_at, revoked_at
        FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE
      `,
      [tokenHash],
    );

    const tokenRow = result.rows[0];

    if (!tokenRow) {
      await client.query("ROLLBACK");
      return null;
    }

    if (tokenRow.revoked_at) {
      await client.query("ROLLBACK");
      await revokeAllUserTokens(tokenRow.user_id);
      return null;
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        UPDATE refresh_tokens
        SET revoked_at = NOW()
        WHERE id = $1
      `,
      [tokenRow.id],
    );

    const newRawToken = crypto.randomBytes(48).toString("base64url");
    const newTokenHash = hashToken(newRawToken);

    const newResult = await client.query(
      `
        INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 day' * $4)
        RETURNING expires_at
      `,
      [tokenRow.user_id, tokenRow.tenant_id, newTokenHash, REFRESH_TOKEN_TTL_DAYS],
    );

    await client.query("COMMIT");

    return {
      userId: tokenRow.user_id,
      tenantId: tokenRow.tenant_id,
      refreshToken: newRawToken,
      expiresAt: newResult.rows[0].expires_at,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeRefreshToken(rawToken) {
  if (!isDatabaseConfigured() || !dbPool || typeof rawToken !== "string" || !rawToken.trim()) {
    return false;
  }

  const tokenHash = hashToken(rawToken.trim());

  const result = await dbPool.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL
    `,
    [tokenHash],
  );

  return result.rowCount > 0;
}
