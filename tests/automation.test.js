import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.AUTOMATION_WEBHOOK_ALLOWLIST = "example.com";
process.env.DATABASE_URL ||= "postgres://automation-test:automation-test@127.0.0.1:1/automation_test";

const { dbPool } = await import("../src/config/database.js");
const { normalizeWorkflowDefinition, triggerWorkflows } = await import("../src/services/automation.service.js");

test.afterEach(() => mock.restoreAll());
test.after(async () => {
  if (dbPool) await dbPool.end();
});

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const workflowId = "33333333-3333-4333-8333-333333333333";

function mockWorkflowDatabase(t) {
  const inserted = [];
  const seen = new Set();
  t.mock.method(dbPool, "query", async (sql, params) => {
    if (sql.includes("SELECT id FROM automation_workflows")) {
      return { rows: [{ id: workflowId }] };
    }
    if (sql.includes("INSERT INTO automation_runs")) {
      const [tenantId, insertedWorkflowId, conversationId, contactId, context, triggerKey] = params;
      inserted.push({ tenantId, workflowId: insertedWorkflowId, conversationId, contactId, context, triggerKey });
      const uniquenessKey = JSON.stringify([tenantId, insertedWorkflowId, triggerKey]);
      if (seen.has(uniquenessKey)) return { rows: [] };
      seen.add(uniquenessKey);
      return { rows: [{ id: `run-${inserted.length}`, tenant_id: tenantId, workflow_id: insertedWorkflowId, trigger_key: triggerKey }] };
    }
    throw new Error(`Unexpected automation query: ${sql}`);
  });
  return inserted;
}

function messageTrigger(tenantId, messageId) {
  return {
    tenantId,
    triggerType: "message_received",
    context: { message: { id: messageId } },
  };
}

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
  assert.equal(w.steps[3].if_true, 4);
  assert.equal(w.steps[3].if_false, 4);
});

test("passes a stable message trigger key so duplicate runs are ignored", async (t) => {
  const inserted = mockWorkflowDatabase(t);
  const first = await triggerWorkflows(messageTrigger(tenantA, "wamid.same"));
  const second = await triggerWorkflows(messageTrigger(tenantA, "wamid.same"));

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.deepEqual(inserted.map((run) => run.triggerKey), ["message_received:wamid.same", "message_received:wamid.same"]);
});

test("database uniqueness protects concurrent duplicate message triggers", async (t) => {
  const inserted = mockWorkflowDatabase(t);
  const [first, second] = await Promise.all([
    triggerWorkflows(messageTrigger(tenantA, "wamid.concurrent")),
    triggerWorkflows(messageTrigger(tenantA, "wamid.concurrent")),
  ]);

  assert.equal(first.length + second.length, 1);
  assert.equal(inserted.length, 2);
  assert.equal(new Set(inserted.map((run) => run.triggerKey)).size, 1);
});

test("different message IDs create separate workflow runs", async (t) => {
  const inserted = mockWorkflowDatabase(t);
  const first = await triggerWorkflows(messageTrigger(tenantA, "wamid.first"));
  const second = await triggerWorkflows(messageTrigger(tenantA, "wamid.second"));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(inserted.map((run) => run.triggerKey), [
    "message_received:wamid.first",
    "message_received:wamid.second",
  ]);
});

test("the same message ID remains tenant-scoped", async (t) => {
  const inserted = mockWorkflowDatabase(t);
  const first = await triggerWorkflows(messageTrigger(tenantA, "wamid.tenant-scoped"));
  const second = await triggerWorkflows(messageTrigger(tenantB, "wamid.tenant-scoped"));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(inserted.map((run) => run.tenantId), [tenantA, tenantB]);
});

test("valid condition targets include the terminal boundary and self-references", () => {
  const terminal = normalizeWorkflowDefinition({
    steps: [
      { action: "condition", field: "customer.name", operator: "exists", if_true: 1, if_false: 0 },
    ],
  });
  assert.equal(terminal.steps[0].if_true, 1);
  assert.equal(terminal.steps[0].if_false, 0);

  const selfReference = normalizeWorkflowDefinition({
    steps: [
      { action: "condition", field: "customer.name", operator: "exists", if_true: 0, if_false: 0 },
    ],
  });
  assert.equal(selfReference.steps[0].if_true, 0);
  assert.equal(selfReference.steps[0].if_false, 0);
});

test("rejects invalid explicit condition targets", () => {
  for (const value of [-1, 2, 1.5, "1", null, undefined]) {
    assert.throws(
      () => normalizeWorkflowDefinition({
        steps: [
          { action: "condition", field: "customer.name", operator: "exists", if_true: value },
        ],
      }),
      /Invalid workflow condition if_true target/,
    );
  }
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

test("validates JSON-safe webhook bodies, including objects and arrays", () => {
  const objectBody = { customer: { name: "Ada", tags: ["lead"] } };
  const normalizedObject = normalizeWorkflowDefinition({
    steps: [{ action: "webhook", url: "https://example.com/hook", body: objectBody }],
  });
  assert.deepEqual(normalizedObject.steps[0].body, objectBody);

  const normalizedArray = normalizeWorkflowDefinition({
    steps: [{ action: "webhook", url: "https://example.com/hook", body: [{ ok: true }, ["nested"]] }],
  });
  assert.deepEqual(normalizedArray.steps[0].body, [{ ok: true }, ["nested"]]);
});

test("accepts nested webhook bodies within the depth limit", () => {
  const body = { level: { next: { value: "ok" } } };
  const normalized = normalizeWorkflowDefinition({
    steps: [{ action: "webhook", url: "https://example.com/hook", body }],
  });
  assert.deepEqual(normalized.steps[0].body, body);
});

test("rejects oversized and excessively deep webhook bodies", () => {
  assert.throws(
    () => normalizeWorkflowDefinition({
      steps: [{ action: "webhook", url: "https://example.com/hook", body: { payload: "x".repeat(16_384) } }],
    }),
    /Webhook body is too large/,
  );

  let body = { value: "too deep" };
  for (let i = 0; i < 20; i++) body = { nested: body };
  assert.throws(
    () => normalizeWorkflowDefinition({
      steps: [{ action: "webhook", url: "https://example.com/hook", body }],
    }),
    /Webhook body nesting is too deep/,
  );
});

test("rejects circular and non-JSON-safe webhook body values", () => {
  const circular = {};
  circular.self = circular;
  const values = [undefined, () => "nope", Symbol("nope"), 1n, Number.NaN, circular];

  for (const body of values) {
    assert.throws(
      () => normalizeWorkflowDefinition({
        steps: [{ action: "webhook", url: "https://example.com/hook", body }],
      }),
      /Invalid webhook body|Webhook body/,
    );
  }
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

test("long-running automation actions keep their run heartbeat alive", async () => {
  const source = await fs.readFile(
    new URL("../src/services/automation.service.js", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("async function withRunHeartbeat(run, action)"));
  assert.ok(source.includes("setInterval(() => { void beat(); }, 30_000)"));
  assert.ok(source.includes("withRunHeartbeat(run, () => executeSendMessage"));
  assert.ok(source.includes("withRunHeartbeat(run, () => executeTag"));
  assert.ok(source.includes("withRunHeartbeat(run, () => executeWebhook"));
  assert.ok(source.includes("UPDATE automation_runs SET updated_at=NOW()"));
});
