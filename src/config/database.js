import pg from "pg";

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === "production";

function getPoolConfig() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  return {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS || 5_000,
    ),
    allowExitOnIdle: false,
    ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

const poolConfig = getPoolConfig();

export const dbPool = poolConfig ? new Pool(poolConfig) : null;

if (dbPool) {
  dbPool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error", {
      message: error.message,
      code: error.code,
    });
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
