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

import {
  checkDatabaseConnection,
  closeDatabaseConnection,
} from "./config/database.js";
import { runMigrations } from "./database/migrate.js";
import { generateGeminiReply } from "./services/gemini.service.js";
import { sendWhatsAppMessage } from "./services/whatsapp.service.js";
import {
  claimMessage,
  markMessageCompleted,
  releaseMessage,
} from "./services/idempotency.service.js";

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
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  ...(IS_PRODUCTION ? ["DATABASE_URL"] : []),
];

const missingEnvVars = REQUIRED_ENV_VARS.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvVars.length > 0) {
  const message = `Missing required environment variables: ${missingEnvVars.join(", ")}`;

  if (IS_PRODUCTION) {
    throw new Error(message);
  }

  console.warn(message);
}

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
  genReqId: (req) => {
    const incomingId = req.headers["x-request-id"];
    return typeof incomingId === "string" && incomingId.length <= 128
      ? incomingId
      : uuidv4();
  },
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

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet());
app.use(compression());
app.use(httpLogger);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);

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

app.get("/ready", async (req, res) => {
  try {
    const database = await checkDatabaseConnection();

    if (!database.configured) {
      if (IS_PRODUCTION) {
        return res.status(503).json({
          status: "not_ready",
          service: "Nova-AI",
          database: "not_configured",
        });
      }

      return res.status(200).json({
        status: "ready",
        service: "Nova-AI",
        database: "not_configured",
      });
    }

    if (!database.connected) {
      return res.status(503).json({
        status: "not_ready",
        service: "Nova-AI",
        database: "disconnected",
      });
    }

    return res.status(200).json({
      status: "ready",
      service: "Nova-AI",
      database: "connected",
    });
  } catch (error) {
    req.log.error(
      { error: error.message },
      "Readiness check failed",
    );

    return res.status(503).json({
      status: "not_ready",
      service: "Nova-AI",
      database: "error",
    });
  }
});

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

function verifyMetaSignature(req) {
  if (!META_APP_SECRET || !req.rawBody) {
    return false;
  }

  const signature = req.get("x-hub-signature-256");

  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
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

async function processWhatsAppMessage(message, log) {
  const messageId = message.id;
  const claim = claimMessage(messageId);

  if (!claim.claimed) {
    log.info(
      { messageId, reason: claim.reason },
      "Ignoring duplicate WhatsApp message",
    );
    return;
  }

  try {
    const incomingMessage = message.text?.body;
    const senderNumber = message.from;

    if (!incomingMessage || !senderNumber) {
      releaseMessage(messageId);
      log.debug("WhatsApp message missing text or sender");
      return;
    }

    log.info({ messageId }, "Processing WhatsApp message");

    const reply = await generateGeminiReply(incomingMessage);

    await sendWhatsAppMessage(senderNumber, reply);
    markMessageCompleted(messageId);

    log.info({ messageId }, "WhatsApp reply sent");
  } catch (error) {
    releaseMessage(messageId);

    log.error(
      { error: error.message },
      "WhatsApp message processing failed",
    );
  }
}

app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) {
    req.log.warn("Rejected WhatsApp webhook: invalid signature");
    return res.sendStatus(403);
  }

  const message =
    req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message?.text?.body || !message?.from || !message?.id) {
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  setImmediate(() => {
    void processWhatsAppMessage(message, req.log);
  });
});

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

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Route not found",
  });
});

app.use((error, req, res, next) => {
  req.log?.error(
    { error: error.message },
    "Unhandled application error",
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    status: "error",
    message: IS_PRODUCTION ? "Internal server error" : error.message,
  });
});

async function startServer() {
  if (IS_PRODUCTION || process.env.DATABASE_URL) {
    const migrationResult = await runMigrations();

    logger.info(
      { applied: migrationResult.applied },
      "Database migrations checked",
    );
  }

  const server = app.listen(PORT, () => {
    logger.info(
      `Nova-AI server running on port ${PORT} [${NODE_ENV}]`,
    );
  });

  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully`);

    server.close(async (error) => {
      if (error) {
        logger.error(
          { error: error.message },
          "Server shutdown error",
        );

        process.exit(1);
      }

      try {
        await closeDatabaseConnection();
        logger.info("Nova-AI server closed successfully");
        process.exit(0);
      } catch (shutdownError) {
        logger.error(
          { error: shutdownError.message },
          "Database shutdown error",
        );
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error("Forced shutdown after 10 seconds");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((error) => {
  logger.fatal(
    { error: error.message },
    "Nova-AI failed to start",
  );
  process.exit(1);
});

export default app;
