# Nova-AI

Production-oriented multi-tenant WhatsApp AI SaaS backend built with Node.js, Express, PostgreSQL, Redis/BullMQ, Meta WhatsApp Cloud API, and Gemini.

## What it provides

- Multi-tenant data isolation with tenant-scoped PostgreSQL queries and composite relationships.
- JWT authentication with bcrypt password hashing, refresh-token rotation/revocation, active-user and active-tenant checks, and role-based authorization.
- WhatsApp webhook verification and HMAC-SHA256 signature validation.
- Durable webhook inbox, idempotent message persistence, queue/worker processing, lease recovery, retries, and durable outbound delivery tracking.
- Encrypted tenant WhatsApp credentials using AES-256-GCM.
- Business Brain and tenant-scoped customer AI memory/signals.
- Human handoff, AI pause/resume, agent skill routing, handoff summaries, and AI co-pilot drafts.
- Usage metering and account limits.
- Health/readiness endpoints and graceful shutdown.

## Architecture

```
Meta WhatsApp
     |
     v
Express webhook -> tenant resolution -> durable inbox
                                      |
                         +------------+------------+
                         |                         |
                     Redis/BullMQ              recovery
                         |                         |
                         v                         v
                    inbox worker -----> AI / Business Brain
                         |
                         v
                 durable delivery
                         |
                         v
                  Meta WhatsApp API

PostgreSQL stores tenant-scoped business, conversation, message,
authentication, usage, handoff, AI-memory, and delivery state.
```

## Requirements

- Node.js 20+
- PostgreSQL
- Redis is recommended when queue processing is enabled
- Meta WhatsApp Cloud API credentials
- Gemini API key

## Local setup

1. Install dependencies:

   `npm ci`

2. Create environment configuration:

   `cp .env.example .env`

   On Windows, copy the file manually or use:

   `copy .env.example .env`

3. Fill the required values in `.env`.
4. Start the server:

   `npm start`

The server defaults to port 3000.

## Environment variables

### Required for production

- `GEMINI_API_KEY`
- `WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`
- `DATABASE_URL`
- `JWT_SECRET`

### Optional

- `REDIS_URL` — enables Redis/BullMQ queue processing.
- `DATABASE_SSL_CA` — PostgreSQL CA certificate when required by the provider.
- `GEMINI_MODEL` — Gemini model override.
- `META_GRAPH_API_VERSION` — Meta Graph API version; defaults to `v23.0`.
- `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_EXPIRES_IN` — JWT configuration.
- `LOG_LEVEL` — Pino log level.
- `WHATSAPP_DELIVERY_RETRY_WINDOW_SECONDS` — delivery recovery window.

### Credential-encryption key

`CREDENTIAL_ENCRYPTION_KEY` must decode to exactly 32 bytes. The application accepts either 64 hexadecimal characters or a base64 value representing 32 bytes.

Never commit `.env` or real API keys, tokens, database URLs, or encryption keys.

### Payment webhook signing secrets

`PAYMENT_WEBHOOK_SECRETS` configures per-tenant signing keys for the payment webhook endpoint (`POST /api/payments/webhook/:tenantId`). It is a JSON object mapping each tenant UUID to an independent, high-entropy HMAC-SHA256 secret (at least 32 characters; 64 random hex characters are recommended).

```json
{
  "11111111-1111-4111-8111-111111111111": "<64 random hex chars for tenant 1>",
  "22222222-2222-4222-8222-222222222222": "<64 random hex chars for tenant 2>"
}
```

The endpoint verifies the `x-nova-payment-signature` HMAC-SHA256 over the **raw** request body using the **target tenant's** key and fails closed (HTTP 403) when the tenant id is malformed or unknown, or when its key is missing or invalid. It never falls back to a shared secret, so one tenant's signer cannot forge an event that mutates another tenant's payments.

**Deployment note:** integrations that previously signed payment webhooks with the single shared `PAYMENT_WEBHOOK_SECRET` must be configured with their correct tenant-specific key in `PAYMENT_WEBHOOK_SECRETS` **before rollout**. The legacy shared secret no longer authenticates this endpoint and is never used as a fallback.

## Useful endpoints

- `GET /` — basic service health.
- `GET /health` — liveness.
- `GET /ready` — readiness/database check.
- `GET /webhook` — Meta webhook verification.
- `POST /webhook` — Meta WhatsApp webhook receiver.
- `POST /api/auth/login` — login.
- `POST /api/auth/refresh` — rotate refresh token.
- `POST /api/auth/logout` — revoke refresh token.
- `GET /api/auth/me` — authenticated user details.
- `GET /api/conversations` — tenant-scoped conversations.
- `GET /api/usage` — tenant usage summary.

Additional authenticated routes cover Business Brain, AI memory/signals, human handoff, co-pilot drafts, and conversation operations.

## Security model

The tenant identifier is derived from the authenticated JWT and revalidated against the database. Application services use tenant-scoped queries, and database relationships use tenant-aware composite foreign keys where cross-table ownership matters.

Customer data must remain isolated:

**Tenant A cannot access Tenant B's contacts, conversations, messages, AI memory, credentials, usage, or handoff data.**

Do not accept a client-supplied tenant identifier as authority for authorization.

Payment webhook requests are authenticated per tenant: the request HMAC must validate against the **target tenant's own** signing key (`PAYMENT_WEBHOOK_SECRETS`), so one tenant's signer cannot authorize an event that mutates another tenant's payments.

## Testing and CI

Run:

```
npm run lint
npm test
```

For a syntax-only check:

```
find src tests -type f -name '*.js' -print0 | xargs -0 -n1 node --check
```

GitHub Actions runs dependency installation, linting, JavaScript syntax checks, and the test suite on pushes and pull requests targeting `main`.

## Database migrations

Migrations live in `database/` and are applied by the application's migration runner when a database is configured.

Never run destructive production database operations casually. Back up production data and review migrations before deployment.

## Production notes

- Use a strong random `JWT_SECRET`.
- Use a unique random 32-byte `CREDENTIAL_ENCRYPTION_KEY`.
- Keep secrets in the deployment platform's secret/environment manager.
- Use HTTPS for the public webhook and API.
- Configure Meta webhook credentials only through environment variables.
- Keep Redis and PostgreSQL private where the hosting provider supports private networking.
- Monitor `/ready`, application logs, queue health, failed deliveries, and database health.
- Deploy migrations deliberately and verify the readiness endpoint after deployment.

## Project status

Nova-AI is being developed incrementally toward a production WhatsApp AI SaaS platform. Tasks 1–13 are implemented on `main`; subsequent product capabilities should preserve the existing tenant-isolation and security model.



## Production data retention and backups

Nova-AI now runs bounded retention cleanup when PostgreSQL is configured. Defaults are conservative and can be adjusted with:
- `RETENTION_DELETED_MESSAGES_DAYS` (default 90)
- `RETENTION_WEBHOOK_COMPLETED_DAYS` (default 30)
- `RETENTION_USAGE_EVENTS_DAYS` (default 365)
- `RETENTION_OCR_DOCUMENTS_DAYS` (default 90)
- `RETENTION_PAYMENT_EVENTS_DAYS` (default 90)

Create an encrypted PostgreSQL custom-format backup with `npm run db:backup`. It requires `DATABASE_URL` and a dedicated `BACKUP_ENCRYPTION_KEY` (32-byte base64url or 64-character hex). Backups are written with restrictive permissions, authenticated with AES-256-GCM, accompanied by a manifest, and pruned according to `BACKUP_RETENTION_DAYS` (default 30).

Restore is deliberately explicit and non-destructive by default:
`RESTORE_TARGET_DATABASE_URL=... RESTORE_ALLOW_OVERWRITE=YES npm run db:restore -- ./backups/<file>.backup.enc`

Never place database URLs or encryption keys in source control. Test restore against a disposable PostgreSQL database before relying on a backup operationally. The encrypted local backup utility is the production baseline; client-owned cloud/Drive transport remains an optional deployment integration rather than a requirement of the core database backup.
