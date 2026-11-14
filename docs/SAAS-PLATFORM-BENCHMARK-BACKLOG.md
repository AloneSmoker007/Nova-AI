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

## 6. Expert engineering and cybersecurity playbook

This section distills published guidance from experienced engineering practitioners and recognized security/reliability organizations. It is not a claim that any individual personally audited Nova-AI.

### Engineering craft — Martin Fowler, Kent Beck and established refactoring practice

19. **Small, behavior-preserving changes:** refactor in small steps, keep tests green, and avoid mixing cleanup with behavior changes.
20. **Tests define safety, not just coverage:** add focused regression tests for every confirmed defect; include failure paths and boundary conditions, not only happy paths.
21. **Make code easy to change:** prefer clear module boundaries, explicit contracts and simple designs over speculative abstractions or premature microservices.
22. **Review risk before implementation:** document current behavior, desired behavior, affected callers/data, rollback path and acceptance tests before touching critical flows.

### Application security — OWASP, Microsoft SDL, NIST SSDF, CISA and MITRE

23. **Threat-model important flows:** map assets, actors, entry points, data flows and trust boundaries; use STRIDE prompts (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege).
24. **Default deny:** every route and privileged action must explicitly prove authorization; tenant context must come from trusted server-side identity, not a client-supplied tenant ID alone.
25. **Validate at boundaries:** treat webhooks, uploaded files, OCR output, AI output, queue payloads and external API responses as untrusted input.
26. **Secure by default:** no default credentials, debug routes or permissive CORS in production; safe configuration should not depend on customers remembering extra hardening steps.
27. **Protect secrets and identities:** short-lived/scoped credentials where possible, secret managers, rotation/revocation, no secrets in logs, artifacts, job payloads or test output.
28. **Prioritize real weakness classes:** use OWASP Top 10 2025, ASVS 5.0, OWASP Cheat Sheets and MITRE CWE Top 25 as checklists for access control, injection, authentication, misconfiguration, unsafe error handling and dependency risks.
29. **Build security into the lifecycle:** security requirements → design/threat model → implementation → verification → release → monitoring; repeat threat analysis when architecture or data flows change.
30. **Keep an SBOM/dependency inventory:** track direct and transitive dependencies, provenance, supported versions and vulnerability remediation; prioritize exploitable paths and reachable code, not raw scanner counts alone.

### Reliability and operations — Google SRE, AWS and Google Cloud Well-Architected

31. **Define user-facing SLOs:** measure successful webhook acceptance, message delivery, AI response latency and availability; use error budgets to balance features against reliability work.
32. **Observe symptoms and causes:** alerts should detect customer impact; correlate request IDs from HTTP through webhook inbox, queue, worker and provider; avoid logging message contents or credentials.
33. **Practice failure and recovery:** test Redis/PostgreSQL outage, provider timeout, duplicate webhook, worker restart, queue backlog, backup restore and SIGTERM under load in disposable environments.
34. **Make operations repeatable:** documented runbooks, clear owner/severity, incident timeline, customer communication, recovery verification and blameless postmortems with tracked corrective actions.
35. **Design for safe retries:** retry transient failures with bounded exponential backoff and jitter; use idempotency keys for side effects; distinguish permanent failures from transient ones and provide a controlled DLQ replay path.
36. **Prove backup recovery:** backup success is not enough; regularly restore into isolated disposable databases and verify integrity, tenant boundaries, encryption and documented recovery objectives.
37. **Control blast radius:** isolate tenants, credentials, queues and admin permissions; rate-limit per tenant and globally; use circuit breakers/timeouts and bulkheads where appropriate.
38. **Measure cost and performance:** track per-tenant AI tokens/cost, queue wait time, DB pool saturation, storage and provider failures before optimizing; avoid scaling complexity without evidence.

### Direct implications for Nova-AI

- N-13 remains the immediate reliability priority: prove real application shutdown while Redis is unavailable, then preserve active-job drain and stalled-job recovery.
- Before production approval, map every tenant-owned data path and test tenant A/B access denial across APIs, SQL, cache, queues, files, backups, logs and admin operations.
- Treat outbound WhatsApp sends as external side effects: reconcile ambiguous provider outcomes and prevent duplicate sends rather than assuming a DB transaction can roll back a provider action.
- Keep AI-generated content untrusted until validated by deterministic outbound policy; never let model output grant permissions or bypass tenant/business rules.
- Keep the modular monolith until measured scale or team boundaries justify a split.

### Expert source library

- Martin Fowler — Refactoring and behavior-preserving change: https://martinfowler.com/books/refactoring.html
- OWASP Top 10 2025: https://owasp.org/projects/top-ten
- OWASP ASVS 5.0: https://asvs.owasp.org/
- OWASP Cheat Sheet Series: https://owasp.org/projects/cheat-sheet-series
- OWASP Threat Modeling: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- OWASP Attack Surface Analysis: https://cheatsheetseries.owasp.org/cheatsheets/Attack_Surface_Analysis_Cheat_Sheet.html
- Microsoft SDL Threat Modeling: https://www.microsoft.com/en-us/securityengineering/sdl/threatmodeling
- Microsoft Security Development Lifecycle: https://learn.microsoft.com/en-us/windows/security/threat-protection/msft-security-dev-lifecycle
- NIST SSDF SP 800-218: https://csrc.nist.gov/pubs/sp/800/218/final
- MITRE CWE Top 25 2025: https://cwe.mitre.org/top25/
- Google SRE Incident Management: https://sre.google/resources/practices-and-processes/incident-management-guide/
- Google SRE Error Budget Policy: https://sre.google/workbook/error-budget-policy/
- Google Cloud Well-Architected Framework: https://docs.cloud.google.com/architecture/framework
- AWS Well-Architected Security Pillar: https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/security.html
- CISA Secure by Design / Secure by Demand: https://www.cisa.gov/securebydesign
- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use

---
**Safety note:** This document is a research backlog only. It does not authorize merging, deployment, production database changes, credential changes, customer/provider actions, or paid services.
