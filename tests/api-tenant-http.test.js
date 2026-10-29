import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import express from "express";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const skip = integrationUrl && process.env.MIGRATION_TEST_ALLOW_RESET === "1"
  ? false : "Requires an explicitly disposable PostgreSQL database";
const PUBLIC_API = new Set([
  "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout",
  "POST /api/payments/webhook/:tenantId",
]);
const META_STATUS_SECRET = "synthetic-http-callback-signature-secret";
const TABLES = [
  "users", "whatsapp_numbers", "contacts", "conversations", "messages", "conversation_notes", "conversation_tags",
  "contact_ai_memory", "conversation_ai_summaries", "ai_copilot_drafts", "payments",
  "ocr_documents", "appointment_types", "appointments", "business_hours",
  "tenant_business_brain", "automation_workflows", "automation_runs",
  "automation_webhook_effects", "webhook_messages", "usage_events",
];

describe("real HTTP tenant/resource/role authorization (PostgreSQL)", { skip }, () => {
  let dbPool, app, server, port, stopBackgroundServices, generateToken;
  let fixtures;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let requestCount = 0;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = integrationUrl;
    process.env.JWT_SECRET = "http-matrix-synthetic-jwt-secret-32chars";
    process.env.JWT_ISSUER = "nova-ai";
    process.env.JWT_AUDIENCE = "nova-ai-api";
    process.env.META_APP_SECRET = META_STATUS_SECRET;
    // No provider credential is needed or exercised. All HTTP probes below
    // target our loopback server; fail any attempted external fetch locally.
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = async () => { providerCalls += 1; throw new Error("External provider calls are forbidden in the HTTP matrix"); };
    ({ dbPool } = await import("../src/config/database.js"));
    const { runMigrations } = await import("../src/database/migrate.js");
    ({ generateToken } = await import("../src/services/auth.service.js"));
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    await runMigrations();

    const realListen = express.application.listen;
    express.application.listen = () => ({ on() { return this; }, close(callback) { callback?.(); } });
    try {
      const module = await import("../src/index.js");
      ({ default: app, stopBackgroundServices } = module);
      await module.appStartupPromise;
      // Stop recovery/queue work before seeding; only the HTTP request under
      // test may change these fixtures. Keep the shared database pool open.
      await stopBackgroundServices();
    } finally { express.application.listen = realListen; }
    fixtures = [await seedTenant("A", 2), await seedTenant("B", 5)];
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (stopBackgroundServices) await stopBackgroundServices();
      if (dbPool) await dbPool.end();
    } finally { globalThis.fetch = originalFetch; }
  });

  async function seedTenant(label, ipStart) {
    const f = Object.fromEntries(["tenant", "number", "contact", "conversation", "message", "payment", "ocr", "type", "appointment", "workflow", "run", "effect", "inbox"].map((key) => [key, randomUUID()]));
    f.canary = `PRIVATE_TENANT_${label}_${randomUUID()}`;
    f.users = {};
    await dbPool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [f.tenant, f.canary]);
    for (const [index, role] of ["owner", "admin", "agent"].entries()) {
      const user = { id: randomUUID(), tenant_id: f.tenant, role, token_version: 0, ip: `127.0.0.${ipStart + index}` };
      await dbPool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,'synthetic-hash',$4)", [user.id, f.tenant, `${user.id}@example.test`, role]);
      user.token = generateToken(user);
      f.users[role] = user;
    }
    await dbPool.query("INSERT INTO whatsapp_numbers (id,tenant_id,phone_number_id,display_name) VALUES ($1,$2,$3,$4)", [f.number, f.tenant, "synthetic-" + f.number, f.canary]);
    await dbPool.query("INSERT INTO contacts (id,tenant_id,wa_id,display_name) VALUES ($1,$2,$3,$4)", [f.contact, f.tenant, "1555" + ipStart, f.canary]);
    await dbPool.query("INSERT INTO conversations (id,tenant_id,whatsapp_number_id,contact_id,unread_count) VALUES ($1,$2,$3,$4,3)", [f.conversation, f.tenant, f.number, f.contact]);
    await dbPool.query("INSERT INTO messages (id,tenant_id,conversation_id,whatsapp_message_id,direction,text) VALUES ($1,$2,$3,$4,'inbound',$5)", [f.message, f.tenant, f.conversation, "synthetic-" + f.message, f.canary]);
    await dbPool.query("INSERT INTO tenant_business_brain (tenant_id,business_name,description) VALUES ($1,$2,$2)", [f.tenant, f.canary]);
    await dbPool.query("INSERT INTO contact_ai_memory (tenant_id,contact_id,memory_key,memory_value) VALUES ($1,$2,'name',$3)", [f.tenant, f.contact, f.canary]);
    await dbPool.query("INSERT INTO conversation_ai_summaries (tenant_id,conversation_id,summary) VALUES ($1,$2,$3)", [f.tenant, f.conversation, f.canary]);
    await dbPool.query("INSERT INTO ai_copilot_drafts (tenant_id,conversation_id,author_user_id,draft) VALUES ($1,$2,$3,$4)", [f.tenant, f.conversation, f.users.owner.id, f.canary]);
    await dbPool.query("INSERT INTO payments (id,tenant_id,provider,provider_payment_id,amount_minor,currency,description) VALUES ($1,$2,'synthetic',$3,1000,'USD',$3)", [f.payment, f.tenant, f.canary]);
    await dbPool.query("INSERT INTO ocr_documents (id,tenant_id,filename,mime_type,extracted_text,created_by) VALUES ($1,$2,$3,'image/png',$3,$4)", [f.ocr, f.tenant, f.canary, f.users.owner.id]);
    await dbPool.query("INSERT INTO appointment_types (id,tenant_id,name,duration_minutes) VALUES ($1,$2,$3,30)", [f.type, f.tenant, f.canary]);
    await dbPool.query("INSERT INTO appointments (id,tenant_id,appointment_type_id,contact_id,conversation_id,customer_name,customer_phone,starts_at,ends_at,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,'15550001111',NOW()+INTERVAL '3 days',NOW()+INTERVAL '3 days 30 minutes',$6,$7)", [f.appointment, f.tenant, f.type, f.contact, f.conversation, f.canary, f.users.owner.id]);
    await dbPool.query("INSERT INTO automation_workflows (id,tenant_id,name,trigger_type,status,created_by,definition) VALUES ($1,$2,$3,'manual','active',$4,'{\"steps\":[]}')", [f.workflow, f.tenant, f.canary, f.users.owner.id]);
    await dbPool.query("INSERT INTO automation_runs (id,tenant_id,workflow_id,status) VALUES ($1,$2,$3,'failed')", [f.run, f.tenant, f.workflow]);
    await dbPool.query("INSERT INTO automation_webhook_effects (id,tenant_id,run_id,step_index,endpoint_host,request_sha256,status) VALUES ($1,$2,$3,0,'synthetic.example.test',$4,'unknown')", [f.effect, f.tenant, f.run, "0".repeat(64)]);
    await dbPool.query("INSERT INTO webhook_messages (id,tenant_id,whatsapp_number_id,phone_number_id,whatsapp_message_id,wa_id,body,received_at,state) VALUES ($1,$2,$3,$4,$5,'15550001111',$6,NOW(),'DEAD_LETTER')", [f.inbox, f.tenant, f.number, "synthetic-" + f.number, "synthetic-" + f.inbox, f.canary]);
    return f;
  }

  function request(actor, method, path, body, extraHeaders = {}) {
    requestCount += 1;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, path, method,
        // Each synthetic identity has a real loopback source address. This
        // exercises the normal limiter without spoofing X-Forwarded-For or
        // disabling production middleware to fit the matrix under one IP.
        localAddress: actor?.ip || "127.0.0.10",
        headers: {
          ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...extraHeaders,
        },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let body;
          try { body = JSON.parse(text); } catch { body = null; }
          resolve({ status: res.statusCode, headers: res.headers, body, text });
        });
      });
      req.setTimeout(10_000, () => req.destroy(new Error("HTTP matrix request timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  function privateAbsent(response, foreign) {
    assert.ok(!response.text.includes(foreign.canary), "foreign tenant canary must not escape");
    for (const key of ["tenant", "contact", "conversation", "message", "payment", "ocr", "type", "appointment", "workflow", "run", "effect", "inbox"]) {
      assert.ok(!response.text.includes(foreign[key]), `foreign ${key} identifier must not escape`);
    }
    for (const user of Object.values(foreign.users)) assert.ok(!response.text.includes(user.id), "foreign user ID must not escape");
  }

  async function snapshot(tenantId) {
    // Fixed, server-authored table names; all values remain SQL parameters.
    const data = {};
    for (const table of TABLES) {
      const rows = await dbPool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [tenantId]);
      data[table] = rows.rows;
    }
    return data;
  }

  it("every composed protected API route rejects anonymous real HTTP requests", async (t) => {
    const routes = app._router.stack.flatMap((layer) => {
      const route = layer.route;
      if (!route || typeof route.path !== "string" || !route.path.startsWith("/api/")) return [];
      return Object.keys(route.methods).map((method) => [method.toUpperCase(), route.path]);
    }).filter(([method, path]) => !PUBLIC_API.has(`${method} ${path}`));
    assert.ok(routes.length >= 35);
    for (const [method, path] of routes) {
      await t.test(`${method} ${path}`, async () => {
        const expanded = path.replace(/:[A-Za-z]+/g, fixtures[0].conversation);
        const res = await request(null, method, expanded, method === "GET" ? undefined : {});
        assert.equal(res.status, 401, res.text);
      });
    }
  });

  function privileged(f) {
    return [
      ["GET", `/api/contacts/${f.contact}/ai-memory`],
      ["POST", `/api/contacts/${f.contact}/ai-memory`, { key: "name", value: f.canary }],
      ["POST", "/api/payments", { provider: "synthetic", providerPaymentId: "control-" + randomUUID(), amountMinor: 1000, currency: "USD" }],
      ["PATCH", `/api/payments/${f.payment}/status`, { status: "pending" }],
      ["GET", "/api/automations"],
      ["POST", "/api/automations", { name: "control-" + randomUUID(), definition: { steps: [] } }],
      ["PATCH", `/api/automations/${f.workflow}/status`, { status: "active" }],
      ["POST", `/api/automations/${f.workflow}/run`, {}],
      ["GET", "/api/automations/health"],
      ["GET", "/api/automations/webhook-effects/unknown"],
      ["POST", `/api/automations/webhook-effects/${f.effect}/resolve`, { outcome: "not_sent", reason: "synthetic operator check" }],
      ["POST", "/api/appointments/types", { name: "control", durationMinutes: 30 }],
      ["PUT", "/api/appointments/hours", { hours: [] }],
      ["PUT", "/api/business-brain", { businessName: f.canary, description: f.canary }],
      ["GET", "/api/webhook-inbox/dead-letters"],
      ["POST", `/api/webhook-inbox/dead-letters/${f.inbox}/retry`, { reason: "synthetic operator check" }],
    ];
  }

  it("agent denial and legitimate owner/admin access are proved over HTTP", async (t) => {
    for (const f of fixtures) for (const role of ["agent", "owner", "admin"]) {
      if (role !== "agent") {
        await dbPool.query("UPDATE automation_runs SET status='failed' WHERE id=$1", [f.run]);
        await dbPool.query("UPDATE automation_webhook_effects SET status='unknown' WHERE id=$1", [f.effect]);
        await dbPool.query("UPDATE webhook_messages SET state='DEAD_LETTER' WHERE id=$1", [f.inbox]);
      }
      for (const [method, path, body] of privileged(f)) {
        await t.test(`${role} ${method} ${path}`, async () => {
          const foreign = fixtures.find((other) => other !== f);
          const scopedPath = method === "GET" ? path + "?tenantId=" + foreign.tenant : path;
          const res = await request(f.users[role], method, scopedPath, body);
          privateAbsent(res, foreign);
          if (role === "agent") assert.equal(res.status, 403, res.text);
          else assert.ok(res.status >= 200 && res.status < 300, `${res.status} ${res.text}`);
        });
      }
    }
  });

  it("list and resource reads never return another tenant's canaries or IDs", async (t) => {
    for (const [index, f] of fixtures.entries()) {
      const foreign = fixtures[1 - index];
      const lists = ["/api/auth/me", "/api/dashboard/summary", "/api/contacts", "/api/conversations", "/api/payments", "/api/usage", "/api/appointments/types", "/api/appointments/hours", "/api/appointments", "/api/ocr/documents", "/api/business-brain"];
      const resources = (x) => [
        [`/api/conversations/${x.conversation}/messages`, 200],
        [`/api/conversations/${x.conversation}/copilot/drafts`, 200],
        [`/api/conversations/${x.conversation}/handoff`, 404],
        [`/api/conversations/${x.conversation}/handoff-summary`, 404],
        [`/api/payments/${x.payment}`, 404], [`/api/ocr/documents/${x.ocr}`, 404],
        [`/api/appointments/${x.appointment}`, 404], [`/api/appointments/${x.appointment}/ics`, 404],
        [`/api/contacts/${x.contact}/ai-memory`, 200, true],
      ];
      for (const role of ["owner", "admin", "agent"]) {
        const actor = f.users[role];
        for (const path of lists) await t.test(`${role} own-scope ${path}`, async () => {
          const res = await request(actor, "GET", path + "?tenantId=" + foreign.tenant);
          assert.equal(res.status, 200, res.text);
          privateAbsent(res, foreign);
        });
        for (const [path, status, privileged] of resources(foreign)) await t.test(`${role} foreign ${path}`, async () => {
          const res = await request(actor, "GET", path);
          const expected = privileged && role === "agent" ? 403 : status;
          assert.equal(res.status, expected, res.text);
          if (expected === 200) assert.deepEqual(res.body.data, []);
          privateAbsent(res, foreign);
        });
        // Positive controls prove the resource handlers are actually reachable,
        // rather than returning empty data for all users.
        for (const [path, , privileged] of resources(f)) await t.test(`${role} owned ${path}`, async () => {
          const res = await request(actor, "GET", path);
          if (privileged && role === "agent") {
            assert.equal(res.status, 403, res.text);
            return;
          }
          assert.equal(res.status, 200, res.text);
          if (path.endsWith("/handoff")) assert.equal(res.body.data.id, f.conversation);
          else assert.ok(res.text.includes(f.canary), "owned resource should expose its synthetic data");
          privateAbsent(res, foreign);
        });
      }
    }
  });

  it("foreign resource mutations are denied and leave the complete foreign snapshot unchanged", async (t) => {
    for (const [index, f] of fixtures.entries()) {
      const foreign = fixtures[1 - index];
      const before = await snapshot(foreign.tenant);
      const writes = [
        ["PATCH", `/api/conversations/${foreign.conversation}`, { priority: 5 }],
        ["POST", `/api/conversations/${foreign.conversation}/read`, {}],
        ["POST", `/api/conversations/${foreign.conversation}/notes`, { body: "forbidden foreign note" }],
        ["PUT", `/api/conversations/${foreign.conversation}/tags`, { tags: ["forbidden"] }],
        ["POST", `/api/conversations/${foreign.conversation}/handoff`, {}],
        ["POST", `/api/conversations/${foreign.conversation}/pause-ai`, {}],
        ["POST", `/api/conversations/${foreign.conversation}/resume-ai`, {}],
        ["POST", `/api/conversations/${foreign.conversation}/assign-round-robin`, {}],
        ["POST", `/api/conversations/${foreign.conversation}/copilot/draft`, {}],
        ["POST", `/api/contacts/${foreign.contact}/ai-memory`, { key: "name", value: "forbidden" }],
        ["PATCH", `/api/payments/${foreign.payment}/status`, { status: "paid" }],
        ["PATCH", `/api/appointments/${foreign.appointment}/status`, { status: "cancelled" }],
        ["PATCH", `/api/automations/${foreign.workflow}/status`, { status: "paused" }],
        ["POST", `/api/automations/${foreign.workflow}/run`, {}],
        ["POST", `/api/automations/webhook-effects/${foreign.effect}/resolve`, { outcome: "not_sent", reason: "forbidden" }],
        ["POST", `/api/webhook-inbox/dead-letters/${foreign.inbox}/retry`, { reason: "forbidden" }],
      ];
      for (const role of ["owner", "admin", "agent"]) for (const [method, path, body] of writes) {
        await t.test(`${role} ${method} ${path}`, async () => {
          const res = await request(f.users[role], method, path, body);
          assert.ok(res.status >= 400 && res.status < 500, `${res.status} ${res.text}`);
          privateAbsent(res, foreign);
        });
      }
      assert.deepEqual(await snapshot(foreign.tenant), before, "forbidden requests must not mutate foreign rows, summaries, queues or usage");
    }
  });

  it("nested foreign IDs are rejected without persisted side effects or provider calls", async (t) => {
    for (const [index, f] of fixtures.entries()) {
      const foreign = fixtures[1 - index];
      const before = await snapshot(f.tenant);
      const probes = [
        ["PATCH", `/api/conversations/${f.conversation}`, { assignedUserId: foreign.users.agent.id }],
        ["POST", `/api/automations/${f.workflow}/run`, { contactId: foreign.contact }],
        ["POST", `/api/automations/${f.workflow}/run`, { conversationId: foreign.conversation }],
        ["POST", "/api/appointments", { appointmentTypeId: f.type, startsAt: new Date(Date.now() + 10 * 86400_000).toISOString(), customerName: "synthetic", customerPhone: "15550001111", contactId: foreign.contact }],
        ["POST", "/api/appointments", { appointmentTypeId: f.type, startsAt: new Date(Date.now() + 10 * 86400_000).toISOString(), customerName: "synthetic", customerPhone: "15550001111", conversationId: foreign.conversation }],
      ];
      for (const [method, path, body] of probes) await t.test(`${method} ${path} ${Object.keys(body).at(-1)}`, async () => {
        const res = await request(f.users.owner, method, path, body);
        assert.ok(res.status >= 400 && res.status < 500, `${res.status} ${res.text}`);
        privateAbsent(res, foreign);
      });
      assert.deepEqual(await snapshot(f.tenant), before, "nested foreign IDs must not leave local side effects");
    }
    assert.equal(providerCalls, 0, "no request may reach a paid/external provider");
  });

  it("owned nested references, clearing assignment and caller-owned writes remain usable", async () => {
    for (const [index, f] of fixtures.entries()) {
      const foreign = fixtures[1 - index];
      const actor = f.users.owner;
      const assignment = await request(actor, "PATCH", `/api/conversations/${f.conversation}`, { assignedUserId: f.users.agent.id });
      assert.equal(assignment.status, 200, assignment.text);
      assert.equal(assignment.body.data.assigned_user_id, f.users.agent.id);
      const clear = await request(actor, "PATCH", `/api/conversations/${f.conversation}`, { assignedUserId: null });
      assert.equal(clear.status, 200, clear.text);
      assert.equal(clear.body.data.assigned_user_id, null);
      const run = await request(actor, "POST", `/api/automations/${f.workflow}/run`, { conversationId: f.conversation, contactId: f.contact, tenantId: foreign.tenant });
      assert.equal(run.status, 202, run.text);
      assert.equal(run.body.data.tenant_id, f.tenant);
      assert.equal(run.body.data.conversation_id, f.conversation);
      assert.equal(run.body.data.contact_id, f.contact);
      const booking = await request(actor, "POST", "/api/appointments", { appointmentTypeId: f.type, startsAt: new Date(Date.now() + 12 * 86400_000).toISOString(), customerName: "synthetic control", customerPhone: "15550001111", contactId: f.contact, conversationId: f.conversation, tenantId: foreign.tenant });
      assert.equal(booking.status, 201, booking.text);
      assert.equal(booking.body.data.tenant_id, f.tenant);
      assert.equal(booking.body.data.contact_id, f.contact);
      assert.equal(booking.body.data.created_by, actor.id);
      const foreignUserBefore = await dbPool.query("SELECT skills FROM users WHERE id=$1", [foreign.users.agent.id]);
      const skills = await request(f.users.agent, "PUT", "/api/users/me/skills", { skills: ["sales"], tenantId: foreign.tenant, userId: foreign.users.agent.id });
      assert.equal(skills.status, 200, skills.text);
      assert.equal(skills.body.data.id, f.users.agent.id);
      const foreignUserAfter = await dbPool.query("SELECT skills FROM users WHERE id=$1", [foreign.users.agent.id]);
      assert.deepEqual(foreignUserAfter.rows, foreignUserBefore.rows);
      for (const role of ["owner", "admin", "agent"]) {
        const analyze = await request(f.users[role], "POST", "/api/ai/analyze", { message: "Can I book a service?", tenantId: foreign.tenant });
        assert.equal(analyze.status, 200, analyze.text);
        privateAbsent(analyze, foreign);
        const invalidOcr = await request(f.users[role], "POST", "/api/ocr/extract", {});
        assert.equal(invalidOcr.status, 400, "authenticated roles reach upload validation before any provider operation");
      }
    }
  });

  it("diagnostic role checks reach validation for owner/admin and deny agents without a provider call", async () => {
    for (const f of fixtures) for (const role of ["owner", "admin", "agent"]) {
      const res = await request(f.users[role], "POST", "/api/test/gemini", { message: "" });
      assert.equal(res.status, role === "agent" ? 403 : 400, res.text);
    }
    assert.equal(providerCalls, 0);
  });

  it("real HTTP login/refresh/logout revokes access and reports database logout failures honestly", async () => {
    const f = fixtures[0];
    const id = randomUUID();
    const email = `http-login-${id}@example.com`;
    const password = "synthetic-http-password-12345";
    const { hashPassword } = await import("../src/services/auth.service.js");
    await dbPool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,'agent')", [id, f.tenant, email, await hashPassword(password)]);
    const actor = { ip: "127.0.0.40" };
    const login = await request(actor, "POST", "/api/auth/login", { email, password });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.body.user.id, id);
    actor.token = login.body.token;
    const originalConnect = dbPool.connect;
    dbPool.connect = async () => { throw new Error("synthetic logout database failure"); };
    try {
      const failedLogout = await request(actor, "POST", "/api/auth/logout", { refreshToken: login.body.refreshToken });
      assert.equal(failedLogout.status, 503);
      assert.equal(failedLogout.body.error, "Logout could not be completed");
    } finally { dbPool.connect = originalConnect; }
    assert.equal((await request(actor, "GET", "/api/auth/me")).status, 200);
    const refreshed = await request(actor, "POST", "/api/auth/refresh", { refreshToken: login.body.refreshToken });
    assert.equal(refreshed.status, 200, refreshed.text);
    actor.token = refreshed.body.token;
    assert.equal((await request(actor, "GET", "/api/auth/me")).status, 200);
    const logout = await request(actor, "POST", "/api/auth/logout", { refreshToken: refreshed.body.refreshToken });
    assert.equal(logout.status, 204, logout.text);
    assert.equal((await request(actor, "GET", "/api/auth/me")).status, 401);
    assert.equal((await request(actor, "POST", "/api/auth/refresh", { refreshToken: refreshed.body.refreshToken })).status, 401);
  });

  it("global and dedicated auth/diagnostic rate limits apply through real HTTP middleware", async () => {
    const cases = [
      ["127.0.0.31", "POST", "/api/auth/login", 10, 400],
      ["127.0.0.32", "POST", "/api/auth/refresh", 30, 400],
      ["127.0.0.33", "POST", "/api/test/gemini", 5, 401],
      ["127.0.0.34", "GET", "/health", 120, 200],
    ];
    for (const [ip, method, path, limit, initialStatus] of cases) {
      const actor = { ip };
      for (let i = 0; i < limit; i += 1) {
        const res = await request(actor, method, path, method === "GET" ? undefined : {});
        assert.equal(res.status, initialStatus, `${path} request ${i}: ${res.text}`);
      }
      const limited = await request(actor, method, path, method === "GET" ? undefined : {});
      assert.equal(limited.status, 429, path);
      assert.ok(Number(limited.headers["retry-after"]) > 0, "clients must receive retry guidance");
    }
    assert.equal(providerCalls, 0);
  });

  it("signed status HTTP callbacks enforce raw recipient and correlation fields", async (t) => {
    const f = fixtures[0];
    const phone = "15550005401";
    await dbPool.query("UPDATE whatsapp_numbers SET phone_number_id=$2 WHERE id=$1", [f.number, phone]);
    const { prepareDelivery, getDelivery } = await import("../src/services/whatsapp-delivery.service.js");
    async function seedTarget() {
      const inbox = randomUUID();
      await dbPool.query("INSERT INTO webhook_messages (id,tenant_id,whatsapp_number_id,phone_number_id,whatsapp_message_id,wa_id,body,received_at,state) VALUES ($1,$2,$3,$4,$5,'15550001111','Synthetic receipt source',NOW(),'DEAD_LETTER')", [inbox, f.tenant, f.number, phone, "wamid.http-source-" + inbox]);
      const delivery = await prepareDelivery({ tenantId: f.tenant, inboxMessageId: inbox, conversationId: f.conversation, recipientWaId: "15550001111", body: "Synthetic receipt reply" });
      return { delivery, providerId: "wamid.http-receipt-" + randomUUID() };
    }
    async function receipt(target, override = {}, validSignature = true) {
      const body = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phone }, statuses: [{ id: target.providerId, status: "sent", recipient_id: "15550001111", biz_opaque_callback_data: target.delivery.delivery_key, timestamp: String(Math.floor(Date.now() / 1000)), ...override }] } }] }] };
      const signature = createHmac("sha256", validSignature ? META_STATUS_SECRET : "wrong-synthetic-secret").update(JSON.stringify(body)).digest("hex");
      return request({ ip: "127.0.0.42" }, "POST", "/webhook", body, { "X-Hub-Signature-256": "sha256=" + signature });
    }
    await t.test("valid progression and replay", async () => {
      const target = await seedTarget();
      for (const status of ["sent", "delivered", "read", "sent"]) assert.equal((await receipt(target, { status })).status, 200);
      const row = await getDelivery(target.delivery.id, f.tenant);
      assert.equal(row.state, "READ");
      assert.equal(row.provider_message_id, target.providerId);
      assert.equal(row.attempt_count, 0);
    });
    const invalid = [
      ["wrong raw recipient_id", { recipient_id: "15559990000" }],
      ["conflicting provider id", { id: "wamid.http-unrelated-" + randomUUID() }],
      ["unknown callback key", { biz_opaque_callback_data: randomUUID() }],
      ["malformed callback UUID", { biz_opaque_callback_data: "-".repeat(36) }],
    ];
    for (const [label, override] of invalid) await t.test(label, async () => {
      const target = await seedTarget();
      assert.equal((await receipt(target)).status, 200);
      const before = await getDelivery(target.delivery.id, f.tenant);
      const response = await receipt(target, { status: "read", ...override });
      assert.equal(response.status, 200, "an authenticated but inconsistent receipt is safely ignored");
      assert.deepEqual(await getDelivery(target.delivery.id, f.tenant), before);
    });
    await t.test("known provider ID with absent callback data", async () => {
      const target = await seedTarget();
      assert.equal((await receipt(target)).status, 200);
      assert.equal((await receipt(target, { status: "delivered", biz_opaque_callback_data: undefined })).status, 200);
      assert.equal((await getDelivery(target.delivery.id, f.tenant)).state, "DELIVERED");
    });
    await t.test("invalid signature never changes a known delivery", async () => {
      const target = await seedTarget();
      assert.equal((await receipt(target)).status, 200);
      const before = await getDelivery(target.delivery.id, f.tenant);
      assert.equal((await receipt(target, { status: "read" }, false)).status, 403);
      assert.deepEqual(await getDelivery(target.delivery.id, f.tenant), before);
    });
    await t.test("unrelated database failures are retriable 500s with no private detail", async () => {
      const target = await seedTarget();
      assert.equal((await receipt(target)).status, 200);
      const before = await getDelivery(target.delivery.id, f.tenant);
      const originalQuery = dbPool.query;
      const sentinel = "synthetic-private-callback-database-error";
      dbPool.query = function (sql, ...args) {
        if (typeof sql === "string" && sql.includes("WITH target AS") && sql.includes("UPDATE whatsapp_deliveries d")) {
          const failure = new Error(sentinel);
          failure.code = "23505";
          failure.constraint = "unrelated_synthetic_constraint";
          return Promise.reject(failure);
        }
        return originalQuery.call(this, sql, ...args);
      };
      try {
        const response = await receipt(target, { status: "read" });
        assert.equal(response.status, 500);
        assert.equal(response.body.message, "Internal server error");
        assert.ok(!response.text.includes(sentinel));
      } finally { dbPool.query = originalQuery; }
      assert.deepEqual(await getDelivery(target.delivery.id, f.tenant), before);
    });
    assert.equal(providerCalls, 0);
  });

  it("token role claims cannot promote a database agent, and unexpected errors remain private", async (t) => {
    const f = fixtures[0];
    const forgedRole = { ...f.users.agent, ip: "127.0.0.20", token: generateToken({ ...f.users.agent, role: "owner" }) };
    assert.equal((await request(forgedRole, "GET", "/api/automations")).status, 403);
    const originalQuery = dbPool.query;
    const sentinel = "synthetic-private-database-error-canary";
    dbPool.query = function (sql, ...args) {
      if (typeof sql === "string" && sql.includes("SELECT * FROM ocr_documents")) return Promise.reject(new Error(sentinel));
      return originalQuery.call(this, sql, ...args);
    };
    try {
      const res = await request(f.users.owner, "GET", "/api/ocr/documents");
      assert.equal(res.status, 500);
      assert.equal(res.body.message, "Internal server error");
      assert.ok(!res.text.includes(sentinel));
    } finally { dbPool.query = originalQuery; }
    assert.equal(providerCalls, 0);
    t.diagnostic(`HTTP requests completed: ${requestCount}; external provider calls: ${providerCalls}`);
  });
});
