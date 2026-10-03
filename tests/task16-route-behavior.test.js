import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import express from "express";

// ---------------------------------------------------------------------------
// Behavioural proof that Task 16 routes are genuinely reachable through the
// production app composition (src/index.js), not just present in source order.
//
// Two independent forms of evidence:
//   1. The compiled Express router layer stack: every Task 16 route layer must
//      precede the terminal 404 middleware layer.
//   2. Real HTTP requests against the real exported app: an unauthenticated
//      request to a Task 16 route must reach its route/auth middleware
//      (401/403) instead of being swallowed by the terminal 404.
//
// Requires no database, no WhatsApp, no Gemini and no credentials:
//   - requireAuth answers 401 before touching JWT config or the DB when the
//     Authorization header is absent.
//   - the payment webhook answers 403 when no webhook secret is configured.
//
// src/index.js calls app.listen() at module scope (startServer). That would
// bind a port and keep the test process alive, so the listen is suppressed
// while the module is imported, then restored for the test's own server.
// ---------------------------------------------------------------------------

const TASK16_ROUTES = [
  "/api/payments/:paymentId",
  "/api/payments/:paymentId/status",
  "/api/payments/webhook/:tenantId",
  "/api/ocr/documents",
  "/api/ocr/documents/:documentId",
  "/api/ocr/extract",
];

let app;
let server;
let baseUrl;
const realListen = express.application.listen;

function fakeServer() {
  return {
    on() { return this; },
    once() { return this; },
    close(cb) { if (typeof cb === "function") cb(); return this; },
    address() { return { port: 0, address: "127.0.0.1", family: "IPv4" }; },
    unref() { return this; },
    ref() { return this; },
  };
}

before(async () => {
  express.application.listen = function suppressed() { return fakeServer(); };
  try {
    ({ default: app } = await import("../src/index.js"));
  } finally {
    // express() mixins application methods onto the app instance, so the
    // instance holds its own copy of `listen` captured at construction time.
    // Restoring the prototype alone is not enough - restore it on the instance.
    express.application.listen = realListen;
    app.listen = realListen;
  }
  server = app.listen(0);
  await new Promise((resolve) => server.on("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

test("compiled Express stack places every Task 16 route before the terminal 404", () => {
  assert.ok(app, "the production app must be importable");
  assert.ok(app._router, "app must have a compiled Express router");

  const layers = app._router.stack;
  const errorLayerIndex = layers.findIndex((layer) => layer.handle?.length === 4);
  assert.ok(errorLayerIndex > 0, "the 4-argument error handler must be registered");

  // The terminal 404 is the non-error, route-less layer immediately preceding
  // the error handler (src/index.js: app.use((req, res) => ...404...)).
  const terminal404Index = errorLayerIndex - 1;
  const terminal404 = layers[terminal404Index];
  assert.equal(terminal404.route, undefined, "terminal 404 must not be a route layer");
  assert.equal(terminal404.handle?.length, 2, "terminal 404 must be (req, res) => ...");

  const located = new Map();
  layers.forEach((layer, index) => {
    const routePath = layer.route?.path;
    if (routePath) located.set(routePath, index);
  });

  for (const route of TASK16_ROUTES) {
    const index = located.get(route);
    assert.notEqual(index, undefined, `Task 16 route ${route} must be registered on the app`);
    assert.ok(
      index < terminal404Index,
      `Task 16 route ${route} is registered at layer ${index}, AFTER the terminal 404 at ${terminal404Index} -> unreachable`,
    );
  }
});

test("unauthenticated GET /api/ocr/documents reaches requireAuth (401), not the catch-all 404", async () => {
  const res = await request("GET", "/api/ocr/documents");
  assert.equal(res.status, 401, `expected 401 from requireAuth, got ${res.status} ${res.body}`);
  assert.doesNotMatch(res.body, /Route not found/, "must not be answered by the terminal 404");
  assert.match(res.body, /Authentication required/);
});

test("unauthenticated GET /api/payments/:paymentId reaches requireAuth (401), not the catch-all 404", async () => {
  const res = await request("GET", "/api/payments/pay_123");
  assert.equal(res.status, 401, `expected 401 from requireAuth, got ${res.status} ${res.body}`);
  assert.doesNotMatch(res.body, /Route not found/, "must not be answered by the terminal 404");
  assert.match(res.body, /Authentication required/);
});

test("POST /api/payments/webhook/:tenantId reaches the webhook handler (403), not the catch-all 404", async () => {
  // No payment webhook secret is configured in the test environment, and no
  // signature is sent, so the handler must reject with 403.
  const res = await request("POST", "/api/payments/webhook/tenant_1", { tenantId: "tenant_1" });
  assert.equal(res.status, 403, `expected 403 from the webhook handler, got ${res.status} ${res.body}`);
  assert.doesNotMatch(res.body, /Route not found/, "must not be answered by the terminal 404");
});

test("POST /api/ocr/extract reaches requireAuth (401), not the catch-all 404", async () => {
  const res = await request("POST", "/api/ocr/extract", { not: "a file" });
  assert.equal(res.status, 401, `expected 401 from requireAuth, got ${res.status} ${res.body}`);
  assert.doesNotMatch(res.body, /Route not found/, "must not be answered by the terminal 404");
});

test("the terminal 404 still handles genuinely unknown routes", async () => {
  const res = await request("GET", "/__definitely_not_a_real_route__");
  assert.equal(res.status, 404);
  assert.match(res.body, /Route not found/);
});
