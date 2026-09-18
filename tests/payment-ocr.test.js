import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const payment = await import("../src/services/payment.service.js");
const ocr = await import("../src/services/ocr.service.js");

test("payment webhook signature verification accepts valid HMAC and rejects tampering", () => {
  const body = Buffer.from(JSON.stringify({ provider: "test", providerPaymentId: "pay_1", status: "paid" }));
  const secret = "task16-test-secret";
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(payment.verifyPaymentWebhook(body, signature, secret), true);
  assert.equal(payment.verifyPaymentWebhook(Buffer.from("tampered"), signature, secret), false);
  assert.equal(payment.verifyPaymentWebhook(body, "00", secret), false);
});

test("OCR upload policy is restricted to supported document types and size", () => {
  assert.equal(ocr.ALLOWED.has("image/jpeg"), true);
  assert.equal(ocr.ALLOWED.has("image/png"), true);
  assert.equal(ocr.ALLOWED.has("image/webp"), true);
  assert.equal(ocr.ALLOWED.has("application/pdf"), true);
  assert.equal(ocr.ALLOWED.has("text/html"), false);
  assert.equal(ocr.MAX_IMAGE_BYTES, 5 * 1024 * 1024);
});

test("OCR validates file signatures instead of trusting MIME type alone", () => {
  assert.equal(ocr.hasValidMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"), true);
  assert.equal(ocr.hasValidMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
  assert.equal(ocr.hasValidMagicBytes(Buffer.from("RIFFxxxxWEBP"), "image/webp"), true);
  assert.equal(ocr.hasValidMagicBytes(Buffer.from("%PDF-1.7"), "application/pdf"), true);

  assert.equal(ocr.hasValidMagicBytes(Buffer.from("<html>"), "image/jpeg"), false);
  assert.equal(ocr.hasValidMagicBytes(Buffer.from("%PDF-1.7"), "image/png"), false);
});
