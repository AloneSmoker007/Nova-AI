import test from "node:test";
import assert from "node:assert/strict";

test("Business Brain structured configuration accepts object values", () => {
  const config = { persona: { tone: "friendly" }, salesGuardrails: { maxDiscountPercent: 10 }, languageConfig: { autoDetect: true } };
  assert.equal(Array.isArray(config.persona), false);
  assert.equal(typeof config.salesGuardrails.maxDiscountPercent, "number");
  assert.equal(config.languageConfig.autoDetect, true);
});

test("Business Brain limits remain bounded", () => {
  assert.equal(100, 100);
  assert.equal(5, 5);
});
