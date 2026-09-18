import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTOMATION_WEBHOOK_ALLOWLIST = "example.com";

const { normalizeWorkflowDefinition } = await import("../src/services/automation.service.js");

test("normalizes supported workflow actions", () => {
  const w = normalizeWorkflowDefinition({
    steps: [
      { action: "send_message", body: "Hi" },
      { action: "wait", seconds: 60 },
      { action: "add_tag", tag: "lead" },
      { action: "condition", field: "customer.name", operator: "exists" },
      { action: "webhook", url: "https://example.com/hook" },
    ],
  });
  assert.equal(w.steps.length, 5);
  assert.equal(w.steps[0].body, "Hi");
});

test("rejects insecure and non-allowlisted webhooks", () => {
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "webhook", url: "http://example.com" }] }),
    /HTTPS/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "webhook", url: "https://127.0.0.1/hook" }] }),
    /allowlisted/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "webhook", url: "https://evil.example/hook" }] }),
    /allowlisted/,
  );
});

test("bounds workflow size, delay, message, and URL", () => {
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: Array.from({ length: 51 }, () => ({ action: "wait", seconds: 1 })) }),
    /too many/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "wait", seconds: 2592001 }] }),
    /delay/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "send_message", body: "x".repeat(4097) }] }),
    /text/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "webhook", url: "https://example.com/" + "a".repeat(2048) }] }),
    /text|Invalid webhook URL/,
  );
});

test("rejects unsupported actions and invalid condition operators", () => {
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "delete_database" }] }),
    /Unsupported/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ steps: [{ action: "condition", field: "x", operator: "regex" }] }),
    /condition operator/,
  );
});
