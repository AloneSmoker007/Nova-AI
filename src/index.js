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
import { generateGeminiReply } from "./services/gemini.service.js";
import {
  isAmbiguousWhatsAppSendError,
  sendWhatsAppMessage,
} from "./services/whatsapp.service.js";
import { resolveTenantByPhoneNumberId, isTenantActive } from "./services/tenant.service.js";
import { decryptSecret } from "./services/secrets.service.js";
import { persistInboundMessage, persistOutboundMessage, persistDeletedInboundMessage } from "./services/message-persistence.service.js";
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
} from "./services/webhook-inbox.service.js";
import {
  claimDelivery,
  deliveryStatusToMessageStatus,
  findRecoverableDeliveries,
  getDelivery,
  markDeliveryFailed,
  markDeliverySent,
  markDeliveryStatus,
  markDeliveryUnknown,
  prepareDelivery,
  syncDeliveryToMessage,
} from "./services/whatsapp-delivery.service.js";
import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";
import { registerInboundUsage, getUsageSummary, reserveAiUsage, releaseAiUsage } from "./services/usage.service.js";
import { listConversations, getConversationMessages, updateConversation, markConversationRead, addConversationNote, setConversationTags } from "./services/conversation.service.js";
import { getHandoffState, handoffConversation, pauseAi, resumeAi, assignConversationRoundRobin, saveCopilotDraft, listCopilotDrafts, getLatestHandoffSummary, buildCopilotPrompt, setUserSkills } from "./services/handoff.service.js";
import { createWorkflow, listWorkflows, setWorkflowStatus, startWorkflowRun, triggerWorkflows, processDueWorkflowRuns, scheduleInactivityTriggers } from "./services/automation.service.js";
import { createAppointmentType, listAppointmentTypes, setBusinessHours, getBusinessHours, listAppointments, getAppointment, bookAppointment, updateAppointmentStatus, buildCalendarLinks, buildIcs } from "./services/appointment.service.js";
import { startRetentionScheduler } from "./services/retention.service.js";
import { getDashboardSummary } from "./services/dashboard.service.js";
import { listContacts } from "./services/contact.service.js";
import { listPayments } from "./services/payment.service.js";
import { getAnalytics } from "./services/analytics.service.js";
import { registerTask16Routes } from "./task16.routes.js";
import { askNova } from "./services/assistant.service.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
let startupComplete = false;

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
app.set("trust proxy", 1);
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
      await triggerWorkflows({
        tenantId: tenant.tenantId,
        triggerType: "message_received",
        context: { message: { id: message.id, from: message.from, body: message.text?.body || "" }, inboxId: inboxMessage.id },
      });
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

          if (!message?.text?.body) continue;
          messages.push({ ...message, phoneNumberId });
        }
      }

      if (Array.isArray(value?.statuses)) {
        for (const status of value.statuses) {
          if (!status?.id || !status?.status) continue;
          statuses.push({
            ...status,
            phoneNumberId,
            callbackData: status.biz_opaque_callback_data,
          });
        }
      }
    }
  }

  return { messages, deletedMessages, statuses };
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

    if (!persistedInbound.duplicate) {
      await registerInboundUsage({
        tenantId: message.tenant_id,
        conversationId: persistedInbound.conversationId,
        messageId: persistedInbound.messageId,
        whatsappMessageId: message.whatsapp_message_id,
        occurredAt: message.received_at,
      });
    }

    // Memory persistence intentionally runs on every processing attempt, including
    // duplicate webhook deliveries. If a previous attempt stored the message but
    // failed before saving memory, the durable inbox retry repairs the missing memory.
    if (persistedInbound.contactId) {
      const savedMemories = await syncCustomerMemoryFromMessage({
        tenantId: message.tenant_id,
        contactId: persistedInbound.contactId,
        messageText: message.body,
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
      // call. reserveAiUsage atomically checks the tenant's monthly ai_message\n      // limit (tenant-row serialization prevents concurrent overshoot) and\n      // reserves the ai_message usage event idempotently per WhatsApp message;\n      // the reservation itself is the metering record.\n      let aiReservation;\n      try {\n        aiReservation = await reserveAiUsage({\n          tenantId: message.tenant_id,\n          conversationId: persistedInbound.conversationId,\n          messageId: persistedInbound.messageId,\n          whatsappMessageId: message.whatsapp_message_id,\n        });\n      } catch (usageError) {\n        log.error({ error: usageError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to check AI usage limit");\n        throw usageError;\n      }\n\n      if (!aiReservation.allowed) {\n        // Same safe fallback as the AI-paused path: no reply is sent, nothing\n        // pretends an AI response went out, the message stays visible in the\n        // shared inbox for a human agent, and AI resumes automatically when\n        // usage frees up (new month, raised limit, or hard limit disabled).\n        await markCompleted(message.id, message.tenant_id, leaseToken, null);\n        log.warn(\n          {\n            inboxId: message.id,\n            tenantId: message.tenant_id,\n            conversationId: persistedInbound.conversationId,\n            used: aiReservation.used,\n            limit: aiReservation.limit,\n          },\n          "AI usage hard limit reached; message left for human agent",\n        );\n        return;\n      }\n\n      try {\n        let brain = null;\n        try {\n          brain = await getBusinessBrain(message.tenant_id);\n        } catch (brainError) {\n          log.error(\n            { error: brainError.message, tenantId: message.tenant_id, inboxId: message.id },\n            "Failed to load Business Brain, falling back to default",\n          );\n        }\n\n        const signal = await analyzeCustomerMessage(message.body, brain);\n        try {\n          await recordAiSignal(message.tenant_id, persistedInbound.conversationId, persistedInbound.messageId, signal);\n        } catch (signalError) {\n          log.warn({ error: signalError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to persist AI signal");\n        }\n\n        let memories = [];\n        if (persistedInbound.contactId) {\n          try {\n            memories = await getCustomerMemory(message.tenant_id, persistedInbound.contactId);\n          } catch (memoryError) {\n            log.warn({ error: memoryError.message, tenantId: message.tenant_id, inboxId: message.id }, "Failed to load customer AI memory");\n          }\n        }\n\n        const advancedContext = buildAdvancedAiContext({ signal, memories, businessBrain: brain });\n        const aiBrain = brain\n          ? { ...brain, customInstructions: [brain.customInstructions, advancedContext].filter(Boolean).join("\n\n") }\n          : { customInstructions: advancedContext };\n\n        reply = await generateGeminiReply(message.body, aiBrain);\n        reply = await saveGeneratedResponse(message.id, message.tenant_id, leaseToken, reply);\n      } catch (aiError) {\n        // Any failure after reservation but before a successful durable AI response\n        // must release the reservation. This includes context/signal/memory work,\n        // Gemini failures, and saveGeneratedResponse failures.\n        try {\n          await releaseAiUsage({\n            tenantId: message.tenant_id,\n            messageId: persistedInbound.messageId,\n            whatsappMessageId: message.whatsapp_message_id,\n          });\n        } catch (releaseError) {\n          log.warn(\n            { error: releaseError.message, tenantId: message.tenant_id, inboxId: message.id },\n            "Failed to release reserved AI usage",\n          );\n        }\n        throw aiError;\n      }\n    }\n\n    if (message.provider_message_id) {\n      await persistOutboundMessage({\n        tenantId: message.tenant_id,\n        conversationId: persistedInbound.conversationId,\n        whatsappMessageId: message.provider_message_id,\n        messageType: "text",\n        body: reply,\n        sentAt: new Date(),\n      });\n      await markCompleted(message.id, message.tenant_id, leaseToken, message.provider_message_id);\n      return;\n    }\n\n    const delivery = await prepareDelivery({\n      tenantId: message.tenant_id,\n      inboxMessageId: message.id,\n      conversationId: persistedInbound.conversationId,\n      recipientWaId: message.wa_id,\n      body: reply,\n    });\n\n    const deliveryClaim = await claimDelivery(delivery.id, message.tenant_id);\n\n    if (!deliveryClaim.claimed) {\n      const currentDelivery = await getDelivery(delivery.id, message.tenant_id);\n\n      if (\n        currentDelivery?.provider_message_id &&\n        ["SENT", "DELIVERED", "READ", "FAILED"].includes(currentDelivery.state)\n      ) {\n        await persistOutboundMessage({\n          tenantId: message.tenant_id,\n          conversationId: persistedInbound.conversationId,\n          whatsappMessageId: currentDelivery.provider_message_id,\n          messageType: "text",\n          body: reply,\n          sentAt: currentDelivery.last_attempt_at || new Date(),\n          deliveryId: currentDelivery.id,\n        });\n      }\n\n      await markCompleted(\n        message.id,\n        message.tenant_id,\n        leaseToken,\n        currentDelivery?.provider_message_id || null,\n      );\n      log.info(\n        { inboxId: message.id, deliveryId: delivery.id, reason: deliveryClaim.reason },\n        "Durable delivery already owned by delivery subsystem",\n      );\n      return;\n    }\n\n    const accessToken = decryptSecret(tenant.accessTokenEncrypted);\n\n    try {\n      const sentMessage = await sendWhatsAppMessage({\n        to: deliveryClaim.delivery.recipient_wa_id,\n        message: deliveryClaim.delivery.body,\n        accessToken,\n        phoneNumberId: tenant.phoneNumberId,\n        callbackData: deliveryClaim.delivery.delivery_key,\n      });\n\n      const providerMessageId = sentMessage?.messages?.[0]?.id;\n      if (!providerMessageId || typeof providerMessageId !== "string") {\n        throw new Error("WhatsApp API returned no message ID");\n      }\n\n      const completedDelivery = await markDeliverySent(\n        delivery.id,\n        message.tenant_id,\n        deliveryClaim.leaseToken,\n        providerMessageId,\n      );\n\n      await recordProviderMessageId(\n        message.id,\n        message.tenant_id,\n        leaseToken,\n        providerMessageId,\n      );\n\n      await persistOutboundMessage({\n        tenantId: message.tenant_id,\n        conversationId: persistedInbound.conversationId,\n        whatsappMessageId: providerMessageId,\n        messageType: "text",\n        body: reply,\n        sentAt: new Date(),\n        deliveryId: completedDelivery.id,\n      });\n\n      await markCompleted(message.id, message.tenant_id, leaseToken, providerMessageId);\n      log.info(\n        { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },\n        "WhatsApp reply accepted by provider",\n      );\n    } catch (sendError) {\n      if (isAmbiguousWhatsAppSendError(sendError)) {\n        await markDeliveryUnknown(\n          delivery.id,\n          message.tenant_id,\n          deliveryClaim.leaseToken,\n          sendError,\n        );\n        await markCompleted(message.id, message.tenant_id, leaseToken, null);\n        log.warn(\n          { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },\n          "WhatsApp send outcome is ambiguous; delivery recovery owns retry",\n        );\n        return;\n      }\n\n      await markDeliveryFailed(\n        delivery.id,\n        message.tenant_id,\n        deliveryClaim.leaseToken,\n        sendError,\n      );\n      await markCompleted(message.id, message.tenant_id, leaseToken, null);\n      log.warn(\n        { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },\n        "WhatsApp delivery failed definitively",\n      );\n      return;\n    }\n  } catch (error) {\n    const retryState = await markRetry(message.id, message.tenant_id, leaseToken, error);\n    if (!retryState) {\n      log.warn({ inboxId: message.id, tenantId: message.tenant_id }, "Unable to update durable inbox failure state");\n    }\n    log.error({ error: error.message, inboxId: message.id, tenantId: message.tenant_id }, "WhatsApp message processing failed");\n    throw error;\n  } finally {\n    if (typeof stopHeartbeat === "function") {\n      stopHeartbeat();\n    }\n  }\n}\n\nasync function recoverPendingDeliveries() {\n  try {\n    const pending = await findRecoverableDeliveries(50);\n\n    for (const row of pending) {\n      try {\n        const delivery = await getDelivery(row.id, row.tenant_id);\n        if (!delivery) continue;\n\n        const claim = await claimDelivery(delivery.id, delivery.tenant_id);\n        if (!claim.claimed) continue;\n\n        const inbox = delivery.inbox_message_id\n          ? await getInboxMessage(delivery.inbox_message_id, delivery.tenant_id)\n          : null;\n\n        let phoneNumberId = inbox?.phone_number_id;\n        if (!phoneNumberId && delivery.automation_run_id) {\n          const automation = await dbPool.query(\n            `SELECT wn.phone_number_id\n             FROM automation_runs ar\n             JOIN conversations c ON c.tenant_id = ar.tenant_id AND c.id = ar.conversation_id\n             JOIN whatsapp_numbers wn ON wn.tenant_id = c.tenant_id AND wn.id = c.whatsapp_number_id\n             WHERE ar.tenant_id = $1 AND ar.id = $2 LIMIT 1`,\n            [delivery.tenant_id, delivery.automation_run_id],\n          );\n          phoneNumberId = automation.rows[0]?.phone_number_id;\n        }\n\n        if (!phoneNumberId) {\n          await markDeliveryFailed(delivery.id, delivery.tenant_id, claim.leaseToken, new Error("Unable to resolve WhatsApp number for delivery"));\n          continue;\n        }\n\n        const tenant = await resolveTenantByPhoneNumberId(phoneNumberId);\n        if (!tenant || tenant.tenantId !== delivery.tenant_id) {\n          await markDeliveryFailed(\n            delivery.id,\n            delivery.tenant_id,\n            claim.leaseToken,\n            new Error("Stored WhatsApp delivery tenant mapping is no longer valid"),\n          );\n          continue;\n        }\n\n        const accessToken = decryptSecret(tenant.accessTokenEncrypted);\n\n        try {\n          const sentMessage = await sendWhatsAppMessage({\n            to: delivery.recipient_wa_id,\n            message: delivery.body,\n            accessToken,\n            phoneNumberId: tenant.phoneNumberId,\n            callbackData: delivery.delivery_key,\n          });\n\n          const providerMessageId = sentMessage?.messages?.[0]?.id;\n          if (!providerMessageId || typeof providerMessageId !== "string") {\n            throw new Error("WhatsApp API returned no message ID");\n          }\n\n          const completedDelivery = await markDeliverySent(\n            delivery.id,\n            delivery.tenant_id,\n            claim.leaseToken,\n            providerMessageId,\n          );\n\n          await persistOutboundMessage({\n            tenantId: delivery.tenant_id,\n            conversationId: delivery.conversation_id,\n            whatsappMessageId: providerMessageId,\n            messageType: "text",\n            body: delivery.body,\n            sentAt: new Date(),\n            deliveryId: completedDelivery.id,\n          });\n\n          await syncDeliveryToMessage(completedDelivery.id, delivery.tenant_id);\n        } catch (sendError) {\n          if (isAmbiguousWhatsAppSendError(sendError)) {\n            await markDeliveryUnknown(\n              delivery.id,\n              delivery.tenant_id,\n              claim.leaseToken,\n              sendError,\n            );\n          } else {\n            await markDeliveryFailed(\n              delivery.id,\n              delivery.tenant_id,\n              claim.leaseToken,\n              sendError,\n            );\n          }\n        }\n      } catch (error) {\n        logger.error(\n          { error: error.message, deliveryId: row.id, tenantId: row.tenant_id },\n          "Failed to recover WhatsApp delivery",\n        );\n      }\n    }\n  } catch (error) {\n    logger.error({ error: error.message }, "WhatsApp delivery recovery pass failed");\n  }\n}\n\nasync function dispatchPendingInboxMessages() {\n  if (recoveryPassPromise) return recoveryPassPromise;\n\n  recoveryPassPromise = (async () => {\n    try {\n    await recoverExpiredLeases();\n    await recoverPendingDeliveries();\n    await scheduleInactivityTriggers(100);\n    await processDueWorkflowRuns(20);\n    const pending = await findUndispatchedMessages(50);\n\n    for (const row of pending) {\n      try {\n        if (isQueueConfigured()) {\n          const reserved = await reserveQueueDispatch(row.id, row.tenant_id);\n          if (!reserved) continue;\n          try {\n            await enqueueWhatsAppMessage({ inboxId: row.id });\n          } catch (error) {\n            logger.error(\n              { error: error.message, inboxId: row.id, tenantId: row.tenant_id },\n              "Failed to enqueue reserved durable inbox message",\n            );\n            continue;\n          }\n          await markQueueDispatched(row.id, row.tenant_id);\n        } else {\n          await processInboxMessage(row.id, logger);\n        }\n      } catch (error) {\n        logger.error(\n          { error: error.message, inboxId: row.id, tenantId: row.tenant_id },\n          "Failed to recover durable inbox message",\n        );\n      }\n    }\n    } catch (error) {\n      logger.error({ error: error.message }, "Durable inbox recovery pass failed");\n    }\n  })();\n\n  try {\n    return await recoveryPassPromise;\n  } finally {\n    recoveryPassPromise = null;\n  }\n}\n\nlet recoveryTimer = null;\nlet recoveryPassPromise = null;\n\nfunction startInboxRecovery() {\n  if (recoveryTimer) return;\n  recoveryTimer = setInterval(() => {\n    void dispatchPendingInboxMessages();\n  }, 10_000);\n  recoveryTimer.unref();\n  void dispatchPendingInboxMessages();\n}\n\nasync function stopInboxRecovery() {\n  if (recoveryTimer) {\n    clearInterval(recoveryTimer);\n    recoveryTimer = null;\n  }\n  if (recoveryPassPromise) {\n    await recoveryPassPromise;\n  }\n}\n\nconst loginSchema = Joi.object({ email: Joi.string().email().max(255).required(), password: Joi.string().min(8).max(128).required() });\nconst refreshSchema = Joi.object({ refreshToken: Joi.string().trim().min(20).max(512).required() });\n\napp.post("/api/auth/login", loginLimiter, async (req, res, next) => {\n  try {\n    const { error, value } = loginSchema.validate(req.body);\n    if (error) return res.status(400).json({ status: "error", error: "Invalid request" });\n    const result = await loginUser(value.email, value.password);\n    const refreshToken = await issueRefreshToken(result.user.id, result.user.tenantId);\n    return res.status(200).json({ status: "ok", token: result.token, refreshToken, user: result.user });\n  } catch (error) {\n    if (error.message === "Invalid credentials") return res.status(401).json({ status: "error", error: "Invalid credentials" });\n    next(error);\n  }\n});\n\napp.post("/api/auth/refresh", async (req, res) => {\n  const { error, value } = refreshSchema.validate(req.body);\n  if (error) return res.status(400).json({ status: "error", error: "Invalid request" });\n\n  try {\n    const rotatedToken = await rotateRefreshToken(value.refreshToken);\n    if (!rotatedToken) return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });\n    const user = await getUserById(rotatedToken.userId, rotatedToken.tenantId);\n    if (!user || user.status !== "active" || !(await isTenantActive(rotatedToken.tenantId))) return res.status(401).json({ status: "error", error: "Account is inactive" });\n    const token = generateToken(user);\n    return res.status(200).json({ status: "ok", token, refreshToken: rotatedToken.refreshToken, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });\n  } catch (error) {\n    req.log.error({ error: error.message }, "Refresh token request failed");\n    return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });\n  }\n});\n\napp.post("/api/auth/logout", async (req, res) => {\n  const { error, value } = refreshSchema.validate(req.body);\n  if (error) return res.status(400).json({ status: "error", error: "Invalid request" });\n  try {\n    await revokeRefreshToken(value.refreshToken);\n    return res.sendStatus(204);\n  } catch (error) {\n    req.log.error({ error: error.message }, "Logout request failed");\n    return res.sendStatus(204);\n  }\n});\n\napp.get("/api/auth/me", requireAuth, async (req, res) => {\n  try {\n    const user = await getUserById(req.user.id, req.user.tenantId);\n    if (!user || user.status !== "active") return res.status(401).json({ status: "error", error: "Invalid or expired token" });\n    return res.status(200).json({ status: "ok", user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });\n  } catch {\n    return res.status(401).json({ status: "error", error: "Invalid or expired token" });\n  }\n});\n\napp.get("/api/dashboard/summary", requireAuth, async (req, res, next) => {\n  try { return res.status(200).json({ status: "ok", data: await getDashboardSummary(req.user.tenantId) }); }\n  catch (error) { return next(error); }\n});\n\napp.get("/api/contacts", requireAuth, async (req, res, next) => {\n  try { return res.status(200).json({ status: "ok", data: await listContacts(req.user.tenantId, { search: req.query.search, limit: req.query.limit, offset: req.query.offset }) }); }\n  catch (error) { return next(error); }\n});\n\napp.get("/api/payments", requireAuth, async (req, res, next) => {\n  try { return res.status(200).json({ status: "ok", data: await listPayments(req.user.tenantId, { status: req.query.status, limit: req.query.limit, offset: req.query.offset }) }); }\n  catch (error) { return next(error); }\n});\n\napp.get("/api/analytics", requireAuth, async (req, res, next) => {\n  try { return res.status(200).json({ status: "ok", data: await getAnalytics(req.user.tenantId, { days: req.query.days }) }); }\n  catch (error) { return next(error); }\n});\n\napp.get("/api/usage", requireAuth, async (req, res) => {\n  try {\n    const summary = await getUsageSummary(req.user.tenantId);\n    return res.status(200).json({ status: "ok", data: summary });\n  } catch (error) {\n    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to fetch usage summary");\n    return res.status(500).json({ status: "error", error: "Failed to fetch usage summary" });\n  }\n});\n\napp.get("/api/conversations", requireAuth, async (req, res, next) => {\n  try {\n    const data = await listConversations(req.user.tenantId, {\n      search: req.query.search,\n      status: req.query.status,\n      tag: req.query.tag,\n      limit: req.query.limit,\n      offset: req.query.offset,\n    });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.get("/api/conversations/:conversationId/messages", requireAuth, async (req, res, next) => {\n  try {\n    const data = await getConversationMessages(req.user.tenantId, req.params.conversationId, {\n      limit: req.query.limit,\n      offset: req.query.offset,\n    });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.patch("/api/conversations/:conversationId", requireAuth, async (req, res, next) => {\n  try {\n    const data = await updateConversation(req.user.tenantId, req.params.conversationId, req.body || {});\n    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.startsWith("Invalid") || error.message.startsWith("No conversation")) {\n      return res.status(400).json({ status: "error", error: error.message });\n    }\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/read", requireAuth, async (req, res, next) => {\n  try {\n    const data = await markConversationRead(req.user.tenantId, req.params.conversationId);\n    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/notes", requireAuth, async (req, res, next) => {\n  try {\n    const data = await addConversationNote(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.body);\n    return res.status(201).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.startsWith("Invalid") || error.message.includes("not found")) {\n      return res.status(400).json({ status: "error", error: error.message });\n    }\n    return next(error);\n  }\n});\n\napp.put("/api/conversations/:conversationId/tags", requireAuth, async (req, res, next) => {\n  try {\n    const data = await setConversationTags(req.user.tenantId, req.params.conversationId, req.body?.tags);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.startsWith("Invalid") || error.message.includes("not found")) {\n      return res.status(400).json({ status: "error", error: error.message });\n    }\n    return next(error);\n  }\n});\n\napp.get("/api/conversations/:conversationId/handoff", requireAuth, async (req, res, next) => {\n  try {\n    const data = await getHandoffState(req.user.tenantId, req.params.conversationId);\n    if (!data) return res.status(404).json({ status: "error", error: "Conversation not found" });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/handoff", requireAuth, async (req, res, next) => {\n  try {\n    const data = await handoffConversation(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.reason, req.body?.skill);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/pause-ai", requireAuth, async (req, res, next) => {\n  try {\n    const data = await pauseAi(req.user.tenantId, req.params.conversationId, req.user.id, req.body?.reason);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/resume-ai", requireAuth, async (req, res, next) => {\n  try {\n    const data = await resumeAi(req.user.tenantId, req.params.conversationId, req.user.id);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.includes("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/assign-round-robin", requireAuth, async (req, res, next) => {\n  try {\n    const data = await assignConversationRoundRobin(req.user.tenantId, req.params.conversationId, req.body?.skill);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    if (error.message.includes("Invalid") || error.message.includes("not found") || error.message.includes("No active")) return res.status(400).json({ status: "error", error: error.message });\n    return next(error);\n  }\n});\n\napp.get("/api/conversations/:conversationId/handoff-summary", requireAuth, async (req, res, next) => {\n  try {\n    const data = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);\n    if (!data) return res.status(404).json({ status: "error", error: "Summary not found" });\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.get("/api/conversations/:conversationId/copilot/drafts", requireAuth, async (req, res, next) => {\n  try {\n    const data = await listCopilotDrafts(req.user.tenantId, req.params.conversationId, req.query.limit);\n    return res.status(200).json({ status: "ok", data });\n  } catch (error) {\n    return next(error);\n  }\n});\n\napp.post("/api/conversations/:conversationId/copilot/draft", requireAuth, async (req, res, next) => {\n  try {\n    // Copilot drafts are billable Gemini operations: reserve quota from the\n    // tenant's shared monthly AI limit before any context work or provider
    // call, mirroring the inbound AI gate.
    const aiReservation = await reserveAiUsage({
      tenantId: req.user.tenantId,
      conversationId: req.params.conversationId,
      type: "copilot_draft",
    });
    if (!aiReservation.allowed) {
      return res.status(429).json({ status: "error", error: "AI usage hard limit reached" });
    }

    let saved;
    try {
      const messages = await getConversationMessages(req.user.tenantId, req.params.conversationId, { limit: 12, offset: 0 });
      const summary = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);
      const brain = await getBusinessBrain(req.user.tenantId);
      const prompt = buildCopilotPrompt({ summary: summary?.summary, lastMessages: messages, businessBrain: brain });
      const draft = await generateGeminiReply("Create one concise human-agent draft reply now.", {
        ...(brain || {}),
        customInstructions: [brain?.customInstructions, prompt].filter(Boolean).join("\n\n"),
      });
      saved = await saveCopilotDraft(req.user.tenantId, req.params.conversationId, req.user.id, draft);
    } catch (error) {
      // Any post-reservation failure (context, provider, or persistence) must
      // not leave a reservation behind; failed attempts consume no quota.
      try {
        await releaseAiUsage({ tenantId: req.user.tenantId, eventKey: aiReservation.eventKey, type: "copilot_draft" });
      } catch {
        // Release failure leaves a bounded orphan (one unit); nothing else to do.
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
    return res.status(202).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid") || error.message.includes("not found")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

app.get("/api/automations/health", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  return res.status(200).json({ status: "ok", scheduler: "enabled" });
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

app.get("/api/contacts/:contactId/ai-memory", requireAuth, async (req, res, next) => {
  try {
    const data = await getCustomerMemory(req.user.tenantId, req.params.contactId);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/contacts/:contactId/ai-memory", requireAuth, async (req, res, next) => {
  try {
    const data = await rememberCustomerPreference(
      req.user.tenantId,
      req.params.contactId,
      req.body?.key,
      req.body?.value,
      req.body?.confidence,
    );
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

app.post("/api/assistant/ask", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const result = await askNova({ tenantId: req.user.tenantId, prompt: req.body?.prompt });
    if (result.blocked) return res.status(429).json({ status: "error", error: "AI monthly limit reached", data: result });
    return res.status(200).json({ status: "ok", data: result });
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

// Register payment/OCR routes before the terminal 404 handler.
registerTask16Routes(app);
if (!IS_PRODUCTION) {
  app.post("/api/test/gemini", async (req, res, next) => {
    try {
      const { error, value } = geminiTestSchema.validate(req.body);
      if (error) return res.status(400).json({ status: "error", message: "Invalid request body" });
      const reply = await generateGeminiReply(value.message);
      return res.status(200).json({ status: "ok", reply });
    } catch (error) {
      return next(error);
    }
  });
}

app.use((req, res) => res.status(404).json({ status: "error", message: "Route not found" }));
app.use((error, req, res, next) => {
  req.log?.error({ error: error.message }, "Unhandled application error");
  if (res.headersSent) return next(error);
  return res.status(500).json({ status: "error", message: IS_PRODUCTION ? "Internal server error" : error.message });
});

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

  const stopRetentionScheduler = startRetentionScheduler();
  if (isDatabaseConfigured()) startInboxRecovery();

  startupComplete = true;
  logger.info("Nova-AI startup completed");

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    startupComplete = false;
    logger.info(`Received ${signal}, shutting down gracefully`);

    const forceTimer = setTimeout(() => {
      logger.error("Forced shutdown after 10 seconds");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    try {
      // Stop new recovery work first, then wait for any active recovery pass.
      await stopInboxRecovery();

      // Stop accepting HTTP traffic and wait for in-flight requests before
      // closing Redis/BullMQ and PostgreSQL.
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      stopRetentionScheduler?.();
      await closeQueue();
      await closeDatabaseConnection();

      clearTimeout(forceTimer);
      logger.info("Nova-AI server closed successfully");
      process.exit(0);
    } catch (shutdownError) {
      clearTimeout(forceTimer);
      logger.error({ error: shutdownError.message }, "Graceful shutdown error");
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
startServer().catch((error) => {
  logger.fatal({ error: error.message }, "Nova-AI failed to start");
  process.exit(1);
});

export default app;