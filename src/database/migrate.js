import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbPool, isDatabaseConfigured } from "../config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.resolve(__dirname, "../../database");

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

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
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Existing installations have a schema_migrations table without checksum.
    // Add the metadata column safely before reading migration records.
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

    const migrationFiles = await getMigrationFiles();
    const appliedResult = await client.query(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    const appliedChecksums = new Map(
      appliedResult.rows.map((row) => [row.filename, row.checksum]),
    );
    const applied = new Set(appliedChecksums.keys());
    validateMigrationOrder(migrationFiles, applied);

    const newlyApplied = [];

    for (const filename of migrationFiles) {
      const sql = await fs.readFile(
        path.join(migrationsDirectory, filename),
        "utf8",
      );
      const checksum = migrationChecksum(sql);

      if (applied.has(filename)) {
        const previousChecksum = appliedChecksums.get(filename);
        if (!previousChecksum) {
          // Existing installations have no historical checksum to compare
          // against. Bootstrap today's checksum once, then detect all future
          // accidental edits to an already-applied migration.
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL",
            [filename, checksum],
          );
        } else if (previousChecksum !== checksum) {
          throw new Error("Migration checksum drift detected for " + filename);
        }
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [filename, checksum],
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
