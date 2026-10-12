import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const integrationUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const allowReset = process.env.MIGRATION_TEST_ALLOW_RESET === "1";
const skip =
  integrationUrl && allowReset
    ? false
    : "Set MIGRATION_TEST_DATABASE_URL (and MIGRATION_TEST_ALLOW_RESET=1) to run this test";

describe("appointment buffer enforcement (PostgreSQL)", { skip }, () => {
  let dbPool = null;
  let runMigrations = null;
  let appointmentService = null;

  before(async () => {
    process.env.DATABASE_URL = integrationUrl;
    ({ runMigrations } = await import("../src/database/migrate.js"));
    ({ dbPool } = await import("../src/config/database.js"));
    appointmentService = await import("../src/services/appointment.service.js");

    assert.ok(dbPool, "dbPool must use the integration database URL");
    await dbPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbPool.query("CREATE SCHEMA public");
    const migrated = await runMigrations();
    assert.equal(migrated.configured, true);
  });

  after(async () => {
    if (dbPool) await dbPool.end();
  });

  async function seedTenantAndTypes() {
    const tenantId = randomUUID();
    await dbPool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
      tenantId,
      "appointment-buffer-" + tenantId,
    ]);

    const withBuffer = await appointmentService.createAppointmentType({
      tenantId,
      name: "Consultation with buffer",
      durationMinutes: 30,
      bufferMinutes: 15,
    });
    const noBuffer = await appointmentService.createAppointmentType({
      tenantId,
      name: "Short consultation",
      durationMinutes: 20,
      bufferMinutes: 0,
    });

    return { tenantId, withBuffer, noBuffer };
  }

  function booking(tenantId, appointmentTypeId, startsAt, customerName) {
    return appointmentService.bookAppointment({
      tenantId,
      appointmentTypeId,
      startsAt: startsAt.toISOString(),
      customerName,
      customerPhone: "+15551234567",
    });
  }

  it("blocks a booking inside the previous appointment's buffer but allows the exact boundary", async () => {
    const { tenantId, withBuffer, noBuffer } = await seedTenantAndTypes();
    const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);

    const first = await booking(tenantId, withBuffer.id, start, "Buffered booking");
    assert.equal(first.buffer_minutes, 15);
    assert.equal(
      new Date(first.ends_at).getTime() - new Date(first.starts_at).getTime(),
      30 * 60 * 1000,
      "ends_at must remain the actual appointment end, not include the buffer",
    );
    assert.equal(
      new Date(first.occupied_until).getTime() - new Date(first.ends_at).getTime(),
      15 * 60 * 1000,
      "occupied_until must include the configured buffer",
    );

    const insideBuffer = new Date(start.getTime() + 35 * 60 * 1000);
    await assert.rejects(
      () => booking(tenantId, noBuffer.id, insideBuffer, "Inside buffer"),
      /Appointment time is already booked/,
      "a booking starting before the previous buffer ends must be rejected",
    );

    const exactBoundary = new Date(start.getTime() + 45 * 60 * 1000);
    const next = await booking(tenantId, noBuffer.id, exactBoundary, "At buffer boundary");
    assert.ok(next.id, "a booking starting exactly when the occupied range ends is allowed");
    assert.equal(next.buffer_minutes, 0);
  });

  it("uses the database exclusion constraint to serialize concurrent overlapping bookings", async () => {
    const { tenantId, noBuffer } = await seedTenantAndTypes();
    const start = new Date(Date.now() + 96 * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);

    const attempts = await Promise.allSettled([
      booking(tenantId, noBuffer.id, start, "Concurrent A"),
      booking(tenantId, noBuffer.id, start, "Concurrent B"),
    ]);

    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    const rejected = attempts.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /Appointment time is already booked/);
  });

  it("grandfathers already-overlapping legacy rows but rejects new bookings against them", async () => {
    const { tenantId, noBuffer } = await seedTenantAndTypes();
    const start = new Date(Date.now() + 120 * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);

    const first = await booking(tenantId, noBuffer.id, start, "Legacy overlap A");
    const second = await booking(
      tenantId,
      noBuffer.id,
      new Date(start.getTime() + 2 * 60 * 60 * 1000),
      "Legacy overlap B",
    );

    // Simulate pre-migration rows: bypass the new trigger while removing both
    // from the exclusion index, then make the historical ranges overlap.
    await dbPool.query("ALTER TABLE appointments DISABLE TRIGGER appointments_no_overlap");
    try {
      await dbPool.query(
        "UPDATE appointments SET enforce_overlap = FALSE WHERE id = ANY($1::uuid[])",
        [[first.id, second.id]],
      );
      await dbPool.query(
        `UPDATE appointments
         SET starts_at = $3, ends_at = $4, occupied_until = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, second.id, first.starts_at, first.ends_at],
      );
    } finally {
      await dbPool.query("ALTER TABLE appointments ENABLE TRIGGER appointments_no_overlap");
    }

    const legacyRows = await dbPool.query(
      `SELECT id FROM appointments
       WHERE tenant_id = $1
         AND enforce_overlap = FALSE
         AND starts_at = $2
         AND ends_at = $3`,
      [tenantId, start, first.ends_at],
    );
    assert.equal(legacyRows.rowCount, 2, "both historical appointments remain untouched and grandfathered");

    await assert.rejects(
      () => booking(tenantId, noBuffer.id, start, "New conflicting booking"),
      /Appointment time is already booked/,
      "new bookings must still be checked against grandfathered legacy appointments",
    );
  });

});
