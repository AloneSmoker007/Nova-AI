import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import Joi from "joi";

import { checkDatabaseConnection, closeDatabaseConnection, isDatabaseConfigured } from "./config/database.js";
import { logger, createHttpLogger } from "./config/logger.js";
import { runMigrations } from "./database/migrate.js";
import { generateGeminiReply } from "./services/gemini.service.js";
import {
  isAmbiguousWhatsAppSendError,
  sendWhatsAppMessage,
} from "./services/whatsapp.service.js";
import { resolveTenantByPhoneNumberId, isTenantActive } from "./services/tenant.service.js";
import { decryptSecret } from "./services/secrets.service.js";
import { persistInboundMessage, persistOutboundMessage } from "./services/message-persistence.service.js";
import { getBusinessBrain, upsertBusinessBrain } from "./services/business-brain.service.js";
import { analyzeCustomerMessage, buildAdvancedAiContext, getCustomerMemory, rememberCustomerPreference, recordAiSignal } from "./services/advanced-ai.service.js";
import { loginUser, getUserById, generateToken } from "./services/auth.service.js";
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from "./services/refresh-token.service.js";
import {
  enqueueWhatsAppMessage,
  isQueueConfigured,
  startWorker,
  closeQueue,
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
import { registerInboundUsage, getUsageSummary } from "./services/usage.service.js";
import { listConversations, getConversationMessages, updateConversation, markConversationRead, addConversationNote, setConversationTags } from "./services/conversation.service.js";
import { getHandoffState, handoffConversation, pauseAi, resumeAi, assignConversationRoundRobin, saveCopilotDraft, listCopilotDrafts, getLatestHandoffSummary, buildCopilotPrompt, setUserSkills } from "./services/handoff.service.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

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
    const database = await checkDatabaseConnection();
    if (!database.configured) {
      return res.status(IS_PRODUCTION ? 503 : 200).json({
        status: IS_PRODUCTION ? "not_ready" : "ready",
        service: "Nova-AI",
        database: "not_configured",
      });
    }
    if (!database.connected) return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "disconnected" });
    return res.status(200).json({ status: "ready", service: "Nova-AI", database: "connected" });
  } catch (error) {
    req.log.error({ error: error.message }, "Readiness check failed");
    return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "error" });
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

  const { messages, statuses } = extractWebhookEvents(req.body);
  if (messages.length === 0 && statuses.length === 0) return res.sendStatus(200);

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

    for (const message of messages) {
      const tenant = await resolveTenantByPhoneNumberId(message.phoneNumberId);
      if (!tenant) {
        req.log.warn(
          { messageId: message.id, phoneNumberId: message.phoneNumberId },
          "Ignoring WhatsApp message: no active tenant mapping",
        );
        continue;
      }
      await ingestWebhookMessage({ message, tenant });
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
          if (!message?.text?.body || !message?.from || !message?.id) continue;
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

  return { messages, statuses };
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
      const aiBrain = brain ? { ...brain, customInstructions: [brain.customInstructions, advancedContext].filter(Boolean).join("\\n\\n") } : { customInstructions: advancedContext };
      reply = await generateGeminiReply(message.body, aiBrain);
      reply = await saveGeneratedResponse(message.id, message.tenant_id, leaseToken, reply);
    }

    if (message.provider_message_id) {
      await persistOutboundMessage({
        tenantId: message.tenant_id,
        conversationId: persistedInbound.conversationId,
        whatsappMessageId: message.provider_message_id,
        messageType: "text",
        body: reply,
        sentAt: new Date(),
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
          body: reply,
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
      const sentMessage = await sendWhatsAppMessage({
        to: deliveryClaim.delivery.recipient_wa_id,
        message: deliveryClaim.delivery.body,
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
        body: reply,
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
      );
      await markCompleted(message.id, message.tenant_id, leaseToken, null);
      log.warn(
        { inboxId: message.id, tenantId: message.tenant_id, deliveryId: delivery.id },
        "WhatsApp delivery failed definitively",
      );
      return;
    }
  } catch (error) {
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
    const pending = await findRecoverableDeliveries(50);

    for (const row of pending) {
      try {
        const delivery = await getDelivery(row.id, row.tenant_id);
        if (!delivery) continue;

        const claim = await claimDelivery(delivery.id, delivery.tenant_id);
        if (!claim.claimed) continue;

        const inbox = await getInboxMessage(delivery.inbox_message_id, delivery.tenant_id);
        if (!inbox) {
          await markDeliveryFailed(
            delivery.id,
            delivery.tenant_id,
            claim.leaseToken,
            new Error("Durable inbox record for delivery no longer exists"),
          );
          continue;
        }

        const tenant = await resolveTenantByPhoneNumberId(inbox.phone_number_id);
        if (!tenant || tenant.tenantId !== delivery.tenant_id) {
          await markDeliveryFailed(
            delivery.id,
            delivery.tenant_id,
            claim.leaseToken,
            new Error("Stored WhatsApp delivery tenant mapping is no longer valid"),
          );
          continue;
        }

        const accessToken = decryptSecret(tenant.accessTokenEncrypted);

        try {
          const sentMessage = await sendWhatsAppMessage({
            to: delivery.recipient_wa_id,
            message: delivery.body,
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
          );

          await persistOutboundMessage({
            tenantId: delivery.tenant_id,
            conversationId: delivery.conversation_id,
            whatsappMessageId: providerMessageId,
            messageType: "text",
            body: delivery.body,
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
            );
          } else {
            await markDeliveryFailed(
              delivery.id,
              delivery.tenant_id,
              claim.leaseToken,
              sendError,
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
  } catch (error) {
    logger.error({ error: error.message }, "WhatsApp delivery recovery pass failed");
  }
}

async function dispatchPendingInboxMessages() {
  if (recoveryPassRunning) return;
  recoveryPassRunning = true;

  try {
    await recoverExpiredLeases();
    await recoverPendingDeliveries();
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
  } finally {
    recoveryPassRunning = false;
  }
}

let recoveryTimer = null;
let recoveryPassRunning = false;

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
}

const loginSchema = Joi.object({ email: Joi.string().email().max(255).required(), password: Joi.string().min(8).max(128).required() });
const refreshSchema = Joi.object({ refreshToken: Joi.string().trim().min(20).max(512).required() });

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ status: "error", error: "Invalid request" });
    const result = await loginUser(value.email, value.password);
    const refreshToken = await issueRefreshToken(result.user.id, result.user.tenantId);
    return res.status(200).json({ status: "ok", token: result.token, refreshToken, user: result.user });
  } catch (error) {
    if (error.message === "Invalid credentials") return res.status(401).json({ status: "error", error: "Invalid credentials" });
    next(error);
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  const { error, value } = refreshSchema.validate(req.body);
  if (error) return res.status(400).json({ status: "error", error: "Invalid request" });

  try {
    const rotatedToken = await rotateRefreshToken(value.refreshToken);
    if (!rotatedToken) return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
    const user = await getUserById(rotatedToken.userId, rotatedToken.tenantId);
    if (!user || user.status !== "active" || !(await isTenantActive(rotatedToken.tenantId))) return res.status(401).json({ status: "error", error: "Account is inactive" });
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
    await revokeRefreshToken(value.refreshToken);
    return res.sendStatus(204);
  } catch (error) {
    req.log.error({ error: error.message }, "Logout request failed");
    return res.sendStatus(204);
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

app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const summary = await getUsageSummary(req.user.tenantId);
    return res.status(200).json({ status: "ok", data: summary });
  } catch (error) {
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to fetch usage summary");
    return res.status(500).json({ status: "error", error: "Failed to fetch usage summary" });
  }
});

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
    const messages = await getConversationMessages(req.user.tenantId, req.params.conversationId, { limit: 12, offset: 0 });
    const summary = await getLatestHandoffSummary(req.user.tenantId, req.params.conversationId);
    const brain = await getBusinessBrain(req.user.tenantId);
    const prompt = buildCopilotPrompt({ summary: summary?.summary, lastMessages: messages, businessBrain: brain });
    const draft = await generateGeminiReply("Create one concise human-agent draft reply now.", {
      ...(brain || {}),
      customInstructions: [brain?.customInstructions, prompt].filter(Boolean).join("\\n\\n"),
    });
    const saved = await saveCopilotDraft(req.user.tenantId, req.params.conversationId, req.user.id, draft);
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

  if (isQueueConfigured()) {
    startWorker(async (jobData) => {
      const inboxId = jobData?.inboxId;
      return processInboxMessage(inboxId, logger);
    });
    logger.info("WhatsApp queue worker started");
  }

  if (isDatabaseConfigured()) startInboxRecovery();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully`);
    await stopInboxRecovery();
    server.close(async (error) => {
      if (error) {
        logger.error({ error: error.message }, "Server shutdown error");
        process.exit(1);
      }
      try {
        await closeQueue();
        await closeDatabaseConnection();
        logger.info("Nova-AI server closed successfully");
        process.exit(0);
      } catch (shutdownError) {
        logger.error({ error: shutdownError.message }, "Graceful shutdown error");
        process.exit(1);
      }
    });
    setTimeout(() => { logger.error("Forced shutdown after 10 seconds"); process.exit(1); }, 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.fatal({ error: error.message }, "Nova-AI failed to start");
  process.exit(1);
});

export default app;