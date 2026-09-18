import test from "node:test";
import assert from "node:assert/strict";
import { extractCustomerPreferencesFromText } from "../src/services/advanced-ai.service.js";

test("customer memory extraction captures stable facts from normal inbound messages", () => {
  const memories = extractCustomerPreferencesFromText(
    "Mera naam Bilal hai. Mujhe astrology service chahiye. My budget is 5000 PKR. I prefer Urdu.",
  );

  assert.ok(memories.some((item) => item.key === "name"));
  assert.ok(memories.some((item) => item.key === "service_interest"));
  assert.ok(memories.some((item) => item.key === "budget"));
  assert.ok(memories.some((item) => item.key === "preferred_language"));
});

test("customer memory extraction does not create entries for empty messages", () => {
  assert.deepEqual(extractCustomerPreferencesFromText("   "), []);
});
