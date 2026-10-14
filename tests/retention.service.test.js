import test from "node:test";
import assert from "node:assert/strict";

test("retention policy enforces bounded configuration", async () => {
  const original = {
    deleted: process.env.RETENTION_DELETED_MESSAGES_DAYS,
    webhook: process.env.RETENTION_WEBHOOK_COMPLETED_DAYS,
    usage: process.env.RETENTION_USAGE_EVENTS_DAYS,
    ocr: process.env.RETENTION_OCR_DOCUMENTS_DAYS,
    payments: process.env.RETENTION_PAYMENT_EVENTS_DAYS,
    expiredRefreshTokens: process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS,
    aiMemory: process.env.RETENTION_AI_MEMORY_DAYS,
    aiSignals: process.env.RETENTION_AI_SIGNALS_DAYS,
    aiSummaries: process.env.RETENTION_AI_SUMMARIES_DAYS,
    aiDrafts: process.env.RETENTION_AI_DRAFTS_DAYS,
  };
  try {
    process.env.RETENTION_DELETED_MESSAGES_DAYS = "90";
    process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = "30";
    process.env.RETENTION_USAGE_EVENTS_DAYS = "365";
    process.env.RETENTION_OCR_DOCUMENTS_DAYS = "90";
    process.env.RETENTION_PAYMENT_EVENTS_DAYS = "90";
    process.env.RETENTION_EXPIRED_REFRESH_TOKENS_DAYS = "30";
    process.env.RETENTION_AI_MEMORY_DAYS = "180";
    process.env.RETENTION_AI_SIGNALS_DAYS = "120";
    process.env.RETENTION_AI_SUMMARIES_DAYS = "90";
    process.env.RETENTION_AI_DRAFTS_DAYS = "30";
    const { getRetentionConfig } = await import("../src/services/retention.service.js");
    const config = getRetentionConfig();
    assert.equal(config.deletedMessagesDays, 90);
    assert.equal(config.webhookCompletedDays, 30);
    assert.equal(config.usageEventsDays, 365);
    assert.equal(config.expiredRefreshTokensDays, 30);
    assert.equal(config.aiMemoryDays, 180);
    assert.equal(config.aiSignalsDays, 120);
    assert.equal(config.aiSummariesDays, 90);
    assert.equal(config.aiDraftsDays, 30);
  } finally {
    for (const [key, value] of Object.entries({
      RETENTION_DELETED_MESSAGES_DAYS: original.deleted,
      RETENTION_WEBHOOK_COMPLETED_DAYS: original.webhook,
      RETENTION_USAGE_EVENTS_DAYS: original.usage,
      RETENTION_OCR_DOCUMENTS_DAYS: original.ocr,
      RETENTION_PAYMENT_EVENTS_DAYS: original.payments,
      RETENTION_EXPIRED_REFRESH_TOKENS_DAYS: original.expiredRefreshTokens,
      RETENTION_AI_MEMORY_DAYS: original.aiMemory,
      RETENTION_AI_SIGNALS_DAYS: original.aiSignals,
      RETENTION_AI_SUMMARIES_DAYS: original.aiSummaries,
      RETENTION_AI_DRAFTS_DAYS: original.aiDrafts,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("retention policy rejects unsafe values", async () => {
  process.env.RETENTION_DELETED_MESSAGES_DAYS = "1";
  const { getRetentionConfig } = await import("../src/services/retention.service.js");
  assert.throws(() => getRetentionConfig(), /between 7 and 3650/);
  delete process.env.RETENTION_DELETED_MESSAGES_DAYS;
});

test("retention cleanup interval safely handles invalid and out-of-range timer values", async () => {
  const original = process.env.RETENTION_CLEANUP_INTERVAL_MS;
  const { getRetentionConfig } = await import("../src/services/retention.service.js");

  try {
    for (const invalid of ["not-a-number", "NaN", "Infinity", "1.5"]) {
      process.env.RETENTION_CLEANUP_INTERVAL_MS = invalid;
      assert.equal(
        getRetentionConfig().cleanupIntervalMs,
        24 * 60 * 60 * 1000,
        `invalid interval ${invalid} must fall back to the daily default`,
      );
    }

    process.env.RETENTION_CLEANUP_INTERVAL_MS = "1";
    assert.equal(getRetentionConfig().cleanupIntervalMs, 60 * 60 * 1000);

    process.env.RETENTION_CLEANUP_INTERVAL_MS = String(3 * 24 * 60 * 60 * 1000);
    assert.equal(getRetentionConfig().cleanupIntervalMs, 3 * 24 * 60 * 60 * 1000);

    process.env.RETENTION_CLEANUP_INTERVAL_MS = String(Number.MAX_SAFE_INTEGER);
    assert.equal(
      getRetentionConfig().cleanupIntervalMs,
      2_147_483_647,
      "intervals must not exceed the platform timer maximum",
    );
  } finally {
    if (original === undefined) delete process.env.RETENTION_CLEANUP_INTERVAL_MS;
    else process.env.RETENTION_CLEANUP_INTERVAL_MS = original;
  }
});
