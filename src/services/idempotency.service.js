import { dbPool, isDatabaseConfigured } from "../config/database.js";
import { logger } from "../config/logger.js";

const DEFAULT_CLEANUP_DAYS = 30;

function validateMessageId(messageId) {
  return typeof messageId === "string" && messageId.trim() !== "";
}

export async function claimMessage(messageId, tenantId) {
  if (!validateMessageId(messageId) || (tenantId !== undefined && (typeof tenantId !== "string" || tenantId.trim() === ""))) {
    return { claimed: false, reason: "invalid" };
  }

  if (!isDatabaseConfigured()) {
    throw new Error("Database is not configured");
  }

  const id = messageId.trim();
  const tid = tenantId ? tenantId.trim() : null;

  const insertResult = await dbPool.query(
    `INSERT INTO processed_messages (message_id, tenant_id, status, attempts)
     VALUES ($1, $2, 'processing', 1)
     ON CONFLICT (message_id) DO NOTHING`,
    [id, tid],
  );

  if (insertResult.rowCount === 1) {
    logger.info({ messageId: id }, "Message claimed as new");
    return { claimed: true, reason: "new" };
  }

  const selectResult = await dbPool.query(
    `SELECT status, started_at FROM processed_messages WHERE message_id = $1`,
    [id],
  );

  const row = selectResult.rows[0];

  if (!row) {
    return { claimed: false, reason: "invalid" };
  }

  if (row.status === "completed") {
    return { claimed: false, reason: "completed" };
  }

  if (row.status === "processing") {
    const startedAt = new Date(row.started_at);
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);

    if (startedAt < staleThreshold) {
      const updateResult = await dbPool.query(
        `UPDATE processed_messages
         SET started_at = NOW(), attempts = attempts + 1, status = 'processing'
         WHERE message_id = $1 AND status = 'processing' AND started_at < NOW() - INTERVAL '10 minutes'`,
        [id],
      );

      if (updateResult.rowCount === 1) {
        logger.info({ messageId: id }, "Stale claim retried");
        return { claimed: true, reason: "retry_stale" };
      }

      return { claimed: false, reason: "processing" };
    }

    return { claimed: false, reason: "processing" };
  }

  if (row.status === "failed") {
    const updateResult = await dbPool.query(
      `UPDATE processed_messages
       SET status = 'processing', attempts = attempts + 1, started_at = NOW()
       WHERE message_id = $1 AND status = 'failed'`,
      [id],
    );

    if (updateResult.rowCount === 1) {
      logger.info({ messageId: id }, "Failed claim retried");
      return { claimed: true, reason: "retry_failed" };
    }

    return { claimed: false, reason: "invalid" };
  }

  return { claimed: false, reason: "invalid" };
}

export async function markMessageCompleted(messageId) {
  if (!validateMessageId(messageId)) {
    return;
  }

  const id = messageId.trim();

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
     WHERE message_id = $1`,
    [id],
  );

  logger.info({ messageId: id }, "Message marked completed");
}

export async function markMessageFailed(messageId, errorMessage) {
  if (!validateMessageId(messageId)) {
    return;
  }

  const id = messageId.trim();
  const error = typeof errorMessage === "string" ? errorMessage.slice(0, 1000) : String(errorMessage ?? "").slice(0, 1000);

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'failed', last_error = $2, updated_at = NOW()
     WHERE message_id = $1`,
    [id, error],
  );

  logger.warn({ messageId: id, error }, "Message marked failed");
}

export async function releaseMessage(messageId) {
  if (!validateMessageId(messageId)) {
    return;
  }

  const id = messageId.trim();

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'failed', last_error = COALESCE(last_error, 'released'), updated_at = NOW()
     WHERE message_id = $1 AND status = 'processing'`,
    [id],
  );

  logger.info({ messageId: id }, "Message released");
}

export async function cleanupOldClaims(daysOld = DEFAULT_CLEANUP_DAYS) {
  const result = await dbPool.query(
    `DELETE FROM processed_messages
     WHERE status = 'completed'
       AND completed_at < NOW() - INTERVAL '${daysOld} days'`,
  );

  logger.info({ daysOld, count: result.rowCount }, "Cleaned up old completed claims");

  return result.rowCount;
}