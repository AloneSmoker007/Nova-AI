import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import logger from "../config/logger.js";

const QUEUE_NAME = "whatsapp-messages";
const MAX_ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 2000;

let redisConnection = null;
let messageQueue = null;
let messageWorker = null;

export function isQueueConfigured() {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}

function getRedisConnection() {
  if (!isQueueConfigured()) return null;
  if (redisConnection) return redisConnection;

  redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on("error", (error) => {
    logger.error({ error: error.message }, "Redis connection error");
  });

  return redisConnection;
}

export function getQueue() {
  if (!isQueueConfigured()) return null;
  if (messageQueue) return messageQueue;

  const connection = getRedisConnection();
  if (!connection) return null;

  messageQueue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: BACKOFF_DELAY_MS,
      },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  return messageQueue;
}

export async function enqueueWhatsAppMessage(payload) {
  if (!payload || !payload.id) {
    throw new Error("Payload must contain a message id");
  }

  const queue = getQueue();
  if (!queue) {
    throw new Error("Queue is not configured (REDIS_URL missing)");
  }

  const job = await queue.add("process-whatsapp-message", payload, {
    jobId: payload.id,
  });

  logger.info({ messageId: payload.id, jobId: job.id }, "Enqueued WhatsApp message to Redis queue");
  return job;
}

export function startWorker(processor) {
  if (!isQueueConfigured()) return null;
  if (messageWorker) return messageWorker;

  const connection = getRedisConnection();
  if (!connection) return null;

  const concurrency = Number(process.env.QUEUE_CONCURRENCY || 5);
  const rateMax = Number(process.env.QUEUE_RATE_MAX || 20);

  messageWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info({ jobId: job.id, messageId: job.data?.id, attempt: job.attemptsMade + 1 }, "Worker processing queued message");
      await processor(job.data, logger);
    },
    {
      connection,
      concurrency,
      limiter: {
        max: rateMax,
        duration: 1000,
      },
    },
  );

  messageWorker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, messageId: job?.data?.id, error: error.message, attempts: job?.attemptsMade },
      "Queued message job failed",
    );
  });

  messageWorker.on("completed", (job) => {
    logger.info({ jobId: job.id, messageId: job.data?.id }, "Queued message job completed");
  });

  logger.info({ concurrency, rateMax }, "BullMQ worker started successfully");
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
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
