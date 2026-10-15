import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bare test discovery cannot run the live Gemini billing diagnostic", async () => {
  const source = await readFile(new URL("../src/test-gemini.js", import.meta.url), "utf8");
  assert.match(source, /process\.env\.RUN_GEMINI_LIVE_TEST === "1"/);
  assert.match(source, /process\.env\.NODE_TEST_CONTEXT/);
  assert.match(source, /!invokedDirectly/);
  assert.match(source, /Live Gemini diagnostic skipped/);
});
