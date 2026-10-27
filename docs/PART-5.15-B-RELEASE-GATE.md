# Part 5.15-B release gate — evidence and owner signoff

**State: BLOCKED / NOT RELEASE APPROVED.** This is a living release-control document for PR [#163](https://github.com/AloneSmoker007/Nova-AI/pull/163), not a certification or deployment authorization.

## Verified branch evidence (2026-10-27)

- Baseline reviewed: PR #163 head `29c79c470ca4f8bd0dca762c0e03d14085026547`. `main` remains separate. Recheck the SHA before reusing this evidence.
- [GitHub Actions CI run #40479443739](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40479443739): quality and PostgreSQL integration jobs succeeded at that SHA.
- Quality job: 185 passed, 0 failed and 2 summarized skips among 187 test records. The raw TAP output also contains 18 environment-gated suite `# SKIP` markers; skipped coverage is **not** a pass.
- Separate serialized tests using PostgreSQL 15 and Redis 7: 19 test files, 99 passed, 0 failed, 0 skipped (per [review checkpoint](https://github.com/AloneSmoker007/Nova-AI/pull/163#issuecomment-6438087420)).
- Disposable-db encrypted backup/restore integration: tested authenticated encryption, wrong key, corrupted ciphertext, no target mutation on decryption failure and successful data round-trip. Tested with PostgreSQL 15 client against PostgreSQL 15 server.
- The N-07 internal-error redaction and N-13 natural lifecycle shutdown regressions were included and passed within this test scope.

These results establish **automated test confidence**, not safe live provider behavior or a production authorization.

## Open evidence gaps

| Gate | Current state | Required evidence before approval |
| --- | --- | --- |
| Historical Parts 5.1–5.15 | **INCOMPLETE** | Locate original reports or explicitly mark each as unavailable; do not transform missing reports into PASS |
| Part 5.10 | **HISTORICAL FAIL; ORIGINAL REPORT MISSING** | Earlier conversation checkpoint recovered the scope and severity-level findings below, but not finding IDs/full original report. Re-audit each issue against the current SHA with evidence and independent review |
| Meta WhatsApp Cloud API | **UNTESTED live** | Owner-approved test phone/number and credentials, signed webhook delivery, duplicated inbound event, outbound status, ambiguous send, retry, human takeover |
| Gemini and paid AI provider | **UNTESTED live** | Owner-approved bounded test budget; prompt-injection / output-redaction checks, quota reservation and provider-failure exercise |
| Deployment network controls | **NO production signoff** | Confirm exact public reverse-proxy hop count; no direct path that permits spoofed forwarding headers; HTTPS, private database/Redis and rate-limit behavior in the actual topology |
| Per-tenant payment signing rollout | **NO production signoff** | Confirm every active tenant signer has the correct unique `PAYMENT_WEBHOOK_SECRETS` entry; stage coordinated switch away from `PAYMENT_WEBHOOK_SECRET`; verify rejection of old/unknown/cross-tenant signatures and replay |
| Backup operations | **SMOKE PASS; ops NOT SIGNED** | Verified offsite encrypted copies, retention, access control, independent key recovery, scheduled restore drill, `pg_dump` / server version compatibility, RPO/RTO |
| Monitoring and rollback | **NO production signoff** | Alerts for webhook queue/dead letter, payment failures, Redis/Postgres readiness and AI budget; migration rollback/roll-forward plan; owner drill |
| Final red-team and release review | **PENDING** | Evidence-indexed security review, explicit owner signoff tied to *exact* final commit SHA |

## Part 5.10 historical scope recovery (not a pass)

An earlier **2026-10-01 multi-agent checkpoint summary** identifies Part 5.10 as AI memory, prompt-injection, PII, and red-team coverage. It records three independent reviewer roles, 125/125 then-current unit tests green, but a **security gate FAIL**. The original complete report, stable finding IDs and exact reproductions have **not** been recovered. Do not claim that the original audit passed.

- **HIGH historical concerns:** customer-controlled memory/context in trusted system instructions, persistent poisoning, memory-wrapper escaping/breakout, missing deterministic outbound AI validation.
- **MEDIUM:** deleted-message context reuse, memory-write role authorization, memory/AI artifact retention, long handoff-context resource consumption.
- **LOW:** zero-width/bidi text, incorrect literal newline joins, memory-source metadata forgery, development error disclosure.

Current **candidate mitigations for independent review**, not proof of closure: `src/services/gemini.service.js` keeps a server-authored system instruction and puts business/memory data in the untrusted user payload; `advanced-ai.service.js` sanitizes and XML-escapes memory; `ai-output-safety.service.js` applies high-confidence output rejection; AI-memory API routes restrict writes; source-message deletion purges derived records; retention windows exist; handoff context is bounded; N-07 masks server errors.

In the subsequent unmerged PR #163 patch, direct `rememberCustomerPreference` provenance checks now require the source to be a live inbound message belonging to that **same contact** and lock it against concurrent deletion. The new real-PostgreSQL regression must pass in CI before this mitigation can be marked verified. This is narrower than a comprehensive prompt-injection / PII red-team signoff.

## Operator preflight (no secrets in GitHub)

- [ ] Confirm `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `GEMINI_API_KEY` in the deployment secret manager, and test startup failure on missing mandatory configuration.
- [ ] Set `TRUST_PROXY_HOPS` to the *actual number of trusted proxy hops* after documenting CDN/load-balancer ingress. `0` is safe only when headers must not be trusted. Probe an untrusted `X-Forwarded-For` header and rate limits from outside.
- [ ] Confirm per-tenant payment webhooks have their target-specific signing keys and that each provider/integration uses the new signing contract. Do not roll out a rejecting endpoint before signers are migrated.
- [ ] Confirm private Postgres/Redis reachability, TLS policy, webhook signature integrity, least-privilege deployment tokens, and no secrets in logs.
- [ ] Confirm backup location persists beyond an ephemeral app container and has an offsite recovery copy. Keep `BACKUP_ENCRYPTION_KEY` independently recoverable from the backup data, under audited limited access.
- [ ] Rehearse restore into a **new disposable database** with the correct PostgreSQL client major version; verify application-level data and owner-approved RPO/RTO. `RESTORE_ALLOW_OVERWRITE=YES` must never be used against production casually.
- [ ] Independently verify migrations and rollback strategy on a disposable/staging clone; backups do not make nonreversible schema migrations automatically safe.
- [ ] Recheck the PR head, branch diff, review threads, CI, real PostgreSQL/Redis suites, and external integration evidence **after the last code change**.

## Release decision record

| Field | Value |
| --- | --- |
| Candidate SHA | _Unset — exact final candidate required_ |
| CI workflow run | _Unset — must match final candidate_ |
| Parts 5.1–5.15 reconciliation owner | _Unsigned_ |
| Part 5.10 disposition and evidence | _Unsigned_ |
| External Meta/Gemini E2E owner | _Unsigned_ |
| Payment signer migration owner | _Unsigned_ |
| Operations / backup / reverse proxy owner | _Unsigned_ |
| Security review owner | _Unsigned_ |
| Project owner go/no-go | **NO-GO** |
| Merge SHA / deployment run | _None_ |

**Branch policy:** PR #164 and PR #165 contain overlapping fixes now included in #163. Do not merge duplicate branches blindly. Do not merge PR #163 or deploy production until all blockers are resolved, CI is green at the exact candidate SHA, and project-owner approval is recorded. Any final post-merge gate must refer to the actual merged SHA, not only the PR head.
