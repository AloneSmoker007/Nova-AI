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
      // Verification/OAuth tokens and private search text can arrive in queries.
      // Sanitize only the log representation; routing still needs the full URL.
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: typeof req.url === "string" ? req.url.split(/[?#]/, 1)[0] : undefined,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
