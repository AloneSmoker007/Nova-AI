import test from "node:test";
import assert from "node:assert/strict";
import { requireRole } from "../src/middleware/require-role.js";

test("requireRole allows an authorized role", () => {
  let nextCalled = false;
  const req = { user: { role: "admin" } };
  const res = {
    status() {
      throw new Error("status should not be called");
    },
  };

  requireRole("owner", "admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test("requireRole rejects an unauthorized role", () => {
  let nextCalled = false;
  let statusCode;
  const req = { user: { role: "agent" } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      assert.equal(body.error, "Insufficient permissions");
      return this;
    },
  };

  requireRole("owner", "admin")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
});

test("requireRole rejects a request without an authenticated user", () => {
  let nextCalled = false;
  let statusCode;
  const req = {};
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      assert.equal(body.error, "Authentication required");
      return this;
    },
  };

  requireRole("owner")(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
});
