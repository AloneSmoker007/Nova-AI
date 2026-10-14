import assert from "node:assert/strict";
import express from "express";
import { before, test } from "node:test";

import { requireAuth } from "../src/middleware/auth.js";

const PUBLIC_API_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "POST /api/payments/webhook/:tenantId",
]);

let app;
const realListen = express.application.listen;

function fakeServer() {
  return {
    on() { return this; },
    once() { return this; },
    close(callback) { if (typeof callback === "function") callback(); return this; },
    address() { return { port: 0, address: "127.0.0.1", family: "IPv4" }; },
    unref() { return this; },
    ref() { return this; },
  };
}

before(async () => {
  // This is a route-composition test, not a boot/database test.
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "";
  express.application.listen = function suppressedListen() { return fakeServer(); };
  try {
    ({ default: app } = await import("../src/index.js"));
  } finally {
    express.application.listen = realListen;
    if (app) app.listen = realListen;
  }
});

function allApiRoutes() {
  const routes = [];
  for (const layer of app?._router?.stack ?? []) {
    const route = layer.route;
    if (!route || typeof route.path !== "string" || !route.path.startsWith("/api/")) continue;
    for (const method of Object.keys(route.methods || {})) {
      if (method === "_all") continue;
      routes.push({
        key: `${method.toUpperCase()} ${route.path}`,
        middleware: route.stack.map((entry) => entry.handle),
      });
    }
  }
  return routes;
}

test("every API route has authentication or is an explicit token/signature endpoint", () => {
  assert.ok(app?._router, "the composed Express router must exist");
  const routes = allApiRoutes();
  assert.ok(routes.length >= 35, `expected a useful full API inventory, found ${routes.length}`);

  const missing = routes
    .filter((route) => !PUBLIC_API_ROUTES.has(route.key))
    .filter((route) => !route.middleware.includes(requireAuth))
    .map((route) => route.key);

  assert.deepEqual(
    missing,
    [],
    "every non-public API route must include requireAuth; add any deliberate exception with a verified signature/token contract",
  );

  const seen = routes.map((route) => route.key);
  assert.equal(new Set(seen).size, seen.length, "each method/path pair should have one handler");
});

test("privileged data/configuration endpoints retain owner/admin guards", () => {
  const routes = new Map(allApiRoutes().map((route) => [route.key, route.middleware]));
  const privileged = [
    "GET /api/contacts/:contactId/ai-memory",
    "POST /api/contacts/:contactId/ai-memory",
    "POST /api/payments",
    "PATCH /api/payments/:paymentId/status",
    "GET /api/automations",
    "POST /api/automations",
    "PATCH /api/automations/:workflowId/status",
    "POST /api/automations/:workflowId/run",
    "POST /api/appointments/types",
    "PUT /api/appointments/hours",
    "PUT /api/business-brain",
    "GET /api/webhook-inbox/dead-letters",
    "POST /api/webhook-inbox/dead-letters/:inboxId/retry",
  ];

  for (const key of privileged) {
    const middleware = routes.get(key);
    assert.ok(middleware, `expected privileged route ${key}`);
    assert.ok(
      middleware.length >= 3,
      `${key} must contain auth, role guard, and route handler middleware`,
    );
  }
});
