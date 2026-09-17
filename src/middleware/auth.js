import { verifyToken } from "../services/auth.service.js";
import { isUserActive, isTenantActive } from "../services/tenant.service.js";

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== "string") {
    return res.status(401).json({ status: "error", error: "Authentication token is missing" });
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ status: "error", error: "Invalid authorization format" });
  }

  try {
    const payload = verifyToken(token);

    if (!payload.sub || !payload.tenantId || !payload.role) {
      return res.status(401).json({ status: "error", error: "Invalid token payload" });
    }

    const [userOk, tenantOk] = await Promise.all([
      isUserActive(payload.sub, payload.tenantId),
      isTenantActive(payload.tenantId),
    ]);

    if (!userOk || !tenantOk) {
      return res.status(401).json({ status: "error", error: "User or tenant account is inactive" });
    }

    req.user = {
      id: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    };

    return next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({ status: "error", error: "Invalid or expired token" });
    }

    req.log?.error({ error: error.message }, "Auth middleware error");
    return res.status(500).json({ status: "error", error: "Internal server error" });
  }
}
