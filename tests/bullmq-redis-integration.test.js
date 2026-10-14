import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";

import { enqueueWhatsAppMessage } from "../src/services/queue.service.js";

const redisUrl = process.env.REDIS_URL || "";
const skip = redisUrl ? false : "Set REDIS_URL to run the live Redis/BullMQ integration test";

test("a retained failed BullMQ job can be removed and re-enqueued against live Redis", { skip }, async () => {
  const queueName = `nova-ai-test-${randomUUID()}`;
  const inboxId = randomUUID();
  const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 5000 });
  const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 5000 });
  const queue = new Queue(queueName, { connection: queueConnection });
  const worker = new Worker(
    queueName,
    async () => { throw new Error("intentional integration-test failure"); },
    { connection: workerConnection, concurrency: 1 },
  );
  let failureListener;
  let errorListener;

  try {
    await queue.waitUntilReady();
    await worker.waitUntilReady();

    const failed = new Promise((resolve, reject) => {
      failureListener = (job) => {
        if (job?.id === inboxId) resolve(job);
      };
      errorListener = (error) => reject(error);
      worker.on("failed", failureListener);
      worker.on("error", errorListener);
    });

    await queue.add(
      "process",
      { inboxId },
      { jobId: inboxId, attempts: 1, removeOnFail: false },
    );
    await failed;
    await worker.pause();

    const retained = await queue.getJob(inboxId);
    assert.ok(retained, "the terminal failed job must still be retained");
    assert.equal(await retained.getState(), "failed");

    await enqueueWhatsAppMessage({ inboxId, queue });

    const replacement = await queue.getJob(inboxId);
    assert.ok(replacement, "enqueue must create a job after removing a retained terminal job");
    assert.equal(await replacement.getState(), "waiting");
    assert.equal((await replacement.getState()), "waiting");
  } finally {
    if (failureListener) worker.off("failed", failureListener);
    if (errorListener) worker.off("error", errorListener);
    await worker.close(true).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.all([
      queueConnection.quit().catch(() => undefined),
      workerConnection.quit().catch(() => undefined),
    ]);
  }
});
