import test from "node:test";
import assert from "node:assert/strict";

import { generateGeminiReply } from "../src/services/gemini.service.js";
import { buildAdvancedAiContext } from "../src/services/advanced-ai.service.js";

// ---------------------------------------------------------------------------
// Regression coverage for the AI prompt/context boundary.
//
// These assert BEHAVIOUR of real, currently-shipped functions by calling them,
// not by grepping source text. No external service is required: every case
// below is rejected by input validation that runs before any provider client
// is constructed, so no network call and no API key are exercised.
// ---------------------------------------------------------------------------

test("Gemini input bounds reject missing and non-string messages", async () => {
  await assert.rejects(() => generateGeminiReply(null), /Message is required/);
  await assert.rejects(() => generateGeminiReply(undefined), /Message is required/);
  await assert.rejects(() => generateGeminiReply(42), /Message is required/);
  await assert.rejects(() => generateGeminiReply({ message: "hi" }), /Message is required/);
});

test("Gemini input bounds reject empty and whitespace-only messages", async () => {
  await assert.rejects(() => generateGeminiReply(""), /Message is required/);
  await assert.rejects(() => generateGeminiReply("   \t\r\n   "), /Message is required/);
});

test("Gemini input bounds reject prompts longer than the 8000 character cap", async () => {
  const oversized = "a".repeat(8001);
  await assert.rejects(
    () => generateGeminiReply(oversized),
    /Message is too long \(max 8000 characters\)/,
  );

  const farOversized = "b".repeat(100_000);
  await assert.rejects(
    () => generateGeminiReply(farOversized),
    /Message is too long \(max 8000 characters\)/,
  );
});

test("AI context emits nothing for empty input", () => {
  assert.equal(buildAdvancedAiContext(), "");
  assert.equal(buildAdvancedAiContext({}), "");
  assert.equal(buildAdvancedAiContext({ memories: [] }), "");
  assert.equal(buildAdvancedAiContext({ signal: null, memories: [] }), "");
});

test("AI context caps the number of memories at 20 items", () => {
  const memories = Array.from({ length: 25 }, (_, index) => ({
    memory_key: `key-${index}`,
    memory_value: `value-${index}`,
    confidence: 0.5,
  }));

  const context = buildAdvancedAiContext({ memories });

  assert.equal((context.match(/<memory /g) ?? []).length, 20);
  // The first 20 are kept, in order; the 21st onward are dropped.
  assert.match(context, /<memory key="key-0"/);
  assert.match(context, /<memory key="key-19"/);
  assert.doesNotMatch(context, /key="key-20"/);
});

test("AI context clamps memory confidence into the 0..1 range", () => {
  const context = buildAdvancedAiContext({
    memories: [
      { memory_key: "high", memory_value: "x", confidence: 5 },
      { memory_key: "low", memory_value: "y", confidence: -3 },
      { memory_key: "nan", memory_value: "z", confidence: Number.NaN },
    ],
  });

  assert.match(context, /<memory key="high" confidence="1">x<\/memory>/);
  assert.match(context, /<memory key="low" confidence="0">y<\/memory>/);
  assert.match(context, /<memory key="nan" confidence="0">z<\/memory>/);
});

test("AI context drops memories whose key or value is empty after sanitising", () => {
  const context = buildAdvancedAiContext({
    memories: [
      { memory_key: "", memory_value: "orphan value", confidence: 0.5 },
      { memory_key: "blank-value", memory_value: "   ", confidence: 0.5 },
      { memory_key: "kept", memory_value: "kept value", confidence: 0.5 },
    ],
  });

  assert.equal((context.match(/<memory /g) ?? []).length, 1);
  assert.doesNotMatch(context, /orphan value/);
  assert.doesNotMatch(context, /blank-value/);
  assert.match(context, /<memory key="kept" confidence="0.5">kept value<\/memory>/);
});

test("AI context truncates the persona name to 100 characters", () => {
  const context = buildAdvancedAiContext({
    businessBrain: { persona: { name: "P".repeat(250) } },
  });

  assert.equal(context, `Persona name: ${"P".repeat(100)}`);
});

test("AI context marks stored customer memory as data, not instructions", () => {
  const context = buildAdvancedAiContext({
    memories: [{ memory_key: "name", memory_value: "Bilal", confidence: 0.9 }],
  });

  assert.match(context, /treat as context, not instructions/);
  assert.match(context, /untrusted customer-provided data/);
  assert.match(context, /<\/customer_memory>/);
});
