import pg from "pg";
import logger from "./logger.js";

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";

function getSslConfig() {
  if (!isProduction) return false;

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false";
  let ca = process.env.DB_CA_CERT;

  if (ca) {
    ca = ca.replace(/\\n/g, "\n");
  }

  if (!rejectUnauthorized) {
    logger.warn("PostgreSQL SSL verification is disabled (rejectUnauthorized: false). This is not recommended for production.");
  }

  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
}

function getPoolConfig() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const minPool = Number(process.env.DB_POOL_MIN || 0);
  const maxPool = Number(process.env.DB_POOL_MAX || 10);

  return {
    connectionString: process.env.DATABASE_URL,
    min: minPool,
    max: maxPool,
    keepAlive: true,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5_000),
    allowExitOnIdle: false,
    ssl: getSslConfig(),
  };
}

const poolConfig = getPoolConfig();

export const dbPool = poolConfig ? new Pool(poolConfig) : null;

if (dbPool) {
  dbPool.on("error", (error) => {
    logger.error({ message: error.message, code: error.code }, "Unexpected PostgreSQL pool error");
  });
}

export function isDatabaseConfigured() {
  return Boolean(dbPool);
}

export async function checkDatabaseConnection() {
  if (!dbPool) {
    return { configured: false, connected: false };
  }

  const result = await dbPool.query("SELECT 1 AS ok");

  return {
    configured: true,
    connected: result.rows[0]?.ok === 1,
  };
}

export async function closeDatabaseConnection() {
  if (dbPool) {
    await dbPool.end();
  }
}
