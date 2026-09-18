import test from "node:test";
import assert from "node:assert/strict";

const packageJson = await import("../package.json", { with: { type: "json" } });

import {
  compareMigrationFilenames,
  validateMigrationFiles,
  validateMigrationOrder,
} from "../src/database/migrate.js";

test("package exposes the production bootstrap and test scripts", () => {
  assert.equal(packageJson.default.scripts.start, "node src/bootstrap.js");
  assert.equal(packageJson.default.scripts.test, "node --test tests");
  assert.match(packageJson.default.engines.node, />=20/);
});

test("migration order rejects pending migration older than latest applied migration", () => {
  assert.throws(
    () => validateMigrationOrder(
      ["001_base.sql", "002_auth.sql", "003_new.sql"],
      ["001_base.sql", "003_new.sql"],
    ),
    /Out-of-order database migrations detected/,
  );
});

test("migration order accepts only-newer pending migrations", () => {
  assert.doesNotThrow(() =>
    validateMigrationOrder(
      ["001_base.sql", "002_auth.sql", "003_new.sql"],
      ["001_base.sql", "002_auth.sql"],
    ),
  );
});

test("migration filenames are ordered by numeric prefix", () => {
  assert.deepEqual(
    ["009_old.sql", "010_next.sql", "011_latest.sql"].sort(compareMigrationFilenames),
    ["009_old.sql", "010_next.sql", "011_latest.sql"],
  );
});

test("migration ordering handles multi-digit prefixes correctly", () => {
  assert.deepEqual(
    ["020_deleted.sql", "003_base.sql", "011_ai.sql"].sort(compareMigrationFilenames),
    ["003_base.sql", "011_ai.sql", "020_deleted.sql"],
  );
});

test("migration files reject duplicate numeric prefixes", () => {
  assert.throws(
    () => validateMigrationFiles(["022_first.sql", "022_second.sql"]),
    /Duplicate migration number detected: 22 in 022_first\.sql and 022_second\.sql/,
  );
});

test("migration files reject duplicate filenames", () => {
  assert.throws(
    () => validateMigrationFiles(["022_first.sql", "022_first.sql"]),
    /Duplicate migration filename detected: 022_first\.sql/,
  );
});

test("migration files accept unique numeric prefixes", () => {
  assert.doesNotThrow(() =>
    validateMigrationFiles(["021_payment.sql", "022_backup.sql", "023_audit.sql"]),
  );
});
