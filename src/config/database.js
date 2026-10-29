import pg from "pg";
import fs from "node:fs";
import { checkServerIdentity } from "node:tls";
import { parse as parseConnectionString } from "pg-connection-string";
import { logger } from "./logger.js";

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function readBoundedIntegerEnv(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    logger.warn(
      { configKey: key, min, max },
      "Invalid numeric database setting; using safe default",
    );
    return fallback;
  }
  return value;
}

function readSslCa(caPath = process.env.DATABASE_SSL_CA) {
  if (!caPath) return null;

  try {
    const contents = fs.readFileSync(caPath, "utf8");
    return contents;
  } catch (error) {
    logger.warn({ error: error.message, caPath }, "Failed to read DATABASE_SSL_CA");
    return null;
  }
}

export function getPoolConfig(env = process.env) {
  if (!env.DATABASE_URL) {
    return null;
  }

  const sslCa = readSslCa(env.DATABASE_SSL_CA);
  // pg reparses connectionString after merging the explicit options, allowing
  // URI sslmode/ssl flags to replace ssl and even disable TLS. Parse once in
  // production, then apply the deployment policy to the final driver options.
  const connectionOptions = isProduction
    ? parseConnectionString(env.DATABASE_URL)
    : { connectionString: env.DATABASE_URL };
  if (isProduction) delete connectionOptions.connectionString;
  const urlSsl = typeof connectionOptions.ssl === "object" && connectionOptions.ssl
    ? connectionOptions.ssl
    : {};
  const sslConfig = isProduction
    ? {
        ...urlSsl,
        ...(sslCa ? { ca: sslCa } : {}),
        rejectUnauthorized: true,
        checkServerIdentity,
      }
    : sslCa
      ? { ca: sslCa }
      : undefined;

  return {
    ...connectionOptions,
    max: readBoundedIntegerEnv(env, "DB_POOL_MAX", DEFAULT_DB_POOL_MAX, 1, 100),
    idleTimeoutMillis: readBoundedIntegerEnv(
      env,
      "DB_IDLE_TIMEOUT_MS",
      DEFAULT_IDLE_TIMEOUT_MS,
      0,
      MAX_TIMER_DELAY_MS,
    ),
    connectionTimeoutMillis: readBoundedIntegerEnv(
      env,
      "DB_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS,
      0,
      MAX_TIMER_DELAY_MS,
    ),
    allowExitOnIdle: false,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  };
}

const poolConfig = getPoolConfig();

export const dbPool = poolConfig ? new Pool(poolConfig) : null;

if (dbPool) {
  dbPool.on("error", (error) => {
    logger.error({ error: error.message, code: error.code }, "Unexpected PostgreSQL pool error");
  });
}

export function isDatabaseConfigured() {
  return Boolean(dbPool);
}

export async function checkDatabaseReadiness() {
  if (!dbPool) {
    return { configured: false, connected: false };
  }

  const result = await dbPool.query("SELECT 1 AS ok");

  return {
    configured: true,
    connected: result.rows[0]?.ok === 1,
  };
}

export const checkDatabaseConnection = checkDatabaseReadiness;

export async function closeDatabaseConnection() {
  if (dbPool) {
    await dbPool.end();
  }
}
