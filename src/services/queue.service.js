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

function validateInboxId(inboxId) {
  return typeof inboxId === "string" && inboxId.trim() !== "";
}

export async function enqueueWhatsAppMessage({ inboxId }) {
  if (!isQueueConfigured()) {
    throw new Error("Queue is not configured (REDIS_URL missing)");
  }

  if (!validateInboxId(inboxId)) {
    throw new Error("Invalid durable inbox job");
  }

  const normalizedInboxId = inboxId.trim();
  if (!messageQueue) {
    messageQueue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
    });
  }

  await messageQueue.add(
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
