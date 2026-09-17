## 2026-09-17 - Durable Webhook Idempotency and Async Queueing
**Learning:** Synchronous in-memory idempotency maps incur linear O(N) iteration overhead on every incoming webhook and risk losing messages during unexpected server restarts or high-concurrency spikes.
**Action:** Use database-backed transactional idempotency tables with Redis queue workers (`BullMQ`) to guarantee durable zero-message-loss processing and bounded O(1) status queries under load.
