import test from "node:test";
import assert from "node:assert/strict";

const packageJson = await import("../package.json", { with: { type: "json" } });

test("package exposes the production start and test scripts", () => {
  assert.equal(packageJson.default.scripts.start, "node src/index.js");
  assert.equal(packageJson.default.scripts.test, "node --test tests");
  assert.match(packageJson.default.engines.node, />=20/);
});
