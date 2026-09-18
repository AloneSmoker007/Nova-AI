import { dbPool, isDatabaseConfigured } from "../config/database.js";
import { logger } from "../config/logger.js";

const DEFAULT_CLEANUP_DAYS = 30;
const STALE_PROCESSING_MINUTES = 10;

function validateTenantId(tenantId) {
  return typeof tenantId === "string" && tenantId.trim() !== "";
}

function validateMessageId(messageId) {
  return typeof messageId === "string" && messageId.trim() !== "";
}

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }
}

export async function claimMessage(messageId, tenantId) {
  if (!validateMessageId(messageId) || !validateTenantId(tenantId)) {
    return { claimed: false, reason: "invalid" };
  }

  assertDatabase();

  const id = messageId.trim();
  const tid = tenantId.trim();

  const insertResult = await dbPool.query(
    `INSERT INTO processed_messages (message_id, tenant_id, status, attempts)
     VALUES ($1, $2, 'processing', 1)
     ON CONFLICT (tenant_id, message_id) DO NOTHING`,
    [id, tid],
  );

  if (insertResult.rowCount === 1) {
    logger.info({ messageId: id, tenantId: tid }, "Message claimed as new");
    return { claimed: true, reason: "new" };
  }

  const selectResult = await dbPool.query(
    `SELECT status, started_at
     FROM processed_messages
     WHERE message_id = $1 AND tenant_id = $2`,
    [id, tid],
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
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000);

    if (startedAt < staleThreshold) {
      const updateResult = await dbPool.query(
        `UPDATE processed_messages
         SET started_at = NOW(), attempts = attempts + 1, status = 'processing'
         WHERE message_id = $1
           AND tenant_id = $2
           AND status = 'processing'
           AND started_at < NOW() - INTERVAL '10 minutes'`,
        [id, tid],
      );

      if (updateResult.rowCount === 1) {
        logger.info({ messageId: id, tenantId: tid }, "Stale claim retried");
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
       WHERE message_id = $1 AND tenant_id = $2 AND status = 'failed'`,
      [id, tid],
    );

    if (updateResult.rowCount === 1) {
      logger.info({ messageId: id, tenantId: tid }, "Failed claim retried");
      return { claimed: true, reason: "retry_failed" };
    }

    return { claimed: false, reason: "invalid" };
  }

  return { claimed: false, reason: "invalid" };
}

export async function markMessageCompleted(messageId, tenantId) {
  if (!validateMessageId(messageId) || !validateTenantId(tenantId)) {
    return;
  }

  assertDatabase();

  const id = messageId.trim();
  const tid = tenantId.trim();

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
     WHERE message_id = $1 AND tenant_id = $2`,
    [id, tid],
  );

  logger.info({ messageId: id, tenantId: tid }, "Message marked completed");
}

export async function markMessageFailed(messageId, tenantId, errorMessage) {
  if (!validateMessageId(messageId) || !validateTenantId(tenantId)) {
    return;
  }

  assertDatabase();

  const id = messageId.trim();
  const tid = tenantId.trim();
  const error = typeof errorMessage === "string" ? errorMessage.slice(0, 1000) : String(errorMessage ?? "").slice(0, 1000);

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'failed', last_error = $3, updated_at = NOW()
     WHERE message_id = $1 AND tenant_id = $2`,
    [id, tid, error],
  );

  logger.warn({ messageId: id, tenantId: tid, error }, "Message marked failed");
}

export async function releaseMessage(messageId, tenantId) {
  if (!validateMessageId(messageId) || !validateTenantId(tenantId)) {
    return;
  }

  assertDatabase();

  const id = messageId.trim();
  const tid = tenantId.trim();

  await dbPool.query(
    `UPDATE processed_messages
     SET status = 'failed', last_error = COALESCE(last_error, 'released'), updated_at = NOW()
     WHERE message_id = $1 AND tenant_id = $2 AND status = 'processing'`,
    [id, tid],
  );

  logger.info({ messageId: id, tenantId: tid }, "Message released");
}

export async function cleanupOldClaims(daysOld = DEFAULT_CLEANUP_DAYS) {
  assertDatabase();

  if (!Number.isInteger(daysOld) || daysOld < 1 || daysOld > 3650) {
    throw new Error("daysOld must be an integer between 1 and 3650");
  }

  const result = await dbPool.query(
    `DELETE FROM processed_messages
     WHERE status = 'completed'
       AND completed_at < NOW() - ($1 * INTERVAL '1 day')`,
    [daysOld],
  );

  logger.info({ daysOld, count: result.rowCount }, "Cleaned up old completed claims");

  return result.rowCount;
}
