import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPool, isDatabaseConfigured } from "../config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.resolve(__dirname, "../../database");

async function getMigrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function runMigrations() {
  if (!isDatabaseConfigured() || !dbPool) {
    return { configured: false, applied: [] };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = await getMigrationFiles();
    const appliedResult = await client.query(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));
    const newlyApplied = [];

    for (const filename of migrationFiles) {
      if (applied.has(filename)) {
        continue;
      }

      const sql = await fs.readFile(
        path.join(migrationsDirectory, filename),
        "utf8",
      );

      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      newlyApplied.push(filename);
    }

    await client.query("COMMIT");

    return {
      configured: true,
      applied: newlyApplied,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
