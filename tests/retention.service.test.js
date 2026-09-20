import test from "node:test";
import assert from "node:assert/strict";

test("retention policy enforces bounded configuration", async () => {
  const original = {
    deleted: process.env.RETENTION_DELETED_MESSAGES_DAYS,
    webhook: process.env.RETENTION_WEBHOOK_COMPLETED_DAYS,
    usage: process.env.RETENTION_USAGE_EVENTS_DAYS,
    ocr: process.env.RETENTION_OCR_DOCUMENTS_DAYS,
    payments: process.env.RETENTION_PAYMENT_EVENTS_DAYS,
  };
  try {
    process.env.RETENTION_DELETED_MESSAGES_DAYS = "90";
    process.env.RETENTION_WEBHOOK_COMPLETED_DAYS = "30";
    process.env.RETENTION_USAGE_EVENTS_DAYS = "365";
    process.env.RETENTION_OCR_DOCUMENTS_DAYS = "90";
    process.env.RETENTION_PAYMENT_EVENTS_DAYS = "90";
    const { getRetentionConfig } = await import("../src/services/retention.service.js");
    const config = getRetentionConfig();
    assert.equal(config.deletedMessagesDays, 90);
    assert.equal(config.webhookCompletedDays, 30);
    assert.equal(config.usageEventsDays, 365);
  } finally {
    for (const [key, value] of Object.entries({
      RETENTION_DELETED_MESSAGES_DAYS: original.deleted,
      RETENTION_WEBHOOK_COMPLETED_DAYS: original.webhook,
      RETENTION_USAGE_EVENTS_DAYS: original.usage,
      RETENTION_OCR_DOCUMENTS_DAYS: original.ocr,
      RETENTION_PAYMENT_EVENTS_DAYS: original.payments,
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
