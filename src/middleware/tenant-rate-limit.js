import rateLimit from "express-rate-limit";

const maxRequests = Number(process.env.TENANT_RATE_LIMIT || 300);

export const tenantRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.tenantId || req.ip,
  skip: (req) => req.path === "/webhook" || req.path === "/metrics",
  message: {
    status: "error",
    error: "Too many requests for this tenant. Please slow down.",
  },
});
