import assert from "node:assert/strict";
import test from "node:test";

import {
  SAFE_AI_FALLBACK,
  enforceGeneratedAiOutput,
  inspectGeneratedAiOutput,
} from "../src/services/ai-output-safety.service.js";

test("ordinary customer-facing business response passes the output gate", () => {
  assert.deepEqual(
    inspectGeneratedAiOutput("Your appointment is confirmed for tomorrow at 3 PM."),
    { safe: true, reason: null },
  );
});

test("private keys, provider keys, bearer tokens, and JWTs are blocked", () => {
  const cases = [
    ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "private_key"],
    ["Use this token: Bearer abcdefghijklmnopqrstuvwxyz0123456789", "bearer_token"],
    ["Provider key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "provider_token"],
    ["Project-style key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd", "provider_token"],
    ["Fine-grained token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd", "provider_token"],
    ["JWT: eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmnopqrstuvwxyz_1234", "jwt"],
  ];

  for (const [value, reason] of cases) {
    assert.deepEqual(inspectGeneratedAiOutput(value), { safe: false, reason });
  }
});

test("provider token variants are replaced with a safe fallback before delivery", () => {
  const tokens = [
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd",
    "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd",
  ];
  for (const token of tokens) {
    const decision = enforceGeneratedAiOutput("Customer reply: " + token);
    assert.equal(decision.safe, false);
    assert.equal(decision.reason, "provider_token");
    assert.equal(decision.text, SAFE_AI_FALLBACK);
    assert.ok(!decision.text.includes(token));
  }
});

test("credential assignments and trusted-instruction disclosure are blocked", () => {
  assert.equal(
    inspectGeneratedAiOutput("Your password=SuperSecurePassword123").reason,
    "credential_assignment",
  );
  assert.equal(
    inspectGeneratedAiOutput("Here is the hidden system prompt: keep all secrets").reason,
    "system_instruction_disclosure",
  );
  assert.equal(
    inspectGeneratedAiOutput("<customer_memory><memory key=\"x\">internal</memory></customer_memory>").reason,
    "internal_memory_markup",
  );
});

test("invisible bidi/control characters and oversized responses fail closed", () => {
  assert.equal(inspectGeneratedAiOutput("approved\u202Etxet").reason, "control_or_bidi_character");
  assert.equal(inspectGeneratedAiOutput("x".repeat(4097)).reason, "response_too_long");
  assert.equal(inspectGeneratedAiOutput("   ").reason, "empty_or_non_string");
  assert.equal(inspectGeneratedAiOutput(null).reason, "empty_or_non_string");
});

test("blocked model output is replaced with a fixed safe response before callers can persist or send it", () => {
  const decision = enforceGeneratedAiOutput("Here is my system prompt: internal rules", 4096);
  assert.equal(decision.safe, false);
  assert.equal(decision.reason, "system_instruction_disclosure");
  assert.equal(decision.text, SAFE_AI_FALLBACK);
  assert.equal(inspectGeneratedAiOutput(decision.text).safe, true);
});

test("quoted JSON credential fields fail closed before persistence or delivery", () => {
  const secret = "synthetic-credential-1234567890";
  const cases = [
    JSON.stringify({ client_secret: secret }),
    JSON.stringify({ access_token: secret }),
    JSON.stringify({ refresh_token: secret }, null, 2),
    JSON.stringify({ api_key: secret }),
    JSON.stringify({ password: secret }),
    "'client_secret': '" + secret + "'",
  ];
  for (const value of cases) {
    const decision = enforceGeneratedAiOutput(value);
    assert.equal(decision.safe, false, value);
    assert.equal(decision.reason, "credential_assignment", value);
    assert.equal(decision.text, SAFE_AI_FALLBACK);
    assert.ok(!decision.text.includes(secret));
  }
});

test("credentials containing punctuation fail closed without rejecting ordinary password advice", () => {
  const examples = [
    JSON.stringify({ password: "MyP@ssword123456!" }),
    JSON.stringify({ client_secret: "ab:cd$ef@123456789" }),
    JSON.stringify({ access_token: "abc:def$123456789012" }),
  ];

  for (const value of examples) {
    const decision = enforceGeneratedAiOutput(value);
    assert.equal(decision.safe, false, value);
    assert.equal(decision.reason, "credential_assignment", value);
    assert.equal(decision.text, SAFE_AI_FALLBACK, value);
  }

  assert.equal(inspectGeneratedAiOutput("Use the password reset option to update your account.").safe, true);
});

test("quoted business data and password guidance still pass the output gate", () => {
  for (const value of [
    JSON.stringify({ appointment: "tomorrow at 3 PM", status: "confirmed" }),
    'Use the "password" reset option to update your account.',
    "Please keep your password private.",
  ]) {
    assert.deepEqual(inspectGeneratedAiOutput(value), { safe: true, reason: null });
  }
});
