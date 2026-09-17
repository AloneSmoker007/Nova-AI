import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import Joi from "joi";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";

import logger from "./config/logger.js";
import { checkDatabaseConnection, closeDatabaseConnection, isDatabaseConfigured } from "./config/database.js";
import { runMigrations } from "./database/migrate.js";
import { generateGeminiReply } from "./services/gemini.service.js";
import { sendWhatsAppMessage } from "./services/whatsapp.service.js";
import { claimMessage, markMessageCompleted, markMessageFailed } from "./services/idempotency.service.js";
import { resolveTenantByPhoneNumberId } from "./services/tenant.service.js";
import { decryptSecret } from "./services/secrets.service.js";
import { persistInboundMessage, persistOutboundMessage } from "./services/message-persistence.service.js";
import { getBusinessBrain, upsertBusinessBrain } from "./services/business-brain.service.js";
import { loginUser, getUserById, generateToken } from "./services/auth.service.js";
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from "./services/refresh-token.service.js";
import { isQueueConfigured, enqueueWhatsAppMessage, startWorker, closeQueue } from "./services/queue.service.js";
import { metricsMiddleware, metricsEndpoint, messagesProcessedTotal, geminiDurationSeconds } from "./services/metrics.service.js";
import { tenantRateLimit } from "./middleware/tenant-rate-limit.js";
import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

if (!process.env.NODE_ENV) {
  logger.warn("NODE_ENV is not explicitly set; defaulting to 'development'.");
}

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
  logger.warn(message);
}

const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => {
    const incomingId = req.headers["x-request-id"];
    return typeof incomingId === "string" && incomingId.length <= 128 ? incomingId : uuidv4();
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());
app.use(metricsMiddleware);
app.use(httpLogger);

const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/webhook" || req.path === "/metrics",
});
app.use(globalRateLimiter);

app.use(express.json({
  limit: "100kb",
  verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", error: "Too many login attempts. Please try again later." },
});

app.get("/", (req, res) => res.status(200).json({ status: "ok", service: "Nova-AI", message: "Nova-AI server is running" }));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", service: "Nova-AI", uptime: process.uptime() }));
app.get("/metrics", metricsEndpoint);

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

export function verifyMetaSignature(req) {
  if (!META_APP_SECRET || !req.rawBody) return false;
  const signature = req.get("x-hub-signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expectedSignature = `sha256=${crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex")}`;
  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function extractWebhookMessages(body) {
  const messages = [];
  if (!body || !Array.isArray(body.entry)) return messages;

  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (typeof phoneNumberId !== "string" || !/^\d{5,30}$/.test(phoneNumberId)) continue;
      const profileName = value.contacts?.[0]?.profile?.name;

      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          if (msg?.text?.body && msg?.from && msg?.id) {
            messages.push({ ...msg, phoneNumberId, profileName });
          }
        }
      }
    }
  }
  return messages;
}

export async function processWhatsAppMessage(message, log = logger) {
  const messageId = message.id;

  try {
    const tenant = await resolveTenantByPhoneNumberId(message.phoneNumberId);

    if (!tenant) {
      log.warn({ messageId, phoneNumberId: message.phoneNumberId }, "Ignoring WhatsApp message: no active tenant mapping");
      return;
    }

    const claim = await claimMessage(messageId, tenant.tenantId);
    if (!claim.claimed) {
      log.info({ messageId, reason: claim.reason }, "Ignoring duplicate WhatsApp message");
      return;
    }

    log.info({ messageId, tenantId: tenant.tenantId, whatsappNumberId: tenant.whatsappNumberId }, "Processing tenant WhatsApp message");

    if (!tenant.accessTokenEncrypted) throw new Error("Tenant WhatsApp credentials are not configured");
    const accessToken = decryptSecret(tenant.accessTokenEncrypted);

    const persistedInbound = await persistInboundMessage({
      tenantId: tenant.tenantId,
      whatsappNumberId: tenant.whatsappNumberId,
      waId: message.from,
      profileName: message.profileName,
      whatsappMessageId: messageId,
      messageType: "text",
      body: message.text.body,
      receivedAt: new Date(),
    });

    if (persistedInbound.duplicate) {
      await markMessageCompleted(messageId);
      messagesProcessedTotal.inc({ tenant_id: tenant.tenantId, status: "duplicate" });
      log.info({ messageId, tenantId: tenant.tenantId }, "Ignoring duplicate WhatsApp message already persisted");
      return;
    }

    if (persistedInbound.conversationStatus === "human") {
      await markMessageCompleted(messageId);
      messagesProcessedTotal.inc({ tenant_id: tenant.tenantId, status: "human_takeover" });
      log.info({ messageId, tenantId: tenant.tenantId }, "Skipping AI reply: conversation is in human takeover status");
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

    const geminiStart = process.hrtime();
    const reply = await generateGeminiReply(message.text.body, brain);
    const geminiDiff = process.hrtime(geminiStart);
    geminiDurationSeconds.observe(geminiDiff[0] + geminiDiff[1] / 1e9);

    const sentMessage = await sendWhatsAppMessage({
      to: message.from,
      message: reply,
      accessToken,
      phoneNumberId: tenant.phoneNumberId,
    });

    const outboundWaId = sentMessage?.messages?.[0]?.id || `outbound-${messageId}`;

    try {
      await persistOutboundMessage({
        tenantId: tenant.tenantId,
        conversationId: persistedInbound.conversationId,
        whatsappMessageId: outboundWaId,
        messageType: "text",
        body: reply,
        sentAt: new Date(),
      });
    } catch (persistenceError) {
      log.error({ error: persistenceError.message, messageId, tenantId: tenant.tenantId }, "Outbound WhatsApp message sent but persistence failed");
    }

    await markMessageCompleted(messageId);
    messagesProcessedTotal.inc({ tenant_id: tenant.tenantId, status: "success" });
    log.info({ messageId, tenantId: tenant.tenantId }, "WhatsApp reply sent");
  } catch (error) {
    await markMessageFailed(messageId, error.message);
    log.error({ error: error.message, messageId }, "WhatsApp message processing failed");
    throw error;
  }
}

app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) {
    req.log.warn("Rejected WhatsApp webhook: invalid signature");
    return res.sendStatus(403);
  }
  const messages = extractWebhookMessages(req.body);
  if (messages.length === 0) return res.sendStatus(200);

  res.sendStatus(200);

  for (const msg of messages) {
    if (isQueueConfigured()) {
      enqueueWhatsAppMessage(msg).catch((err) => {
        req.log.error({ error: err.message, messageId: msg.id }, "Failed to enqueue message, falling back to inline execution");
        setImmediate(() => { void processWhatsAppMessage(msg, req.log).catch(() => undefined); });
      });
    } else {
      setImmediate(() => { void processWhatsAppMessage(msg, req.log).catch(() => undefined); });
    }
  }
});

// ── Auth Routes ──────────────────────────
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

    let refreshInfo = null;
    if (isDatabaseConfigured()) {
      refreshInfo = await issueRefreshToken(result.user.id, result.user.tenantId);
    }

    return res.status(200).json({
      status: "ok",
      token: result.token,
      refreshToken: refreshInfo?.refreshToken || null,
      user: result.user,
    });
  } catch (error) {
    if (error.message === "Invalid credentials") {
      return res.status(401).json({ status: "error", error: "Invalid credentials" });
    }
    return next(error);
  }
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

app.post("/api/auth/refresh", async (req, res, next) => {
  try {
    const { error, value } = refreshSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ status: "error", error: "Invalid request" });
    }

    const rotated = await rotateRefreshToken(value.refreshToken);
    if (!rotated) {
      return res.status(401).json({ status: "error", error: "Invalid or expired refresh token" });
    }

    const user = await getUserById(rotated.userId, rotated.tenantId);
    if (!user) {
      return res.status(401).json({ status: "error", error: "User account inactive or missing" });
    }

    const token = generateToken({ id: user.id, tenant_id: user.tenant_id, role: user.role });

    return res.status(200).json({
      status: "ok",
      token,
      refreshToken: rotated.refreshToken,
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const { error, value } = refreshSchema.validate(req.body);
    if (!error && value.refreshToken) {
      await revokeRefreshToken(value.refreshToken);
    }
    return res.status(200).json({ status: "ok", message: "Logged out successfully" });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", requireAuth, tenantRateLimit, async (req, res, next) => {
  try {
    const user = await getUserById(req.user.id, req.user.tenantId);
    if (!user) {
      return res.status(401).json({ status: "error", error: "User not found or inactive" });
    }
    return res.status(200).json({ status: "ok", user });
  } catch (error) {
    return next(error);
  }
});

// ── Business Brain API (AUTH REQUIRED + TENANT RATE LIMITED) ──────────────────────
app.get("/api/business-brain", requireAuth, tenantRateLimit, async (req, res) => {
  try {
    const brain = await getBusinessBrain(req.user.tenantId);
    return res.status(200).json({ status: "ok", data: brain || {} });
  } catch (error) {
    req.log.error({ error: error.message, tenantId: req.user.tenantId }, "Failed to fetch Business Brain");
    return res.status(500).json({ status: "error", error: "Failed to fetch Business Brain" });
  }
});

app.put("/api/business-brain", requireAuth, tenantRateLimit, requireRole("owner", "admin"), async (req, res) => {
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

  if (isQueueConfigured()) {
    startWorker(processWhatsAppMessage);
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
        await closeQueue();
        await closeDatabaseConnection();
        logger.info("Nova-AI server closed successfully");
        process.exit(0);
      } catch (shutdownError) {
        logger.error({ error: shutdownError.message }, "Shutdown error");
        process.exit(1);
      }
    });
    setTimeout(() => { logger.error("Forced shutdown after 10 seconds"); process.exit(1); }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((error) => {
    logger.fatal({ error: error.message }, "Nova-AI failed to start");
    process.exit(1);
  });
}

export default app;
