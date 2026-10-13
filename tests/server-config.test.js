import test from "node:test";
import assert from "node:assert/strict";
import { getServerPort } from "../src/config/server.js";

test("server port defaults safely when missing or invalid", () => {
  assert.equal(getServerPort({}), 3000);
  assert.equal(getServerPort({ PORT: "" }), 3000);
  for (const PORT of ["abc", "NaN", "Infinity", "-1", "0", "1.5", "65536", "9999999999999999999"]) {
    assert.equal(
      getServerPort({ PORT }),
      3000,
      `invalid port ${PORT} should fall back to the default port`,
    );
  }
});

test("server port preserves valid integer ports", () => {
  assert.equal(getServerPort({ PORT: "3000" }), 3000);
  assert.equal(getServerPort({ PORT: "8080" }), 8080);
  assert.equal(getServerPort({ PORT: "65535" }), 65535);
});
