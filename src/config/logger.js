import pino from "pino";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";

const REDACTED_PATHS = [
  "req.headers.authorization",
  'req.headers["x-hub-signature-256"]',
  "req.headers.cookie",
  "*.token",
  "*.apiKey",
  "*.secret",
  "*.accessToken",
  "*.accessTokenEncrypted",
  "*.password",
  "*.password_hash",
  "*.passwordHash",
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  redact: {
    paths: REDACTED_PATHS,
    censor: "[REDACTED]",
  },
});

export function createHttpLogger(baseLogger = logger) {
  return pinoHttp({
    logger: baseLogger,
    genReqId: (req) => {
      const incomingId = req.headers["x-request-id"];
      return typeof incomingId === "string" && incomingId.length <= 128
        ? incomingId
        : uuidv4();
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
