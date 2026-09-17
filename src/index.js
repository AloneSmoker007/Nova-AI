import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import Joi from "joi";

import { checkDatabaseConnection, closeDatabaseConnection } from "./config/database.js";
import { logger, createHttpLogger } from "./config/logger.js";
import { runMigrations } from "./database/migrate.js";
import { generateGeminiReply } from "./services/gemini.service.js";
import { sendWhatsAppMessage } from "./services/whatsapp.service.js";
import { claimMessage, markMessageCompleted, releaseMessage } from "./services/idempotency.service.js";
import { resolveTenantByPhoneNumberId } from "./services/tenant.service.js";
import { decryptSecret } from "./services/secrets.service.js";
import { persistInboundMessage, persistOutboundMessage } from "./services/message-persistence.service.js";
import { getBusinessBrain, upsertBusinessBrain } from "./services/business-brain.service.js";
import { loginUser, getUserById } from "./services/auth.service.js";
import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";

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
    if (!database.connected) {
      return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "disconnected" });
    }
    return res.status(200).json({ status: "ready", service: "Nova-AI", database: "connected" });
  } catch (error) {
    req.log.error({ error: error.message }, "Readiness check failed");
    return res.status(503).json({ status: "not_ready", service: "Nova-AI", database: "error" });
  }
});

// WhatsApp webhook verification and delivery use Meta's verification token
// and HMAC signature respectively; they intentionally do not use JWT auth.
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

app.post("/webhook", webhookLimiter, (req, res) => {
  if (!verifyMetaSignature(req)) {
    req.log.warn("Rejected WhatsApp webhook: invalid signature");
    return res.sendStatus(403);
  }
  const messages = extractWebhookMessages(req.body);
  if (!messages || messages.length === 0) return res.sendStatus(200);
  res.sendStatus(200);
  setImmediate(() => { void processWhatsAppMessages(messages, req.log); });
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

function extractWebhookMessages(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (typeof phoneNumberId !== "string" || !/^\d{5,30}$/.test(phoneNumberId)) return [];

  return messages
    .filter((message) => message?.text?.body && message?.from && message?.id)
    .map((message) => ({ ...message, phoneNumberId }));
}

async function processWhatsAppMessages(messages, log) {
  for (const message of messages) {
    await processWhatsAppMessage(message, log);
  }
}

async function processWhatsAppMessage(message, log) {
  const messageId = message.id;
  const claim = claimMessage(messageId);
  if (!claim.claimed) {
    log.info({ messageId, reason: claim.reason }, "Ignoring duplicate WhatsApp message");
    return;
  }

  try {
    const incomingMessage = message.text.body;
    const senderNumber = message.from;
    const tenant = await resolveTenantByPhoneNumberId(message.phoneNumberId);

    if (!tenant) {
      releaseMessage(messageId);
      log.warn({ messageId, phoneNumberId: message.phoneNumberId }, "Ignoring WhatsApp message: no active tenant mapping");
      return;
    }

    log.info({ messageId, tenantId: tenant.tenantId, whatsappNumberId: tenant.whatsappNumberId }, "Processing tenant WhatsApp message");

    if (!tenant.accessTokenEncrypted) throw new Error("Tenant WhatsApp credentials are not configured");
    const accessToken = decryptSecret(tenant.accessTokenEncrypted);

    const persistedInbound = await persistInboundMessage({
      tenantId: tenant.tenantId,
      whatsappNumberId: tenant.whatsappNumberId,
      waId: senderNumber,
      profileName: message.profileName,
      whatsappMessageId: messageId,
      messageType: "text",
      body: incomingMessage,
      receivedAt: new Date(),
    });

    if (persistedInbound.duplicate) {
      markMessageCompleted(messageId);
      log.info({ messageId, tenantId: tenant.tenantId }, "Ignoring duplicate WhatsApp message already persisted");
      return;
    }

    let brain = null;
    try {
      brain = await getBusinessBrain(tenant.tenantId);
    } catch (brainError) {
      log.error(
        { error: brainError.message, tenantId: tenant.tenantId, messageId },
        "Failed to load Business Brain, falling back to default",
      );
    }

    const reply = await generateGeminiReply(incomingMessage, brain);

    const sentMessage = await sendWhatsAppMessage({
      to: senderNumber,
      message: reply,
      accessToken,
      phoneNumberId: tenant.phoneNumberId,
    });

    try {
      await persistOutboundMessage({
        tenantId: tenant.tenantId,
        conversationId: persistedInbound.conversationId,
        whatsappMessageId: sentMessage?.messages?.[0]?.id ?? null,
        messageType: "text",
        body: reply,
        sentAt: new Date(),
      });
    } catch (persistenceError) {
      log.error({ error: persistenceError.message, messageId, tenantId: tenant.tenantId }, "Outbound WhatsApp message sent but persistence failed");
    }

    markMessageCompleted(messageId);
    log.info({ messageId, tenantId: tenant.tenantId }, "WhatsApp reply sent");
  } catch (error) {
    releaseMessage(messageId);
    log.error({ error: error.message, messageId }, "WhatsApp message processing failed");
  }
}

// ── Auth Routes (NO JWT required) ──────────────────────────
const loginSchema = Joi.object({
  email: Joi.string().email().max(255).required(),
  password: Joi.string().min(8).max(128).required(),
});

app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ status: "error", error: "Invalid request" });
    }

    const result = await loginUser(value.email, value.password);

    return res.status(200).json({
      status: "ok",
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    if (error.message === "Invalid credentials") {
      return res.status(401).json({ status: "error", error: "Invalid credentials" });
    }
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user || user.status !== "active") {
      return res.status(401).json({ status: "error", error: "Invalid or expired token" });
    }

    return res.status(200).json({
      status: "ok",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      },
    });
  } catch {
    return res.status(401).json({ status: "error", error: "Invalid or expired token" });
  }
});

// ── Business Brain API (AUTH REQUIRED) ──────────────────────
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
    if (error.message.includes("Invalid") || error.message.includes("must be")) {
      return res.status(400).json({ status: "error", error: error.message });
    }
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to update Business Brain");
    return res.status(500).json({ status: "error", error: "Failed to update Business Brain" });
  }
});

// Gemini test is intentionally development-only to prevent production API-key abuse.
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

  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully`);
    server.close(async (error) => {
      if (error) {
        logger.error({ error: error.message }, "Server shutdown error");
        process.exit(1);
      }
      try {
        await closeDatabaseConnection();
        logger.info("Nova-AI server closed successfully");
        process.exit(0);
      } catch (shutdownError) {
        logger.error({ error: shutdownError.message }, "Database shutdown error");
        process.exit(1);
      }
    });
    setTimeout(() => { logger.error("Forced shutdown after 10 seconds"); process.exit(1); }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.fatal({ error: error.message }, "Nova-AI failed to start");
  process.exit(1);
});

export default app;
