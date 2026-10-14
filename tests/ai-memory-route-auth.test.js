import assert from "node:assert/strict";
import { before, test } from "node:test";
import express from "express";

import { requireAuth } from "../src/middleware/auth.js";

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
  express.application.listen = function suppressedListen() { return fakeServer(); };
  try {
    ({ default: app } = await import("../src/index.js"));
  } finally {
    express.application.listen = realListen;
    app.listen = realListen;
  }
});

function routeFor(method, path) {
  const layer = app._router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods?.[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must be registered`);
  return layer.route;
}

function runRoleGuard(guard, role) {
  let statusCode = null;
  let responseBody = null;
  let nextCalled = false;
  const result = guard(
    { user: { role } },
    {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return this; },
    },
    () => { nextCalled = true; },
  );
  return { result, statusCode, responseBody, nextCalled };
}

test("AI-memory GET and POST authenticate first and then enforce owner/admin role policy", () => {
  for (const [method, path] of [
    ["get", "/api/contacts/:contactId/ai-memory"],
    ["post", "/api/contacts/:contactId/ai-memory"],
  ]) {
    const route = routeFor(method, path);
    assert.equal(route.stack[0].handle, requireAuth, `${method} must authenticate before role checks`);
    const roleGuard = route.stack[1]?.handle;
    assert.equal(typeof roleGuard, "function", `${method} must register a role guard before the handler`);

    for (const role of ["agent"]) {
      const denied = runRoleGuard(roleGuard, role);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.responseBody.error, "Insufficient permissions");
      assert.equal(denied.nextCalled, false);
    }

    for (const role of ["owner", "admin"]) {
      const allowed = runRoleGuard(roleGuard, role);
      assert.equal(allowed.nextCalled, true, `${role} should be allowed to ${method} AI memory`);
      assert.equal(allowed.statusCode, null);
    }
  }
});
