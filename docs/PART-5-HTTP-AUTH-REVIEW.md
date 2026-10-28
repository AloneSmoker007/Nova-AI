# HTTP authorization and auth concurrency follow-up — 29 October 2026

**Release gate remains NO-GO.** This sequential review expands deterministic evidence for Parts 5.1–5.3, 5.6 and 5.14. It is not an independent review or a live Meta/Gemini test.

## Reproduced baseline failures

Application baseline: `0760e5d82269b4b28b9ec603fcada2b58b89c1ab`. The following reproduction commits added tests and CI wiring without changing application behavior:

| Reproduction | Real PostgreSQL evidence | Result |
| --- | --- | --- |
| HTTP matrix at `165487ea5525ee85310a63d2d1140f6056930b21` | [CI #40753861259](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40753861259) | Matrix reported 394 passing / 26 failing test records. Twenty-four leaf probes failed the expected rejection contract; the remaining two failures were their containing groups. Foreign reads and protected-row snapshots held within this fixture scope. |
| Concurrent auth at `d5666f3695e6c0eed9234aa7dbb47ce3ce24ac80` | [CI #40754303878](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40754303878) | Auth suite reported 10 pass / 1 fail. Simultaneous logout of two sessions produced PostgreSQL `40P01` (deadlock); the logout-versus-rotation case passed. Later integration steps were skipped after the failure. |

### Confirmed HTTP contract defects

The checked database constraints and scoped reads prevented foreign data disclosure/modification. These failures concern validation, response semantics and rejecting bad references before unnecessary work:

- Foreign conversation Copilot drafts and foreign-contact manual memory writes reached foreign-key failures and returned generic HTTP 500.
- Starting a foreign/missing workflow returned HTTP 202 with `data: null`, implying acceptance when no run existed.
- Assigning a foreign user to a local conversation, referencing foreign contacts/conversations in workflow runs, and booking with foreign nested references returned HTTP 500 from database integrity errors.

The fixes add tenant-qualified existence predicates or transaction-scoped reference checks, retain composite foreign keys, and return explicit 4xx rejection. No new data-access role is granted. Positive controls cover owned IDs, nullable assignment, and caller-derived ownership despite forged body/query tenant IDs.

### Confirmed auth deadlock

Each logout previously locked its own refresh-token row, then updated all tokens for the account. Two logouts could each hold a row needed by the other. One request then failed rather than completing the logout contract.

Rotation and logout now discover the token's account without first locking a token, lock that account row, then lock/revalidate the token row. Account operations serialize in the same order. Existing issuance-version fences, expired-token precedence, revoked-token authority checks and safe replay behavior remain enforced. The regression uses real transactions and a bounded scheduling barrier; it does not fake PostgreSQL SQL/results or require the unsafe lock order to proceed.

## Verification scope

Read the CI run associated with the commit containing this follow-up for its final result. Local lint/unit checks cannot substitute for the explicitly gated PostgreSQL/HTTP assertions.

| Area | Behavioral coverage |
| --- | --- |
| Anonymous API access | Enumerate every composed non-public `/api/` method/path and send an actual unauthenticated HTTP request. The four explicit token/signature endpoints remain separately classified. New protected routes automatically enter the sweep. |
| Database-backed roles | Two synthetic tenants, each with owner/admin/agent identities. Exercise all sixteen listed privileged data/configuration operations with actual owner/admin success and agent denial. Check diagnostic role guards separately before model work. A signed owner claim on a database agent must not elevate its role. |
| Tenant reads | List endpoints receive a forged tenant query; direct resource reads use both owned and foreign IDs across the three roles. Cover conversations/messages/handoff/summaries/drafts, contact memory, payments, OCR, appointments and calendar downloads. Check foreign canaries, resource IDs and user IDs. |
| Foreign mutations | Sixteen mutation paths in both tenant directions across all three roles. Snapshot 21 named protected tables before/after each direction to detect foreign writes to identities, resources, summaries, queues and usage. Empty list responses remain the existing contract for collection reads. |
| Nested references | Foreign assignee, workflow contact/conversation and appointment contact/conversation IDs. Assert 4xx and unchanged local snapshots. Verify owned equivalents remain usable and that body tenant/user IDs cannot redirect ownership. |
| Middleware and errors | Normal HTTP stack, including authentication, role guards, JSON parsing, global and dedicated login/refresh/diagnostic limiters. Burst tests use separate real loopback source addresses, check 429 and Retry-After, and do not disable rate limits or spoof proxy headers. Inject one synthetic post-auth database failure and verify constant internal-error response. |
| Auth lifecycle | Actual HTTP login → refresh → logout → revoked access/refresh rejection. A simulated database failure must return logout 503 and leave success unclaimed. Real-PG transaction overlap covers concurrent logout and logout versus another session's refresh rotation. |
| External actions | No Meta/Gemini credentials or requests are exercised. External `fetch` is forbidden and counted; fixture recovery/queue workers are stopped before seeding. Valid OCR/model generation and actual provider messages remain outside this test. |

Counts distinguish test records, subtest groups and HTTP requests. Do not equate hundreds of parameterized probes with hundreds of independent vulnerabilities or sum overlapping CI suites as distinct tests.

## Residual release work

- The HTTP matrix proves the listed cases against synthetic fixtures, not exhaustive payload fuzzing, every business-policy decision, all interleavings or deployed identity/ingress settings.
- Real Meta delivery/callback/ambiguous-outcome cases and Gemini semantic/PII red-team still require isolated credentials, explicit test-send authorization and bounded spend.
- Actual reverse-proxy hop count, private services, tenant signer rollout, offsite backup/key recovery, restore drill, monitoring and rollback need staging/operator evidence.
- An independent review and explicit owner decision tied to the final candidate are still required. Keep the [release gate](./PART-5.15-B-RELEASE-GATE.md) blocked; the broader [Part 5 evidence map](./PART-5-AUDIT-EVIDENCE-MATRIX.md) remains a scoped reconciliation.
