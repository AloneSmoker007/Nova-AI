import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import axios from "axios";
import express from "express";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const skip = integrationUrl && process.env.MIGRATION_TEST_ALLOW_RESET === "1" && process.env.REDIS_URL
  ? false : "Requires explicitly disposable PostgreSQL and Redis services";
const appSecret = "synthetic-outbound-boundary-meta-secret";
const accessToken = "synthetic-outbound-boundary-access-token";
const secretCanary = "SYNTHETIC_MODEL_SECRET_NEVER_PERSIST_123456789";

// Real HTTP ingress, signature verification, PostgreSQL, recovery dispatcher,
// BullMQ worker, Gemini SDK parsing, output policy and delivery persistence.
// Only external transports are replaced. No customer/provider account is used.
describe("AI output boundary through the real webhook worker and delivery pipeline", { skip }, () => {
  let dbPool, server, port, stopBackgroundServices, safeFallback;
  let fixtures;
  const originalFetch = globalThis.fetch;
  const originalPost = axios.post;
  const modelRequests = [];
  const metaRequests = [];
  const responses = [];

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = integrationUrl;
    process.env.GEMINI_API_KEY = "synthetic-non-working-gemini-key";
    process.env.META_APP_SECRET = appSecret;
    process.env.WEBHOOK_VERIFY_TOKEN = "synthetic-webhook-verification";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);

    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "generativelanguage.googleapis.com");
      assert.equal(options.method, "POST");
      assert.ok(url.pathname.endsWith(":generateContent"));
      modelRequests.push(JSON.parse(options.body));
      assert.ok(responses.length, "each model call must have an explicit synthetic response");
      const next = responses.shift();
      const text = typeof next === "function" ? await next() : next;
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    axios.post = async (url, body, options) => {
      assert.match(url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/\d+\/messages$/);
      assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
      metaRequests.push({ url, body });
      return { data: { messages: [{ id: `wamid.synthetic-outbound-${randomUUID()}` }] } };
    };

    ({ dbPool } = await import("../src/config/database.js"));
    const { runMigrations } = await import("../src/database/migrate.js");
    const { encryptSecret } = await import("../src/services/secrets.service.js");
    ({ SAFE_AI_FALLBACK: safeFallback } = await import("../src/services/ai-output-safety.service.js"));
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    await runMigrations();
    fixtures = [];
    for (const [index, label] of ["Alpha", "Beta"].entries()) {
      const f = { tenant: randomUUID(), number: randomUUID(), owner: randomUUID(), phone: `1555000990${index}`, wa: `1555000880${index}`, canary: `PRIVATE_BRAIN_${label}_${randomUUID()}` };
      await dbPool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [f.tenant, label]);
      await dbPool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,'synthetic-hash','owner')", [f.owner, f.tenant, `${f.owner}@example.test`]);
      await dbPool.query("INSERT INTO whatsapp_numbers (id,tenant_id,phone_number_id,access_token_encrypted) VALUES ($1,$2,$3,$4)", [f.number, f.tenant, f.phone, encryptSecret(accessToken)]);
      await dbPool.query("INSERT INTO tenant_business_brain (tenant_id,business_name,description,hours) VALUES ($1,$2,$2,$3::jsonb)", [f.tenant, f.canary, JSON.stringify({ monday: "9am to 5pm" })]);
      fixtures.push(f);
    }

    const realListen = express.application.listen;
    express.application.listen = () => ({ on() { return this; }, close(callback) { callback?.(); } });
    try {
      const module = await import("../src/index.js");
      ({ stopBackgroundServices } = module);
      await module.appStartupPromise;
      server = http.createServer(module.default);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
    } finally { express.application.listen = realListen; }
  });

  after(async () => {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (stopBackgroundServices) await stopBackgroundServices();
      if (dbPool) await dbPool.end();
    } finally {
      globalThis.fetch = originalFetch;
      axios.post = originalPost;
    }
  });

  function payload(f, id) {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "synthetic-waba", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: f.phone },
        contacts: [{ wa_id: f.wa, profile: { name: "Synthetic Customer" } }],
        messages: [{ from: f.wa, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "What are your Monday opening hours?" } }],
      } }] }],
    });
  }

  function postWebhook(body, valid = true) {
    const signature = createHmac("sha256", valid ? appSecret : "wrong-synthetic-secret").update(body).digest("hex");
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1", port, path: "/webhook", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Hub-Signature-256": `sha256=${signature}` },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.setTimeout(10_000, () => request.destroy(new Error("Synthetic webhook timed out")));
      request.on("error", reject);
      request.end(body);
    });
  }

  async function completed(id) {
    const deadline = Date.now() + 35_000;
    let row;
    while (Date.now() < deadline) {
      row = (await dbPool.query("SELECT * FROM webhook_messages WHERE whatsapp_message_id=$1", [id])).rows[0];
      if (row?.state === "COMPLETED") return row;
      if (["RETRY_WAIT", "DEAD_LETTER"].includes(row?.state)) assert.fail(`Worker failed: ${row.state}, ${row.last_error}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Worker did not complete; last state=${row?.state}`);
  }

  it("an invalid webhook signature cannot persist, generate or send", async () => {
    assert.equal(await postWebhook(payload(fixtures[0], "wamid.synthetic-invalid"), false), 403);
    assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM webhook_messages")).rows[0].n, 0);
    assert.equal(modelRequests.length, 0);
    assert.equal(metaRequests.length, 0);
  });

  for (const [index, label, modelOutput] of [
    [0, "unsafe credential output becomes the safe fallback before persistence and send", JSON.stringify({ access_token: secretCanary })],
    [1, "an ordinary supported business reply reaches only its own tenant unchanged", "Our Monday opening hours are 9am to 5pm."],
  ]) {
    it(label, async () => {
      const f = fixtures[index];
      const foreign = fixtures[1 - index];
      const id = `wamid.synthetic-inbound-${randomUUID()}`;
      const expected = index === 0 ? safeFallback : modelOutput;
      const beforeCalls = modelRequests.length;
      const beforeSends = metaRequests.length;
      responses.push(modelOutput);
      assert.equal(await postWebhook(payload(f, id)), 200);
      const inbox = await completed(id);
      assert.equal(inbox.tenant_id, f.tenant);
      assert.equal(inbox.generated_response, expected);
      assert.equal(modelRequests.length, beforeCalls + 1);
      assert.equal(metaRequests.length, beforeSends + 1);
      const prompt = JSON.stringify(modelRequests.at(-1));
      assert.ok(prompt.includes(f.canary), "own business facts must reach the model");
      assert.ok(!prompt.includes(foreign.canary), "foreign business facts must not reach the model");
      assert.ok(!prompt.includes(accessToken), "Meta credentials must not enter the model prompt");
      const delivery = (await dbPool.query("SELECT * FROM whatsapp_deliveries WHERE inbox_message_id=$1", [inbox.id])).rows;
      assert.equal(delivery.length, 1);
      assert.equal(delivery[0].tenant_id, f.tenant);
      assert.equal(delivery[0].body, expected);
      assert.equal(delivery[0].state, "SENT");
      const outbound = (await dbPool.query("SELECT tenant_id,text FROM messages WHERE whatsapp_message_id=$1", [inbox.provider_message_id])).rows;
      assert.deepEqual(outbound, [{ tenant_id: f.tenant, text: expected }]);
      const sent = metaRequests.at(-1);
      assert.ok(sent.url.endsWith(`/${f.phone}/messages`));
      assert.equal(sent.body.to, f.wa);
      assert.equal(sent.body.text.body, expected);

      // Signed duplicates after completion stay idempotent even if explicitly
      // re-enqueued through the real Redis worker (as recovery may do).
      assert.equal(await postWebhook(payload(f, id)), 200);
      const { enqueueWhatsAppMessage } = await import("../src/services/queue.service.js");
      const { Queue } = await import("bullmq");
      const { getConnection } = await import("../src/services/queue.service.js");
      const queue = new Queue("whatsapp-messages", { connection: getConnection() });
      try {
        await enqueueWhatsAppMessage({ inboxId: inbox.id });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const job = await queue.getJob(inbox.id);
          if (job && await job.getState() === "completed") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const job = await queue.getJob(inbox.id);
        assert.equal(await job?.getState(), "completed", "duplicate worker job must settle normally");
      } finally { await queue.close(); }
      assert.equal(modelRequests.length, beforeCalls + 1, "replay must not spend on another model call");
      assert.equal(metaRequests.length, beforeSends + 1, "replay must not send again");
      assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM whatsapp_deliveries WHERE inbox_message_id=$1", [inbox.id])).rows[0].n, 1);
      assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM usage_events WHERE tenant_id=$1 AND event_type='ai_message'", [f.tenant])).rows[0].n, 1);
      const artifacts = await dbPool.query("SELECT to_jsonb(w)::text AS data FROM webhook_messages w UNION ALL SELECT to_jsonb(d)::text FROM whatsapp_deliveries d UNION ALL SELECT to_jsonb(m)::text FROM messages m");
      assert.ok(artifacts.rows.every((row) => !row.data.includes(secretCanary)), "raw unsafe model output must never reach durable artifacts");
    });
  }

  it("human takeover during model generation suppresses the unsent automatic reply", async () => {
    const f = fixtures[0];
    const { pauseAi, resumeAi } = await import("../src/services/handoff.service.js");
    let conversationId;
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    responses.push(async () => {
      const row = await dbPool.query("SELECT c.id FROM conversations c JOIN contacts ct ON ct.tenant_id=c.tenant_id AND ct.id=c.contact_id WHERE c.tenant_id=$1 AND ct.wa_id=$2", [f.tenant, f.wa]);
      conversationId = row.rows[0].id;
      await pauseAi(f.tenant, conversationId, f.owner, "Synthetic takeover while Gemini is running");
      return "Our Monday opening hours are 9am to 5pm.";
    });
    try {
      const id = `wamid.synthetic-takeover-${randomUUID()}`;
      assert.equal(await postWebhook(payload(f, id)), 200);
      const inbox = await completed(id);
      assert.ok(conversationId, "the takeover must have executed during the actual SDK call");
      assert.equal(modelRequests.length, beforeCalls + 1);
      assert.equal(metaRequests.length, beforeSends, "a completed takeover must prevent the subsequent automatic send");
      assert.equal(inbox.provider_message_id, null);
      assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound' AND created_at >= $3", [f.tenant, conversationId, inbox.created_at])).rows[0].n, 0);
    } finally {
      if (conversationId) await resumeAi(f.tenant, conversationId, f.owner);
    }
  });

  it("an explicit resume allows a fresh automatic reply", async () => {
    const f = fixtures[0];
    const beforeSends = metaRequests.length;
    const reply = "Our Monday opening hours are 9am to 5pm.";
    responses.push(reply);
    const id = `wamid.synthetic-resumed-${randomUUID()}`;
    assert.equal(await postWebhook(payload(f, id)), 200);
    const inbox = await completed(id);
    assert.equal(inbox.generated_response, reply);
    assert.equal(metaRequests.length, beforeSends + 1);
    assert.equal(metaRequests.at(-1).body.text.body, reply);
  });

  for (const [index, block] of ["paused", "deleted", "allowed"].entries()) {
    it(`pre-request delivery recovery respects ${block} source/conversation state`, async () => {
      const f = fixtures[index % 2];
      const wa = `1555000770${index}`;
      const id = `wamid.synthetic-recovery-${randomUUID()}`;
      const reply = "This cached reply must follow the current conversation policy.";
      const { persistInboundMessage, persistDeletedInboundMessage } = await import("../src/services/message-persistence.service.js");
      const { prepareDelivery, claimDelivery } = await import("../src/services/whatsapp-delivery.service.js");
      const { pauseAi } = await import("../src/services/handoff.service.js");
      const source = await persistInboundMessage({ tenantId: f.tenant, whatsappNumberId: f.number, waId: wa, whatsappMessageId: id, body: "What are your hours?", receivedAt: new Date() });
      const inbox = (await dbPool.query("INSERT INTO webhook_messages (tenant_id,whatsapp_number_id,phone_number_id,whatsapp_message_id,wa_id,body,received_at,state,completed_at,generated_response) VALUES ($1,$2,$3,$4,$5,'What are your hours?',NOW(),'COMPLETED',NOW(),$6) RETURNING *", [f.tenant, f.number, f.phone, id, wa, reply])).rows[0];
      const delivery = await prepareDelivery({ tenantId: f.tenant, inboxMessageId: inbox.id, conversationId: source.conversationId, recipientWaId: wa, body: reply });
      const initialClaim = await claimDelivery(delivery.id, f.tenant);
      assert.equal(initialClaim.claimed, true);
      if (block === "paused") await pauseAi(f.tenant, source.conversationId, f.owner);
      if (block === "deleted") await persistDeletedInboundMessage({ tenantId: f.tenant, whatsappNumberId: f.number, waId: wa, whatsappMessageId: id });
      const beforeCalls = modelRequests.length;
      const beforeSends = metaRequests.length;
      // Only after the block is committed, simulate a crashed worker whose
      // lease expired before any provider request. Recovery may now claim it.
      await dbPool.query("UPDATE whatsapp_deliveries SET lease_until=NOW()-INTERVAL '1 hour',last_attempt_at=NOW()-INTERVAL '2 hours' WHERE id=$1", [delivery.id]);
      let recovered;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        recovered = (await dbPool.query("SELECT * FROM whatsapp_deliveries WHERE id=$1", [delivery.id])).rows[0];
        if (["SENT", "FAILED", "UNKNOWN", "DELIVERED", "READ"].includes(recovered.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(recovered.state, block === "allowed" ? "SENT" : "FAILED");
      assert.equal(recovered.attempt_count, 2, "the actual recovery dispatcher must have claimed the stale attempt");
      assert.equal(modelRequests.length, beforeCalls, "delivery recovery must not generate another reply");
      assert.equal(metaRequests.length, beforeSends + (block === "allowed" ? 1 : 0));
      if (block !== "allowed") {
        assert.equal(recovered.provider_message_id, null);
        assert.equal(recovered.provider_request_started_at, null);
        assert.match(recovered.last_error, block === "paused" ? /paused|handoff|human/i : /deleted|source/i);
        assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'", [f.tenant, source.conversationId])).rows[0].n, 0);
      } else {
        assert.equal(metaRequests.at(-1).body.to, wa);
        assert.equal(metaRequests.at(-1).body.text.body, reply);
      }
    });
  }

  let cachedSequence = 0;
  async function seedCachedReply({ reply, deliveryBody, recovery = false, accepted = false }) {
    const f = fixtures[cachedSequence % 2];
    const wa = String(15550006000 + cachedSequence++);
    const id = `wamid.synthetic-cached-${randomUUID()}`;
    const { persistInboundMessage } = await import("../src/services/message-persistence.service.js");
    const deliveryService = await import("../src/services/whatsapp-delivery.service.js");
    const source = await persistInboundMessage({ tenantId: f.tenant, whatsappNumberId: f.number, waId: wa, whatsappMessageId: id, body: "What are your hours?", receivedAt: new Date() });
    // Keep the inbox out of background dispatch until the complete fixture is
    // ready. These are legacy/pre-upgrade caches, intentionally not generated
    // through the current SDK output filter.
    const inbox = (await dbPool.query("INSERT INTO webhook_messages (tenant_id,whatsapp_number_id,phone_number_id,whatsapp_message_id,wa_id,body,received_at,state,generated_response) VALUES ($1,$2,$3,$4,$5,'What are your hours?',NOW(),'DEAD_LETTER',$6) RETURNING *", [f.tenant, f.number, f.phone, id, wa, reply])).rows[0];
    let delivery;
    if (deliveryBody !== undefined) {
      delivery = await deliveryService.prepareDelivery({ tenantId: f.tenant, inboxMessageId: inbox.id, conversationId: source.conversationId, recipientWaId: wa, body: deliveryBody });
      if (recovery || accepted) {
        const claim = await deliveryService.claimDelivery(delivery.id, f.tenant);
        assert.equal(claim.claimed, true);
        if (accepted) {
          await deliveryService.markDeliveryRequestStarted(delivery.id, f.tenant, claim.leaseToken, claim.delivery.attempt_count);
          await deliveryService.markDeliverySent(delivery.id, f.tenant, claim.leaseToken, `wamid.synthetic-prior-accepted-${randomUUID()}`, claim.delivery.attempt_count);
        }
      }
    }
    return { ...f, wa, id, inbox, source, delivery };
  }

  async function activateCachedReply(f) {
    await dbPool.query("UPDATE webhook_messages SET state='RECEIVED' WHERE id=$1", [f.inbox.id]);
    const { enqueueWhatsAppMessage } = await import("../src/services/queue.service.js");
    await enqueueWhatsAppMessage({ inboxId: f.inbox.id });
    return completed(f.id);
  }

  async function settledDelivery(id) {
    let row;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      row = (await dbPool.query("SELECT * FROM whatsapp_deliveries WHERE id=$1", [id])).rows[0];
      if (["SENT", "FAILED", "UNKNOWN", "DELIVERED", "READ"].includes(row?.state)) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Delivery did not settle; state=${row?.state}`);
  }

  async function withHistoryRepairBarrier(action) {
    // Exercise the inbox worker's own history write deterministically. A
    // simultaneous repair scan must not hide a wrong-body write by winning
    // first. Every query still executes against PostgreSQL after release.
    const originalQuery = dbPool.query;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const deadline = setTimeout(release, 10_000);
    dbPool.query = function (query, ...args) {
      if (typeof query === "string" && query.includes("FROM whatsapp_deliveries d") && query.includes("NOT EXISTS")) {
        return barrier.then(() => originalQuery.call(this, query, ...args));
      }
      return originalQuery.call(this, query, ...args);
    };
    try { return await action(); }
    finally { release(); clearTimeout(deadline); dbPool.query = originalQuery; }
  }

  it("unsafe legacy inbox output is quarantined without regeneration, delivery creation or send", async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const f = await seedCachedReply({ reply: JSON.stringify({ access_token: secretCanary }) });
    const inbox = await activateCachedReply(f);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends);
    assert.equal(inbox.provider_message_id, null);
    assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM whatsapp_deliveries WHERE inbox_message_id=$1", [f.inbox.id])).rows[0].n, 0);
    assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'", [f.tenant, f.source.conversationId])).rows[0].n, 0);
  });

  it("a safe inbox cache cannot authorize an unsafe existing delivery body", async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const f = await seedCachedReply({ reply: "Our Monday hours are 9am to 5pm.", deliveryBody: JSON.stringify({ access_token: secretCanary }) });
    await activateCachedReply(f);
    const delivery = await settledDelivery(f.delivery.id);
    assert.equal(delivery.state, "FAILED");
    assert.equal(delivery.provider_request_started_at, null);
    assert.equal(delivery.provider_message_id, null);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends);
    assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'", [f.tenant, f.source.conversationId])).rows[0].n, 0);
  });

  it("pre-request recovery cannot resend an unsafe legacy AI delivery body", async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const f = await seedCachedReply({ reply: "Our Monday hours are 9am to 5pm.", deliveryBody: JSON.stringify({ access_token: secretCanary }), recovery: true });
    await dbPool.query("UPDATE webhook_messages SET state='COMPLETED',completed_at=NOW() WHERE id=$1", [f.inbox.id]);
    await dbPool.query("UPDATE whatsapp_deliveries SET lease_until=NOW()-INTERVAL '1 hour',last_attempt_at=NOW()-INTERVAL '2 hours' WHERE id=$1", [f.delivery.id]);
    const delivery = await settledDelivery(f.delivery.id);
    assert.equal(delivery.state, "FAILED");
    assert.equal(delivery.attempt_count, 2);
    assert.equal(delivery.provider_request_started_at, null);
    assert.equal(delivery.provider_message_id, null);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends);
    assert.equal((await dbPool.query("SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'", [f.tenant, f.source.conversationId])).rows[0].n, 0);
  });

  it("an ordinary safe cached inbox reply is sent without another model call", async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const reply = "Our Monday hours are 9am to 5pm.";
    const f = await seedCachedReply({ reply });
    const inbox = await activateCachedReply(f);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends + 1);
    assert.equal(metaRequests.at(-1).body.text.body, reply);
    assert.equal((await dbPool.query("SELECT text FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2", [f.tenant, inbox.provider_message_id])).rows[0].text, reply);
  });

  it("outbound history records the actual retained delivery body when safe caches differ", async () => {
    await withHistoryRepairBarrier(async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const actual = "The original durable delivery says Monday hours are 9am to 5pm.";
    const f = await seedCachedReply({ reply: "A different cached reply that was never dispatched.", deliveryBody: actual });
    const inbox = await activateCachedReply(f);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends + 1);
    assert.equal(metaRequests.at(-1).body.text.body, actual);
    assert.equal((await dbPool.query("SELECT text FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2", [f.tenant, inbox.provider_message_id])).rows[0].text, actual);
    });
  });

  it("history repair for an accepted delivery preserves its actual body without resending", async () => {
    await withHistoryRepairBarrier(async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const actual = "The original accepted reply says Monday hours are 9am to 5pm.";
    const f = await seedCachedReply({ reply: "A different inbox cache, not the accepted provider message.", deliveryBody: actual, accepted: true });
    const inbox = await activateCachedReply(f);
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends);
    assert.equal((await dbPool.query("SELECT text FROM messages WHERE tenant_id=$1 AND whatsapp_message_id=$2", [f.tenant, inbox.provider_message_id])).rows[0].text, actual);
    });
  });

  it("explicit non-AI automation text keeps its existing send policy during recovery", async () => {
    const beforeCalls = modelRequests.length;
    const beforeSends = metaRequests.length;
    const f = await seedCachedReply({ reply: "Unused inbox cache." });
    const { pauseAi } = await import("../src/services/handoff.service.js");
    await pauseAi(f.tenant, f.source.conversationId, f.owner);
    const workflow = randomUUID();
    const run = randomUUID();
    const actual = "password=SYNTHETIC_AUTOMATION_REFERENCE_12345";
    await dbPool.query("INSERT INTO automation_workflows (id,tenant_id,name,trigger_type,status,definition) VALUES ($1,$2,'Synthetic configured message','manual','active','{\"steps\":[]}')", [workflow, f.tenant]);
    await dbPool.query("INSERT INTO automation_runs (id,tenant_id,workflow_id,conversation_id,status) VALUES ($1,$2,$3,$4,'completed')", [run, f.tenant, workflow, f.source.conversationId]);
    const delivery = (await dbPool.query("INSERT INTO whatsapp_deliveries (tenant_id,conversation_id,recipient_wa_id,body,automation_run_id,automation_step) VALUES ($1,$2,$3,$4,$5,0) RETURNING *", [f.tenant, f.source.conversationId, f.wa, actual, run])).rows[0];
    assert.equal((await settledDelivery(delivery.id)).state, "SENT");
    assert.equal(modelRequests.length, beforeCalls);
    assert.equal(metaRequests.length, beforeSends + 1);
    assert.equal(metaRequests.at(-1).body.text.body, actual);
  });

  it("records the transport boundary without any external provider call", (t) => {
    assert.equal(responses.length, 0);
    assert.equal(modelRequests.length, 4);
    assert.equal(metaRequests.length, 7);
    t.diagnostic("4 Gemini SDK responses and 7 Meta sends simulated; real PostgreSQL + Redis + signed HTTP, takeover/deletion/cache recovery; 0 external provider calls");
  });
});
