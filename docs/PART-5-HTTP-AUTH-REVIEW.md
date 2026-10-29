# HTTP authorization and auth concurrency follow-up — 29 October 2026

**Release gate remains NO-GO.** This sequential review expands deterministic evidence for Parts 5.1–5.3, 5.6 and 5.14. It is not an independent review or a live Meta/Gemini test.

## Verified follow-up evidence

- HTTP/auth corrections passed at `a1387e5a54358d88f9eefacbd05d9578d4e6e7ae` in [CI #40756385327](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40756385327). The database job reported 545 pass / 0 fail / 0 skip, including 436 HTTP matrix records and 11 auth integration cases.
- The added AI outbound boundary suite passed at `157512fa14f7c467a1a2641565f0d07afb4559f7` in [CI #40757466666](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40757466666). Both jobs succeeded: quality 197 pass / 0 fail / 2 summarized skips; 21 serialized PostgreSQL 15 / Redis 7 test commands reported 549 pass / 0 fail / 0 skip. These counts overlap and must not be added as unique coverage. The quality job's 20 raw `# SKIP` markers include environment-gated suites and the two summarized skipped tests; they are not passes.
- The HTTP matrix completed **633 actual loopback HTTP requests** with zero external provider calls. Its 436 test records include grouped/parameterized probes, not 436 independent findings.
- Production dependency audit in that CI reported zero vulnerabilities. The local full production-and-development dependency audit also reported zero known vulnerabilities at this checkpoint; this is time-bound advisory evidence, not proof of no dependency flaws.
- Any later commit still needs its own exact-SHA CI result before merge. No production migration, real provider request, customer send, independent approval, merge or deployment is implied.

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

The fixes add tenant-qualified existence predicates, transaction-scoped reference checks or safe API translation of integrity rejection. Composite foreign keys remain in force, and the API returns explicit 4xx rejection. In particular, direct workflow service calls still reject a foreign nested reference with PostgreSQL `23503`; the HTTP handler translates that failure without revealing constraint details. No new data-access role is granted. Positive controls cover owned IDs, nullable assignment, and caller-derived ownership despite forged body/query tenant IDs.

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

## AI output at the outbound delivery boundary

`tests/ai-outbound-boundary.test.js` drives the real signed webhook HTTP handler, migrated PostgreSQL database, recovery dispatcher, Redis/BullMQ worker, Gemini SDK response parser, output policy and durable WhatsApp delivery path. Only the Gemini and Meta network transports are replaced; all credentials and identities are synthetic.

Four passing cases establish the tested contract:

1. A webhook with an invalid signature creates no inbox record and makes no generation/send attempt.
2. A synthetic model response containing a JSON `access_token` assignment becomes the fixed safe fallback before it reaches the durable inbox response, delivery body, outbound history or simulated Meta payload. The raw secret canary is absent from those durable artifacts.
3. A supported ordinary business reply passes unchanged to the owning tenant's recipient/number. Each model prompt contains its own business canary, excludes the other tenant's canary and excludes the Meta access credential.
4. Signed duplicate deliveries and a completed inbox row re-enqueued through the real worker do not generate or send again; one AI usage event and one delivery intent remain per message. The final transport accounting is two simulated Gemini responses, two simulated Meta sends and **zero external provider calls**.

The final accounting assertion is separate from the two substantive message cases. The replay assertion settles the real worker job before checking call counts. This exercises deterministic output-to-persistence/send wiring; it does not establish real-model semantic safety, universal PII detection, live Meta behavior, billing correctness or deployment controls.

## Residual release work

- The HTTP matrix proves the listed cases against synthetic fixtures, not exhaustive payload fuzzing, every business-policy decision, all interleavings or deployed identity/ingress settings.
- Real Meta delivery/callback/ambiguous-outcome cases and Gemini semantic/PII red-team still require isolated credentials, explicit test-send authorization and bounded spend.
- Actual reverse-proxy hop count, private services, tenant signer rollout, offsite backup/key recovery, restore drill, monitoring and rollback need staging/operator evidence.
- An independent review and explicit owner decision tied to the final candidate are still required. Keep the [release gate](./PART-5.15-B-RELEASE-GATE.md) blocked; the broader [Part 5 evidence map](./PART-5-AUDIT-EVIDENCE-MATRIX.md) remains a scoped reconciliation.

## 29 October follow-up: takeover and deleted-source sends

At code baseline `cbd00c50dcfd6efb00f73386f4c89cba66b7bfd5`, the initial inbox worker checked AI pause before generation, but did not re-authorize the reply after the model returned. Delivery recovery also retried a pre-request crashed attempt without checking whether its source was deleted or its conversation had since been paused.

The test-only reproduction commit `51f02932192790b10c8302ea930c34f80b23e743`, [CI #40823898387](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40823898387), demonstrated three unexpected simulated sends: human takeover committed during generation, paused-conversation recovery and deleted-source recovery. The expanded AI boundary suite reported **5 pass / 4 fail** among 9 cases: three behavioral failures plus the final transport-count assertion (7 sends instead of the expected 4). Normal generation, explicit resume and eligible recovery controls passed. Later database steps were skipped after the failing step; they are not passing evidence.

The correction places AI eligibility in `markDeliveryRequestStarted()`'s lease/attempt-fenced database update. Both the initial worker and recovery use this boundary. An inbox-derived AI delivery needs a canonical live inbound message in its own tenant and conversation, and an existing conversation with AI unpaused. Shared row locks serialize this check against an already-running pause/deletion update. A missing/deleted source or paused conversation rejects request-start; existing callers mark that unsent attempt failed with a constant internal reason. No provider request-start marker, provider ID or fictitious outbound history is created for these blocked sends.

The delivery fixture now includes its canonical inbound message, matching the application's normal preparation order; existing reliability assertions remain intact. Added direct PostgreSQL cases check paused/re-enabled conversation policy, missing-source denial, retained lease/attempt fencing, an in-progress takeover transaction, and an explicit non-AI automation control. Workflow-configured messages remain governed by their existing policy; `ai_paused` applies here to inbox-derived AI replies.

Verify CI at the containing fix commit before accepting the correction as tested. These deterministic checks use real HTTP/PostgreSQL/Redis/worker behavior and synthetic Gemini/Meta transports. They do not recall a request that already crossed the provider dispatch boundary, erase already-sent history, certify all crash interleavings or replace live Meta/Gemini and independent review evidence. Gate remains **NO-GO**.
