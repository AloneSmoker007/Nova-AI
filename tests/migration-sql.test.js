import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertUniqueMigrationNames,
  compareMigrationFilenames,
  findDuplicateMigrationPrefixes,
} from "../src/database/migrate.js";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(testsDirectory, "../database");
const MIGRATION_FILE_PATTERN = /^(\d+)_.+\.sql$/;

// Migration 001 declares the only single-column ON DELETE SET NULL foreign keys
// (usage_events.conversation_id and usage_events.message_id). A column list is
// unnecessary there because tenant_id is not part of the foreign key; migration
// 002 replaces both with composite, column-list variants. Every other
// ON DELETE SET NULL in the chain must name the nullable column.
const ALLOWED_BARE_SET_NULL = new Map([["001_initial_schema.sql", 2]]);

const EXPECTED_COLUMN_LIST_SET_NULL = new Map([
  ["002_tenant_integrity.sql", ["conversation_id", "message_id"]],
  ["010_whatsapp_delivery_hardening.sql", ["conversation_id"]],
  ["011_usage_metering_24h.sql", ["source_message_id"]],
  ["013_shared_inbox.sql", ["assigned_user_id"]],
  ["014_advanced_ai.sql", ["message_id"]],
  ["015_human_handoff_copilot.sql", ["ai_paused_by", "author_user_id"]],
  ["016_automation_workflows.sql", ["created_by"]],
  ["018_appointments.sql", ["contact_id", "conversation_id", "created_by"]],
  ["019_payments_ocr.sql", ["created_by"]],
]);

function stripLineComments(sql) {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function flatten(sql) {
  return stripLineComments(sql).replace(/\s+/g, " ").trim();
}

function countOccurrences(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

// ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL, so a name that is added
// again without being dropped earlier in the same file is a hard failure.
function collectUnguardedConstraintAdds(sql) {
  const dropped = new Set();
  const unguarded = [];

  for (const line of sql.split(/\r?\n/)) {
    const drop = /DROP CONSTRAINT(?: IF EXISTS)? ([A-Za-z0-9_]+)/i.exec(line);
    if (drop) dropped.add(drop[1].toLowerCase());

    const add = /ADD CONSTRAINT ([A-Za-z0-9_]+)/i.exec(line);
    if (add && !dropped.has(add[1].toLowerCase())) {
      unguarded.push(add[1].toLowerCase());
    }
  }

  return unguarded;
}

function collectIndexDefinitions(sql) {
  const definitions = new Map();
  const pattern = /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?([A-Za-z0-9_]+) ON [^;]*/gi;

  for (const match of flatten(sql).matchAll(pattern)) {
    definitions.set(match[1].toLowerCase(), match[0].trim());
  }

  return definitions;
}

async function loadMigrations() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareMigrationFilenames);

  const contents = new Map();
  for (const filename of filenames) {
    contents.set(filename, await fs.readFile(path.join(migrationsDirectory, filename), "utf8"));
  }

  return { filenames, contents };
}

const migrations = await loadMigrations();

test("migration files are contiguous, ordered by numeric prefix, and uniquely named", () => {
  assert.ok(
    migrations.filenames.length >= 21,
    `expected at least the 21 audited migrations, found ${migrations.filenames.length}`,
  );
  assert.doesNotThrow(() => assertUniqueMigrationNames(migrations.filenames));

  const numbers = migrations.filenames.map((filename) =>
    Number(MIGRATION_FILE_PATTERN.exec(filename)[1]),
  );
  numbers.forEach((number, index) => {
    assert.equal(number, index + 1, "migration numeric prefixes must stay contiguous");
  });
});

test("duplicate numeric prefixes and duplicate filenames are rejected", () => {
  assert.throws(
    () => assertUniqueMigrationNames(["021_a.sql", "021_b.sql"]),
    /Duplicate database migration numeric prefixes detected/,
  );
  assert.throws(
    () => assertUniqueMigrationNames(["021_a.sql", "21_b.sql"]),
    /Duplicate database migration numeric prefixes detected/,
  );
  assert.throws(
    () => assertUniqueMigrationNames(["001_base.sql", "001_base.sql"]),
    /Duplicate database migration filenames detected/,
  );
  assert.doesNotThrow(() => assertUniqueMigrationNames(["021_a.sql", "022_b.sql"]));

  assert.deepEqual(findDuplicateMigrationPrefixes(["021_a.sql", "021_b.sql"]).duplicatePrefixes, [
    ["021_a.sql", "021_b.sql"],
  ]);
  assert.deepEqual(findDuplicateMigrationPrefixes(["021_a.sql", "022_b.sql"]), {
    duplicateFilenames: [],
    duplicatePrefixes: [],
  });
});

test("uq_users_tenant_id is created exactly once across all migrations", () => {
  const filesDeclaringConstraint = [...migrations.contents]
    .filter(([, sql]) => sql.includes("ADD CONSTRAINT uq_users_tenant_id"))
    .map(([filename]) => filename);

  assert.deepEqual(filesDeclaringConstraint, ["007_tenant_scoped_integrity.sql"]);
});

test("no ADD CONSTRAINT name is repeated without an in-file DROP", () => {
  const declaredIn = new Map();
  const duplicates = [];

  for (const [filename, sql] of migrations.contents) {
    for (const name of collectUnguardedConstraintAdds(sql)) {
      if (declaredIn.has(name)) {
        duplicates.push(`${name} (${declaredIn.get(name)} and ${filename})`);
      } else {
        declaredIn.set(name, filename);
      }
    }
  }

  assert.deepEqual(duplicates, [], `duplicate ADD CONSTRAINT names: ${duplicates.join("; ")}`);
});

test("index names are never redefined with different columns or predicates", () => {
  const definitions = new Map();
  const conflicting = [];

  for (const [filename, sql] of migrations.contents) {
    for (const [name, definition] of collectIndexDefinitions(sql)) {
      const existing = definitions.get(name);
      if (existing && existing.definition !== definition) {
        conflicting.push(`${name} (${existing.filename} and ${filename})`);
      }
      definitions.set(name, { definition, filename });
    }
  }

  assert.deepEqual(
    conflicting,
    [],
    `index names reused with different definitions: ${conflicting.join("; ")}`,
  );
});

test("composite foreign keys always name the nullable column in ON DELETE SET NULL", () => {
  for (const [filename, sql] of migrations.contents) {
    const flat = flatten(sql);

    const bareCount = countOccurrences(flat, /ON DELETE SET NULL(?! \()/g);
    assert.equal(
      bareCount,
      ALLOWED_BARE_SET_NULL.get(filename) ?? 0,
      `${filename} has an ON DELETE SET NULL without a column list`,
    );

    const columns = [...flat.matchAll(/ON DELETE SET NULL \(([a-z_]+)\)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      columns,
      EXPECTED_COLUMN_LIST_SET_NULL.get(filename) ?? [],
      `${filename} column-list ON DELETE SET NULL columns changed`,
    );
  }
});

test("automation composite foreign keys have tenant-scoped unique keys declared first", () => {
  const workflows = migrations.contents.get("016_automation_workflows.sql");
  const delivery = migrations.contents.get("017_automation_delivery.sql");

  assert.ok(workflows.includes("uq_automation_workflows_tenant_id"));
  assert.ok(workflows.includes("uq_automation_runs_tenant_id"));
  assert.equal(countOccurrences(flatten(workflows), /UNIQUE \(tenant_id, id\)/g), 2);

  assert.ok(
    workflows.indexOf("uq_automation_workflows_tenant_id") <
      workflows.indexOf("REFERENCES automation_workflows (tenant_id, id)"),
    "the automation_workflows unique key must be declared before its foreign key",
  );
  assert.ok(
    migrations.filenames.indexOf("016_automation_workflows.sql") <
      migrations.filenames.indexOf("017_automation_delivery.sql"),
    "the automation_runs unique key must be applied before the 017 foreign key",
  );
  assert.ok(delivery.includes("REFERENCES automation_runs (tenant_id, id)"));
});

test("the 016 scheduler index and the 017 partial dispatch index both exist", () => {
  const workflows = migrations.contents.get("016_automation_workflows.sql");
  const delivery = migrations.contents.get("017_automation_delivery.sql");

  assert.ok(
    workflows.includes("CREATE INDEX IF NOT EXISTS idx_automation_runs_due"),
    "016 must keep its scheduler index",
  );
  assert.ok(
    workflows.includes("ON automation_runs (tenant_id, status, next_run_at, created_at)"),
  );

  assert.ok(delivery.includes("CREATE INDEX IF NOT EXISTS idx_automation_runs_dispatch"));
  assert.ok(delivery.includes("ON automation_runs (status, next_run_at)"));
  assert.ok(delivery.includes("WHERE status IN ('queued','waiting','running')"));
  assert.equal(
    countOccurrences(delivery, /idx_automation_runs_due/g),
    0,
    "017 must not reuse the 016 index name",
  );
});

test("tenant_id stays NOT NULL and no destructive DDL is introduced", () => {
  for (const [filename, sql] of migrations.contents) {
    const body = stripLineComments(sql);

    assert.doesNotMatch(
      body,
      /\bTRUNCATE\b|\bDROP TABLE\b|\bDROP COLUMN\b|\bDROP SCHEMA\b/i,
      `${filename} must not contain destructive DDL`,
    );

    for (const match of body.matchAll(/tenant_id\s+UUID([^,\n]*)/g)) {
      assert.match(
        match[1],
        /NOT NULL|PRIMARY KEY/,
        `${filename} must keep tenant_id NOT NULL`,
      );
    }
  }
});

function normalizeColumns(list) {
  return list
    .split(",")
    .map((column) => column.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

// Collects unique/primary keys and foreign keys in application order so a
// composite FK can be checked against the key it must reference.
function collectTableKeysAndForeignKeys(contents, filenames) {
  const uniqueKeys = new Map();
  const foreignKeys = [];
  let position = 0;

  const addUniqueKey = (table, columns, keyPosition) => {
    const key = table.toLowerCase();
    const list = uniqueKeys.get(key) ?? [];
    list.push({ columns: normalizeColumns(columns), position: keyPosition });
    uniqueKeys.set(key, list);
  };

  for (const filename of filenames) {
    for (const chunk of flatten(contents.get(filename)).split(";")) {
      const statement = chunk.trim();
      if (!statement) continue;
      position += 1;

      const createTable = /^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_]+)/i.exec(statement);
      const alterTable = /^ALTER TABLE ([a-z0-9_]+)/i.exec(statement);
      const createIndex =
        /^CREATE UNIQUE INDEX (?:IF NOT EXISTS )?[a-z0-9_]+ ON ([a-z0-9_]+) \(([^)]*)\)/i.exec(
          statement,
        );

      if (createTable) {
        for (const match of statement.matchAll(/\b(?:UNIQUE|PRIMARY KEY) \(([^)]*)\)/gi)) {
          addUniqueKey(createTable[1], match[1], position);
        }
      } else if (alterTable) {
        for (const match of statement.matchAll(
          /ADD CONSTRAINT [a-z0-9_]+ (?:UNIQUE|PRIMARY KEY) \(([^)]*)\)/gi,
        )) {
          addUniqueKey(alterTable[1], match[1], position);
        }
      } else if (createIndex && !/\bWHERE\b/i.test(statement)) {
        addUniqueKey(createIndex[1], createIndex[2], position);
      }

      for (const match of statement.matchAll(
        /FOREIGN KEY \(([^)]*)\) REFERENCES ([a-z0-9_]+)\s*\(([^)]*)\)/gi,
      )) {
        foreignKeys.push({
          references: match[2].toLowerCase(),
          referenceColumns: normalizeColumns(match[3]),
          position,
        });
      }
    }
  }

  return { uniqueKeys, foreignKeys };
}

test("every tenant-scoped foreign key references a table with a matching unique key", () => {
  const { uniqueKeys, foreignKeys } = collectTableKeysAndForeignKeys(
    migrations.contents,
    migrations.filenames,
  );
  const compositeKeys = foreignKeys.filter((fk) => fk.referenceColumns.includes("tenant_id"));
  assert.ok(compositeKeys.length > 0, "expected composite tenant-scoped foreign keys");

  for (const fk of compositeKeys) {
    const candidates = uniqueKeys.get(fk.references) ?? [];
    const expected = fk.referenceColumns.join(",");
    const satisfied = candidates.some(
      (key) => key.position <= fk.position && key.columns.join(",") === expected,
    );
    assert.ok(
      satisfied,
      `${fk.references} needs a unique key on (${expected}) before this foreign key`,
    );
  }
});



