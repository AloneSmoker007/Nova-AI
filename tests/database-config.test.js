import test from "node:test";
import assert from "node:assert/strict";

const { getPoolConfig } = await import("../src/config/database.js");

const DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

test("database pool numeric env settings fall back safely when malformed or out of range", () => {
  const config = getPoolConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/nova",
    DB_POOL_MAX: "not-a-number",
    DB_IDLE_TIMEOUT_MS: "Infinity",
    DB_CONNECTION_TIMEOUT_MS: "1.5",
  });

  assert.equal(config.max, DEFAULTS.max);
  assert.equal(config.idleTimeoutMillis, DEFAULTS.idleTimeoutMillis);
  assert.equal(config.connectionTimeoutMillis, DEFAULTS.connectionTimeoutMillis);
});

test("database pool numeric env settings preserve valid values and enforce timer bounds", () => {
  const valid = getPoolConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/nova",
    DB_POOL_MAX: "25",
    DB_IDLE_TIMEOUT_MS: "0",
    DB_CONNECTION_TIMEOUT_MS: "2000",
  });

  assert.equal(valid.max, 25);
  assert.equal(valid.idleTimeoutMillis, 0);
  assert.equal(valid.connectionTimeoutMillis, 2000);

  const oversizedPool = getPoolConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/nova",
    DB_POOL_MAX: "101",
  });
  assert.equal(oversizedPool.max, DEFAULTS.max);

  const oversizedTimer = getPoolConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/nova",
    DB_IDLE_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
  });
  assert.equal(oversizedTimer.idleTimeoutMillis, DEFAULTS.idleTimeoutMillis);
  assert.ok(oversizedTimer.connectionTimeoutMillis <= 2_147_483_647);
});

test("database pool configuration remains absent without DATABASE_URL", () => {
  assert.equal(getPoolConfig({}), null);
  assert.equal(getPoolConfig({ DATABASE_URL: "" }), null);
});
