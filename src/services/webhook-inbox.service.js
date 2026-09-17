import crypto from "node:crypto";

import { dbPool, isDatabaseConfigured } from "../config/database.js";

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 1000;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }
}

function validateTenantId(tenantId) {
  return typeof tenantId === "string" && tenantId.trim() !== "";
}

function validateInboxId(inboxId) {
  return typeof inboxId === "string" && inboxId.trim() !== "";
}

function normalizeError(error) {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return value.slice(0, MAX_ERROR_LENGTH);
}

export async function ingestWebhookMessage({ message, tenant }) {
  assertDatabase();

  if (!message?.id || !message?.phoneNumberId || !message?.from || !message?.text?.body) {
    throw new Error("Invalid webhook message");
  }

  if (
    !tenant?.tenantId ||
    !tenant?.whatsappNumberId ||
    tenant.phoneNumberId !== message.phoneNumberId
  ) {
    throw new Error("Invalid webhook tenant mapping");
  }

  const tenantId = tenant.tenantId.trim();
  const phoneNumberId = message.phoneNumberId.trim();
  const whatsappMessageId = message.id.trim();
  const waId = message.from.trim();
  const body = message.text.body.trim();

  if (!validateTenantId(tenantId) || !/^\d{5,30}$/.test(phoneNumberId) || !body) {
    throw new Error("Invalid webhook message data");
  }

  const receivedAt = message.timestamp
    ? new Date(Number(message.timestamp) * 1000)
    : new Date();

  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error("Invalid webhook timestamp");
  }

  const result = await dbPool.query(
    "INSERT INTO webhook_messages (" +
      "tenant_id, whatsapp_number_id, phone_number_id, whatsapp_message_id, " +
      "wa_id, profile_name, message_type, body, received_at, state" +
      ") VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, 'RECEIVED') " +
      "ON CONFLICT (tenant_id, whatsapp_message_id) DO UPDATE SET updated_at = NOW() " +
      "RETURNING id, tenant_id, whatsapp_number_id, phone_number_id, " +
      "whatsapp_message_id, wa_id, profile_name, message_type, body, received_at, " +
      "state, attempts, available_at, lease_until, lease_token, last_error, " +
      "generated_response, provider_message_id",
    [
      tenantId,
      tenant.whatsappNumberId,
      phoneNumberId,
      whatsappMessageId,
      waId,
      typeof message.profileName === "string"
        ? message.profileName.trim().slice(0, 255) || null
        : null,
      body.slice(0, 4096),
      receivedAt,
    ],
  );

  return result.rows[0];
}

export async function getInboxMessage(inboxId) {
  assertDatabase();

  if (!validateInboxId(inboxId)) return null;

  const result = await dbPool.query(
    "SELECT * FROM webhook_messages WHERE id = $1 LIMIT 1",
    [inboxId.trim()],
  );

  return result.rows[0] ?? null;
}

export async function claimInboxMessage(inboxId) {
  assertDatabase();

  if (!validateInboxId(inboxId)) {
    return { claimed: false, reason: "invalid" };
  }

  const leaseToken = crypto.randomUUID();
  const result = await dbPool.query(
    "UPDATE webhook_messages SET state = 'PROCESSING', " +
      "attempts = attempts + 1, " +
      "lease_until = NOW() + ($2 * INTERVAL '1 second'), " +
      "lease_token = $3::uuid, updated_at = NOW() " +
      "WHERE id = $1 AND " +
      "(state IN ('RECEIVED', 'QUEUED', 'RETRY_WAIT') OR " +
      "(state = 'PROCESSING' AND lease_until < NOW())) AND " +
      "available_at <= NOW() AND attempts < $4 " +
      "RETURNING *",
    [inboxId.trim(), LEASE_SECONDS, leaseToken, MAX_ATTEMPTS],
  );

  if (result.rowCount === 1) {
    return { claimed: true, leaseToken, message: result.rows[0] };
  }

  const current = await getInboxMessage(inboxId);
  if (!current) return { claimed: false, reason: "invalid" };
  if (current.state === "COMPLETED") return { claimed: false, reason: "completed" };
  if (current.attempts >= MAX_ATTEMPTS || current.state === "DEAD_LETTER") {
    return { claimed: false, reason: "exhausted" };
  }

  return { claimed: false, reason: "processing" };
}

export async function markQueueDispatched(inboxId, tenantId) {
  assertDatabase();

  const result = await dbPool.query(
    "UPDATE webhook_messages SET " +
      "state = CASE WHEN state = 'RECEIVED' THEN 'QUEUED' ELSE state END, " +
      "queue_dispatched_at = NOW(), updated_at = NOW() " +
      "WHERE id = $1 AND tenant_id = $2 " +
      "AND state IN ('RECEIVED', 'QUEUED', 'RETRY_WAIT') " +
      "RETURNING id",
    [inboxId, tenantId],
  );

  return result.rowCount === 1;
}

export async function markRetry(inboxId, tenantId, leaseToken, error) {
  assertDatabase();

  const result = await dbPool.query(
    "UPDATE webhook_messages SET " +
      "state = CASE WHEN attempts >= $5 THEN 'DEAD_LETTER' ELSE 'RETRY_WAIT' END, " +
      "available_at = CASE WHEN attempts >= $5 THEN available_at " +
      "ELSE NOW() + (LEAST(300, POWER(2, GREATEST(attempts - 1, 0)) * 2) * INTERVAL '1 second') END, " +
      "lease_until = NULL, lease_token = NULL, last_error = $4, updated_at = NOW() " +
      "WHERE id = $1 AND tenant_id = $2 AND state = 'PROCESSING' " +
      "AND lease_token = $3::uuid RETURNING state",
    [inboxId, tenantId, leaseToken, normalizeError(error), MAX_ATTEMPTS],
  );

  return result.rowCount === 1 ? result.rows[0].state : null;
}

export async function saveGeneratedResponse(inboxId, tenantId, leaseToken, response) {
  assertDatabase();

  if (typeof response !== "string" || !response.trim()) {
    throw new Error("Generated response is invalid");
  }

  const result = await dbPool.query(
    "UPDATE webhook_messages SET generated_response = COALESCE(generated_response, $4), " +
      "updated_at = NOW() WHERE id = $1 AND tenant_id = $2 " +
      "AND state = 'PROCESSING' AND lease_token = $3::uuid " +
      "RETURNING generated_response",
    [inboxId, tenantId, leaseToken, response.slice(0, 4096)],
  );

  if (result.rowCount !== 1) {
    throw new Error("Inbox lease is no longer valid");
  }

  return result.rows[0].generated_response;
}

export async function recordProviderMessageId(inboxId, tenantId, leaseToken, providerMessageId) {
  assertDatabase();

  if (typeof providerMessageId !== "string" || !providerMessageId.trim()) {
    throw new Error("Provider message ID is invalid");
  }

  const result = await dbPool.query(
    "UPDATE webhook_messages SET provider_message_id = COALESCE(provider_message_id, $4), " +
      "updated_at = NOW() WHERE id = $1 AND tenant_id = $2 " +
      "AND state = 'PROCESSING' AND lease_token = $3::uuid " +
      "RETURNING provider_message_id",
    [inboxId, tenantId, leaseToken, providerMessageId.trim()],
  );

  if (result.rowCount !== 1) {
    throw new Error("Inbox lease is no longer valid");
  }

  return result.rows[0].provider_message_id;
}

export async function markCompleted(inboxId, tenantId, leaseToken, providerMessageId) {
  assertDatabase();

  const result = await dbPool.query(
    "UPDATE webhook_messages SET state = 'COMPLETED', " +
      "provider_message_id = COALESCE($4, provider_message_id), " +
      "lease_until = NULL, lease_token = NULL, completed_at = NOW(), " +
      "last_error = NULL, updated_at = NOW() " +
      "WHERE id = $1 AND tenant_id = $2 AND state = 'PROCESSING' " +
      "AND lease_token = $3::uuid RETURNING id",
    [inboxId, tenantId, leaseToken, providerMessageId || null],
  );

  if (result.rowCount !== 1) {
    throw new Error("Inbox lease is no longer valid");
  }
}

export async function findUndispatchedMessages(limit = 50) {
  assertDatabase();

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await dbPool.query(
    "SELECT id, tenant_id FROM webhook_messages " +
      "WHERE state IN ('RECEIVED', 'RETRY_WAIT') AND available_at <= NOW() " +
      "AND (queue_dispatched_at IS NULL OR " +
      "queue_dispatched_at < NOW() - INTERVAL '30 seconds') " +
      "AND attempts < $1 ORDER BY available_at ASC LIMIT $2",
    [MAX_ATTEMPTS, safeLimit],
  );

  return result.rows;
}

export async function recoverExpiredLeases(limit = 100) {
  assertDatabase();

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const result = await dbPool.query(
    "UPDATE webhook_messages SET " +
      "state = CASE WHEN attempts >= $1 THEN 'DEAD_LETTER' ELSE 'RETRY_WAIT' END, " +
      "available_at = CASE WHEN attempts >= $1 THEN available_at ELSE NOW() END, " +
      "lease_until = NULL, lease_token = NULL, " +
      "last_error = COALESCE(last_error, 'Processing lease expired'), updated_at = NOW() " +
      "WHERE id IN (SELECT id FROM webhook_messages " +
      "WHERE state = 'PROCESSING' AND lease_until < NOW() " +
      "ORDER BY lease_until ASC LIMIT $2) " +
      "RETURNING id, tenant_id",
    [MAX_ATTEMPTS, safeLimit],
  );

  return result.rows;
}
