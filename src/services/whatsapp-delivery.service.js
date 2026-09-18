import crypto from "node:crypto";

import { dbPool, isDatabaseConfigured } from "../config/database.js";

const DELIVERY_LEASE_SECONDS = 120;
const DEFAULT_RETRY_WINDOW_SECONDS = 15 * 60;
const MAX_RETRY_WINDOW_SECONDS = 24 * 60 * 60;
const VALID_STATUS = new Set(["sent", "delivered", "read", "failed"]);
const STATUS_RANK = {
  PENDING: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
};

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }
}

function validateTenantId(tenantId) {
  return typeof tenantId === "string" && tenantId.trim() !== "";
}

function validateUuid(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value.trim());
}

function getRetryWindowSeconds() {
  const configured = Number(process.env.WHATSAPP_DELIVERY_RETRY_WINDOW_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_RETRY_WINDOW_SECONDS;
  return Math.min(Math.max(Math.floor(configured), 60), MAX_RETRY_WINDOW_SECONDS);
}

function normalizeStatus(status) {
  if (typeof status !== "string") return null;
  const normalized = status.trim().toLowerCase();
  return VALID_STATUS.has(normalized) ? normalized : null;
}

function normalizeStatusTimestamp(timestamp) {
  if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) return timestamp;

  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const value = new Date(timestamp * 1000);
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof timestamp === "string" && /^\d+$/.test(timestamp.trim())) {
    const value = new Date(Number(timestamp.trim()) * 1000);
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof timestamp === "string") {
    const value = new Date(timestamp);
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return null;
}

function normalizeErrorDetails(errors) {
  const first = Array.isArray(errors) ? errors[0] : null;
  if (!first || typeof first !== "object") {
    return { code: null, title: null, details: null };
  }

  const code = Number.isInteger(first.code) ? first.code : null;
  const title = typeof first.title === "string" ? first.title.slice(0, 500) : null;
  const details =
    typeof first.error_data?.details === "string"
      ? first.error_data.details.slice(0, 1000)
      : typeof first.message === "string"
        ? first.message.slice(0, 1000)
        : null;

  return { code, title, details };
}

export async function prepareDelivery({
  tenantId,
  inboxMessageId,
  conversationId,
  recipientWaId,
  body,
}) {
  assertDatabase();

  if (
    !validateTenantId(tenantId) ||
    !validateUuid(inboxMessageId) ||
    !validateUuid(conversationId)
  ) {
    throw new Error("Invalid WhatsApp delivery identifiers");
  }

  if (
    typeof recipientWaId !== "string" ||
    !/^\d{7,15}$/.test(recipientWaId.trim())
  ) {
    throw new Error("Invalid WhatsApp delivery recipient");
  }

  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Invalid WhatsApp delivery body");
  }

  const result = await dbPool.query(
    `
      INSERT INTO whatsapp_deliveries (
        tenant_id,
        inbox_message_id,
        conversation_id,
        recipient_wa_id,
        body
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, inbox_message_id)
      DO UPDATE SET
        conversation_id = COALESCE(whatsapp_deliveries.conversation_id, EXCLUDED.conversation_id),
        recipient_wa_id = whatsapp_deliveries.recipient_wa_id,
        body = whatsapp_deliveries.body,
        updated_at = NOW()
      RETURNING *
    `,
    [
      tenantId.trim(),
      inboxMessageId.trim(),
      conversationId.trim(),
      recipientWaId.trim(),
      body.slice(0, 4096),
    ],
  );

  return result.rows[0];
}

export async function getDelivery(deliveryId, tenantId) {
  assertDatabase();

  if (!validateUuid(deliveryId) || !validateTenantId(tenantId)) return null;

  const result = await dbPool.query(
    `SELECT * FROM whatsapp_deliveries
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1`,
    [deliveryId.trim(), tenantId.trim()],
  );

  return result.rows[0] ?? null;
}

export async function claimDelivery(deliveryId, tenantId) {
  assertDatabase();

  if (!validateUuid(deliveryId) || !validateTenantId(tenantId)) {
    return { claimed: false, reason: "invalid" };
  }

  const leaseToken = crypto.randomUUID();
  const retryWindow = getRetryWindowSeconds();

  const result = await dbPool.query(
    `
      UPDATE whatsapp_deliveries
      SET
        state = 'SENDING',
        attempt_count = attempt_count + 1,
        lease_token = $3::uuid,
        lease_until = NOW() + ($4 * INTERVAL '1 second'),
        last_attempt_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND (
          state = 'PENDING'
          OR (
            state = 'SENDING'
            AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - ($5 * INTERVAL '1 second'))
            AND provider_message_id IS NULL
          )
        )
      RETURNING *
    `,
    [
      deliveryId.trim(),
      tenantId.trim(),
      leaseToken,
      DELIVERY_LEASE_SECONDS,
      retryWindow,
    ],
  );

  if (result.rowCount === 1) {
    return { claimed: true, leaseToken, delivery: result.rows[0] };
  }

  const current = await getDelivery(deliveryId, tenantId);
  if (!current) return { claimed: false, reason: "invalid" };
  if (["SENT", "DELIVERED", "READ"].includes(current.state)) {
    return { claimed: false, reason: "completed" };
  }
  if (current.state === "FAILED") {
    return { claimed: false, reason: "failed" };
  }

  return { claimed: false, reason: "in_flight" };
}

export async function markDeliverySent(
  deliveryId,
  tenantId,
  leaseToken,
  providerMessageId,
) {
  assertDatabase();

  if (
    !validateUuid(deliveryId) ||
    !validateTenantId(tenantId) ||
    !validateUuid(leaseToken) ||
    typeof providerMessageId !== "string" ||
    !providerMessageId.trim()
  ) {
    throw new Error("Invalid WhatsApp delivery completion data");
  }

  const result = await dbPool.query(
    `
      UPDATE whatsapp_deliveries
      SET
        provider_message_id = COALESCE(provider_message_id, $4),
        state = CASE
          WHEN state IN ('DELIVERED', 'READ', 'FAILED') THEN state
          ELSE 'SENT'
        END,
        lease_token = NULL,
        lease_until = NULL,
        status_at = COALESCE(status_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND lease_token = $3::uuid
      RETURNING *
    `,
    [deliveryId.trim(), tenantId.trim(), leaseToken.trim(), providerMessageId.trim()],
  );

  if (result.rowCount !== 1) {
    throw new Error("WhatsApp delivery lease is no longer valid");
  }

  return result.rows[0];
}

export async function markDeliveryUnknown(deliveryId, tenantId, leaseToken, error) {
  assertDatabase();

  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown delivery outcome");

  const result = await dbPool.query(
    `
      UPDATE whatsapp_deliveries
      SET
        state = 'SENDING',
        lease_token = NULL,
        lease_until = NULL,
        last_error = $4,
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND lease_token = $3::uuid
        AND state = 'SENDING'
      RETURNING *
    `,
    [deliveryId, tenantId, leaseToken, message.slice(0, 1000)],
  );

  return result.rows[0] ?? null;
}

export async function markDeliveryFailed(
  deliveryId,
  tenantId,
  leaseToken,
  error,
) {
  assertDatabase();

  const message =
    error instanceof Error ? error.message : String(error ?? "WhatsApp delivery failed");

  const result = await dbPool.query(
    `
      UPDATE whatsapp_deliveries
      SET
        state = 'FAILED',
        lease_token = NULL,
        lease_until = NULL,
        last_error = $4,
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND lease_token = $3::uuid
        AND state = 'SENDING'
      RETURNING *
    `,
    [deliveryId, tenantId, leaseToken, message.slice(0, 1000)],
  );

  return result.rows[0] ?? null;
}

export async function markDeliveryStatus({
  tenantId,
  phoneNumberId,
  providerMessageId,
  callbackData,
  status,
  timestamp,
  errors,
}) {
  assertDatabase();

  if (!validateTenantId(tenantId)) return null;

  const normalizedStatus = normalizeStatus(status);
  if (!normalizedStatus) return null;

  if (
    typeof providerMessageId !== "string" ||
    !providerMessageId.trim()
  ) {
    return null;
  }

  const statusAt = normalizeStatusTimestamp(timestamp) ?? new Date();
  const errorDetails = normalizeErrorDetails(errors);
  const callbackKey =
    typeof callbackData === "string" && validateUuid(callbackData)
      ? callbackData.trim()
      : null;

  const result = await dbPool.query(
    `
      WITH target AS (
        SELECT d.id
        FROM whatsapp_deliveries d
        JOIN webhook_messages wm
          ON wm.id = d.inbox_message_id
         AND wm.tenant_id = d.tenant_id
        JOIN whatsapp_numbers wn
          ON wn.id = wm.whatsapp_number_id
         AND wn.tenant_id = wm.tenant_id
        WHERE d.tenant_id = $1
          AND wn.phone_number_id = $2
          AND (
            d.provider_message_id = $3
            OR ($4::uuid IS NOT NULL AND d.delivery_key = $4::uuid)
          )
        LIMIT 1
      )
      UPDATE whatsapp_deliveries d
      SET
        provider_message_id = COALESCE(d.provider_message_id, $3),
        state = CASE
          WHEN d.state = 'READ' THEN 'READ'
          WHEN d.state = 'FAILED' THEN 'FAILED'
          WHEN $5 = 'failed' THEN 'FAILED'
          WHEN $5 = 'read' THEN 'READ'
          WHEN $5 = 'delivered' AND d.state IN ('PENDING', 'SENDING', 'SENT') THEN 'DELIVERED'
          WHEN $5 = 'sent' AND d.state IN ('PENDING', 'SENDING') THEN 'SENT'
          ELSE d.state
        END,
        status_at = CASE
          WHEN d.status_at IS NULL OR $6::timestamptz >= d.status_at THEN $6::timestamptz
          ELSE d.status_at
        END,
        error_code = CASE WHEN $5 = 'failed' THEN $7 ELSE d.error_code END,
        error_title = CASE WHEN $5 = 'failed' THEN $8 ELSE d.error_title END,
        error_details = CASE WHEN $5 = 'failed' THEN $9 ELSE d.error_details END,
        last_error = CASE WHEN $5 = 'failed' THEN COALESCE($9, $8) ELSE d.last_error END,
        lease_token = NULL,
        lease_until = NULL,
        updated_at = NOW()
      FROM target
      WHERE d.id = target.id
      RETURNING d.*
    `,
    [
      tenantId.trim(),
      phoneNumberId,
      providerMessageId.trim(),
      callbackKey,
      normalizedStatus,
      statusAt,
      errorDetails.code,
      errorDetails.title,
      errorDetails.details,
    ],
  );

  return result.rows[0] ?? null;
}

export async function findRecoverableDeliveries(limit = 50) {
  assertDatabase();

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const retryWindow = getRetryWindowSeconds();

  const result = await dbPool.query(
    `
      SELECT id, tenant_id
      FROM whatsapp_deliveries
      WHERE state = 'SENDING'
        AND provider_message_id IS NULL
        AND last_attempt_at < NOW() - ($1 * INTERVAL '1 second')
      ORDER BY last_attempt_at ASC
      LIMIT $2
    `,
    [retryWindow, safeLimit],
  );

  return result.rows;
}

export function deliveryStatusToMessageStatus(state) {
  switch (state) {
    case "READ":
      return "read";
    case "DELIVERED":
      return "delivered";
    case "FAILED":
      return "failed";
    case "SENT":
      return "sent";
    default:
      return null;
  }
}

export async function syncDeliveryToMessage(deliveryId, tenantId) {
  assertDatabase();

  if (!validateUuid(deliveryId) || !validateTenantId(tenantId)) return null;

  const result = await dbPool.query(
    `
      UPDATE messages m
      SET status = CASE d.state
        WHEN 'READ' THEN 'read'
        WHEN 'DELIVERED' THEN 'delivered'
        WHEN 'FAILED' THEN 'failed'
        WHEN 'SENT' THEN 'sent'
        ELSE m.status
      END
      FROM whatsapp_deliveries d
      WHERE d.id = $1
        AND d.tenant_id = $2
        AND m.tenant_id = d.tenant_id
        AND m.whatsapp_message_id = d.provider_message_id
        AND d.state IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
      RETURNING m.id, m.status
    `,
    [deliveryId.trim(), tenantId.trim()],
  );

  return result.rows[0] ?? null;
}
