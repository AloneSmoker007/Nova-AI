import { randomUUID } from "node:crypto";
import { dbPool, isDatabaseConfigured } from "../config/database.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

function validTenantId(value) {
  return typeof value === "string" && value.trim() !== "";
}

// AI usage is metered once per inbound WhatsApp message. The key mirrors the
// inbound usage contract but uses a distinct event-type prefix so a blocked or
// retried AI attempt can never collide with (or be counted as) an inbound event.
export function aiUsageEventKey({ messageId, whatsappMessageId }) {
  return `ai_message:${whatsappMessageId || messageId}`;
}

// Every billable Gemini operation — inbound auto-reply, agent copilot draft,
// and OCR extraction — shares the tenant's existing monthly AI limit
// (monthly_ai_message_limit) under the existing hard_limit_enabled flag.
// Distinct event types keep operations auditable without introducing new
// billing plans; extending this list requires no schema migration.
export const AI_EVENT_TYPES = ["ai_message", "copilot_draft", "ocr_document", "assistant_query"];

function isAiEventType(type) {
  return AI_EVENT_TYPES.includes(type);
}

// Copilot and OCR operations have no provider-side message id; each call
// reserves its own event with a collision-free random key. Inbound messages
// keep the H1 key so durable-inbox retries stay idempotent.
export function aiUsageEventKeyForType(type, { messageId, whatsappMessageId } = {}) {
  if (type === "ai_message") return aiUsageEventKey({ messageId, whatsappMessageId });
  return `${type}:${randomUUID()}`;
}

export async function registerInboundUsage({
  tenantId,
  conversationId,
  messageId,
  whatsappMessageId,
  occurredAt = new Date(),
  eventType = "inbound_message",
}) {
  assertDatabase();
  if (!validTenantId(tenantId) || !validTenantId(conversationId) || !validTenantId(messageId)) {
    throw new Error("Missing usage identifiers");
  }

  const eventTime = new Date(occurredAt);
  if (Number.isNaN(eventTime.getTime())) throw new Error("Invalid usage timestamp");

  const eventKey = `${eventType}:${whatsappMessageId || messageId}`;
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const conversation = await client.query(
      `SELECT id, free_until
       FROM conversations
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, conversationId],
    );
    if (!conversation.rows[0]) throw new Error("Conversation not found");

    const existingEvent = await client.query(
      `SELECT id FROM usage_events
       WHERE tenant_id = $1 AND event_key = $2
       LIMIT 1`,
      [tenantId, eventKey],
    );

    if (existingEvent.rowCount > 0) {
      await client.query("COMMIT");
      return { duplicate: true, countedConversation: false, windowExpiresAt: conversation.rows[0].free_until };
    }

    const previousExpiry = conversation.rows[0].free_until
      ? new Date(conversation.rows[0].free_until)
      : null;
    const windowActive = previousExpiry && previousExpiry.getTime() > eventTime.getTime();
    const windowStartedAt = windowActive
      ? new Date(previousExpiry.getTime() - WINDOW_MS)
      : eventTime;
    const windowExpiresAt = new Date(eventTime.getTime() + WINDOW_MS);

    let countedConversation = false;

    if (!windowActive) {
      const windowResult = await client.query(
        `INSERT INTO conversation_windows (
           tenant_id, conversation_id, window_started_at, window_expires_at, source_message_id
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, conversation_id, window_started_at) DO NOTHING
         RETURNING id`,
        [tenantId, conversationId, windowStartedAt, windowExpiresAt, messageId],
      );
      countedConversation = windowResult.rowCount === 1;
    }

    await client.query(
      `INSERT INTO usage_events (
         tenant_id, conversation_id, message_id, event_type, event_key, units, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (tenant_id, event_key) DO NOTHING`,
      [tenantId, conversationId, messageId, eventType, eventKey, eventTime],
    );

    await client.query(
      `UPDATE conversations
       SET conversation_started_at = COALESCE(conversation_started_at, $3),
           free_until = $4,
           last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, conversationId, windowStartedAt, windowExpiresAt],
    );

    await client.query("COMMIT");
    return { duplicate: false, countedConversation, windowStartedAt, windowExpiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getUsageSummary(tenantId, { monthStart = null, client = null } = {}) {
  assertDatabase();
  if (!validTenantId(tenantId)) throw new Error("Invalid tenant ID");

  const start = monthStart ? new Date(monthStart) : new Date();
  if (!monthStart) start.setUTCDate(1), start.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid monthStart");

  // `client` lets callers (reserveAiUsage) read usage inside their own
  // transaction so the count and the reservation share one consistent snapshot.
  const dbc = client || dbPool;

  const result = await dbc.query(
    `SELECT
       COALESCE((SELECT COUNT(*) FROM conversation_windows cw
         WHERE cw.tenant_id = $1 AND cw.created_at >= $2), 0)::int AS conversations,
       COALESCE(SUM(CASE WHEN ue.event_type IN ('ai_message', 'copilot_draft', 'ocr_document') THEN ue.units ELSE 0 END), 0)::int AS ai_messages,
       COALESCE(SUM(CASE WHEN ue.event_type = 'media_message' THEN ue.units ELSE 0 END), 0)::int AS media_messages
     FROM usage_events ue
     WHERE ue.tenant_id = $1 AND ue.created_at >= $2`,
    [tenantId, start],
  );

  const plan = await dbc.query(
    `SELECT monthly_conversation_limit, monthly_ai_message_limit,
            monthly_media_limit, warning_percent, hard_limit_enabled
     FROM tenant_usage_plans WHERE tenant_id = $1`,
    [tenantId],
  );

  const row = result.rows[0];
  const limits = plan.rows[0] || {
    monthly_conversation_limit: 1000,
    monthly_ai_message_limit: 5000,
    monthly_media_limit: 1000,
    warning_percent: 80,
    hard_limit_enabled: true,
  };

  return { periodStart: start, usage: {
    conversations: Number(row.conversations),
    aiMessages: Number(row.ai_messages),
    mediaMessages: Number(row.media_messages),
  }, limits };
}

// Single source of truth for hard-limit decisions. The read-only API
// (isUsageAllowed) and the atomic reservation path (reserveAiUsage) must
// evaluate limits identically.
export function evaluateHardLimit({ hardLimitEnabled, used, limit }) {
  const usedCount = Number.isFinite(Number(used)) ? Number(used) : 0;
  const limitCount = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  return {
    allowed: !hardLimitEnabled || usedCount < limitCount,
    used: usedCount,
    limit: limitCount,
    percent: limitCount > 0 ? Math.round((usedCount / limitCount) * 100) : 100,
  };
}

export async function isUsageAllowed(tenantId, type = "conversations") {
  const summary = await getUsageSummary(tenantId);
  const key = type === "ai_messages" ? "aiMessages" : type === "media_messages" ? "mediaMessages" : "conversations";
  const limitKey = type === "ai_messages"
    ? "monthly_ai_message_limit"
    : type === "media_messages" ? "monthly_media_limit" : "monthly_conversation_limit";
  const decision = evaluateHardLimit({
    hardLimitEnabled: summary.limits.hard_limit_enabled,
    used: summary.usage[key],
    limit: summary.limits[limitKey],
  });
  return {
    ...decision,
    warning:
      decision.limit > 0 &&
      decision.used >= Math.ceil(decision.limit * (Number(summary.limits.warning_percent) / 100)),
  };
}

// Atomically checks the tenant's monthly AI hard limit and reserves the usage
// event BEFORE any Gemini invocation. Concurrency safety: the tenants row
// is locked FOR UPDATE, so concurrent reservations for the same tenant
// serialize and cannot all pass the check-then-insert window; the existing
// (tenant_id, event_key) unique index keeps retries idempotent. The reservation
// itself is the metering record — no second counting system is introduced.
// `type` selects the billable Gemini operation (see AI_EVENT_TYPES); the
// default preserves the H1 inbound-message behavior.
export async function reserveAiUsage({ tenantId, conversationId, messageId, whatsappMessageId, type = "ai_message" } = {}) {
  if (!isAiEventType(type)) throw new Error("Invalid AI usage event type");
  assertDatabase();
  if (!validTenantId(tenantId)) throw new Error("Invalid tenant ID");
  if (type === "ai_message") {
    if (!validTenantId(conversationId)) throw new Error("Invalid conversation ID");
    if (!validTenantId(whatsappMessageId || messageId)) throw new Error("Missing usage identifiers");
  } else if (type === "copilot_draft") {
    if (!validTenantId(conversationId)) throw new Error("Invalid conversation ID");
  }
  // ocr_document carries no conversation/message context; both stay NULL.

  const eventKey = type === "assistant_query" ? `assistant_query:${randomUUID()}` : aiUsageEventKeyForType(type, { messageId, whatsappMessageId });
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    // Tenant-wide monthly limit → tenant-wide serialization point.
    const tenantLock = await client.query(
      `SELECT id FROM tenants
       WHERE id = $1
       FOR UPDATE`,
      [tenantId],
    );
    if (tenantLock.rowCount === 0) throw new Error("Tenant not found");

    const existingEvent = await client.query(
      `SELECT id FROM usage_events
       WHERE tenant_id = $1 AND event_key = $2
       LIMIT 1`,
      [tenantId, eventKey],
    );
    if (existingEvent.rowCount > 0) {
      // This message already holds its AI reservation (durable-inbox retry
      // after a crash mid-generation). Never self-block, never double-count.
      await client.query("COMMIT");
      return { allowed: true, duplicate: true };
    }

    const summary = await getUsageSummary(tenantId, { client });
    const decision = evaluateHardLimit({
      hardLimitEnabled: summary.limits.hard_limit_enabled,
      used: summary.usage.aiMessages,
      limit: summary.limits.monthly_ai_message_limit,
    });

    if (!decision.allowed) {
      await client.query("ROLLBACK");
      return { allowed: false, used: decision.used, limit: decision.limit, percent: decision.percent };
    }

    await client.query(
      `INSERT INTO usage_events (
         tenant_id, conversation_id, message_id, event_type, event_key, units, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 1, NOW())
       ON CONFLICT (tenant_id, event_key) DO NOTHING`,
      [tenantId, conversationId || null, messageId || null, type, eventKey],
    );

    await client.query("COMMIT");
    return { allowed: true, duplicate: false, used: decision.used + 1, limit: decision.limit, eventKey };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Releases a reservation whose AI operation failed so failed attempts do not
// consume the tenant's monthly AI quota. Safe to call when no reservation
// exists; a durable-inbox retry reserves again on its next attempt. The
// release is restricted to the reservation's own event type so releasing one
// operation can never delete another operation's reservation.
export async function releaseAiUsage({ tenantId, messageId, whatsappMessageId, eventKey, type = "ai_message" } = {}) {
  if (!isAiEventType(type)) throw new Error("Invalid AI usage event type");
  assertDatabase();
  if (!validTenantId(tenantId)) throw new Error("Invalid tenant ID");

  const key = eventKey || aiUsageEventKeyForType(type, { messageId, whatsappMessageId });
  if (!validTenantId(key)) throw new Error("Missing usage identifiers");

  const result = await dbPool.query(
    `DELETE FROM usage_events
     WHERE tenant_id = $1 AND event_key = $2 AND event_type = $3`,
    [tenantId, key, type],
  );
  return { released: result.rowCount > 0 };
}
