import { verifyToken, getUserById } from "../services/auth.service.js";
import { isTenantActive } from "../services/tenant.service.js";

/**
 * Authenticate a request with a Bearer JWT and re-check
 * user and tenant active status against the database.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== "string") {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = authHeader.slice(7);

  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Authentication required" });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    if (!decoded?.sub || typeof decoded.sub !== "string" || !decoded?.tenantId || typeof decoded.tenantId !== "string") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await getUserById(decoded.sub, decoded.tenantId);
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Legacy tokens without tokenVersion map to version 0. Once logout, a
    // password change, or a role change bumps the account version, every older
    // access JWT is rejected on the next request.
    const currentTokenVersion = Number.isInteger(user.token_version) ? user.token_version : 0;
    if ((decoded.tokenVersion ?? 0) !== currentTokenVersion) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const tenantActive = await isTenantActive(user.tenant_id);
    if (!tenantActive) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = {
      id: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    };

    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
