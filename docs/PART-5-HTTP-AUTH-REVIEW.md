# HTTP authorization and auth concurrency follow-up — 29 October 2026

**Release gate remains NO-GO.** This sequential review expands deterministic evidence for Parts 5.1–5.3, 5.6 and 5.14. It is not an independent review or a live Meta/Gemini test.

## Webhook verification query privacy (29 October)

At `e20d70d42701060e209cb51eccbefc5d1cbdd437`, the real HTTP logger
serialized `req.url` with its query. A successful Meta-style GET verification
therefore logged the synthetic `hub.verify_token` and challenge; rejected
verification and private API search queries were also retained. Existing
object/header redaction did not sanitize the URL string. This demonstrates a
log-disclosure path, not proof that actual production credentials were leaked.

The six new behavioral cases reported **1 pass / 5 fail** before correction.
The fix logs only the request path, preserving method, request ID, status and
the original URL/query used by routing. Query text is deliberately unavailable
in access logs on every route; operators should use safe structured fields
instead of adding raw queries back. No dependency or schema change is needed.

After correction, local Node 24 checks passed **6/6**, including a child
process running the actual composed Nova app: a valid verification still returns
the challenge with 200, and an invalid token still returns 403, while neither
query appears in its logs. Encoded/repeated query keys, ordinary query routing
and a query-free control are covered. Full local quality passed **218/0/2**
among 220 records, and lint passed. Read the containing commit's full CI before
accepting the PostgreSQL/Redis and production-network regression scope.

This does not sanitize reverse-proxy/provider logs, arbitrary application error
messages, secrets placed in URL paths or malicious request IDs. Deployment and
live signed-webhook evidence remain separate release requirements.

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

## 29 October follow-up: legacy output caches and outbound history

Code baseline `1758313697d1612afebd0561cf7623bd490070ce` filtered newly generated Gemini output, but trusted cached inbox/delivery text on later processing attempts. A safe inbox cache could coexist with an older unsafe delivery body because delivery preparation intentionally retains the first body. In addition, the inbox worker recorded its cached response in outbound history even when the immutable delivery body actually sent/accepted by the provider differed.

Test-only commit `81b8476174935d0187eff89cb8ddc0568ceeaf62`, [CI #40825634543](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40825634543), reproduced **five behavioral failures**: unsafe inbox-cache send, unsafe retained-delivery send, unsafe recovery send, wrong body in normal outbound history and wrong body in accepted-delivery history repair. The AI suite reported **10 pass / 6 fail** among 16 cases; the sixth failure was final accounting (10 simulated sends instead of 7). Normal cached output, non-AI automation and prior takeover/deletion controls passed. Later integration steps skipped after the failure are not passing evidence.

The correction re-inspects unsent cached AI text before creating another delivery intent and inspects the exact retained AI payload before request-start in both the initial worker and recovery. Unsafe cached inbox output completes without a new delivery/send/regeneration; unsafe delivery attempts fail before a provider request-start marker. Logs contain fixed messages and a policy reason, never the output itself. This does not purge or rewrite preexisting stored content; retention and historical privacy scope remain separate.

Outbound persistence now uses the normalized text actually sent from the durable delivery, including no-resend history repair. Where the inbox already carries a provider ID, a matching tenant/inbox/provider-correlated delivery is authoritative when available; legacy rows without a delivery keep their existing history fallback. Additional regression checks cover that provider-correlated branch and ordinary whitespace normalization. A bounded scheduling barrier pauses only background history scans so the inbox worker's own writes are tested; every SQL query still executes against PostgreSQL. No query result is fabricated.

The AI policy applies to inbox-derived AI replies. Explicitly configured non-AI automation retains its current policy, with an actual recovery/send control. Already-accepted delivery history is preserved, not reclassified as a new safe generation or resent. Read exact-SHA CI at the containing fix commit before accepting these cases as passing. This closes the reproduced known-pattern cache bypass and history mismatch, not arbitrary PII/semantic leakage or the live-provider release gate.

## 29 October bounded callback/replay review

This pass has five explicit acceptance areas: valid early/provider-only receipts, consistency of all supplied identities, malformed-input rejection, replay/monotonic behavior, and concurrent provider binding. It covers both inbox-derived and automation delivery sources plus the actual signed HTTP parser. It does not expand into an unbounded assurance that every code path is bug-free.

Test-only commit `4209f46facadd73c77731ed4dc0cd970a50bbb91`, [CI #40827381086](https://github.com/AloneSmoker007/Nova-AI/actions/runs/40827381086), reproduced these integrity/validation problems at application baseline `27efb519a9b680d7a96a9dbff128b4771b92860c`:

- The status target used provider-ID **or** callback-key matching. A supplied unknown/foreign/malformed key could be ignored when the provider ID matched, and a known key could accept status for an inconsistent provider ID. These cases changed the owning delivery; no cross-tenant data disclosure is established by this finding.
- Recipient was neither checked by the service nor mapped from the raw `recipient_id` field. A mismatched recipient could therefore change status despite otherwise known IDs.
- The old UUID expression accepted 36 hyphens, leading to PostgreSQL `22P02` / HTTP 500 instead of safely ignoring that invalid receipt.
- Existing provider-ID collisions raised `23505`; racing different IDs against one key could both appear accepted, with the first ID retained but another receipt's status applied.

Baseline delivery suite: **21 pass / 22 fail** among 43 test records. Twenty failing leaf checks plus two failed containing groups account for those failures. Signed-HTTP suite: **439 pass / 5 fail** among 444 records (four failing receipt cases plus their containing group). The CI step deliberately runs both schema-resetting suites serially and exits nonzero if either fails; later steps after that failed step were skipped, not passing evidence.

The fix requires every supplied key/provider/recipient to agree. A missing callback key can still use an already-known provider ID; a valid key can still bind the first early receipt. Supplied malformed keys or recipients reject before SQL. Recipient mapping uses the raw signed payload field. Both source-specific joins retain tenant and WhatsApp-number ownership. The final update rechecks provider/key/recipient conditions after row-lock waits, preventing a second conflicting provider identity from being applied. Known duplicate provider binding uses the existing unique constraint as the final race boundary: only that exact constraint collision returns no match; unrelated database failures still propagate for a retriable, redacted HTTP 500.

Positive controls retain sent → delivered → read, valid repeated/concurrent receipts, provider-only delivery updates and both delivery source types. Negative controls compare entire rows, including timestamps, lease/error fields and provider binding; foreign rows remain unchanged. Signed HTTP tests cover recipient and ID/key mismatch, malformed UUID, absent callback data, invalid signature and an unrelated database failure. The fault injection does not replace SQL results for ordinary/race cases; those execute against real PostgreSQL.

Accept this bounded review only after its containing fix commit's full CI succeeds. Existing state-transition policy is preserved; synthetic receipts do not establish live Meta behavior or a final independent security approval. The remaining release gate still requires real provider, staging/operations and independent-review evidence.

## 29 October follow-up: production database TLS policy

At baseline `8ef0b7b898ffcbf9ba48e27491bcc533669a6c7b`, `getPoolConfig()` returned an explicit production SSL object, but also passed the original `connectionString` to `pg`. The driver parses that URL after merging explicit options. URL TLS settings could therefore replace the application's SSL object: `sslmode=disable` and `ssl=0` allowed a plaintext startup; `no-verify` and libpq-compatible require/prefer modes disabled certificate checking. A URL-provided CA/compatibility mode could replace the deployment CA and disable hostname checking. This is a deployment-configuration policy gap, not evidence that a tenant can edit server configuration or that customer data was exposed.

Local behavioral reproduction against the real installed `pg` driver: **4 pass / 8 fail** among 12 tests before correction. A rejecting synthetic loopback peer records whether the client starts with a PostgreSQL SSLRequest or a direct TLS handshake; it never accepts a session. Client options additionally verify certificate/hostname policy and deployment CA retention. The eight failures are parameterized examples of this precedence problem, not eight independent vulnerabilities. Ordinary verified TLS, legitimate direct negotiation, nested-URL and development-loopback controls passed at baseline.

The fix parses the production URL once using the already-resolved official `pg-connection-string` package, now declared directly without changing its locked version. It removes any nested `connectionString` query field before creating the pool, preserves parsed identity/application settings and TLS client material, then applies verified certificates, Node's standard hostname check and the explicit deployment CA. No second URL parse can replace that final policy. Non-production retains its original connection-string behavior.

Focused local result after correction: **15/15 pass** (12 new driver/wire cases plus three existing database configuration cases); lint also passed. Encoded credentials/application names, direct TLS, deployment CA precedence, safe nested-URL handling and explicit development plaintext remain covered. These tests use no real credentials, PostgreSQL server, cloud resources or provider requests. They establish the first protocol packet and the actual driver's verification configuration, not a successful remote certificate chain or production network posture. Read full CI at the containing fix commit before accepting release regression evidence.

Rollout: production URLs that previously relied on plaintext, untrusted certificates or hostname bypass will now fail closed. Provision a verifiable endpoint and appropriate CA instead of disabling verification. In particular, Render documents self-signed certificates for its internal PostgreSQL endpoint; provider compatibility must be checked before using that endpoint. Neither this fix nor a free hosting plan signs the staging, live-provider, backup or independent-review gates.
