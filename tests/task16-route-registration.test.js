import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Task 16 routes are registered before the terminal 404 middleware", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const registration = source.indexOf("registerTask16Routes(app);");
  const terminal404 = source.indexOf('app.use((req, res) => res.status(404).json({ status: "error", message: "Route not found" }));');

  assert.notEqual(registration, -1, "Task 16 route registration must exist");
  assert.notEqual(terminal404, -1, "terminal 404 middleware must exist");
  assert.ok(registration < terminal404, "Task 16 routes must be registered before terminal 404");
});
