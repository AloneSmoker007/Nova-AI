import test from "node:test";
import assert from "node:assert/strict";

const packageJson = await import("../package.json", { with: { type: "json" } });

test("package exposes the production bootstrap and test scripts", () => {
  assert.equal(packageJson.default.scripts.start, "node src/bootstrap.js");
  assert.equal(packageJson.default.scripts.test, "node --test tests");
  assert.match(packageJson.default.engines.node, />=20/);
});
