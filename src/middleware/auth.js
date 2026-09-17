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
    const user = await getUserById(decoded.sub);
    if (!user || user.status !== "active") {
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
