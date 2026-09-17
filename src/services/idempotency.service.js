import { dbPool, isDatabaseConfigured } from "../config/database.js";

const PROCESSING_STALE_MS = 10 * 60 * 1000;

// Fallback in-memory map if DB is not configured (for dev/unit tests)
const fallbackProcessingMap = new Map();
const fallbackCompletedMap = new Map();

export async function claimMessage(messageId, tenantId) {
  if (typeof messageId !== "string" || !messageId.trim()) {
    return { claimed: false, reason: "invalid" };
  }

  const id = messageId.trim();

  if (!isDatabaseConfigured() || !dbPool) {
    const now = Date.now();
    if (fallbackProcessingMap.has(id)) return { claimed: false, reason: "processing" };
    if (fallbackCompletedMap.has(id)) return { claimed: false, reason: "completed" };
    fallbackProcessingMap.set(id, now + PROCESSING_STALE_MS);
    return { claimed: true, reason: "new" };
  }

  const insertResult = await dbPool.query(
    `
      INSERT INTO processed_messages (message_id, tenant_id, status, attempts, started_at, updated_at)
      VALUES ($1, $2, 'processing', 1, NOW(), NOW())
      ON CONFLICT (message_id) DO NOTHING
      RETURNING status
    `,
    [id, tenantId],
  );

  if (insertResult.rowCount > 0) {
    return { claimed: true, reason: "new" };
  }

  const existingResult = await dbPool.query(
    `
      SELECT status, started_at, attempts
      FROM processed_messages
      WHERE message_id = $1
    `,
    [id],
  );

  const existing = existingResult.rows[0];

  if (!existing) {
    return { claimed: false, reason: "unknown" };
  }

  if (existing.status === "completed") {
    return { claimed: false, reason: "completed" };
  }

  const startedAt = new Date(existing.started_at).getTime();
  const isStale = Date.now() - startedAt > PROCESSING_STALE_MS;

  if (existing.status === "processing" && isStale) {
    await dbPool.query(
      `
        UPDATE processed_messages
        SET status = 'processing', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
        WHERE message_id = $1
      `,
      [id],
    );
    return { claimed: true, reason: "retry_stale" };
  }

  if (existing.status === "processing") {
    return { claimed: false, reason: "processing" };
  }

  if (existing.status === "failed") {
    await dbPool.query(
      `
        UPDATE processed_messages
        SET status = 'processing', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
        WHERE message_id = $1
      `,
      [id],
    );
    return { claimed: true, reason: "retry_failed" };
  }

  return { claimed: false, reason: "unknown" };
}

export async function markMessageCompleted(messageId) {
  if (typeof messageId !== "string" || !messageId.trim()) return;
  const id = messageId.trim();

  if (!isDatabaseConfigured() || !dbPool) {
    fallbackProcessingMap.delete(id);
    fallbackCompletedMap.set(id, Date.now() + 24 * 3600 * 1000);
    return;
  }

  await dbPool.query(
    `
      UPDATE processed_messages
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE message_id = $1
    `,
    [id],
  );
}

export async function markMessageFailed(messageId, errorMessage = null) {
  if (typeof messageId !== "string" || !messageId.trim()) return;
  const id = messageId.trim();

  if (!isDatabaseConfigured() || !dbPool) {
    fallbackProcessingMap.delete(id);
    return;
  }

  await dbPool.query(
    `
      UPDATE processed_messages
      SET status = 'failed', last_error = $2, updated_at = NOW()
      WHERE message_id = $1
    `,
    [id, errorMessage ? String(errorMessage).slice(0, 1000) : null],
  );
}

export async function releaseMessage(messageId) {
  return markMessageFailed(messageId, "Released for retry");
}

export async function cleanupOldClaims(daysOld = 30) {
  if (!isDatabaseConfigured() || !dbPool) return 0;

  const result = await dbPool.query(
    `
      DELETE FROM processed_messages
      WHERE (status = 'completed' AND completed_at < NOW() - ($1 || ' days')::INTERVAL)
         OR (status = 'failed' AND updated_at < NOW() - ($1 || ' days')::INTERVAL)
    `,
    [daysOld],
  );

  return result.rowCount;
}
