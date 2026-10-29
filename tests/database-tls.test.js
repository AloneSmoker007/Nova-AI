import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// A child imports the real production configuration and pg driver, isolated
// from the environment/module cache of the other tests. The loopback peer
// records the first protocol packet and refuses every connection. No actual
// database, provider, certificate, account or external request is involved.
const probeSource = `
import net from "node:net";
import tls from "node:tls";
import pg from "pg";
delete process.env.DATABASE_URL;
const { getPoolConfig } = await import("./src/config/database.js");
const input = JSON.parse(process.env.NOVA_DATABASE_TLS_PROBE);
const sockets = new Set();
let wireTls = false;
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.setTimeout(1000, () => socket.destroy());
  let packet = Buffer.alloc(0);
  const receive = (chunk) => {
    packet = Buffer.concat([packet, chunk]);
    if (packet.length < 8) return;
    socket.off("data", receive);
    const sslRequest = packet.readUInt32BE(0) === 8 && packet.readUInt32BE(4) === 80877103;
    const directTls = packet[0] === 22 && packet[1] === 3;
    wireTls = sslRequest || directTls;
    socket.end(sslRequest ? "N" : undefined);
  };
  socket.on("data", receive);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let client;
try {
  const url = new URL(input.url);
  url.port = String(server.address().port);
  const config = getPoolConfig({
    DATABASE_URL: url.toString(),
    DATABASE_SSL_CA: input.caPath,
    DB_CONNECTION_TIMEOUT_MS: "750",
  });
  client = new pg.Client(config);
  const parameters = client.connectionParameters;
  const ssl = parameters.ssl;
  try {
    await client.connect();
    throw new Error("The rejecting loopback peer unexpectedly accepted a session");
  } catch (error) {
    if (error.message.includes("unexpectedly accepted")) throw error;
  }
  console.log(JSON.stringify({
    wireTls,
    certificateVerification: ssl === true || Boolean(ssl && typeof ssl === "object" && ssl.rejectUnauthorized !== false),
    defaultHostnameVerification: !ssl?.checkServerIdentity || ssl.checkServerIdentity === tls.checkServerIdentity,
    ca: ssl?.ca ?? null,
    user: parameters.user,
    password: parameters.password,
    database: parameters.database,
    applicationName: parameters.application_name,
    host: parameters.host,
  }));
} finally {
  if (client) await client.end();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
`;

function probe(query = "", { mode = "production", caPath, credentials = "synthetic:synthetic" } = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: mode,
      DATABASE_URL: "",
      DATABASE_SSL_CA: "",
      PGSSLMODE: "disable",
      NOVA_DATABASE_TLS_PROBE: JSON.stringify({
        url: `postgres://${credentials}@127.0.0.1:5432/nova_tls_test${query ? `?${query}` : ""}`,
        caPath,
      }),
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function assertStrictTls(result) {
  assert.equal(result.wireTls, true, "production must negotiate TLS instead of sending a plaintext startup");
  assert.equal(result.certificateVerification, true, "the actual pg driver must retain certificate verification");
  assert.equal(result.defaultHostnameVerification, true, "URL compatibility flags must not disable hostname verification");
}

test("production pg driver requests verified TLS without URL overrides", () => {
  assertStrictTls(probe());
});

for (const query of [
  "sslmode=disable",
  "ssl=0",
  "ssl=no-verify",
  "sslmode=no-verify",
  "sslmode=require&uselibpqcompat=true",
  "sslmode=prefer&uselibpqcompat=true",
]) {
  test(`production pg driver prevents TLS policy override by ${query}`, () => {
    assertStrictTls(probe(query));
  });
}

test("production supports direct TLS negotiation with the driver's secure defaults", () => {
  assertStrictTls(probe("sslnegotiation=direct"));
});

test("production preserves the deployment CA and hostname checks with URL TLS settings", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nova-database-tls-"));
  try {
    const caPath = path.join(directory, "deployment-ca.pem");
    const otherCaPath = path.join(directory, "url-ca.pem");
    const deploymentCa = "synthetic deployment CA configuration (not a real certificate)\n";
    writeFileSync(caPath, deploymentCa);
    writeFileSync(otherCaPath, "synthetic URL CA configuration (not a real certificate)\n");
    const query = new URLSearchParams({
      sslmode: "require",
      uselibpqcompat: "true",
      sslrootcert: otherCaPath,
    });
    const result = probe(query.toString(), { caPath });
    assertStrictTls(result);
    assert.equal(result.ca, deploymentCa);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production TLS enforcement preserves encoded credentials and application settings", () => {
  const result = probe("sslmode=disable&application_name=nova%20tls%20control", {
    credentials: "synthetic%40user:p%3Fa%3Ass%23word",
  });
  assertStrictTls(result);
  assert.equal(result.user, "synthetic@user");
  assert.equal(result.password, "p?a:ss#word");
  assert.equal(result.database, "nova_tls_test");
  assert.equal(result.applicationName, "nova tls control");
});

test("production does not reparse a nested connectionString query parameter", () => {
  const nested = "postgres://synthetic:synthetic@unreachable.invalid/nested?sslmode=disable";
  const result = probe(new URLSearchParams({ connectionString: nested }).toString());
  assertStrictTls(result);
  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.database, "nova_tls_test");
});

test("development retains explicit plaintext loopback configuration", () => {
  const result = probe("sslmode=disable", { mode: "development" });
  assert.equal(result.wireTls, false);
  assert.equal(result.certificateVerification, false);
});
