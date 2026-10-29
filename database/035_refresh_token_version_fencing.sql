-- Bind refresh credentials to the account version at issuance. Existing rows
-- have no trustworthy issuance version: revoke them once rather than upgrade
-- potentially stolen credentials to the user's current version. Users must
-- sign in again after this migration; existing access JWTs retain their TTL.
ALTER TABLE refresh_tokens
  ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

UPDATE refresh_tokens
SET revoked_at = COALESCE(revoked_at, NOW()), token_version = -1;
-- The sentinel is deliberately different from every valid account version.
-- Replaying a legacy token must not revoke a fresh post-upgrade session.
