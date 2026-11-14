# Nova-AI — SaaS Platform Benchmark & Improvement Backlog

**Research date:** 2026-11-14  
**Status:** Candidate backlog; research only. Items below are not implementation claims.  
**Scope:** Preserve the existing Express + PostgreSQL + Redis/BullMQ modular monolith. Do not rewrite Nova-AI or migrate its forge/platform.

## 1. Platform and project references reviewed

### Developer platforms / CI forges

| Platform | Useful patterns for Nova-AI | Cautions |
|---|---|---|
| GitHub Actions | Immutable action references (full commit SHA), least-privilege workflow permissions, dependency review, protected branches | Existing Nova workflow uses mutable major tags in several jobs; audit every `uses:` entry before changing |
| GitLab | Secret/dependency scanning, MR security findings, protected variables/runners, security approval policies | Some enforced policies are Ultimate-tier; do not assume free availability |
| Bitbucket | Merge checks, successful-build gates, branch permissions, environment-specific deploy permissions | Several enforcement/deployment controls are Premium; free CI minutes are limited |
| Azure DevOps | Branch policies, required reviewers/build validation, linked work-item traceability, scoped pipeline identities | Adds another platform and operating surface; no migration recommended |
| Gitea | Protected branches and self-hosted Actions runners | Runner should be isolated from the application host; self-hosting adds maintenance |
| Forgejo / Codeberg | Fork-workflow approval, runner trust boundaries, CI with Woodpecker or self-hosted runners | Codeberg-hosted CI has onboarding/resource limitations; do not put secrets on untrusted runners |
| SourceHut | Patch-based review, isolated build jobs, ad-hoc CI, SSH debugging | Different workflow model; useful ideas, not a reason to move repos |

### Application / architecture references

- Chatwoot — mature customer-support inbox, operational docs, security disclosure and release practices: https://github.com/chatwoot/chatwoot
- Open SaaS — example of SaaS workflows, background jobs and browser E2E testing: https://github.com/wasp-lang/open-saas
- SaaS API Starter — Node/Express/Postgres/Redis/RBAC/rate-limit reference; portfolio/reference project, not proof of production maturity: https://github.com/alireza-ghaemitalab/saas-api-starter
- WhatsApp AI SaaS example — useful service-boundary ideas only; do not copy its multi-service complexity: https://github.com/Javier407/whatsapp-ai-saas
- Multi-tenant WhatsApp backend — useful webhook/queue concepts, but its README labels it a proof of concept: https://github.com/souvik-techno-exponent/multi-tenant-whatsapp

## 2. Recommended improvement backlog

### P0 — Reliability gate (do before production approval)

1. **N-13 deterministic app-level shutdown regression:** reproduce Redis-unavailable shutdown through the real app's `closeQueue()`; identify the exact hanging await. Preserve graceful active-job drain and prove stalled-job recovery. Do not blindly force-close workers.
2. **Real dependency outage matrix:** test Redis unavailable at startup, transient disconnect during active work, PostgreSQL outage, recovery, SIGTERM and SIGINT. Assert bounded exit and no lost/duplicate durable work.
3. **Tenant boundary test inventory:** enumerate every tenant-owned table, cache key, queue job, dead-letter action, file/object path, backup/restore path and admin route. Prove tenant A cannot read/write tenant B.
4. **Outbound side-effect safety:** verify provider idempotency/reconciliation for WhatsApp sends and automation effects; ambiguous provider outcomes must not trigger blind duplicate sends.
5. **Backup/restore isolation:** test single-tenant recovery from a shared backup without exposing or overwriting another tenant's records; record operator, reason, source and result.

### P1 — Security and delivery quality

6. **GitHub Actions supply-chain hardening:** inventory every workflow `uses:`; pin third-party actions to verified full-length commit SHAs (or an approved immutable lockfile mechanism), audit action source, and keep `permissions` least-privileged. Current workflow inspection found major-version tags such as `actions/checkout@v5` and `actions/setup-node@v5` plus older `@v4` references; this is a review item, not an instruction to bulk-update blindly.
7. **PR trust boundary:** ensure fork/untrusted PR workflows receive no secrets and no write token; review any `pull_request_target` use separately.
8. **Dependency security policy:** retain production high/critical audit gate; triage the currently reported moderate advisories with dependency path, exploitability and fix availability. Add dependency review / scheduled scans if compatible with the current GitHub plan and CI cost.
9. **Security regression gates:** add secret scanning, dependency scanning, static analysis and targeted API security tests where practical; fail on new high/critical findings rather than hiding existing debt.
10. **Webhook integrity:** require signature validation, timestamp/replay tolerance where supported, provider event-ID idempotency, and tenant-scoped replay tests.
11. **Privileged audit trail:** record actor, tenant, action, target, outcome and correlation/request ID for security-sensitive admin, credential, billing, retention and restore operations; keep secrets and message bodies out of logs.
12. **Tenant-aware resource controls:** enforce per-tenant limits for API requests, AI spend, queued work, concurrency and storage, plus global safety limits and correct HTTP 429 / Retry-After behavior.
13. **Credential lifecycle:** hash high-entropy API keys at rest; scope service credentials to tenant, environment and permissions; rotate/revoke and audit them.

### P2 — Operability and customer readiness

14. **Operational dashboards/alerts:** queue backlog age/depth, failed jobs, stopped workers, provider error rates, AI latency/cost, quota denials, database pool pressure and recovery status.
15. **Structured observability:** consistent request/correlation IDs across HTTP → webhook inbox → queue → worker → provider; metrics, traces and redacted structured logs.
16. **Release discipline:** migration forward-compatibility checks, rollback/restore runbook, release checklist, change log, health/readiness checks and tested staging promotion.
17. **Customer lifecycle:** tenant provisioning as an all-or-nothing workflow; offboarding revokes sessions/keys and applies documented retention across DB, cache, files, exports and backups.
18. **End-to-end product tests:** when UI work is unlocked, add browser E2E for signup/login, tenant switching/isolation, WhatsApp connection onboarding, inbox, billing/usage and role permissions.

## 3. What Nova-AI should adopt — and what it should not

**Adopt:** immutable CI dependencies, least-privilege permissions, protected branch/build gates, real PostgreSQL/Redis integration tests, tenant-aware quotas and queues, append-only/auditable privileged actions, backup restore drills, and actionable operational alerts.

**Do not adopt now:** migrating away from GitHub, switching frameworks, splitting the modular monolith into microservices, adding enterprise SSO/SCIM without customer demand, or buying paid monitoring/security platforms before free/current capabilities are evaluated.

## 4. Execution order

1. Finish N-13 diagnosis and deterministic regression.
2. Re-run the complete CI gate on the exact candidate SHA.
3. Review and pin workflow actions in a separate, narrowly scoped change.
4. Reconcile this backlog against existing tests/issues so no duplicate work is created.
5. Implement one item at a time with gap → spec → risk → tests → review → CI → checkpoint.

## 5. Source material

- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use
- GitLab application security: https://docs.gitlab.com/user/application_security/get-started-security/
- GitLab MR pipelines / protected resources: https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/
- Bitbucket merge checks: https://support.atlassian.com/bitbucket-cloud/docs/suggest-or-require-checks-before-a-merge/
- Azure Repos branch policies: https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies-overview
- Gitea protected branches: https://docs.gitea.com/1.27/usage/access-control/protected-branches/
- Forgejo Actions security: https://forgejo.org/docs/latest/user/actions/security/
- Codeberg CI guide: https://docs.codeberg.org/ci/
- SourceHut: https://sourcehut.org/
- OWASP Multi-Tenant Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
- BullMQ graceful shutdown: https://docs.bullmq.io/guide/workers/graceful-shutdown
- BullMQ production guide: https://docs.bullmq.io/guide/going-to-production
- BullMQ retries: https://docs.bullmq.io/guide/retrying-failing-jobs

---
**Safety note:** This document is a research backlog only. It does not authorize merging, deployment, production database changes, credential changes, customer/provider actions, or paid services.
