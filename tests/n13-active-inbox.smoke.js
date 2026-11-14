import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { getPoolConfig } from "../src/config/database.js";

const mode = process.argv[2];
const controlDir = process.env.N13_CONTROL_DIR || "/control";
const inboxId = process.env.N13_INBOX_ID;
const messageId = process.env.N13_MESSAGE_ID;
const tenantId = process.env.N13_TENANT_ID;
const phoneNumberId = process.env.N13_PHONE_NUMBER_ID;
const advisoryA = 171;
const advisoryB = 1301;

function makeClient() {
  return new pg.Client(getPoolConfig());
}

async function waitUntil(fn, timeoutMs, message) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await delay(250);
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}

function postSignedWebhook(body) {
  return new Promise((resolve, reject) => {
    const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;
    const req = https.request({
      hostname: "edge",
      port: 443,
      path: "/webhook",
      method: "POST",
      ca: fs.readFileSync("/certs/ca.crt"),
      rejectUnauthorized: true,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "content-length": Buffer.byteLength(body),
        connection: "close",
      },
    }, (res) => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, response }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("N-13 webhook request timed out")));
    req.end(body);
  });
}

async function prepare() {
  const client = makeClient();
  const id = crypto.randomUUID();
  const providerMessageId = `wamid.nova-n13-${id.replaceAll("-", "")}`;
  const phoneId = "15550000000001";
  const waId = "15550000000002";
  let locked = false;
  try {
    await client.connect();
    const tenant = await client.query(
      "INSERT INTO tenants (name, status) VALUES ('NOVA N13 disposable fixture', 'active') RETURNING id",
    );
    const newTenantId = tenant.rows[0].id;
    const number = await client.query(
      "INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, display_phone_number, display_name, status) " +
      "VALUES ($1, $2, '+15550000001', 'NOVA N13 disposable fixture', 'active') RETURNING id",
      [newTenantId, phoneId],
    );
    await client.query(
      "CREATE OR REPLACE FUNCTION n13_pause_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ " +
      "BEGIN IF NEW.whatsapp_message_id = '" + providerMessageId + "' THEN " +
      "PERFORM pg_advisory_lock(171, 1301); PERFORM pg_advisory_unlock(171, 1301); " +
      "END IF; RETURN NEW; END; $$",
    );
    await client.query(
      "CREATE TRIGGER n13_pause_message_insert BEFORE INSERT ON messages " +
      "FOR EACH ROW EXECUTE FUNCTION n13_pause_message_insert()",
    );
    await client.query("SELECT pg_advisory_lock($1, $2)", [advisoryA, advisoryB]);
    locked = true;

    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "NOVA-N13-DISPOSABLE",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "+15550000001", phone_number_id: phoneId },
            contacts: [{ profile: { name: "NOVA N13" }, wa_id: waId }],
            messages: [{
              from: waId,
              id: providerMessageId,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: "image",
              image: { id: "NOVA-N13-NO-MEDIA-DOWNLOAD" },
            }],
          },
        }],
      }],
    });
    const response = await postSignedWebhook(body);
    assert.equal(response.status, 200, `signed webhook rejected: ${response.response}`);

    const row = await waitUntil(async () => {
      const result = await client.query(
        "SELECT id, state, lease_token FROM webhook_messages " +
        "WHERE tenant_id=$1 AND whatsapp_message_id=$2",
        [newTenantId, providerMessageId],
      );
      const candidate = result.rows[0];
      if (!candidate || candidate.state !== "PROCESSING" || !candidate.lease_token) return null;
      const blocked = await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() " +
        "AND wait_event_type='Lock' AND wait_event='advisory' " +
        "AND query ILIKE '%INSERT INTO messages%' LIMIT 1",
      );
      return blocked.rowCount === 1 ? candidate : null;
    }, 20000, "worker never reached the scoped messages trigger with an active inbox lease");

    fs.writeFileSync(`${controlDir}/ready.json`, JSON.stringify({
      tenantId: newTenantId,
      whatsappNumberId: number.rows[0].id,
      phoneNumberId: phoneId,
      waId,
      messageId: providerMessageId,
      inboxId: row.id,
      leaseToken: row.lease_token,
    }));
    await waitUntil(() => fs.existsSync(`${controlDir}/release-lock`), 60000, "host did not release fixture lock");
    await client.query("SELECT pg_advisory_unlock($1, $2)", [advisoryA, advisoryB]);
    locked = false;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1, $2)", [advisoryA, advisoryB]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function verifyLiveLease() {
  assert.ok(inboxId && messageId && tenantId, "fixture identifiers are required");
  const client = makeClient();
  const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue("whatsapp-messages", { connection: redis });
  try {
    await client.connect();
    await waitUntil(async () => {
      const job = await queue.getJob(inboxId);
      if (!job || await job.getState() !== "completed") return null;
      const result = await client.query(
        "SELECT state, lease_until > NOW() AS lease_live FROM webhook_messages " +
        "WHERE id=$1 AND tenant_id=$2 AND whatsapp_message_id=$3",
        [inboxId, tenantId, messageId],
      );
      const row = result.rows[0];
      if (!row || row.state !== "PROCESSING" || row.lease_live !== true) return null;
      const counts = await client.query(
        "SELECT " +
        "(SELECT COUNT(*)::int FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2) AS inbound_count, " +
        "(SELECT COUNT(*)::int FROM whatsapp_deliveries WHERE tenant_id=$1) AS delivery_count",
        [tenantId, messageId],
      );
      if (counts.rows[0].inbound_count !== 0 || counts.rows[0].delivery_count !== 0) return null;
      return true;
    }, 95000, "stalled BullMQ job did not safely no-op against the still-live PostgreSQL lease");
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function verifyCompleted() {
  assert.ok(inboxId && messageId && tenantId, "fixture identifiers are required");
  const client = makeClient();
  const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue("whatsapp-messages", { connection: redis });
  try {
    await client.connect();
    await waitUntil(async () => {
      const result = await client.query(
        "SELECT state, attempts FROM webhook_messages WHERE id=$1 AND tenant_id=$2 AND whatsapp_message_id=$3",
        [inboxId, tenantId, messageId],
      );
      const row = result.rows[0];
      if (!row || row.state !== "COMPLETED") return null;
      const counts = await client.query(
        "SELECT " +
        "(SELECT COUNT(*)::int FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2) AS inbound_count, " +
        "(SELECT COUNT(*)::int FROM whatsapp_deliveries WHERE tenant_id=$1) AS delivery_count",
        [tenantId, messageId],
      );
      if (counts.rows[0].inbound_count !== 1 || counts.rows[0].delivery_count !== 0) return null;
      const job = await queue.getJob(inboxId);
      if (!job || await job.getState() !== "completed") return null;
      return { attempts: row.attempts, inboundCount: counts.rows[0].inbound_count };
    }, 45000, "expired DB lease was not recovered to one completed canonical inbound message");
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

try {
  if (mode === "prepare") await prepare();
  else if (mode === "verify-live") await verifyLiveLease();
  else if (mode === "verify-completed") await verifyCompleted();
  else throw new Error("Expected mode: prepare, verify-live, or verify-completed");
  process.stdout.write(`PASS: N-13 ${mode}\n`);
} catch (error) {
  process.stderr.write(`FAIL: N-13 ${mode}: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
