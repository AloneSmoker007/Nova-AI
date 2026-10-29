import { dbPool, isDatabaseConfigured } from "../config/database.js";
import { logger } from "../config/logger.js";
import { reconcileExpiredAiUsageReservations } from "./usage.service.js";

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Node timers cannot safely represent intervals above signed 32-bit milliseconds;
// larger values (or NaN/Infinity) can be treated as ~1ms and cause a tight loop.
const MAX_CLEANUP_INTERVAL_MS = 2_147_483_647;

function getDays(envName, fallback) {
  const value = Number(process.env[envName] ?? fallback);
  if (!Number.isInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    throw new Error(`${envName} must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`);
  }
  return value;
}

function getCleanupIntervalMs() {
  const raw = process.env.RETENTION_CLEANUP_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CLEANUP_INTERVAL_MS;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_CLEANUP_INTERVAL_MS;
  }

  return Math.min(
    Math.max(value, MIN_CLEANUP_INTERVAL_MS),
    MAX_CLEANUP_INTERVAL_MS,
  );
}

export function getRetentionConfig() {
  return {
    deletedMessagesDays: getDays("RETENTION_DELETED_MESSAGES_DAYS", DEFAULT_RETENTION_DAYS),
    webhookCompletedDays: getDays("RETENTION_WEBHOOK_COMPLETED_DAYS", 30),
    usageEventsDays: getDays("RETENTION_USAGE_EVENTS_DAYS", 365),
    ocrDocumentsDays: getDays("RETENTION_OCR_DOCUMENTS_DAYS", DEFAULT_RETENTION_DAYS),
    paymentEventsDays: getDays("RETENTION_PAYMENT_EVENTS_DAYS", DEFAULT_RETENTION_DAYS),
    expiredRefreshTokensDays: getDays("RETENTION_EXPIRED_REFRESH_TOKENS_DAYS", 30),
    aiMemoryDays: getDays("RETENTION_AI_MEMORY_DAYS", 365),
    aiSignalsDays: getDays("RETENTION_AI_SIGNALS_DAYS", 365),
    aiSummariesDays: getDays("RETENTION_AI_SUMMARIES_DAYS", 365),
    aiDraftsDays: getDays("RETENTION_AI_DRAFTS_DAYS", 365),
    cleanupIntervalMs: getCleanupIntervalMs(),
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
    ["expiredRefreshTokens", `DELETE FROM refresh_tokens WHERE expires_at < NOW() - ($1 * INTERVAL '1 day')`, config.expiredRefreshTokensDays],
    ["aiMemory", `DELETE FROM contact_ai_memory WHERE updated_at < NOW() - ($1 * INTERVAL '1 day')`, config.aiMemoryDays],
    ["aiSignals", `DELETE FROM conversation_ai_signals WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, config.aiSignalsDays],
    ["aiSummaries", `DELETE FROM conversation_ai_summaries WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`, config.aiSummariesDays],
    ["aiDrafts", `DELETE FROM ai_copilot_drafts WHERE updated_at < NOW() - ($1 * INTERVAL '1 day')`, config.aiDraftsDays],
  ];

  for (const [name, sql, days] of queries) {
    const result = await dbPool.query(sql, [days]);
    results[name] = result.rowCount;
  }

  const reservations = await reconcileExpiredAiUsageReservations();
  results.aiReservationsFinalized = reservations.committed;
  results.aiReservationsReleased = reservations.released;

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
