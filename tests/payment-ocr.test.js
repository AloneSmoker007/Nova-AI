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
