import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const indexSource = await fs.readFile(path.join(testsDirectory, "../src/index.js"), "utf8");

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing route marker: ${endMarker}`);
  return source.slice(start, end);
}

test("dead-letter listing is authenticated, owner/admin-only, and uses the caller tenant", () => {
  const route = sectionBetween(
    indexSource,
    'app.get(\n  "/api/webhook-inbox/dead-letters"',
    'app.post(\n  "/api/webhook-inbox/dead-letters/:inboxId/retry"',
  );

  assert.ok(route.includes("requireAuth"));
  assert.ok(route.includes('requireRole("owner", "admin")'));
  assert.ok(route.includes("listDeadLetterMessages(req.user.tenantId"));
  assert.ok(!route.includes("req.query.tenantId"), "tenant identity must never come from query parameters");
});

test("manual dead-letter retry is authenticated, tenant-scoped, reasoned, and logged", () => {
  const route = sectionBetween(
    indexSource,
    'app.post(\n  "/api/webhook-inbox/dead-letters/:inboxId/retry"',
    'app.get("/api/conversations"',
  );

  assert.ok(route.includes("requireAuth"));
  assert.ok(route.includes('requireRole("owner", "admin")'));
  assert.ok(route.includes("req.user.tenantId"));
  assert.ok(route.includes("req.user.id"));
  assert.ok(route.includes("req.body?.reason"));
  assert.ok(route.includes('res.status(202)'));
  assert.ok(route.includes('res.status(409)'));
  assert.ok(route.includes("Dead-letter webhook message manually requeued"));
});
