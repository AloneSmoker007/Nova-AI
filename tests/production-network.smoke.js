// Explicitly invoked by scripts/production-network-smoke.sh, outside unit glob.
// All traffic stays in a disposable internal Docker network; no providers.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getPoolConfig, closeDatabaseConnection } from "../src/config/database.js";

const phase = process.env.NOVA_NETWORK_PHASE;
assert.equal(process.env.NODE_ENV, "production");
assert.ok(["tls", "https", "unavailable", "recovered"].includes(phase), "explicit smoke phase required");
const ca = fs.readFileSync("/certs/ca.crt");
const wrongCaPath = "/certs/wrong-ca.crt";

async function databaseProbe(overrides = {}) {
  const client = new pg.Client(getPoolConfig({ ...process.env, ...overrides }));
  try {
    await client.connect();
    const result = await client.query("SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    assert.equal(result.rows[0]?.ssl, true);
    assert.match(result.rows[0]?.version, /^TLSv1\.[23]$/);
  } finally {
    await client.end();
  }
}

function request(path, { method = "GET", headers = {}, body, host = "edge", trustedCa = ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, port: 443, path, method, ca: trustedCa,
      rejectUnauthorized: true, headers: { ...headers, connection: "close" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.setTimeout(6000, () => req.destroy(new Error("HTTPS smoke timeout")));
    req.end(body);
  });
}

async function waitForReady(expected) {
  let last;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      last = await request("/ready");
      if (last.status === expected) return last;
    } catch (error) { last = error.code ?? error.message; }
    await delay(500);
  }
  assert.fail(`readiness did not reach ${expected}: ${JSON.stringify(last)}`);
}

if (phase === "tls") {
  for (const mode of ["disable", "no-verify", "require&uselibpqcompat=true"]) {
    test(`real production SQL uses verified TLS despite sslmode=${mode}`, async () => {
      const url = new URL(process.env.DATABASE_URL);
      url.search = `sslmode=${mode}`;
      await databaseProbe({ DATABASE_URL: url.toString() });
    });
  }
  test("real database rejects an unrelated CA", async () => {
    await assert.rejects(databaseProbe({ DATABASE_SSL_CA: wrongCaPath }), (error) =>
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code));
  });
  test("real database rejects a trusted certificate for a different hostname", async () => {
    const url = new URL(process.env.DATABASE_URL);
    url.hostname = "db-wrong";
    await assert.rejects(databaseProbe({ DATABASE_URL: url.toString() }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
} else if (phase === "https") {
  test("production bootstrap migrates and becomes ready through verified HTTPS", async () => {
    const response = await waitForReady(200);
    const body = JSON.parse(response.text);
    assert.equal(body.status, "ready");
    assert.equal(body.database, "connected");
    assert.equal(body.redis, "connected");
  });
  test("HTTPS endpoint rejects untrusted CA and mismatched hostname", async () => {
    await assert.rejects(request("/health", { trustedCa: fs.readFileSync(wrongCaPath) }), (error) =>
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code));
    await assert.rejects(request("/health", { host: "edge-wrong" }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
  test("HTTPS health and security headers survive the proxy", async () => {
    const response = await request("/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-powered-by"], undefined);
    assert.ok(response.headers["strict-transport-security"]);
  });
  test("protected API still requires authentication behind the proxy", async () => {
    assert.equal((await request("/api/conversations")).status, 401);
  });
  test("production Gemini diagnostic is absent", async () => {
    assert.equal((await request("/api/test/gemini", { method: "POST" })).status, 404);
  });
  test("signed empty webhook succeeds without model calls or sends", async () => {
    const body = JSON.stringify({ entry: [] });
    const signature = crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex");
    const response = await request("/webhook", {
      method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    });
    assert.equal(response.status, 200);
  });
  test("unsigned webhook fails behind HTTPS proxy", async () => {
    assert.equal((await request("/webhook", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 403);
  });
  test("changing spoofed forwarding headers cannot reset the login limit", async () => {
    for (let attempt = 1; attempt <= 11; attempt++) {
      const response = await request("/api/auth/login", {
        method: "POST", body: JSON.stringify({ email: "missing@example.com", password: "synthetic-password" }),
        headers: {
          "content-type": "application/json", "x-forwarded-for": `198.51.100.${attempt}`,
          "x-real-ip": `203.0.113.${attempt}`, "forwarded": `for=192.0.2.${attempt}`,
        },
      });
      assert.equal(response.status, attempt <= 10 ? 401 : 429, `login attempt ${attempt}`);
    }
  });
} else {
  test(`dependency readiness ${phase === "unavailable" ? "fails closed" : "recovers"} while health remains live`, async () => {
    const response = await waitForReady(phase === "unavailable" ? 503 : 200);
    assert.equal(JSON.parse(response.text).status, phase === "unavailable" ? "not_ready" : "ready");
    assert.equal((await request("/health")).status, 200);
  });
}

test.after(async () => { await closeDatabaseConnection(); });
