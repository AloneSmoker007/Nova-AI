import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { logger } from "../config/logger.js";

const QUEUE_NAME = "whatsapp-messages";
const MAX_ATTEMPTS = 1;
const BACKOFF_MS = 2000;

let connection = null;
let messageQueue = null;
let messageWorker = null;

export function getConnection() {
  if (connection) return connection;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on("error", (err) => {
    logger.error({ error: err.message }, "Redis connection error");
  });

  return connection;
}

export function isQueueConfigured() {
  return Boolean(process.env.REDIS_URL);
}

export async function checkRedisConnection() {
  if (!isQueueConfigured()) {
    return { configured: false, connected: false };
  }

  const redis = getConnection();
  if (!redis) {
    return { configured: true, connected: false };
  }

  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis readiness timeout")), 3000)),
    ]);
    return { configured: true, connected: true };
  } catch {
    return { configured: true, connected: false };
  }
}

function validateInboxId(inboxId) {
  return typeof inboxId === "string" && inboxId.trim() !== "";
}

// BullMQ job states that must keep their jobId dedupe (a live job is left
// untouched). Anything else — completed, failed, unknown — must not suppress
// re-enqueue of the same job id, because removeOnComplete/removeOnFail retain
// terminal jobs and BullMQ's addJob dedupes silently on an existing jobId.
const LIVE_JOB_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

export async function enqueueWhatsAppMessage({ inboxId, queue } = {}) {
  if (!queue && !isQueueConfigured()) {
    throw new Error("Queue is not configured (REDIS_URL missing)");
  }

  if (!validateInboxId(inboxId)) {
    throw new Error("Invalid durable inbox job");
  }

  const normalizedInboxId = inboxId.trim();
  if (!messageQueue && !queue) {
    messageQueue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
    });
  }
  const targetQueue = queue ?? messageQueue;

  // A retained terminal job (see removeOnComplete/removeOnFail below) with the
  // same jobId would make the add() below a silent no-op and freeze durable
  // re-dispatch of this inbox message until retention expires. Remove terminal
  // jobs first so re-enqueue always works; live jobs keep their dedupe.
  const existing = await targetQueue.getJob(normalizedInboxId);
  if (existing) {
    const state = await existing.getState();
    if (LIVE_JOB_STATES.has(state)) return;
    try {
      await existing.remove();
    } catch {
      // Another dispatcher already removed it — safe to enqueue below.
    }
  }

  await targetQueue.add(
    "process",
    { inboxId: normalizedInboxId },
    {
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: BACKOFF_MS },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
      jobId: normalizedInboxId,
    },
  );
}

export function startWorker(processor) {
  if (!isQueueConfigured()) {
    logger.warn("Queue is not configured (REDIS_URL missing) — worker not started");
    return null;
  }

  if (messageWorker) return messageWorker;

  messageWorker = new Worker(
    QUEUE_NAME,
    async (job) => processor(job.data, job),
    {
      connection: getConnection(),
      concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
      limiter: {
        max: Number(process.env.QUEUE_RATE_MAX || 20),
        duration: 1000,
      },
    },
  );

  messageWorker.on("completed", (job) => {
    logger.info(
      { jobId: job.id, inboxId: job.data?.inboxId },
      "Queue job completed",
    );
  });

  messageWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        inboxId: job?.data?.inboxId,
        attempts: job?.attemptsMade,
        error: err?.message,
      },
      "Queue job failed",
    );
  });

  return messageWorker;
}

export async function closeQueue() {
  if (messageWorker) {
    await messageWorker.close();
    messageWorker = null;
  }

  if (messageQueue) {
    await messageQueue.close();
    messageQueue = null;
  }

  if (connection) {
    await connection.quit();
    connection = null;
  }
}
