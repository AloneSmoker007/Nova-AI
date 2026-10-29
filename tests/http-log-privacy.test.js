import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import { createHttpLogger } from "../src/config/logger.js";

async function captureRequest(target) {
  const chunks = [];
  const sink = new Writable({ write(chunk, encoding, done) { chunks.push(chunk.toString()); done(); } });
  const middleware = createHttpLogger(pino({ level: "info" }, sink));
  const server = http.createServer((req, res) => {
    middleware(req, res);
    const url = new URL(req.url, "http://localhost");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ originalUrl: req.url, page: url.searchParams.get("page") }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${target}`, {
      headers: { "x-request-id": "synthetic-request-id" },
    });
    const body = await response.json();
    const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    return { body, records };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const [index, target] of [
  "/webhook?hub.mode=subscribe&hub.verify_token=SYNTHETIC_VERIFY_TOKEN&hub.challenge=SYNTHETIC_CHALLENGE",
  "/webhook?hub.verify_token=WRONG_SYNTHETIC_TOKEN&hub.challenge=SECOND_CHALLENGE",
  "/webhook?hub%2Everify_token=ENCODED_SYNTHETIC_TOKEN&hub.verify_token=REPEATED_SYNTHETIC_TOKEN",
  "/api/conversations?page=2&search=SYNTHETIC_PRIVATE_SEARCH",
  "/health",
].entries()) {
  test(`HTTP logs retain path without query data (case ${index + 1}: ${target.split("?")[0]})`, async () => {
    const { body, records } = await captureRequest(target);
    assert.equal(body.originalUrl, target, "logging must not mutate the request used by routing/verification");
    if (target.includes("page=2")) assert.equal(body.page, "2");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].req, { id: "synthetic-request-id", method: "GET", url: target.split("?")[0] });
    assert.equal(records[0].res.statusCode, 200);
    const logged = JSON.stringify(records);
    assert.equal(logged.includes("?"), false);
    assert.doesNotMatch(logged, /SYNTHETIC_|CHALLENGE|hub[.%]/);
  });
}

test("real Nova verification accepts/rejects tokens while neither query reaches its HTTP logs", () => {
  const source = `
    import assert from "node:assert/strict";
    import express from "express";
    const listen = express.application.listen;
    express.application.listen = function () { return { on() { return this; }, close(done) { done(); } }; };
    const { default: app, appStartupPromise, stopBackgroundServices } = await import("./src/index.js");
    await appStartupPromise;
    express.application.listen = listen;
    app.listen = listen;
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    try {
      const base = "http://127.0.0.1:" + server.address().port;
      for (const [token, status, id] of [["SYNTHETIC_REAL_VERIFY", 200, "verify-ok"], ["SYNTHETIC_WRONG_VERIFY", 403, "verify-denied"]]) {
        const response = await fetch(base + "/webhook?hub.mode=subscribe&hub.verify_token=" + token + "&hub.challenge=SYNTHETIC_REAL_CHALLENGE", { headers: { "x-request-id": id } });
        assert.equal(response.status, status);
        const body = await response.text();
        if (status === 200) assert.equal(body, "SYNTHETIC_REAL_CHALLENGE");
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      await stopBackgroundServices({ closeDatabase: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10000,
    env: {
      ...process.env, NODE_ENV: "test", LOG_LEVEL: "info", DATABASE_URL: "", REDIS_URL: "",
      GEMINI_API_KEY: "synthetic-no-provider", META_APP_SECRET: "synthetic-meta-secret",
      WEBHOOK_VERIFY_TOKEN: "SYNTHETIC_REAL_VERIFY", CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32), JWT_SECRET: "synthetic-jwt-secret-".repeat(3),
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const requests = records.filter((record) => record.req);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => [r.req.id, r.req.method, r.req.url, r.res.statusCode]), [
    ["verify-ok", "GET", "/webhook", 200], ["verify-denied", "GET", "/webhook", 403],
  ]);
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_REAL_VERIFY|SYNTHETIC_WRONG_VERIFY|SYNTHETIC_REAL_CHALLENGE|hub.verify_token/);
});
