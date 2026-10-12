import test from "node:test";
import assert from "node:assert/strict";
import { getWorkerConfig } from "../src/services/queue.service.js";

test("queue worker settings use safe defaults for malformed and out-of-range values", () => {
  const config = getWorkerConfig({
    QUEUE_CONCURRENCY: "not-a-number",
    QUEUE_RATE_MAX: "Infinity",
  });

  assert.equal(config.concurrency, 5);
  assert.equal(config.limiter.max, 20);
  assert.equal(config.limiter.duration, 1000);

  const oversized = getWorkerConfig({
    QUEUE_CONCURRENCY: "101",
    QUEUE_RATE_MAX: "1001",
  });
  assert.equal(oversized.concurrency, 5);
  assert.equal(oversized.limiter.max, 20);

  const nonIntegers = getWorkerConfig({
    QUEUE_CONCURRENCY: "1.5",
    QUEUE_RATE_MAX: "2.5",
  });
  assert.equal(nonIntegers.concurrency, 5);
  assert.equal(nonIntegers.limiter.max, 20);
});

test("queue worker settings preserve valid values within configured bounds", () => {
  const config = getWorkerConfig({
    QUEUE_CONCURRENCY: "12",
    QUEUE_RATE_MAX: "250",
  });

  assert.equal(config.concurrency, 12);
  assert.deepEqual(config.limiter, { max: 250, duration: 1000 });

  assert.deepEqual(getWorkerConfig({}), {
    concurrency: 5,
    limiter: { max: 20, duration: 1000 },
  });
});

test("queue worker concurrency and rate limits reject zero and negative values", () => {
  const config = getWorkerConfig({
    QUEUE_CONCURRENCY: "0",
    QUEUE_RATE_MAX: "-1",
  });

  assert.equal(config.concurrency, 5);
  assert.equal(config.limiter.max, 20);
});
