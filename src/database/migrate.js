import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPool, isDatabaseConfigured } from "../config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.resolve(__dirname, "../../database");

function migrationNumber(filename) {
  const match = /^([0-9]+)_/.exec(filename);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function compareMigrationFilenames(a, b) {
  const numberDiff = migrationNumber(a) - migrationNumber(b);
  return numberDiff !== 0 ? numberDiff : a.localeCompare(b);
}

// A duplicate numeric prefix (for example 022_a.sql and 022_b.sql, or
// 022_a.sql and 22_b.sql) would otherwise be applied in an ambiguous
// locale-dependent order, so it is rejected before any migration runs.
export function findDuplicateMigrationPrefixes(migrationFiles) {
  const seenFilenames = new Set();
  const duplicateFilenames = new Set();
  const byNumber = new Map();

  for (const filename of migrationFiles) {
    if (seenFilenames.has(filename)) duplicateFilenames.add(filename);
    seenFilenames.add(filename);

    const match = /^([0-9]+)_/.exec(filename);
    if (!match) continue;

    const number = Number(match[1]);
    const group = byNumber.get(number);
    if (group) {
      group.push(filename);
    } else {
      byNumber.set(number, [filename]);
    }
  }

  return {
    duplicateFilenames: [...duplicateFilenames].sort(),
    duplicatePrefixes: [...byNumber.values()].filter((group) => group.length > 1),
  };
}

export function assertUniqueMigrationNames(migrationFiles) {
  const { duplicateFilenames, duplicatePrefixes } =
    findDuplicateMigrationPrefixes(migrationFiles);

  if (duplicateFilenames.length > 0) {
    throw new Error(
      `Duplicate database migration filenames detected: ${duplicateFilenames.join(", ")}.`,
    );
  }

  if (duplicatePrefixes.length > 0) {
    const details = duplicatePrefixes.map((group) => group.join(" / ")).join("; ");
    throw new Error(
      `Duplicate database migration numeric prefixes detected: ${details}. ` +
        "Give every migration a unique numeric prefix before applying them.",
    );
  }
}

// One transaction-level advisory lock prevents multiple Nova-AI
// instances from applying migrations concurrently during startup.
const MIGRATION_ADVISORY_LOCK_ID = 7_421_991;

async function getMigrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });

  const migrationFiles = entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name);

  // Fail clearly instead of silently ordering migrations that share a prefix.
  assertUniqueMigrationNames(migrationFiles);

  return migrationFiles.sort(compareMigrationFilenames);
}

export function validateMigrationOrder(migrationFiles, appliedFilenames) {
  const applied = new Set(appliedFilenames);
  const pending = migrationFiles.filter((filename) => !applied.has(filename));
  if (pending.length === 0) return;

  const highestApplied = [...applied]
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort(compareMigrationFilenames)
    .at(-1);

  if (!highestApplied) return;

  const outOfOrder = pending.filter(
    (filename) => compareMigrationFilenames(filename, highestApplied) < 0,
  );
  if (outOfOrder.length > 0) {
    throw new Error(
      `Out-of-order database migrations detected: ${outOfOrder.join(", ")}. Add new migrations with a higher numeric prefix than the latest applied migration.`,
    );
  }
}

export async function runMigrations() {
  if (!isDatabaseConfigured() || !dbPool) {
    return { configured: false, applied: [] };
  }

  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    // Transaction-scoped: automatically released by PostgreSQL at COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      MIGRATION_ADVISORY_LOCK_ID,
    ]);

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
    validateMigrationOrder(migrationFiles, applied);

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
