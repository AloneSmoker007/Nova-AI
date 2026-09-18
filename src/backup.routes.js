import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";
import { buildGoogleDriveAuthorizationUrl, completeGoogleDriveAuthorization, getDriveConnection } from "./services/google-drive.service.js";
import { createTenantBackup, listBackups } from "./services/backup.service.js";

export function registerBackupRoutes(app) {
  app.get("/api/backup/google/connect", requireAuth, requireRole("owner", "admin"), (req, res) => res.redirect(buildGoogleDriveAuthorizationUrl({ tenantId: req.user.tenantId, userId: req.user.id })));
  app.get("/api/backup/google/callback", async (req, res) => {
    try { const data = await completeGoogleDriveAuthorization(req.query.code, req.query.state); return res.status(200).json({ status: "ok", message: "Google Drive connected", data }); }
    catch { return res.status(400).json({ status: "error", error: "Google Drive connection failed" }); }
  });
  app.get("/api/backup/google/status", requireAuth, async (req, res, next) => {
    try { return res.status(200).json({ status: "ok", data: await getDriveConnection(req.user.tenantId) }); } catch (error) { return next(error); }
  });
  app.post("/api/backup/run", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try { return res.status(202).json({ status: "ok", data: await createTenantBackup(req.user.tenantId) }); } catch (error) { return next(error); }
  });
  app.get("/api/backup/history", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try { return res.status(200).json({ status: "ok", data: await listBackups(req.user.tenantId, req.query.limit) }); } catch (error) { return next(error); }
  });
}