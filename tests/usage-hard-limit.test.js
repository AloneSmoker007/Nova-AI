import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(testsDirectory, "../src");

const usageService = await import("../src/services/usage.service.js");
const indexSource = await fs.readFile(path.join(sourceDirectory, "index.js"), "utf8");
const usageSource = await fs.readFile(
  path.join(sourceDirectory, "services", "usage.service.js"),
  "utf8",
);
const ocrSource = await fs.readFile(
  path.join(sourceDirectory, "services", "ocr.service.js"),
  "utf8",
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `source marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `source marker not found: ${endMarker}`);
  return source.slice(start, end);
}

test("hard-limit decision: disabled limit never blocks the AI path", () => {
  const decision = usageService.evaluateHardLimit({ hardLimitEnabled: false, used: 5000, limit: 100 });
  assert.equal(decision.allowed, true);
});

test("hard-limit decision: enabled limit allows usage strictly below the limit", () => {
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 99, limit: 100 }).allowed, true);
});

test("hard-limit decision: enabled limit blocks at and above the limit", () => {
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 100, limit: 100 }).allowed, false);
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 250, limit: 100 }).allowed, false);
});

test("hard-limit decision: non-numeric usage never blocks or crashes the decision", () => {
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: undefined, limit: 100 }).allowed, true);
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: Number.NaN, limit: 0 }).allowed, false);
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 100, limit: undefined }).allowed, false);
});

test("hard-limit decision: percent is reported for observability", () => {
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 50, limit: 100 }).percent, 50);
  assert.equal(usageService.evaluateHardLimit({ hardLimitEnabled: true, used: 50, limit: 0 }).percent, 100);
});

test("AI usage event keys are stable per message and distinct from inbound usage keys", () => {
  assert.equal(
    usageService.aiUsageEventKey({ messageId: "m-1", whatsappMessageId: "wamid.abc" }),
    "ai_message:wamid.abc",
  );
  // Retries of the same message resolve to the same key → idempotent reservation.
  assert.equal(
    usageService.aiUsageEventKey({ messageId: "m-1", whatsappMessageId: "wamid.abc" }),
    usageService.aiUsageEventKey({ messageId: "m-1", whatsappMessageId: "wamid.abc" }),
  );
  // Missing WhatsApp id falls back to the persisted message id.
  assert.equal(usageService.aiUsageEventKey({ messageId: "m-1" }), "ai_message:m-1");
  assert.notEqual(
    usageService.aiUsageEventKey({ messageId: "m-1", whatsappMessageId: "wamid.abc" }),
    "wamid.abc",
  );
});

test("hard-limit gate runs before any AI context work or the Gemini call", () => {
  const gate = sliceBetween(indexSource, "Hard usage limit gate", "let brain = null;");
  assert.ok(gate.includes("reserveAiUsage"), "gate must reserve AI usage");
  assert.ok(gate.includes("!aiReservation.allowed"), "gate must branch on the reservation decision");

  const gateReserve = indexSource.indexOf("reserveAiUsage({");
  assert.ok(gateReserve > 0, "reserveAiUsage must be called in the worker");
  assert.ok(
    indexSource.indexOf("getBusinessBrain(message.tenant_id)") > gateReserve,
    "Business Brain must load after the usage gate",
  );
  assert.ok(
    indexSource.indexOf("generateGeminiReply(message.body") > gateReserve,
    "Gemini must be invoked after the usage gate",
  );
  assert.ok(
    indexSource.indexOf("buildAdvancedAiContext(") > gateReserve,
    "advanced AI context must be built after the usage gate",
  );
  assert.ok(
    indexSource.indexOf("analyzeCustomerMessage(") > gateReserve,
    "AI signal analysis must run after the usage gate",
  );
});

test("blocked AI attempts take the safe human-handoff fallback and are not double-counted", () => {
  const blockedPath = sliceBetween(indexSource, "!aiReservation.allowed", "let brain = null;");
  assert.ok(
    blockedPath.includes("markCompleted(message.id, message.tenant_id, leaseToken, null)"),
    "blocked messages must complete the durable inbox without a generated response",
  );
  assert.ok(
    blockedPath.includes("return;"),
    "blocked messages must not continue into the Gemini flow",
  );
  // The blocked path must reserve nothing new: between the limit decision and
  // the reservation INSERT there is only a ROLLBACK and the refusal return, so
  // a refused attempt consumes no quota at all.
  const reserve = usageSource.slice(
    usageSource.indexOf("export async function reserveAiUsage"),
    usageSource.indexOf("export async function releaseAiUsage"),
  );
  const refusedBranch = reserve.slice(
    reserve.indexOf("if (!decision.allowed) {"),
    reserve.indexOf("INSERT INTO usage_events"),
  );
  assert.ok(
    refusedBranch.includes('client.query("ROLLBACK")'),
    "refused reservations must roll back",
  );
  assert.ok(
    refusedBranch.includes("return { allowed: false"),
    "refused reservations must return without reserving",
  );
  assert.ok(
    !refusedBranch.includes("INSERT INTO usage_events"),
    "refused reservations must not insert a usage event",
  );
});

test("any post-reservation pre-success AI failure releases the reservation", () => {
  const aiSection = sliceBetween(
    indexSource,
    "Hard usage limit gate",
    "if (message.provider_message_id)",
  );
  const reservation = aiSection.indexOf("reserveAiUsage({");
  const cleanup = aiSection.lastIndexOf("releaseAiUsage({");
  const generation = aiSection.indexOf("generateGeminiReply(message.body");
  const save = aiSection.indexOf("saveGeneratedResponse(");

  assert.ok(reservation >= 0, "AI flow must reserve usage before provider work");
  assert.ok(cleanup > reservation, "AI flow must release usage after a reservation failure path");
  assert.ok(generation > reservation, "Gemini must run after reservation");
  assert.ok(save > generation, "generated response must be durably saved after Gemini");
  assert.ok(
    aiSection.slice(cleanup).includes("throw aiError;"),
    "cleanup path must rethrow so durable inbox retry semantics are preserved",
  );
});

test("failed AI generations release the reservation so retries are not double-billed", () => {
  const guardedCall = sliceBetween(
    indexSource,
    "reply = await generateGeminiReply(message.body, aiBrain);",
    "Failed to release reserved AI usage",
  );
  assert.ok(
    guardedCall.includes("releaseAiUsage"),
    "generation failure must release the reservation",
  );
  assert.ok(
    indexSource.includes("throw aiError;"),
    "generation failure must still fail the attempt",
  );
});

test("reservation is idempotent for durable-inbox retries and race-safe per tenant", () => {
  const reserve = sliceBetween(usageSource, "export async function reserveAiUsage", "export async function releaseAiUsage");
  assert.ok(
    reserve.includes("SELECT id FROM usage_events") && reserve.includes("LIMIT 1"),
    "an existing reservation must short-circuit as a duplicate",
  );
  assert.ok(
    reserve.includes("{ allowed: true, duplicate: true }"),
    "duplicate reservations must allow generation without double-counting",
  );
  assert.ok(
    reserve.includes("FOR UPDATE"),
    "the tenant row must be locked so concurrent messages cannot overshoot the limit",
  );
  assert.ok(
    reserve.includes("ON CONFLICT (tenant_id, event_key) DO NOTHING"),
    "the insert must lean on the existing usage_events idempotency index",
  );
  assert.ok(
    reserve.includes("getUsageSummary(tenantId, { client })"),
    "the limit check must read usage inside the reservation transaction",
  );
});

test("AI usage reservation and release remain strictly tenant-scoped", () => {
  const reserve = sliceBetween(usageSource, "export async function reserveAiUsage", "export async function releaseAiUsage");
  const release = sliceBetween(usageSource, "export async function releaseAiUsage", "return { released: result.rowCount > 0 };");
  assert.ok(
    reserve.includes("WHERE tenant_id = $1 AND event_key = $2"),
    "duplicate detection must be tenant-scoped",
  );
  assert.ok(
    release.includes("WHERE tenant_id = $1 AND event_key = $2 AND event_type = $3"),
    "release must be tenant-scoped and restricted to the reservation's own event type",
  );
  assert.ok(
    reserve.includes("FROM tenants") && reserve.includes("WHERE id = $1"),
    "the serialization lock must target the message's own tenant row",
  );
  assert.ok(
    usageSource.includes("ON CONFLICT (tenant_id, event_key)"),
    "idempotency itself is composite-keyed per tenant",
  );
});

test("usage gate and fallback never log message bodies or AI content", () => {
  const gate = sliceBetween(indexSource, "Hard usage limit gate", "let brain = null;");
  assert.ok(!gate.includes("message.body"), "gate logging must not include the customer message body");
  const blockedPath = sliceBetween(indexSource, "!aiReservation.allowed", "let brain = null;");
  assert.ok(!blockedPath.includes("message.body"), "blocked-path logging must not include customer content");
});

test("every billable Gemini operation shares the existing monthly AI limit", () => {
  assert.deepEqual(
    [...usageService.AI_EVENT_TYPES].sort(),
    ["ai_message", "assistant_query", "copilot_draft", "ocr_document"],
    "copilot and OCR must be billable AI event types",
  );
  const reserve = usageSource.slice(
    usageSource.indexOf("export async function reserveAiUsage"),
    usageSource.indexOf("export async function releaseAiUsage"),
  );
  assert.ok(
    reserve.includes('type = "ai_message"'),
    "reservation type must default to the H1 inbound event so the worker needs no changes",
  );
  assert.ok(
    reserve.includes("summary.usage.aiMessages") && reserve.includes("summary.limits.monthly_ai_message_limit"),
    "every AI event type must consume the shared monthly_ai_message_limit",
  );
  assert.ok(
    reserve.includes("conversationId || null"),
    "OCR reservations must tolerate missing conversation context",
  );
});

test("inbound AI reservations keep deterministic retry keys; other types use per-call keys", () => {
  assert.equal(
    usageService.aiUsageEventKeyForType("ai_message", { whatsappMessageId: "wam.id.1" }),
    "ai_message:wam.id.1",
    "inbound retries must derive the same key so they never double-count",
  );
  const key = usageService.aiUsageEventKeyForType("ocr_document");
  assert.ok(key.startsWith("ocr_document:"), "non-inbound keys must be namespaced by event type");
  assert.notEqual(key, usageService.aiUsageEventKeyForType("ocr_document"), "per-call keys must be unique");
});

test("copilot draft route reserves quota before any context work or Gemini call", () => {
  const route = sliceBetween(indexSource, 'copilot/draft", requireAuth', 'app.put("/api/users/me/skills"');
  const reserveAt = route.indexOf("reserveAiUsage({");
  assert.ok(reserveAt > -1, "copilot route must reserve AI usage");
  assert.ok(route.includes('type: "copilot_draft"'), "copilot reservations must use the copilot_draft event type");
  assert.ok(
    route.indexOf("getConversationMessages") > reserveAt && route.indexOf("getBusinessBrain") > reserveAt,
    "context work must happen after the reservation",
  );
  assert.ok(route.indexOf("generateGeminiReply") > reserveAt, "Gemini must be invoked after the reservation");
  assert.ok(route.includes("status(429)"), "blocked copilot drafts must return 429 without calling Gemini");
  assert.ok(
    route.indexOf("releaseAiUsage({") > route.indexOf("generateGeminiReply") &&
      route.includes('eventKey: aiReservation.eventKey, type: "copilot_draft"'),
    "any post-reservation copilot failure must release its own reservation",
  );
});

test("OCR extraction reserves quota before the Gemini call and releases on failure", () => {
  const extract = sliceBetween(
    ocrSource,
    "export async function extractTextFromDocument",
    "export async function listOcrDocuments",
  );
  const reserveAt = extract.indexOf("reserveAiUsage({");
  assert.ok(reserveAt > -1, "OCR must reserve AI usage");
  assert.ok(extract.includes('type: "ocr_document"'), "OCR reservations must use the ocr_document event type");
  const validation = extract.slice(0, reserveAt);
  assert.ok(
    validation.includes("MAX_IMAGE_BYTES") && validation.includes("hasValidMagicBytes"),
    "upload validation must stay ahead of the reservation so rejected uploads consume nothing",
  );
  assert.ok(extract.indexOf("generateContent") > reserveAt, "Gemini must be invoked after the reservation");
  assert.ok(
    extract.indexOf('throw new Error("AI usage hard limit reached")') > reserveAt,
    "blocked OCR must fail before any provider call",
  );
  assert.ok(
    extract.includes("releaseAiUsage({") &&
      extract.includes('eventKey: aiReservation.eventKey, type: "ocr_document"'),
    "any post-reservation OCR failure must release its own reservation",
  );
});

test("the dev-only Gemini test route stays out of production builds", () => {
  const devSection = sliceBetween(indexSource, "if (!IS_PRODUCTION)", "app.use((req, res) => res.status(404)");
  assert.ok(
    devSection.includes("/api/test/gemini"),
    "the un-gated Gemini test route must only exist behind the IS_PRODUCTION guard",
  );
});

