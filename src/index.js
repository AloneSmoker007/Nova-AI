import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import Joi from "joi";

import { checkDatabaseReadiness, closeDatabaseConnection, isDatabaseConfigured, dbPool } from "./config/database.js";
import { logger, createHttpLogger } from "./config/logger.js";
import { runMigrations } from "./database/migrate.js";
import { generateCopilotDraftReply, generateGeminiReply } from "./services/gemini.service.js";
import { inspectGeneratedAiOutput } from "./services/ai-output-safety.service.js";
import {
  isAmbiguousWhatsAppSendError,
  sendWhatsAppMessage,
} from "./services/whatsapp.service.js";
import { resolveTenantByPhoneNumberId, isTenantActive } from "./services/tenant.service.js";
import { decryptSecret } from "./services/secrets.service.js";
import { persistInboundMessage, persistOutboundMessage, persistDeletedInboundMessage, isInboundMessageDeleted } from "./services/message-persistence.service.js";
import { getBusinessBrain, upsertBusinessBrain } from "./services/business-brain.service.js";
import { analyzeCustomerMessage, buildAdvancedAiContext, getCustomerMemory, rememberCustomerPreference, recordAiSignal, syncCustomerMemoryFromMessage } from "./services/advanced-ai.service.js";
import { loginUser, getUserById, generateToken } from "./services/auth.service.js";
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from "./services/refresh-token.service.js";
import {
  enqueueWhatsAppMessage,
  isQueueConfigured,
  startWorker,
  closeQueue,
  checkRedisConnection,
} from "./services/queue.service.js";
import {
  ingestWebhookMessage,
  getInboxMessage,
  claimInboxMessage,
  markQueueDispatched,
  reserveQueueDispatch,
  markRetry,
  saveGeneratedResponse,
  recordProviderMessageId,
  markCompleted,
  findUndispatchedMessages,
  recoverExpiredLeases,
  listDeadLetterMessages,
  requeueDeadLetterMessage,
} from "./services/webhook-inbox.service.js";
import {
  claimDelivery,
  deliveryStatusToMessageStatus,
  failExhaustedDeliveries,
  findDeliveriesMissingOutboundMessage,
  findRecoverableDeliveries,
  getDelivery,
  markDeliveryFailed,
  markDeliveryRequestStarted,
  markDeliverySent,
  markDeliveryStatus,
  markDeliveryUnknown,
  markExpiredAmbiguousDeliveries,
  prepareDelivery,
  syncDeliveryToMessage,
} from "./services/whatsapp-delivery.service.js";
import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";
import { registerInboundUsage, getUsageSummary, reserveAiUsage, commitAiUsage, releaseAiUsage } from "./services/usage.service.js";
import { listConversations, getConversationMessages, updateConversation, markConversationRead, addConversationNote, setConversationTags } from "./services/conversation.service.js";
import { getHandoffState, handoffConversation, pauseAi, resumeAi, assignConversationRoundRobin, saveCopilotDraft, listCopilotDrafts, getLatestHandoffSummary, buildCopilotContext, setUserSkills } from "./services/handoff.service.js";
import { createWorkflow, listWorkflows, setWorkflowStatus, startWorkflowRun, triggerWorkflows, processDueWorkflowRuns, scheduleInactivityTriggers, listUnknownWorkflowWebhookEffects, resolveUnknownWorkflowWebhookEffect } from "./services/automation.service.js";
import { createAppointmentType, listAppointmentTypes, setBusinessHours, getBusinessHours, listAppointments, getAppointment, bookAppointment, updateAppointmentStatus, buildCalendarLinks, buildIcs } from "./services/appointment.service.js";
import { startRetentionScheduler } from "./services/retention.service.js";
import { getDashboardSummary } from "./services/dashboard.service.js";
import { listContacts } from "./services/contact.service.js";
import { listPayments } from "./services/payment.service.js";
import { registerTask16Routes } from "./task16.routes.js";
import { getServerPort } from "./config/server.js";
import { getTrustProxySetting } from "./config/trust-proxy.js";

const app = express();
const PORT = getServerPort();
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
let startupComplete = false;
let stopRetentionSchedulerHandle = null;

const REQUIRED_ENV_VARS = [
  "GEMINI_API_KEY",
  "WEBHOOK_VERIFY_TOKEN",
  "META_APP_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  ...(IS_PRODUCTION ? ["DATABASE_URL", "JWT_SECRET"] : []),
];

const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim());
if (missingEnvVars.length > 0) {
  const message = `Missing required environment variables: ${missingEnvVars.join(", ")}`;
  if (IS_PRODUCTION) throw new Error(message);
  console.warn(message);
}

const httpLogger = createHttpLogger(logger);

app.disable("x-powered-by");
app.set("trust proxy", getTrustProxySetting());
app.use(helmet());
app.use(compression());
app.use(httpLogger);

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", error: "Too many login attempts. Please try again later." },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", error: "Too many refresh attempts. Please try again later." },
});

// Development-only Gemini diagnostics can incur provider cost. Keep the route
// unavailable to anonymous users and tightly limit each source IP.
const geminiTestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", error: "Too many AI diagnostic requests. Please try again later." },
});

app.use(express.json({
  limit: "100kb",
  verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

app.get("/", (req, res) => res.status(200).json({ status: "ok", service: "Nova-AI", message: "Nova-AI server is running" }));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", service: "Nova-AI", uptime: process.uptime() }));

app.get("/ready", async (req, res) => {
  try {
    if (!startupComplete) {
      return res.status(503).json({ status: "not_ready", service: "Nova-AI", startup: "starting" });
    }

    const database = await checkDatabaseReadiness();
    if (!database.configured) {
      return res.status(IS_PRODUCTION ? 503 : 200).json({
        status: IS_PRODUCTION ? "not_ready" : "ready",
        service: "Nova-AI",
        database: "not_configured",
      });
    }
    if (!database.connected) {
      return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "disconnected" });
    }

    const redis = await checkRedisConnection();
    if (redis.configured && !redis.connected) {
      return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "connected", redis: "disconnected" });
    }

    return res.status(200).json({
      status: "ready",
      service: "Nova-AI",
      database: "connected",
      ...(redis.configured ? { redis: "connected" } : {}),
    });
  } catch (error) {
    req.log.error({ error: error.message }, "Readiness check failed");
    return res.status(503).json({ status: "not_ready", service: "Nova-AI", dependency: "error" });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN && challenge) {
    logger.info("WhatsApp webhook verification successful");
    return res.status(200).send(challenge);
  }
  logger.warn("WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

app.post("/webhook", webhookLimiter, async (req, res, next) => {
  if (!verifyMetaSignature(req)) {
    req.log.warn("Rejected WhatsApp webhook: invalid signature");
    return res.sendStatus(403);
  }

  const { messages, deletedMessages, statuses } = extractWebhookEvents(req.body);
  if (messages.length === 0 && deletedMessages.length === 0 && statuses.length === 0) return res.sendStatus(200);

  try {
    for (const status of statuses) {
      const tenant = await resolveTenantByPhoneNumberId(status.phoneNumberId);
      if (!tenant) {
        req.log.warn(
          { providerMessageId: status.id, phoneNumberId: status.phoneNumberId },
          "Ignoring WhatsApp status: no active tenant mapping",
        );
        continue;
      }

      const delivery = await markDeliveryStatus({
        tenantId: tenant.tenantId,
        phoneNumberId: status.phoneNumberId,
        providerMessageId: status.id,
        callbackData: status.callbackData,
        status: status.status,
        timestamp: status.timestamp,
        recipientId: status.recipientId,
        errors: status.errors,
      });

      if (delivery) {
        await syncDeliveryToMessage(delivery.id, tenant.tenantId);
        req.log.info(
          {
            deliveryId: delivery.id,
            providerMessageId: status.id,
            status: deliveryStatusToMessageStatus(delivery.state),
            tenantId: tenant.tenantId,
          },
          "WhatsApp delivery status reconciled",
        );
      }
    }

    for (const deletedMessage of deletedMessages) {
      const tenant = await resolveTenantByPhoneNumberId(deletedMessage.phoneNumberId);
      if (!tenant) {
        req.log.warn(
          { messageId: deletedMessage.id, phoneNumberId: deletedMessage.phoneNumberId },
          "Ignoring WhatsApp deletion: no active tenant mapping",
        );
        continue;
      }

      const preserved = await persistDeletedInboundMessage({
        tenantId: tenant.tenantId,
        whatsappNumberId: tenant.whatsappNumberId,
        waId: deletedMessage.from,
        profileName: deletedMessage.profileName,
        whatsappMessageId: deletedMessage.id,
        deletedAt: deletedMessage.timestamp,
      });

      req.log.info(
        {
          tenantId: tenant.tenantId,
          conversationId: preserved.conversationId,
          messageId: preserved.messageId,
          whatsappMessageId: deletedMessage.id,
        },
        "WhatsApp message deletion preserved as durable history",
      );
    }

    for (const message of messages) {
      const tenant = await resolveTenantByPhoneNumberId(message.phoneNumberId);
      if (!tenant) {
        req.log.warn(
          { messageId: message.id, phoneNumberId: message.phoneNumberId },
          "Ignoring WhatsApp message: no active tenant mapping",
        );
        continue;
      }
      const inboxMessage = await ingestWebhookMessage({ message, tenant });
      // The retained canonical-message guard may mark a replay COMPLETED on
      // insertion. It must not launch automation side effects a second time.
      if (inboxMessage.state !== "COMPLETED" && inboxMessage.is_new_delivery !== false) {
        // Duplicate provider deliveries can return an existing RECEIVED or
        // PROCESSING inbox row. Only the INSERT winner may create automation
        // runs; inbox processing itself remains independently lease-fenced.
        await triggerWorkflows({
          tenantId: tenant.tenantId,
          triggerType: "message_received",
          context: {
            message: {
              id: message.id,
              from: message.from,
              type: inboxMessage.message_type,
              body: inboxMessage.body,
            },
            inboxId: inboxMessage.id,
          },
        });
      }
    }
  } catch (error) {
    req.log.error({ error: error.message }, "Failed to durably process WhatsApp webhook");
    return next(error);
  }

  res.sendStatus(200);
  setImmediate(() => {
    void dispatchPendingInboxMessages();
  });
});

function verifyMetaSignature(req) {
  if (!META_APP_SECRET || !req.rawBody) return false;
  const signature = req.get("x-hub-signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expectedSignature = `sha256=${crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex")}`;
  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function extractWebhookEvents(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const messages = [];
  const statuses = [];
  const deletedMessages = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;

      if (typeof phoneNumberId !== "string" || !/^\d{5,30}$/.test(phoneNumberId)) {
        continue;
      }

      if (Array.isArray(value?.messages)) {
        for (const message of value.messages) {
          if (!message?.from || !message?.id) continue;

          if (
            message.type === "unsupported" &&
            Array.isArray(message.errors) &&
            message.errors.some((item) => item?.code === 131051)
          ) {
            const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
            if (!Number.isNaN(timestamp.getTime())) {
              deletedMessages.push({
                id: message.id,
                from: message.from,
                profileName: value?.contacts?.[0]?.profile?.name,
                phoneNumberId,
                timestamp,
              });
            }
            continue;
          }

          // Preserve supported non-text events too. The inbox stores type and
          // caption/placeholder; binary media is not downloaded here.
          messages.push({
            ...message,
            phoneNumberId,
            profileName: value?.contacts?.find((contact) => contact?.wa_id === message.from)?.profile?.name,
          });
        }
      }

      if (Array.isArray(value?.statuses)) {
        for (const status of value.statuses) {
          if (!status?.id || !status?.status) continue;
          statuses.push({
            ...status,
            phoneNumberId,
            callbackData: status.biz_opaque_callback_data,
            recipientId: status.recipient_id,
          });
        }
      }
    }
  }

  return { messages, deletedMessages, statuses };
}

function requireSafeAutomaticReply(value) {
  const decision = inspectGeneratedAiOutput(value);
  if (!decision.safe) {
    const error = new Error("Automatic AI reply suppressed: cached output failed safety policy");
    error.code = "UNSAFE_AI_REPLY";
    error.outputSafetyReason = decision.reason;
    throw error;
  }
  return value.trim();
}

async function processInboxMessage(inboxId, log = logger) {
  const inbox = await getInboxMessage(inboxId);
  if (!inbox) return;

  const tenantId = inbox.tenant_id;
  const claim = await claimInboxMessage(inboxId, tenantId);
  if (!claim.claimed) {
    if (claim.reason !== "processing") {
      log.info({ inboxId, tenantId, reason: claim.reason }, "Skipping durable inbox message");
    }
    return;
  }

  const { leaseToken, stopHeartbeat, message } = claim;

  try {
    const tenant = await resolveTenantByPhoneNumberId(message.phone_number_id);
    if (
      !tenant ||
      tenant.tenantId !== message.tenant_id ||
      tenant.whatsappNumberId !== message.whatsapp_number_id
    ) {
      throw new Error("Stored webhook tenant mapping is no longer valid");
    }

    const persistedInbound = await persistInboundMessage({
      tenantId: message.tenant_id,
      whatsappNumberId: message.whatsapp_number_id,
      waId: message.wa_id,
      profileName: message.profile_name,
      whatsappMessageId: message.whatsapp_message_id,
      messageType: message.message_type,
      body: message.body,
      receivedAt: message.received_at,
    });

    // Provider message IDs are tenant-scoped identities. Reject a conflicting
    // duplicate before touching customer memory, AI usage, signals or replies.
    if (persistedInbound.identityConflict) {
      log.warn(
        {
          inboxId: message.id,
          tenantId: message.tenant_id,
          whatsappMessageId: message.whatsapp_message_id,
        },
        "Rejected conflicting duplicate WhatsApp message identity",
      );
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      return;
    }

    // A delete notification can race with a queued/retried inbound job. Never
    // let a previously deleted message recreate memory, signals or an AI reply.
    if (persistedInbound.deleted || await isInboundMessageDeleted(message.tenant_id, persistedInbound.messageId)) {
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.info(
        { inboxId: message.id, tenantId: message.tenant_id, whatsappMessageId: message.whatsapp_message_id },
        "Skipped deleted inbound message",
      );
      return;
    }

    if (!persistedInbound.duplicate) {
      await registerInboundUsage({
        tenantId: message.tenant_id,
        conversationId: persistedInbound.conversationId,
        messageId: persistedInbound.messageId,
        whatsappMessageId: message.whatsapp_message_id,
        occurredAt: message.received_at,
      });
    }

    // Non-text events are durable history for a human agent. Do not pass media
    // placeholders into customer memory, Gemini, or the outbound auto-reply path.
    if (message.message_type !== "text") {
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.info(
        {
          inboxId: message.id,
          tenantId: message.tenant_id,
          conversationId: persistedInbound.conversationId,
          messageType: message.message_type,
        },
        "Non-text inbound stored for human review; automatic AI reply skipped",
      );
      return;
    }

    // Memory persistence intentionally runs on every processing attempt, including
    // duplicate webhook deliveries. If a previous attempt stored the message but
    // failed before saving memory, the durable inbox retry repairs the missing memory.
    if (persistedInbound.contactId) {
      const savedMemories = await syncCustomerMemoryFromMessage({
        tenantId: message.tenant_id,
        contactId: persistedInbound.contactId,
        messageText: message.body,
        sourceMessageId: persistedInbound.messageId,
      });
      if (savedMemories.length > 0) {
        log.info(
          {
            inboxId: message.id,
            tenantId: message.tenant_id,
            contactId: persistedInbound.contactId,
            memoryKeys: savedMemories.map((item) => item.memory_key),
          },
          "Customer AI memory synchronized from inbound message",
        );
      }
    }

    const handoffState = await getHandoffState(message.tenant_id, persistedInbound.conversationId);
    if (handoffState?.ai_paused) {
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.info({ inboxId: message.id, tenantId: message.tenant_id, conversationId: persistedInbound.conversationId }, "AI paused; message left for human agent");
      return;
    }

    if (!tenant.accessTokenEncrypted && !message.provider_message_id) {
      throw new Error("Tenant WhatsApp credentials are not configured");
    }

    let reply = message.generated_response;
    if (!reply) {
      // Hard usage limit gate — runs before any AI context work or the Gemini
      // call. reserveAiUsage atomically checks the tenant's monthly ai_message
      // limit (tenant-row serialization prevents concurrent overshoot) and
      // reserves the ai_message usage event idempotently per WhatsApp message;
      // the reservation itself is the metering record.
      let aiReservation;
      try {
        aiReservation = await reserveAiUsage({
          tenantId: message.tenant_id,
          conversationId: persistedInbound.conversationId,
          messageId: persistedInbound.messageId,
          whatsappMessageId: message.whatsapp_message_id,
        });
      } catch (usageError) {
        log.error({ error: usageError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to check AI usage limit");
        throw usageError;
      }

      if (aiReservation.inProgress) {
        const reservationBusy = new Error("AI generation reservation is already active; retry later");
        reservationBusy.code = "AI_RESERVATION_IN_PROGRESS";
        throw reservationBusy;
      }

      // A committed reservation with no saved response means Gemini may have
      // been charged but the durable response was not recorded. Do not invoke
      // Gemini again on a durable-inbox retry; leave the conversation for a
      // human rather than creating an unmetered duplicate provider call.
      if (aiReservation.committed && !message.generated_response) {
        await markCompleted(message.id, message.tenant_id, leaseToken, null);
        log.warn(
          { inboxId: message.id, tenantId: message.tenant_id, conversationId: persistedInbound.conversationId },
          "AI usage was already committed without a saved reply; handed off for manual review",
        );
        return;
      }

      if (!aiReservation.allowed) {
        // Same safe fallback as the AI-paused path: no reply is sent, nothing
        // pretends an AI response went out, the message stays visible in the
        // shared inbox for a human agent, and AI resumes automatically when
        // usage frees up (new month, raised limit, or hard limit disabled).
        await markCompleted(message.id, message.tenant_id, leaseToken, null);
        log.warn(
          {
            inboxId: message.id,
            tenantId: message.tenant_id,
            conversationId: persistedInbound.conversationId,
            used: aiReservation.used,
            limit: aiReservation.limit,
          },
          "AI usage hard limit reached; message left for human agent",
        );
        return;
      }

      let providerCallStarted = false;
      try {
        let brain = null;
        try {
          brain = await getBusinessBrain(message.tenant_id);
        } catch (brainError) {
          log.error(
            { error: brainError.message, tenantId: message.tenant_id, inboxId: message.id },
            "Failed to load Business Brain, falling back to default",
          );
        }

        const signal = await analyzeCustomerMessage(message.body, brain);
        try {
          await recordAiSignal(message.tenant_id, persistedInbound.conversationId, persistedInbound.messageId, signal);
        } catch (signalError) {
          log.warn({ error: signalError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to persist AI signal");
        }

        let memories = [];
        if (persistedInbound.contactId) {
          try {
            memories = await getCustomerMemory(message.tenant_id, persistedInbound.contactId);
          } catch (memoryError) {
            log.warn({ error: memoryError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to load customer AI memory");
          }
        }

        const advancedContext = buildAdvancedAiContext({ signal, memories, businessBrain: brain });
        // Keep derived signals and saved customer memory in a distinct data
        // field; never merge runtime/customer context into owner instructions.
        const aiBrain = brain
          ? { ...brain, advancedContext }
          : { advancedContext };

        // After dispatch, provider spend may have occurred even if the
        // request errors or the customer deletes the source message.
        providerCallStarted = true;
        reply = await generateGeminiReply(message.body, aiBrain);

        // Recheck after the provider call. If Meta's deletion webhook landed
        // while Gemini was generating, do not persist/send its text, but retain
        // the usage charge because provider work has already occurred.
        if (await isInboundMessageDeleted(message.tenant_id, persistedInbound.messageId)) {
          try {
            await commitAiUsage({
              tenantId: message.tenant_id,
              eventKey: aiReservation.eventKey,
              reservationToken: aiReservation.reservationToken,
            });
          } catch (commitError) {
            log.warn(
              { error: commitError.message, tenantId: message.tenant_id, inboxId: message.id },
              "Deleted source prevented reply persistence; provider usage remains for reconciliation",
            );
          }
          await markCompleted(message.id, message.tenant_id, leaseToken, null);
          return;
        }

        reply = await saveGeneratedResponse(message.id, message.tenant_id, leaseToken, reply);

        // Persisting the generated response is the durable success boundary.
        // Failure to clear reservation metadata must not release a billable
        // successful generation; the reconciler can finalize it from this row.
        if (aiReservation.reservationToken) {
          try {
            await commitAiUsage({
              tenantId: message.tenant_id,
              eventKey: aiReservation.eventKey,
              reservationToken: aiReservation.reservationToken,
            });
          } catch (commitError) {
            log.warn(
              { tenantId: message.tenant_id, inboxId: message.id, error: commitError.message },
              "AI reply saved but reservation finalization will be reconciled",
            );
          }
        }
      } catch (aiError) {
        if (providerCallStarted) {
          // Gemini may have processed the request even if generation or saving
          // failed. Conservatively count the operation rather than allowing a
          // durable-inbox retry to incur unmetered provider spend.
          try {
            await commitAiUsage({
              tenantId: message.tenant_id,
              eventKey: aiReservation.eventKey,
              reservationToken: aiReservation.reservationToken,
            });
          } catch (commitError) {
            log.warn(
              { error: commitError.message, tenantId: message.tenant_id, inboxId: message.id },
              "AI provider may have been charged; usage reservation remains for reconciliation",
            );
          }
        } else {
          // Failures during local context preparation happen before dispatch
          // and can safely release the reservation for a retry.
          try {
            await releaseAiUsage({
              tenantId: message.tenant_id,
              messageId: persistedInbound.messageId,
              whatsappMessageId: message.whatsapp_message_id,
              eventKey: aiReservation.eventKey,
              reservationToken: aiReservation.reservationToken,
            });
          } catch (releaseError) {
            log.warn(
              { error: releaseError.message, tenantId: message.tenant_id, inboxId: message.id },
              "Failed to release pre-provider AI usage reservation",
            );
          }
        }
        throw aiError;
      }
    }

    if (await isInboundMessageDeleted(message.tenant_id, persistedInbound.messageId)) {
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.info(
        { inboxId: message.id, tenantId: message.tenant_id, whatsappMessageId: message.whatsapp_message_id },
        "Skipped reply after inbound message deletion",
      );
      return;
    }

    // Stored replies may predate the current output policy. Re-authorize an
    // unsent cached result before copying it into a new delivery intent.
    if (!message.provider_message_id) requireSafeAutomaticReply(reply);

    if (message.provider_message_id) {
      const accepted = await dbPool.query(
        `SELECT id, body, last_attempt_at FROM whatsapp_deliveries
         WHERE tenant_id=$1 AND inbox_message_id=$2 AND provider_message_id=$3 LIMIT 1`,
        [message.tenant_id, message.id, message.provider_message_id],
      );
      const actualDelivery = accepted.rows[0];
      await persistOutboundMessage({
        tenantId: message.tenant_id,
        conversationId: persistedInbound.conversationId,
        whatsappMessageId: message.provider_message_id,
        messageType: "text",
        body: actualDelivery ? actualDelivery.body.trim() : reply,
        sentAt: actualDelivery?.last_attempt_at || new Date(),
        deliveryId: actualDelivery?.id,
      });
      await markCompleted(message.id, message.tenant_id, leaseToken, message.provider_message_id);
      return;
    }

    const delivery = await prepareDelivery({
      tenantId: message.tenant_id,
      inboxMessageId: message.id,
      conversationId: persistedInbound.conversationId,
      recipientWaId: message.wa_id,
      body: reply,
    });

    const deliveryClaim = await claimDelivery(delivery.id, message.tenant_id);

    if (!deliveryClaim.claimed) {
      const currentDelivery = await getDelivery(delivery.id, message.tenant_id);

      if (
        currentDelivery?.provider_message_id &&
        ["SENT", "DELIVERED", "READ", "FAILED"].includes(currentDelivery.state)
      ) {
        await persistOutboundMessage({
          tenantId: message.tenant_id,
          conversationId: persistedInbound.conversationId,
          whatsappMessageId: currentDelivery.provider_message_id,
          messageType: "text",
          body: currentDelivery.body.trim(),
          sentAt: currentDelivery.last_attempt_at || new Date(),
          deliveryId: currentDelivery.id,
        });
      }

      await markCompleted(
        message.id,
        message.tenant_id,
        leaseToken,
        currentDelivery?.provider_message_id || null,
      );
      log.info(
        { inboxId: message.id, deliveryId: delivery.id, reason: deliveryClaim.reason },
        "Durable delivery already owned by delivery subsystem",
      );
      return;
    }

    const accessToken = decryptSecret(tenant.accessTokenEncrypted);

    try {
      // A retained delivery body can differ from the inbox's cached response.
      // Validate the exact payload to be sent before recording request-start.
      const outboundBody = requireSafeAutomaticReply(deliveryClaim.delivery.body);
      await markDeliveryRequestStarted(
        delivery.id,
        message.tenant_id,
        deliveryClaim.leaseToken,
        deliveryClaim.delivery.attempt_count,
      );
      const sentMessage = await sendWhatsAppMessage({
        to: deliveryClaim.delivery.recipient_wa_id,
        message: outboundBody,
        accessToken,
        phoneNumberId: tenant.phoneNumberId,
        callbackData: deliveryClaim.delivery.delivery_key,
      });

      const providerMessageId = sentMessage?.messages?.[0]?.id;
      if (!providerMessageId || typeof providerMessageId !== "string") {
        throw new Error("WhatsApp API returned no message ID");
      }

      const completedDelivery = await markDeliverySent(
        delivery.id,
        message.tenant_id,
        deliveryClaim.leaseToken,
        providerMessageId,
        deliveryClaim.delivery.attempt_count,
      );

      await recordProviderMessageId(
        message.id,
        message.tenant_id,
        leaseToken,
        providerMessageId,
      );

      await persistOutboundMessage({
        tenantId: message.tenant_id,
        conversationId: persistedInbound.conversationId,
        whatsappMessageId: providerMessageId,
        messageType: "text",
        body: outboundBody,
        sentAt: new Date(),
        deliveryId: completedDelivery.id,
      });

      await markCompleted(message.id, message.tenant_id, leaseToken, providerMessageId);
      log.info(
        { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },
        "WhatsApp reply accepted by provider",
      );
    } catch (sendError) {
      if (isAmbiguousWhatsAppSendError(sendError)) {
        await markDeliveryUnknown(
          delivery.id,
          message.tenant_id,
          deliveryClaim.leaseToken,
          sendError,
          deliveryClaim.delivery.attempt_count,
        );
        await markCompleted(message.id, message.tenant_id, leaseToken, null);
        log.warn(
          { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },
          "WhatsApp send outcome is ambiguous; delivery recovery owns retry",
        );
        return;
      }

      await markDeliveryFailed(
        delivery.id,
        message.tenant_id,
        deliveryClaim.leaseToken,
        sendError,
        deliveryClaim.delivery.attempt_count,
      );
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.warn(
        { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },
        "WhatsApp delivery failed definitively",
      );
      return;
    }
  } catch (error) {
    if (error.code === "UNSAFE_AI_REPLY") {
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.warn(
        { inboxId: message.id, tenantId: message.tenant_id, reason: error.outputSafetyReason },
        "Unsafe cached AI reply left unsent for human review",
      );
      return;
    }
    const retryState = await markRetry(message.id, message.tenant_id, leaseToken, error);
    if (!retryState) {
      log.warn({ inboxId: message.id, tenantId: message.tenant_id }, "Unable to update durable inbox failure state");
    }
    log.error({ error: error.message, inboxId: message.id, tenantId: message.tenant_id }, "WhatsApp message processing failed");
    throw error;
  } finally {
    if (typeof stopHeartbeat === "function") {
      stopHeartbeat();
    }
  }
}

async function recoverPendingDeliveries() {
  try {
    // A stale lease after a provider request started is ambiguous: WhatsApp
    // may have accepted the send even if the worker died before persisting its
    // response. Mark it UNKNOWN and wait for the provider callback instead of
    // blindly sending the customer a duplicate message.
    const ambiguous = await markExpiredAmbiguousDeliveries(50);
    if (ambiguous.length > 0) {
      logger.warn(
        { count: ambiguous.length, deliveryIds: ambiguous.map((row) => row.id) },
        "WhatsApp delivery outcome uncertain after expired request lease",
      );
    }

    await failExhaustedDeliveries();
    const pending = await findRecoverableDeliveries(50);

    for (const row of pending) {
      try {
        const delivery = await getDelivery(row.id, row.tenant_id);
        if (!delivery) continue;

        const claim = await claimDelivery(delivery.id, delivery.tenant_id);
        if (!claim.claimed) continue;

        const inbox = delivery.inbox_message_id
          ? await getInboxMessage(delivery.inbox_message_id, delivery.tenant_id)
          : null;

        let phoneNumberId = inbox?.phone_number_id;
        if (!phoneNumberId && delivery.automation_run_id) {
          const automation = await dbPool.query(
            `SELECT wn.phone_number_id
             FROM automation_runs ar
             JOIN conversations c ON c.tenant_id = ar.tenant_id AND c.id = ar.conversation_id
             JOIN whatsapp_numbers wn ON wn.tenant_id = c.tenant_id AND wn.id = c.whatsapp_number_id
             WHERE ar.tenant_id = $1 AND ar.id = $2 LIMIT 1`,
            [delivery.tenant_id, delivery.automation_run_id],
          );
          phoneNumberId = automation.rows[0]?.phone_number_id;
        }

        if (!phoneNumberId) {
          await markDeliveryFailed(delivery.id, delivery.tenant_id, claim.leaseToken, new Error("Unable to resolve WhatsApp number for delivery"), claim.delivery.attempt_count);
          continue;
        }

        const tenant = await resolveTenantByPhoneNumberId(phoneNumberId);
        if (!tenant || tenant.tenantId !== delivery.tenant_id) {
          await markDeliveryFailed(
            delivery.id,
            delivery.tenant_id,
            claim.leaseToken,
            new Error("Stored WhatsApp delivery tenant mapping is no longer valid"),
            claim.delivery.attempt_count,
          );
          continue;
        }

        const accessToken = decryptSecret(tenant.accessTokenEncrypted);

        try {
          const outboundBody = delivery.inbox_message_id
            ? requireSafeAutomaticReply(delivery.body)
            : delivery.body.trim();
          await markDeliveryRequestStarted(
            delivery.id,
            delivery.tenant_id,
            claim.leaseToken,
            claim.delivery.attempt_count,
          );
          const sentMessage = await sendWhatsAppMessage({
            to: delivery.recipient_wa_id,
            message: outboundBody,
            accessToken,
            phoneNumberId: tenant.phoneNumberId,
            callbackData: delivery.delivery_key,
          });

          const providerMessageId = sentMessage?.messages?.[0]?.id;
          if (!providerMessageId || typeof providerMessageId !== "string") {
            throw new Error("WhatsApp API returned no message ID");
          }

          const completedDelivery = await markDeliverySent(
            delivery.id,
            delivery.tenant_id,
            claim.leaseToken,
            providerMessageId,
            claim.delivery.attempt_count,
          );

          await persistOutboundMessage({
            tenantId: delivery.tenant_id,
            conversationId: delivery.conversation_id,
            whatsappMessageId: providerMessageId,
            messageType: "text",
            body: outboundBody,
            sentAt: new Date(),
            deliveryId: completedDelivery.id,
          });

          await syncDeliveryToMessage(completedDelivery.id, delivery.tenant_id);
        } catch (sendError) {
          if (isAmbiguousWhatsAppSendError(sendError)) {
            await markDeliveryUnknown(
              delivery.id,
              delivery.tenant_id,
              claim.leaseToken,
              sendError,
              claim.delivery.attempt_count,
            );
          } else {
            await markDeliveryFailed(
              delivery.id,
              delivery.tenant_id,
              claim.leaseToken,
              sendError,
              claim.delivery.attempt_count,
            );
          }
        }
      } catch (error) {
        logger.error(
          { error: error.message, deliveryId: row.id, tenantId: row.tenant_id },
          "Failed to recover WhatsApp delivery",
        );
      }
    }

    // Repair the durable conversation history after a successful provider send.
    // If a worker crashed after persisting the delivery's provider ID but before
    // inserting the outbound message row, backfill it idempotently; never send it
    // again because these rows are already in a terminal delivery state.
    const missingMessages = await findDeliveriesMissingOutboundMessage(50);
    for (const row of missingMessages) {
      try {
        await persistOutboundMessage({
          tenantId: row.tenant_id,
          conversationId: row.conversation_id,
          whatsappMessageId: row.provider_message_id,
          messageType: "text",
          body: row.body.trim(),
          sentAt: row.last_attempt_at || row.created_at || new Date(),
          deliveryId: row.id,
        });
        await syncDeliveryToMessage(row.id, row.tenant_id);
      } catch (error) {
        logger.error(
          { error: error.message, deliveryId: row.id, tenantId: row.tenant_id },
          "Failed to reconcile outbound message history from a terminal delivery",
        );
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "WhatsApp delivery recovery pass failed");
  }
}

async function dispatchPendingInboxMessages() {
  if (recoveryPassPromise) return recoveryPassPromise;

  recoveryPassPromise = (async () => {
    try {
    await recoverExpiredLeases();
    await recoverPendingDeliveries();
    await scheduleInactivityTriggers(100);
    await processDueWorkflowRuns(20);
    const pending = await findUndispatchedMessages(50);

    for (const row of pending) {
      try {
        if (isQueueConfigured()) {
          const reserved = await reserveQueueDispatch(row.id, row.tenant_id);
          if (!reserved) continue;
          try {
            await enqueueWhatsAppMessage({ inboxId: row.id });
          } catch (error) {
            logger.error(
              { error: error.message, inboxId: row.id, tenantId: row.tenant_id },
              "Failed to enqueue reserved durable inbox message",
            );
            continue;
          }
          await markQueueDispatched(row.id, row.tenant_id);
        } else {
          await processInboxMessage(row.id, logger);
        }
      } catch (error) {
        logger.error(
          { error: error.message, inboxId: row.id, tenantId: row.tenant_id },
          "Failed to recover durable inbox message",
        );
      }
    }
    } catch (error) {
      logger.error({ error: error.message }, "Durable inbox recovery pass failed");
    }
  })();

  try {
    return await recoveryPassPromise;
  } finally {
    recoveryPassPromise = null;
  }
}

let recoveryTimer = null;
let recoveryPassPromise = null;

function startInboxRecovery() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    void dispatchPendingInboxMessages();
  }, 10_000);
  recoveryTimer.unref();
  void dispatchPendingInboxMessages();
}

async function stopInboxRecovery() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  if (recoveryPassPromise) {
    await recoveryPassPromise;
  }
}

const loginSchema = Joi.object({ email: Joi.string().email().max(255).required(), password: Joi.string().min(8).max(128).required() });
const refreshSchema = Joi.object({ refreshToken: Joi.string().trim().min(20).max(512).required() });

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ status: "error", error: "Invalid request" });
    const result = await loginUser(value.email, value.password);
    const refreshToken = await issueRefreshToken(result.user.id, result.user.tenantId, result.tokenVersion);
    return res.status(200).json({ status: "ok", token: result.token, refreshToken, user: result.user });
  } catch (error) {
    if (error.message === "Invalid credentials") return res.status(401).json({ status: "error", error: "Invalid credentials" });
    next(error);
  }
});

app.post("/api/auth/refresh", refreshLimiter, async (req, res) => {
  const { error, value } = refreshSchema.validate(req.body);
  if (error) return res.status(400).json({ status: "error", error: "Invalid request" });

  try {
    const rotatedToken = await rotateRefreshToken(value.refreshToken);
    if (!rotatedToken) return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
    const user = await getUserById(rotatedToken.userId, rotatedToken.tenantId);
    if (!user || user.status !== "active" || !(await isTenantActive(rotatedToken.tenantId))) return res.status(401).json({ status: "error", error: "Account is inactive" });
    // A credential/logout change may race with rotation. A rotated token keeps
    // its original version; never mint a new-version access JWT from it.
    if (user.token_version !== rotatedToken.tokenVersion) return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
    const token = generateToken(user);
    return res.status(200).json({ status: "ok", token, refreshToken: rotatedToken.refreshToken, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });
  } catch (error) {
    req.log.error({ error: error.message }, "Refresh token request failed");
    return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const { error, value } = refreshSchema.validate(req.body);
  if (error) return res.status(400).json({ status: "error", error: "Invalid request" });
  try {
    const revoked = await revokeRefreshToken(value.refreshToken);
    if (!revoked) {
      return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
    }
    return res.sendStatus(204);
  } catch (error) {
    req.log.error({ error: error.message }, "Logout request failed");
    return res.status(503).json({ status: "error", error: "Logout could not be completed" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id, req.user.tenantId);
    if (!user || user.status !== "active") return res.status(401).json({ status: "error", error: "Invalid or expired token" });
    return res.status(200).json({ status: "ok", user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });
  } catch {
    return res.status(401).json({ status: "error", error: "Invalid or expired token" });
  }
});

app.get("/api/dashboard/summary", requireAuth, async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await getDashboardSummary(req.user.tenantId) }); }
  catch (error) { return next(error); }
});

app.get("/api/contacts", requireAuth, async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await listContacts(req.user.tenantId, { search: req.query.search, limit: req.query.limit, offset: req.query.offset }) }); }
  catch (error) { return next(error); }
});

app.get("/api/payments", requireAuth, async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await listPayments(req.user.tenantId, { status: req.query.status, limit: req.query.limit, offset: req.query.offset }) }); }
  catch (error) { return next(error); }
});

app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const summary = await getUsageSummary(req.user.tenantId);
    return res.status(200).json({ status: "ok", data: summary });
  } catch (error) {
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to fetch usage summary");
    return res.status(500).json({ status: "error", error: "Failed to fetch usage summary" });
  }
});

app.get(
  "/api/webhook-inbox/dead-letters",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const data = await listDeadLetterMessages(req.user.tenantId, req.query.limit);
      return res.status(200).json({ status: "ok", data });
    } catch (error) {
      if (error.message.startsWith("Invalid")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  },
);

app.post(
  "/api/webhook-inbox/dead-letters/:inboxId/retry",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res, next) => {
    try {
      const data = await requeueDeadLetterMessage(
        req.params.inboxId,
        req.user.tenantId,
        req.user.id,
        req.body?.reason,
      );
      if (!data) {
        return res.status(409).json({
          status: "error",
          error: "Message is not eligible for manual retry or the retry limit was reached",
        });
      }

      req.log.info(
        {
          tenantId: req.user.tenantId,
          inboxId: data.id,
          actorUserId: req.user.id,
          manualRetryCount: data.manual_retry_count,
        },
        "Dead-letter webhook message manually requeued",
      );
      return res.status(202).json({ status: "ok", data });
    } catch (error) {
      if (error.message.startsWith("Invalid")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  },
);

app.get("/api/conversations", requireAuth, async (req, res, next) => {
  try {
    const data = await listConversations(req.user.tenantId, {
      search: req.query.search,
      status: req.query.status,
      tag: req.query.tag,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/conversations/:conversationId/messages", requireAuth, async (req, res, next) => {
  try {
    const data = await getConversationMessages(req.user.tenantId, req.params.conversationId, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/conversations/:conversationId", requireAuth, async (req, res, next) => {
  try {
    const data = await updateConversation(req.user.tenantId, req.params.conversationId, req.body || {});
    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid") || error.message.startsWith("No conversation")) {
      return res.status(400).json({ status: "error", error: error.message });
    }
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/read", requireAuth, async (req, res, next) => {
  try {
    const data = await markConversationRead(req.user.tenantId, req.params.conversationId);
    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/notes", requireAuth, async (req, res, next) => {
  try {
    const data = await addConversationNote(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.body);
    return res.status(201).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid") || error.message.includes("not found")) {
      return res.status(400).json({ status: "error", error: error.message });
    }
    return next(error);
  }
});

app.put("/api/conversations/:conversationId/tags", requireAuth, async (req, res, next) => {
  try {
    const data = await setConversationTags(req.user.tenantId, req.params.conversationId, req.body?.tags);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid") || error.message.includes("not found")) {
      return res.status(400).json({ status: "error", error: error.message });
    }
    return next(error);
  }
});

app.get("/api/conversations/:conversationId/handoff", requireAuth, async (req, res, next) => {
  try {
    const data = await getHandoffState(req.user.tenantId, req.params.conversationId);
    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/handoff", requireAuth, async (req, res, next) => {
  try {
    const data = await handoffConversation(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.reason, req.body?.skill);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/pause-ai", requireAuth, async (req, res, next) => {
  try {
    const data = await pauseAi(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.reason);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/resume-ai", requireAuth, async (req, res, next) => {
  try {
    const data = await resumeAi(req.user.tenantId, req.params.conversationId, req.user.id);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/assign-round-robin", requireAuth, async (req, res, next) => {
  try {
    const data = await assignConversationRoundRobin(req.user.tenantId, req.params.conversationId, req.body?.skill);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found") || error.message.includes("No active")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/conversations/:conversationId/handoff-summary", requireAuth, async (req, res, next) => {
  try {
    const data = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);
    if (!data) return res.status(404).json({ status: "error", error: "Summary not found" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/conversations/:conversationId/copilot/drafts", requireAuth, async (req, res, next) => {
  try {
    const data = await listCopilotDrafts(req.user.tenantId, req.params.conversationId, req.query.limit);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/conversations/:conversationId/copilot/draft", requireAuth, async (req, res, next) => {
  try {
    // Reject missing/foreign context before reserving quota or constructing
    // any model request. Database foreign keys remain the final backstop.
    if (!(await getHandoffState(req.user.tenantId, req.params.conversationId))) {
      return res.status(404).json({ status: "error", error: "Conversation not found" });
    }
    // Copilot drafts are billable Gemini operations: reserve quota from the
    // tenant's shared monthly AI limit before any context work or provider
    // call, mirroring the inbound AI gate.
    const aiReservation = await reserveAiUsage({
      tenantId: req.user.tenantId,
      conversationId: req.params.conversationId,
      type: "copilot_draft",
    });
    if (aiReservation.inProgress) {
      return res.status(409).json({ status: "error", error: "An AI draft operation is already in progress" });
    }
    if (!aiReservation.allowed) {
      return res.status(429).json({ status: "error", error: "AI usage hard limit reached" });
    }

    let saved;
    let providerCallStarted = false;
    try {
      const messages = await getConversationMessages(req.user.tenantId, req.params.conversationId, { limit: 12, offset: 0 });
      const summary = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);
      const brain = await getBusinessBrain(req.user.tenantId);
      const copilotContext = buildCopilotContext({
        summary: summary?.summary,
        lastMessages: messages,
      });
      const sourceMessageIds = messages.map((message) => message.id).filter(Boolean);
      // Once dispatched, a timeout/network error cannot prove Gemini did
      // not process the request, so retain quota for uncertain provider spend.
      providerCallStarted = true;
      const draft = await generateCopilotDraftReply({
        businessBrain: brain,
        copilotContext,
      });

      // The user can delete a message while Gemini is generating. Require the
      // entire source set and the exact summary snapshot to remain valid before
      // persisting a draft that could be sent later.
      if (sourceMessageIds.length > 0) {
        const currentSources = await dbPool.query(
          `SELECT count(*)::int AS count
           FROM messages
           WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
          [req.user.tenantId, sourceMessageIds],
        );
        if (currentSources.rows[0].count !== sourceMessageIds.length) {
          throw new Error("Conversation messages changed or were deleted while drafting; retry");
        }
      }
      const currentSummary = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);
      if (currentSummary?.id !== summary?.id) {
        throw new Error("Conversation summary changed while drafting; retry");
      }

      saved = await saveCopilotDraft(
        req.user.tenantId,
        req.params.conversationId,
        req.user.id,
        draft,
        aiReservation.eventKey,
        { sourceMessageIds, expectedSummaryId: summary?.id ?? null },
      );
      if (aiReservation.reservationToken) {
        try {
          await commitAiUsage({
            tenantId: req.user.tenantId,
            eventKey: aiReservation.eventKey,
            reservationToken: aiReservation.reservationToken,
            type: "copilot_draft",
          });
        } catch (commitError) {
          logger.warn(
            { tenantId: req.user.tenantId, conversationId: req.params.conversationId, error: commitError.message },
            "Copilot draft saved but reservation finalization will be reconciled",
          );
        }
      }
    } catch (error) {
      if (providerCallStarted) {
        // Gemini may have spent quota even if drafting/persistence failed.
        // Commit conservatively to avoid a retry receiving an unmetered call.
        try {
          await commitAiUsage({
            tenantId: req.user.tenantId,
            eventKey: aiReservation.eventKey,
            reservationToken: aiReservation.reservationToken,
            type: "copilot_draft",
          });
        } catch (commitError) {
          logger.warn(
            { tenantId: req.user.tenantId, conversationId: req.params.conversationId, error: commitError.message },
            "Copilot provider may have been charged; usage reservation remains for reconciliation",
          );
        }
      } else {
        // Context/validation failures before dispatch cannot incur Gemini spend.
        try {
          await releaseAiUsage({
            tenantId: req.user.tenantId,
            eventKey: aiReservation.eventKey,
            reservationToken: aiReservation.reservationToken,
            type: "copilot_draft",
          });
        } catch (releaseError) {
          logger.warn(
            { tenantId: req.user.tenantId, conversationId: req.params.conversationId, error: releaseError.message },
            "Failed to release pre-provider Copilot usage reservation",
          );
        }
      }
      throw error;
    }
    return res.status(201).json({ status: "ok", data: saved });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.put("/api/users/me/skills", requireAuth, async (req, res, next) => {
  try {
    const data = await setUserSkills(req.user.tenantId, req.user.id, req.body?.skills);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/automations", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await listWorkflows(req.user.tenantId) }); }
  catch (error) { return next(error); }
});

app.post("/api/automations", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await createWorkflow({
      tenantId: req.user.tenantId,
      createdBy: req.user.id,
      name: req.body?.name,
      description: req.body?.description,
      triggerType: req.body?.triggerType,
      triggerConfig: req.body?.triggerConfig,
      definition: req.body?.definition,
    });
    return res.status(201).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid") || error.message.includes("Unsupported") || error.message.includes("Workflow")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.patch("/api/automations/:workflowId/status", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await setWorkflowStatus(req.user.tenantId, req.params.workflowId, req.body?.status) }); }
  catch (error) {
    if (error.message.startsWith("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/automations/:workflowId/run", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await startWorkflowRun({
      tenantId: req.user.tenantId,
      workflowId: req.params.workflowId,
      conversationId: req.body?.conversationId,
      contactId: req.body?.contactId,
      context: req.body?.context || {},
    });
    if (!data) return res.status(404).json({ status: "error", error: "Workflow or context not found or inactive" });
    return res.status(202).json({ status: "ok", data });
  } catch (error) {
    // Keep the service/database tenant FK contract intact. Translate its
    // rejection at the API boundary without exposing constraint details.
    if (error.code === "23503") return res.status(404).json({ status: "error", error: "Workflow or context not found" });
    if (error.code === "22P02") return res.status(400).json({ status: "error", error: "Invalid identifier" });
    if (error.message.startsWith("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/automations/health", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  return res.status(200).json({ status: "ok", scheduler: "enabled" });
});

app.get("/api/automations/webhook-effects/unknown", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await listUnknownWorkflowWebhookEffects(req.user.tenantId, req.query.limit);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/automations/webhook-effects/:effectId/resolve", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await resolveUnknownWorkflowWebhookEffect({
      tenantId: req.user.tenantId,
      effectId: req.params.effectId,
      resolvedBy: req.user.id,
      outcome: req.body?.outcome,
      reason: req.body?.reason,
    });
    if (!data) return res.status(409).json({ status: "error", error: "Webhook effect is not awaiting reconciliation" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message });
    if (error.message.includes("no longer eligible")) return res.status(409).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/appointments/types", requireAuth, async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await listAppointmentTypes(req.user.tenantId) }); }
  catch (error) { return next(error); }
});

app.post("/api/appointments/types", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await createAppointmentType({
      tenantId: req.user.tenantId, name: req.body?.name, description: req.body?.description,
      durationMinutes: req.body?.durationMinutes, bufferMinutes: req.body?.bufferMinutes, timezone: req.body?.timezone,
    });
    return res.status(201).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/appointments/hours", requireAuth, async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await getBusinessHours(req.user.tenantId) }); }
  catch (error) { return next(error); }
});

app.put("/api/appointments/hours", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try { return res.status(200).json({ status: "ok", data: await setBusinessHours(req.user.tenantId, req.body?.hours) }); }
  catch (error) { if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message }); return next(error); }
});

app.get("/api/appointments", requireAuth, async (req, res, next) => {
  try {
    return res.status(200).json({ status: "ok", data: await listAppointments(req.user.tenantId, {
      from: req.query.from, to: req.query.to, status: req.query.status, contactId: req.query.contactId,
    }) });
  } catch (error) { return next(error); }
});

app.post("/api/appointments", requireAuth, async (req, res, next) => {
  try {
    const data = await bookAppointment({
      tenantId: req.user.tenantId, appointmentTypeId: req.body?.appointmentTypeId, startsAt: req.body?.startsAt,
      customerName: req.body?.customerName, customerPhone: req.body?.customerPhone, customerEmail: req.body?.customerEmail,
      contactId: req.body?.contactId, conversationId: req.body?.conversationId, notes: req.body?.notes,
      createdBy: req.user.id, timezone: req.body?.timezone,
    });
    return res.status(201).json({ status: "ok", data, calendar: buildCalendarLinks(data) });
  } catch (error) {
    if (error.message.includes("already booked") || error.message.includes("outside business hours") || error.message.includes("not found") || error.message.startsWith("Invalid") || error.message.includes("future")) {
      return res.status(409).json({ status: "error", error: error.message });
    }
    return next(error);
  }
});

app.get("/api/appointments/:appointmentId", requireAuth, async (req, res, next) => {
  try {
    const data = await getAppointment(req.user.tenantId, req.params.appointmentId);
    if (!data) return res.status(404).json({ status: "error", error: "Appointment not found" });
    return res.status(200).json({ status: "ok", data, calendar: buildCalendarLinks(data) });
  } catch (error) { return next(error); }
});

app.patch("/api/appointments/:appointmentId/status", requireAuth, async (req, res, next) => {
  try {
    const data = await updateAppointmentStatus(req.user.tenantId, req.params.appointmentId, req.body?.status);
    if (!data) return res.status(404).json({ status: "error", error: "Appointment not found" });
    return res.status(200).json({ status: "ok", data });
  } catch (error) { if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message }); return next(error); }
});

app.get("/api/appointments/:appointmentId/ics", requireAuth, async (req, res, next) => {
  try {
    const data = await getAppointment(req.user.tenantId, req.params.appointmentId);
    if (!data) return res.status(404).json({ status: "error", error: "Appointment not found" });
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="nova-appointment.ics"');
    return res.status(200).send(buildIcs(data));
  } catch (error) { return next(error); }
});

app.get("/api/contacts/:contactId/ai-memory", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await getCustomerMemory(req.user.tenantId, req.params.contactId);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/contacts/:contactId/ai-memory", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const data = await rememberCustomerPreference(
      req.user.tenantId,
      req.params.contactId,
      req.body?.key,
      req.body?.value,
      req.body?.confidence,
    );
    if (!data) return res.status(404).json({ status: "error", error: "Contact not found" });
    return res.status(201).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.post("/api/ai/analyze", requireAuth, async (req, res, next) => {
  try {
    const message = req.body?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 4000) {
      return res.status(400).json({ status: "error", error: "Invalid message" });
    }
    return res.status(200).json({ status: "ok", data: await analyzeCustomerMessage(message) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/business-brain", requireAuth, async (req, res) => {
  try {
    const brain = await getBusinessBrain(req.user.tenantId);
    return res.status(200).json({ status: "ok", data: brain || {} });
  } catch (error) {
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to fetch Business Brain");
    return res.status(500).json({ status: "error", error: "Failed to fetch Business Brain" });
  }
});

app.put("/api/business-brain", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await upsertBusinessBrain(req.user.tenantId, req.body);
    const brain = await getBusinessBrain(req.user.tenantId);
    return res.status(200).json({ status: "ok", data: brain });
  } catch (error) {
    if (error.message.includes("Invalid") || error.message.includes("must be")) return res.status(400).json({ status: "error", error: error.message });
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to update Business Brain");
    return res.status(500).json({ status: "error", error: "Failed to fetch Business Brain" });
  }
});

const geminiTestSchema = Joi.object({ message: Joi.string().trim().min(1).max(4000).required() });
if (!IS_PRODUCTION) {
  app.post(
    "/api/test/gemini",
    geminiTestLimiter,
    requireAuth,
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { error, value } = geminiTestSchema.validate(req.body);
        if (error) return res.status(400).json({ status: "error", message: "Invalid request body" });

        const aiReservation = await reserveAiUsage({
          tenantId: req.user.tenantId,
          type: "ai_diagnostic",
        });
        if (aiReservation.inProgress) {
          return res.status(409).json({ status: "error", message: "An AI diagnostic is already in progress" });
        }
        if (!aiReservation.allowed) {
          return res.status(429).json({ status: "error", message: "AI usage hard limit reached" });
        }

        let providerCallStarted = false;
        try {
          providerCallStarted = true;
          const reply = await generateGeminiReply(value.message);
          if (aiReservation.reservationToken) {
            try {
              await commitAiUsage({
                tenantId: req.user.tenantId,
                eventKey: aiReservation.eventKey,
                reservationToken: aiReservation.reservationToken,
                type: "ai_diagnostic",
              });
            } catch (commitError) {
              req.log.warn(
                { error: commitError.message, tenantId: req.user.tenantId },
                "Diagnostic reply returned but usage finalization will be reconciled",
              );
            }
          }
          return res.status(200).json({ status: "ok", reply });
        } catch (error) {
          if (providerCallStarted) {
            try {
              await commitAiUsage({
                tenantId: req.user.tenantId,
                eventKey: aiReservation.eventKey,
                reservationToken: aiReservation.reservationToken,
                type: "ai_diagnostic",
              });
            } catch (commitError) {
              req.log.warn(
                { error: commitError.message, tenantId: req.user.tenantId },
                "Diagnostic provider may have been charged; usage reservation remains for reconciliation",
              );
            }
          } else {
            try {
              await releaseAiUsage({
                tenantId: req.user.tenantId,
                eventKey: aiReservation.eventKey,
                reservationToken: aiReservation.reservationToken,
                type: "ai_diagnostic",
              });
            } catch (releaseError) {
              req.log.warn(
                { error: releaseError.message, tenantId: req.user.tenantId },
                "Failed to release pre-provider diagnostic reservation",
              );
            }
          }
          throw error;
        }
      } catch (error) {
        return next(error);
      }
    },
  );
}

// Register Task 16 routes before the terminal 404 middleware. Production starts via bootstrap.js,
// but keeping route registration here makes the exported app fully composed before catch-all handling.
registerTask16Routes(app);

app.use((req, res) => res.status(404).json({ status: "error", message: "Route not found" }));
app.use((error, req, res, next) => {
  req.log?.error({ error: error.message }, "Unhandled application error");
  if (res.headersSent) return next(error);
  // Internal details belong in server logs, not the public API response.
  // Fail closed even if NODE_ENV is unset or misconfigured.
  return res.status(500).json({ status: "error", message: "Internal server error" });
});

// Integration tests import the composed app and must release its queue,
// recovery, retention, and optional database resources without force-exit.
export async function stopBackgroundServices({ closeDatabase = false } = {}) {
  await appStartupPromise;
  await stopInboxRecovery();
  stopRetentionSchedulerHandle?.();
  stopRetentionSchedulerHandle = null;
  await closeQueue();
  if (closeDatabase) await closeDatabaseConnection();
}

async function startServer() {
  if (IS_PRODUCTION || process.env.DATABASE_URL) {
    const migrationResult = await runMigrations();
    logger.info({ applied: migrationResult.applied }, "Database migrations checked");
  }

  const server = app.listen(PORT, () => logger.info(`Nova-AI server running on port ${PORT} [${NODE_ENV}]`));
  server.on("error", (error) => {
    logger.fatal({ error: error.message, code: error.code }, "HTTP server error — shutting down");
    process.exit(1);
  });

  if (isQueueConfigured()) {
    startWorker(async (jobData) => {
      const inboxId = jobData?.inboxId;
      return processInboxMessage(inboxId, logger);
    });
    logger.info("WhatsApp queue worker started");
  }

  stopRetentionSchedulerHandle = startRetentionScheduler();
  if (isDatabaseConfigured()) startInboxRecovery();

  startupComplete = true;
  logger.info("Nova-AI startup completed");

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    startupComplete = false;
    logger.info(`Received ${signal}, shutting down gracefully`);
    let shutdownStage = "inbox_recovery";

    const forceTimer = setTimeout(() => {
      logger.error({ shutdownStage }, "Forced shutdown after 10 seconds");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    try {
      // Stop new recovery work first, then wait for any active recovery pass.
      await stopInboxRecovery();

      // Stop accepting HTTP traffic and wait for in-flight requests before
      // closing Redis/BullMQ and PostgreSQL.
      shutdownStage = "http_drain";
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      stopRetentionSchedulerHandle?.();
      stopRetentionSchedulerHandle = null;
      shutdownStage = "queue_close";
      await closeQueue();
      shutdownStage = "database_close";
      await closeDatabaseConnection();

      clearTimeout(forceTimer);
      logger.info("Nova-AI server closed successfully");
      process.exit(0);
    } catch (shutdownError) {
      clearTimeout(forceTimer);
      logger.error({ error: shutdownError.message, shutdownStage }, "Graceful shutdown error");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (error) => {
    logger.fatal(
      { error: error.message, stack: error.stack },
      "Uncaught exception — shutting down",
    );
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message =
      reason?.message != null
        ? reason.message
        : reason instanceof Error
          ? reason.toString()
          : String(reason);
    logger.fatal({ reason: message }, "Unhandled promise rejection — shutting down");
    process.exit(1);
  });
}
export const appStartupPromise = startServer().catch((error) => {
  logger.fatal({ error: error.message }, "Nova-AI failed to start");
  process.exit(1);
});

export default app;
