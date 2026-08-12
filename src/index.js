import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import Joi from "joi";
import pino from "pino";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";

import { generateGeminiReply } from "./services/gemini.service.js";
import { sendWhatsAppMessage } from "./services/whatsapp.service.js";

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

// --------------------------------------------------
// Environment validation
// --------------------------------------------------

if (!WEBHOOK_VERIFY_TOKEN) {
  console.warn("WEBHOOK_VERIFY_TOKEN is not configured");
}

if (!META_APP_SECRET) {
  console.warn("META_APP_SECRET is not configured");
}

// --------------------------------------------------
// Logger
// --------------------------------------------------

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PRODUCTION ? "info" : "debug"),
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-hub-signature-256"]',
      "req.headers.cookie",
      "*.token",
      "*.apiKey",
      "*.secret",
      "*.accessToken",
    ],
    censor: "[REDACTED]",
  },
});

const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers["x-request-id"] || uuidv4(),
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});

// --------------------------------------------------
// App security & middleware
// --------------------------------------------------

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());
app.use(httpLogger);

// General API protection.
// Webhook handling remains lightweight and Meta retries
// are handled separately through signature validation.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Capture raw body for Meta HMAC verification.
app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Nova-AI",
    message: "Nova-AI server is running",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Nova-AI",
    uptime: process.uptime(),
  });
});

// --------------------------------------------------
// Meta webhook verification
// --------------------------------------------------

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    WEBHOOK_VERIFY_TOKEN &&
    token === WEBHOOK_VERIFY_TOKEN &&
    challenge
  ) {
    logger.info("WhatsApp webhook verification successful");
    return res.status(200).send(challenge);
  }

  logger.warn("WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

// --------------------------------------------------
// Meta signature verification
// --------------------------------------------------

function verifyMetaSignature(req) {
  if (!META_APP_SECRET || !req.rawBody) {
    return false;
  }

  const signature = req.get("x-hub-signature-256");

  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody)
      .digest("hex");

  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// --------------------------------------------------
// WhatsApp message processing
// --------------------------------------------------

async function processWhatsAppMessage(message, log) {
  try {
    const incomingMessage = message.text?.body;
    const senderNumber = message.from;

    if (!incomingMessage || !senderNumber) {
      log.debug("WhatsApp message missing text or sender");
      return;
    }

    log.info(
      {
        messageId: message.id,
      },
      "Processing WhatsApp message",
    );

    const reply = await generateGeminiReply(incomingMessage);

    if (
      process.env.WHATSAPP_ACCESS_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID
    ) {
      await sendWhatsAppMessage(senderNumber, reply);

      log.info(
        {
          messageId: message.id,
        },
        "WhatsApp reply sent",
      );
    } else {
      log.warn(
        "WhatsApp credentials are not configured. Gemini reply was generated but not sent.",
      );
    }
  } catch (error) {
    log.error(
      {
        error: error.message,
      },
      "WhatsApp message processing failed",
    );
  }
}

// --------------------------------------------------
// WhatsApp webhook receiver
// --------------------------------------------------

app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) {
    req.log.warn("Rejected WhatsApp webhook: invalid signature");
    return res.sendStatus(403);
  }

  const message =
    req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  // Ignore delivery/read/status events for now.
  if (!message?.text?.body || !message?.from) {
    return res.sendStatus(200);
  }

  // Acknowledge Meta immediately.
  res.sendStatus(200);

  // Process AI response in background.
  setImmediate(() => {
    void processWhatsAppMessage(message, req.log);
  });
});

// --------------------------------------------------
// Gemini test endpoint
// --------------------------------------------------

const geminiTestSchema = Joi.object({
  message: Joi.string().trim().min(1).max(4000).required(),
});

app.post("/api/test/gemini", async (req, res, next) => {
  try {
    const { error, value } = geminiTestSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        status: "error",
        message: "Invalid request body",
      });
    }

    const reply = await generateGeminiReply(value.message);

    return res.status(200).json({
      status: "ok",
      reply,
    });
  } catch (error) {
    return next(error);
  }
});

// --------------------------------------------------
// 404 handler
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Route not found",
  });
});

// --------------------------------------------------
// Global error handler
// --------------------------------------------------

app.use((error, req, res, next) => {
  req.log?.error(
    {
      error: error.message,
    },
    "Unhandled application error",
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    status: "error",
    message: IS_PRODUCTION
      ? "Internal server error"
      : error.message,
  });
});

// --------------------------------------------------
// Server startup
// --------------------------------------------------

const server = app.listen(PORT, () => {
  logger.info(
    `Nova-AI server running on port ${PORT} [${NODE_ENV}]`,
  );
});

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);

  server.close((error) => {
    if (error) {
      logger.error(
        {
          error: error.message,
        },
        "Server shutdown error",
      );

      process.exit(1);
    }

    logger.info("Nova-AI server closed successfully");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Forced shutdown after 10 seconds");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;