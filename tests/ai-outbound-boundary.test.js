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
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: responses.shift() }] }, finishReason: "STOP" }],
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
      const f = { tenant: randomUUID(), number: randomUUID(), phone: `1555000990${index}`, wa: `1555000880${index}`, canary: `PRIVATE_BRAIN_${label}_${randomUUID()}` };
      await dbPool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [f.tenant, label]);
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

  it("records the transport boundary without any external provider call", (t) => {
    assert.equal(responses.length, 0);
    assert.equal(modelRequests.length, 2);
    assert.equal(metaRequests.length, 2);
    t.diagnostic("2 Gemini SDK responses and 2 Meta sends simulated; real PostgreSQL + Redis + signed HTTP; 0 external provider calls");
  });
});
