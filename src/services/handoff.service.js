import { randomUUID } from "node:crypto";
import { dbPool, isDatabaseConfigured } from "../config/database.js";

const VALID_SKILL = /^[a-zA-Z0-9_-]{1,50}$/;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

function validId(value) {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value);
}

function cleanText(value, max) {
  if (typeof value !== "string") throw new Error("Invalid text");
  const text = value.trim();
  if (!text || text.length > max) throw new Error("Invalid text");
  return text;
}

function normalizeSkill(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !VALID_SKILL.test(value.trim())) throw new Error("Invalid skill");
  return value.trim().toLowerCase();
}

function normalizeSkills(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Invalid skills");
  return [...new Set(value.map(normalizeSkill).filter(Boolean))];
}

export async function setUserSkills(tenantId, userId, skills) {
  assertDatabase();
  if (!validId(tenantId) || !validId(userId)) throw new Error("Invalid identifier");
  const normalized = normalizeSkills(skills);
  const result = await dbPool.query(
    `UPDATE users SET skills = $3::jsonb, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING id, skills`,
    [tenantId, userId, JSON.stringify(normalized)],
  );
  if (!result.rows[0]) throw new Error("User not found");
  return result.rows[0];
}

export async function getHandoffState(tenantId, conversationId) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  const result = await dbPool.query(
    `SELECT c.id, c.status, c.ai_paused, c.ai_paused_at, c.ai_paused_by,
            c.handoff_reason, c.handoff_at, c.assigned_skill, c.assigned_user_id,
            u.email AS assigned_user_email
     FROM conversations c
     LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.assigned_user_id
     WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId],
  );
  return result.rows[0] || null;
}

async function buildConversationSummary(client, tenantId, conversationId) {
  const result = await client.query(
    `SELECT direction, text, created_at
     FROM messages
     WHERE tenant_id = $1 AND conversation_id = $2
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 30
     FOR SHARE`,
    [tenantId, conversationId],
  );
  const lines = result.rows.reverse().map((row) => {
    const speaker = row.direction === "inbound" ? "Customer" : "AI/Agent";
    return `${speaker}: ${String(row.text || "").slice(0, 600)}`;
  });
  return cleanText(
    lines.length ? lines.join("\n") : "No message history is available.",
    8000,
  );
}

export async function handoffConversation(tenantId, conversationId, userId, reason = "human_requested", skill = null) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId) || !validId(userId)) throw new Error("Invalid identifier");
  const normalizedSkill = normalizeSkill(skill);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await client.query(
      `SELECT id FROM conversations
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, conversationId],
    );
    if (!conversation.rowCount) throw new Error("Conversation not found");

    const user = await client.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
      [tenantId, userId],
    );
    if (!user.rowCount) throw new Error("User not found");

    const summary = await buildConversationSummary(client, tenantId, conversationId);
    const result = await client.query(
      `UPDATE conversations
       SET status = 'human', ai_paused = TRUE, ai_paused_at = NOW(),
           ai_paused_by = $3, handoff_reason = $4, handoff_at = NOW(),
           assigned_skill = COALESCE($5, assigned_skill), updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, status, ai_paused, ai_paused_at, ai_paused_by,
                 handoff_reason, handoff_at, assigned_skill, assigned_user_id`,
      [tenantId, conversationId, userId, cleanText(reason, 500), normalizedSkill],
    );
    await client.query(
      `INSERT INTO conversation_ai_summaries (tenant_id, conversation_id, summary, trigger)
       VALUES ($1, $2, $3, 'handoff')`,
      [tenantId, conversationId, summary],
    );
    await client.query("COMMIT");
    return { conversation: result.rows[0], summary };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function pauseAi(tenantId, conversationId, userId, reason = "human_requested") {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId) || !validId(userId)) throw new Error("Invalid identifier");
  const result = await dbPool.query(
    `UPDATE conversations
     SET ai_paused = TRUE, ai_paused_at = NOW(), ai_paused_by = $3,
         status = CASE WHEN status = 'archived' THEN status ELSE 'human' END,
         handoff_reason = $4, handoff_at = COALESCE(handoff_at, NOW()), updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
       AND EXISTS (SELECT 1 FROM users WHERE tenant_id = $1 AND id = $3 AND status = 'active')
     RETURNING id, status, ai_paused, ai_paused_at, ai_paused_by, handoff_reason`,
    [tenantId, conversationId, userId, cleanText(reason, 500)],
  );
  if (!result.rows[0]) throw new Error("Conversation or user not found");
  return result.rows[0];
}

export async function resumeAi(tenantId, conversationId, userId) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId) || !validId(userId)) throw new Error("Invalid identifier");
  const result = await dbPool.query(
    `UPDATE conversations
     SET ai_paused = FALSE, ai_paused_at = NULL, ai_paused_by = NULL,
         status = CASE WHEN status = 'human' THEN 'active' ELSE status END,
         handoff_reason = NULL, handoff_at = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
       AND EXISTS (SELECT 1 FROM users WHERE tenant_id = $1 AND id = $3 AND status = 'active')
     RETURNING id, status, ai_paused, assigned_user_id`,
    [tenantId, conversationId, userId],
  );
  if (!result.rows[0]) throw new Error("Conversation or user not found");
  return result.rows[0];
}

export async function assignConversationRoundRobin(tenantId, conversationId, skill = null) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  const normalizedSkill = normalizeSkill(skill);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await client.query(
      `SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, conversationId],
    );
    if (!conversation.rowCount) throw new Error("Conversation not found");

    const skillCondition = normalizedSkill
      ? "AND skills @> $3::jsonb"
      : "";
    const params = normalizedSkill ? [tenantId, normalizedSkill, JSON.stringify([normalizedSkill])] : [tenantId];
    const candidates = await client.query(
      `SELECT id, email
       FROM users
       WHERE tenant_id = $1 AND status = 'active'
         ${skillCondition}
       ORDER BY last_assigned_at NULLS FIRST, last_assigned_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      params,
    );
    if (!candidates.rows[0]) throw new Error("No active agent available for this skill");

    const agent = candidates.rows[0];
    await client.query(
      `UPDATE users SET last_assigned_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, agent.id],
    );
    const updated = await client.query(
      `UPDATE conversations
       SET assigned_user_id = $3, assigned_skill = COALESCE($4, assigned_skill),
           status = 'human', ai_paused = TRUE, ai_paused_at = COALESCE(ai_paused_at, NOW()),
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, assigned_user_id, assigned_skill, status, ai_paused`,
      [tenantId, conversationId, agent.id, normalizedSkill],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveCopilotDraft(
  tenantId,
  conversationId,
  userId,
  draft,
  usageEventKey = null,
  { sourceMessageIds = [], expectedSummaryId = undefined } = {},
) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId) || !validId(userId)) throw new Error("Invalid identifier");
  if (usageEventKey !== null && !validId(usageEventKey)) throw new Error("Invalid AI usage event key");
  if (!Array.isArray(sourceMessageIds) || sourceMessageIds.some((id) => !validId(id))) {
    throw new Error("Invalid Copilot source message identifiers");
  }
  if (expectedSummaryId !== undefined && expectedSummaryId !== null && !validId(expectedSummaryId)) {
    throw new Error("Invalid Copilot summary identifier");
  }

  const text = cleanText(draft, 8000);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    // Serialize draft persistence with handoff and deletion paths. Deletion
    // takes the same conversation lock, then marks a source deleted and purges
    // derived drafts in its transaction. It therefore cannot slip between the
    // source recheck and INSERT.
    const conversation = await client.query(
      "SELECT id FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, conversationId],
    );
    if (!conversation.rowCount) throw new Error("Conversation not found");

    const user = await client.query(
      "SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND status='active'",
      [tenantId, userId],
    );
    if (!user.rowCount) throw new Error("User not found");

    if (sourceMessageIds.length > 0) {
      const sources = await client.query(
        `SELECT id FROM messages
         WHERE tenant_id=$1 AND conversation_id=$2
           AND id=ANY($3::uuid[]) AND deleted_at IS NULL
         FOR SHARE`,
        [tenantId, conversationId, sourceMessageIds],
      );
      if (sources.rowCount !== new Set(sourceMessageIds).size) {
        throw new Error("Conversation messages changed or were deleted while drafting; retry");
      }
    }

    if (expectedSummaryId !== undefined) {
      const latest = await client.query(
        `SELECT id FROM conversation_ai_summaries
         WHERE tenant_id=$1 AND conversation_id=$2
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId, conversationId],
      );
      if ((latest.rows[0]?.id ?? null) !== expectedSummaryId) {
        throw new Error("Conversation summary changed while drafting; retry");
      }
    }

    const result = await client.query(
      `INSERT INTO ai_copilot_drafts
         (tenant_id, conversation_id, author_user_id, draft, usage_event_key)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, conversation_id, author_user_id, draft, status, created_at`,
      [tenantId, conversationId, userId, text, usageEventKey],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCopilotDrafts(tenantId, conversationId, limit = 20) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  const safeLimit = Number.isInteger(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 50) : 20;
  const result = await dbPool.query(
    `SELECT id, conversation_id, author_user_id, draft, status, created_at, updated_at
     FROM ai_copilot_drafts
     WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [tenantId, conversationId, safeLimit],
  );
  return result.rows;
}

export async function getLatestHandoffSummary(tenantId, conversationId) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  const result = await dbPool.query(
    `SELECT id, summary, trigger, created_at
     FROM conversation_ai_summaries
     WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId],
  );
  return result.rows[0] || null;
}

export function buildCopilotContext({ summary, lastMessages = [] } = {}) {
  const messages = Array.isArray(lastMessages) ? lastMessages.slice(-12) : [];
  return {
    summary: typeof summary === "string" ? summary.slice(0, 4000) : "",
    recentMessages: messages.map((item) => ({
      speaker: item?.direction === "inbound" ? "customer" : "agent",
      text: String(item?.text || "").slice(0, 500),
    })),
  };
}

export function createDraftId() {
  return randomUUID();
}
