import crypto from "node:crypto";
import { dbPool } from "../config/database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z0-9_-]{2,40}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const STATUSES = new Set(["pending", "paid", "failed", "refunded", "cancelled"]);
const TRANSITIONS = new Map([
  ["pending", new Set(["paid", "failed", "cancelled"])],
  ["paid", new Set(["refunded"])],
  ["failed", new Set(["pending"])],
  ["cancelled", new Set(["pending"])],
  ["refunded", new Set()],
]);

function tenant(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid tenant");
  return value;
}
function text(value, max, required = true) {
  if (value === null || value === undefined) {
    if (!required) return null;
    throw new Error("Invalid value");
  }
  if (typeof value !== "string") throw new Error("Invalid value");
  const v = value.trim();
  if (required && !v) throw new Error("Invalid value");
  if (v.length > max) throw new Error("Value is too long");
  return v || null;
}
function amount(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) throw new Error("Invalid amount");
  const v = String(value);
  if (!/^\d{1,15}$/.test(v)) throw new Error("Invalid amount");
  return v;
}
function provider(value) {
  const v = text(value, 40);
  if (!PROVIDER.test(v)) throw new Error("Invalid provider");
  return v.toLowerCase();
}
function currency(value) {
  const v = text(value, 3).toUpperCase();
  if (!CURRENCY.test(v)) throw new Error("Invalid currency");
  return v;
}
function metadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata");
  const json = JSON.stringify(value);
  if (json.length > 8000) throw new Error("Metadata is too large");
  return value;
}
function eventId(value) {
  const v = text(value, 200);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(v)) throw new Error("Invalid payment event ID");
  return v;
}

export function validatePaymentWebhookEventId(value) {
  return eventId(value);
}

function validateTransition(current, next) {
  if (!STATUSES.has(next)) throw new Error("Invalid payment status");
  if (current === next) return;
  if (!TRANSITIONS.get(current)?.has(next)) throw new Error("Invalid payment status transition");
}

export async function createPayment({
  tenantId, provider: providerName, providerPaymentId, amountMinor, currency: currencyCode,
  customerName = null, customerPhone = null, description = null, checkoutUrl = null, metadata: meta = {},
}) {
  const t = tenant(tenantId);
  const p = provider(providerName);
  const externalId = text(providerPaymentId, 200);
  const amountValue = amount(amountMinor);
  const curr = currency(currencyCode);
  const name = text(customerName, 160, false);
  const phone = text(customerPhone, 40, false);
  const desc = text(description, 2000, false);
  const url = text(checkoutUrl, 2048, false);
  if (url && !/^https:\/\//i.test(url)) throw new Error("Checkout URL must use HTTPS");
  const metaValue = metadata(meta);

  const r = await dbPool.query(
    `INSERT INTO payments
      (tenant_id,provider,provider_payment_id,amount_minor,currency,customer_name,customer_phone,description,checkout_url,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id,provider,provider_payment_id)
     DO UPDATE SET
       customer_name=EXCLUDED.customer_name,
       customer_phone=EXCLUDED.customer_phone,
       description=EXCLUDED.description,
       checkout_url=EXCLUDED.checkout_url,
       metadata=EXCLUDED.metadata,
       updated_at=NOW()
     RETURNING *`,
    [t,p,externalId,amountValue,curr,name,phone,desc,url,metaValue],
  );
  return r.rows[0];
}

export async function listPayments(tenantId, { status, limit = 100 } = {}) {
  const t = tenant(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 100);
  const params = [t];
  let where = "tenant_id=$1";
  if (status !== undefined) {
    if (!STATUSES.has(status)) throw new Error("Invalid payment status");
    params.push(status);
    where += " AND status=$2";
  }
  params.push(safeLimit);
  const r = await dbPool.query(`SELECT * FROM payments WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

export async function getPayment(tenantId, id) {
  const t = tenant(tenantId);
  const paymentId = text(id, 64);
  const r = await dbPool.query("SELECT * FROM payments WHERE tenant_id=$1 AND id=$2", [t, paymentId]);
  return r.rows[0] || null;
}

export async function updatePaymentStatus(tenantId, id, status) {
  const t = tenant(tenantId);
  const paymentId = text(id, 64);
  if (!STATUSES.has(status)) throw new Error("Invalid payment status");

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      "SELECT status FROM payments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [t, paymentId],
    );
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    validateTransition(current.rows[0].status, status);
    const paidAt = status === "paid" ? "COALESCE(paid_at,NOW())" : "paid_at";
    const updated = await client.query(
      `UPDATE payments SET status=$3, paid_at=${paidAt}, updated_at=NOW()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [t, paymentId, status],
    );

    await client.query("COMMIT");
    return updated.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export function verifyPaymentWebhook(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || typeof signature !== "string" || !secret) return false;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

export async function applyPaymentWebhook({ tenantId, provider: providerName, providerPaymentId, status, eventId: webhookEventId, signatureValid }) {
  if (!signatureValid) throw new Error("Invalid payment webhook signature");
  const t = tenant(tenantId);
  const p = provider(providerName);
  const externalId = text(providerPaymentId, 200);
  const normalizedEventId = eventId(webhookEventId);
  if (!STATUSES.has(status)) throw new Error("Invalid payment status");

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    const event = await client.query(
      "INSERT INTO payment_webhook_events (tenant_id, provider, event_id, provider_payment_id, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, provider, event_id) DO NOTHING RETURNING id",
      [t, p, normalizedEventId, externalId, status],
    );

    if (event.rowCount === 0) {
      await client.query("COMMIT");
      return { duplicate: true };
    }

    const current = await client.query(
      "SELECT status FROM payments WHERE tenant_id=$1 AND provider=$2 AND provider_payment_id=$3 FOR UPDATE",
      [t, p, externalId],
    );

    if (!current.rows[0]) {
      await client.query(
        "DELETE FROM payment_webhook_events WHERE tenant_id=$1 AND provider=$2 AND event_id=$3",
        [t, p, normalizedEventId],
      );
      await client.query("COMMIT");
      return null;
    }

    validateTransition(current.rows[0].status, status);

    const updated = await client.query(
      `UPDATE payments SET
         status=$4,
         paid_at=CASE WHEN $4='paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END,
         updated_at=NOW()
       WHERE tenant_id=$1 AND provider=$2 AND provider_payment_id=$3
       RETURNING *`,
      [t, p, externalId, status],
    );

    await client.query(
      "UPDATE payment_webhook_events SET processed_at=NOW() WHERE tenant_id=$1 AND provider=$2 AND event_id=$3",
      [t, p, normalizedEventId],
    );

    await client.query("COMMIT");
    return updated.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
