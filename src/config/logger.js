import pino from "pino";

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PRODUCTION ? "info" : "debug"),
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-hub-signature-256"]',
      "req.headers.cookie",
      "req.rawBody",
      "*.token",
      "*.apiKey",
      "*.secret",
      "*.accessToken",
      "*.accessTokenEncrypted",
      "*.password",
      "*.password_hash",
      "*.passwordHash",
      "*.authorization",
    ],
    censor: "[REDACTED]",
  },
});

export default logger;
