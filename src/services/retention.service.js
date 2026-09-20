import { dbPool, isDatabaseConfigured } from "../config/database.js";
import { logger } from "../config/logger.js";

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getDays(envName, fallback) {
  const value = Number(process.env[envName] ?? fallback);
  if (!Number.isInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    throw new Error(`${envName} must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`);
  }
  return value;
}

export function getRetentionConfig() {
  return {
    deletedMessagesDays: getDays("RETENTION_DELETED_MESSAGES_DAYS", DEFAULT_RETENTION_DAYS),
    webhookCompletedDays: getDays("RETENTION_WEBHOOK_COMPLETED_DAYS", 30),
    usageEventsDays: getDays("RETENTION_USAGE_EVENTS_DAYS", 365),
    ocrDocumentsDays: getDays("RETENTION_OCR_DOCUMENTS_DAYS", DEFAULT_RETENTION_DAYS),
    paymentEventsDays: getDays("RETENTION_PAYMENT_EVENTS_DAYS", DEFAULT_RETENTION_DAYS),
    cleanupIntervalMs: Math.max(
      60 * 60 * 1000,
      Number(process.env.RETENTION_CLEANUP_INTERVAL_MS ?? DEFAULT_CLEANUP_INTERVAL_MS),
    ),
  };
}

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

export async function runRetentionCleanup() {
  assertDatabase();
  const config = getRetentionConfig();
  const results = {};

  const queries = [
    ["deletedMessages", `DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1 * INTERVAL '1 day')`, config.deletedMessagesDays],
    ["webhookMessages", `DELETE FROM webhook_messages WHERE state = 'COMPLETED' AND completed_at IS NOT NULL AND completed_at < NOW() - ($1 * INTERVAL '1 day')`, config.webhookCompletedDays],
    ["usageEvents", `DELETE FROM usage_events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, config.usageEventsDays],
    ["ocrDocuments", `DELETE FROM ocr_documents WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, config.ocrDocumentsDays],
    ["paymentEvents", `DELETE FROM payment_webhook_events WHERE received_at < NOW() - ($1 * INTERVAL '1 day')`, config.paymentEventsDays],
  ];

  for (const [name, sql, days] of queries) {
    const result = await dbPool.query(sql, [days]);
    results[name] = result.rowCount;
  }

  logger.info({ results, config }, "Retention cleanup completed");
  return results;
}

export function startRetentionScheduler() {
  if (!isDatabaseConfigured()) return null;
  const config = getRetentionConfig();
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runRetentionCleanup();
    } catch (error) {
      logger.error({ error: error.message }, "Retention cleanup failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), config.cleanupIntervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
