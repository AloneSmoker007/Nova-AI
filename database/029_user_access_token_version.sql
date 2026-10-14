-- Migration 029: revoke already-issued access tokens on logout or credential changes.
-- Legacy access JWTs without tokenVersion are accepted only while the account remains at version 0.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_user_token_version_on_credentials_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role
     OR OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    NEW.token_version := COALESCE(OLD.token_version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_bump_token_version_on_credentials_change ON users;
CREATE TRIGGER users_bump_token_version_on_credentials_change
BEFORE UPDATE OF role, password_hash ON users
FOR EACH ROW
EXECUTE FUNCTION bump_user_token_version_on_credentials_change();
