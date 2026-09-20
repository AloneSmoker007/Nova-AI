import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const index = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const database = fs.readFileSync(new URL("../src/config/database.js", import.meta.url), "utf8");
const queue = fs.readFileSync(new URL("../src/services/queue.service.js", import.meta.url), "utf8");
const gitignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("startup has an explicit readiness gate", () => {
  assert.match(index, /let startupComplete = false;/);
  assert.match(index, /startupComplete = true;/);
  assert.match(index, /if \(!startupComplete\)/);
});

test("readiness fails closed while startup is incomplete", () => {
  const readiness = between(index, 'app.get("/ready"', 'app.get("/webhook"');
  assert.match(readiness, /status\(503\)/);
  assert.match(readiness, /startup: "starting"/);
});

test("readiness checks PostgreSQL", () => {
  const readiness = between(index, 'app.get("/ready"', 'app.get("/webhook"');
  assert.match(readiness, /checkDatabaseReadiness\(\)/);
  assert.match(database, /export async function checkDatabaseReadiness\(\)/);
});

test("readiness checks Redis when Redis is configured", () => {
  const readiness = between(index, 'app.get("/ready"', 'app.get("/webhook"');
  assert.match(readiness, /checkRedisConnection\(\)/);
  assert.match(readiness, /redis\.configured && !redis\.connected/);
  assert.match(queue, /export async function checkRedisConnection\(\)/);
});

test("Redis readiness uses a bounded timeout", () => {
  assert.match(queue, /setTimeout\(.*3000\)/s);
});

test("production readiness rejects an unconfigured database", () => {
  const readiness = between(index, 'app.get("/ready"', 'app.get("/webhook"');
  assert.match(readiness, /IS_PRODUCTION \? 503 : 200/);
});

test("startup runs migrations before declaring readiness", () => {
  const startup = between(index, "async function startServer()", "startServer().catch");
  assert.ok(startup.indexOf("await runMigrations()") < startup.indexOf("startupComplete = true;"));
});

test("startup starts the queue worker before readiness", () => {
  const startup = between(index, "async function startServer()", "startServer().catch");
  assert.ok(startup.indexOf("startWorker(") < startup.indexOf("startupComplete = true;"));
});

test("startup starts recovery before readiness when a database is configured", () => {
  const startup = between(index, "async function startServer()", "startServer().catch");
  assert.ok(startup.indexOf("startInboxRecovery()") < startup.indexOf("startupComplete = true;"));
});

test("SIGTERM and SIGINT both use the same shutdown path", () => {
  assert.match(index, /process\.on\("SIGTERM", \(\) => void shutdown\("SIGTERM"\)\)/);
  assert.match(index, /process\.on\("SIGINT", \(\) => void shutdown\("SIGINT"\)\)/);
});

test("shutdown marks the service not ready immediately", () => {
  const shutdown = between(index, "async function shutdown(signal)", 'process.on("SIGTERM"');
  assert.match(shutdown, /startupComplete = false;/);
});

test("shutdown stops recovery before HTTP", () => {
  const shutdown = between(index, "async function shutdown(signal)", 'process.on("SIGTERM"');
  assert.ok(shutdown.indexOf("await stopInboxRecovery()") < shutdown.indexOf("await new Promise"));
});

test("shutdown drains HTTP before queue and database", () => {
  const shutdown = between(index, "async function shutdown(signal)", 'process.on("SIGTERM"');
  const httpClose = shutdown.indexOf("server.close");
  const queueClose = shutdown.indexOf("await closeQueue()");
  const dbClose = shutdown.indexOf("await closeDatabaseConnection()");
  assert.ok(httpClose < queueClose);
  assert.ok(queueClose < dbClose);
});

test("shutdown has a bounded forced-exit timeout", () => {
  const shutdown = between(index, "async function shutdown(signal)", 'process.on("SIGTERM"');
  assert.match(shutdown, /setTimeout\(.*10_000/s);
  assert.match(shutdown, /process\.exit\(1\)/);
});

test("shutdown clears its forced-exit timer on success", () => {
  const shutdown = between(index, "async function shutdown(signal)", 'process.on("SIGTERM"');
  assert.match(shutdown, /clearTimeout\(forceTimer\)/);
});

test("shutdown waits for an active recovery pass", () => {
  assert.match(index, /let recoveryPassPromise = null;/);
  assert.match(index, /if \(recoveryPassPromise\) \{/);
  assert.match(index, /await recoveryPassPromise;/);
});

test("HTTP server errors are handled explicitly", () => {
  const startup = between(index, "async function startServer()", "startServer().catch");
  assert.match(startup, /server\.on\("error"/);
  assert.match(startup, /logger\.fatal/);
});

test("uncaught exceptions and unhandled rejections terminate the process", () => {
  assert.match(index, /process\.on\("uncaughtException"/);
  assert.match(index, /process\.on\("unhandledRejection"/);
  assert.match(index, /Uncaught exception — shutting down/);
  assert.match(index, /Unhandled promise rejection — shutting down/);
});

test("secret-bearing environment files and key material are ignored", () => {
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^\*\.pem$/m);
  assert.match(gitignore, /^\*\.key$/m);
});
