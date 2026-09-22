import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = await fs.readFile(path.join(root, "src", "index.js"), "utf8");

test("central API error handler preserves a stable error field and maps DB conflicts", () => {
  const marker = 'app.use((error, req, res, next) => {';
  const start = indexSource.indexOf(marker);
  assert.ok(start >= 0);
  const end = indexSource.indexOf("\n});", start);
  assert.ok(end >= 0);
  const handler = indexSource.slice(start, end);

  assert.ok(handler.includes('error: publicMessage'));
  assert.ok(handler.includes('message: publicMessage'));
  assert.ok(handler.includes('error?.code === "23505"'));
  assert.ok(handler.includes('error?.code === "23P01"'));
  assert.ok(handler.includes("error?.statusCode"));
  assert.ok(handler.includes("res.headersSent"));
});
