import pg from "pg";
import fs from "node:fs";
import { logger } from "./logger.js";

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";

function readSslCa() {
  const caPath = process.env.DATABASE_SSL_CA;
  if (!caPath) return null;

  try {
    const contents = fs.readFileSync(caPath, "utf8");
    return contents;
  } catch (error) {
    logger.warn({ error: error.message, caPath }, "Failed to read DATABASE_SSL_CA");
    return null;
  }
}

function getPoolConfig() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const sslCa = readSslCa();
  const sslConfig = isProduction
    ? sslCa
      ? { ca: sslCa, rejectUnauthorized: true }
      : { rejectUnauthorized: true }
    : sslCa
      ? { ca: sslCa }
      : undefined;

  return {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS || 5_000,
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
