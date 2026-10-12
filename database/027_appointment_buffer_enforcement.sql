-- Migration 027: enforce post-appointment buffers as occupied booking time.
-- Existing bookings are grandfathered with buffer_minutes=0 to avoid changing
-- existing appointments or making rollout depend on historical rescheduling.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS buffer_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (buffer_minutes BETWEEN 0 AND 1440);

-- Store the calculated occupied end as data rather than an expression index:
-- timestamptz arithmetic with arbitrary intervals is not immutable enough for
-- a PostgreSQL exclusion constraint expression.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS occupied_until TIMESTAMPTZ;

UPDATE appointments
SET occupied_until = ends_at + (buffer_minutes * INTERVAL '1 minute')
WHERE occupied_until IS NULL;

ALTER TABLE appointments
  ALTER COLUMN occupied_until SET NOT NULL;

CREATE OR REPLACE FUNCTION prevent_appointment_overlap()
RETURNS TRIGGER AS $$
BEGIN
  NEW.occupied_until := NEW.ends_at + (NEW.buffer_minutes * INTERVAL '1 minute');

  IF NEW.status IN ('pending', 'confirmed') AND EXISTS (
    SELECT 1
    FROM appointments AS appointment
    WHERE appointment.tenant_id = NEW.tenant_id
      AND appointment.status IN ('pending', 'confirmed')
      AND appointment.id <> NEW.id
      AND appointment.starts_at < NEW.occupied_until
      AND appointment.occupied_until > NEW.starts_at
  ) THEN
    RAISE EXCEPTION 'Appointment time is already booked' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_no_overlap ON appointments;
CREATE TRIGGER appointments_no_overlap
BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, buffer_minutes
ON appointments
FOR EACH ROW EXECUTE FUNCTION prevent_appointment_overlap();

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_no_overlap_exclusion;

-- The exclusion constraint protects against concurrent transactions, even if
-- two requests try to book into the same buffered range at the same time.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap_exclusion
  EXCLUDE USING gist (
    tenant_id WITH =,
    tstzrange(starts_at, occupied_until, '[)') WITH &&
  )
  WHERE (status IN ('pending', 'confirmed'));
