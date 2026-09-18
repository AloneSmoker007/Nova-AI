import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";
import {
  beginGoogleDriveConnection,
  completeGoogleDriveConnection,
  createTenantBackup,
  disconnectGoogleDrive,
  getGoogleDriveStatus,
  inspectTenantBackup,
  listTenantBackups,
  restoreTenantBackup,
} from "./services/backup.service.js";

export function registerBackupRoutes(app) {
  app.get("/api/backups/google-drive/status", requireAuth, async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await getGoogleDriveStatus(req.user.tenantId) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/backups/google-drive/connect", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await beginGoogleDriveConnection(req.user.tenantId) });
    } catch (error) {
      if (error.message.includes("not configured") || error.message.includes("HTTPS")) {
        return res.status(503).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  });

  // OAuth callback is intentionally unauthenticated: the one-time state is
  // cryptographically random, tenant-bound, expiring, and consumed atomically.
  app.get("/api/backups/google-drive/callback", async (req, res, next) => {
    try {
      const data = await completeGoogleDriveConnection({
        state: req.query.state,
        code: req.query.code,
      });
      return res.status(200).json({
        status: "ok",
        message: "Google Drive connected. You can close this window.",
        tenantId: data.tenantId,
      });
    } catch (error) {
      if (error.message.includes("OAuth") || error.message.includes("Google did not")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  });

  app.post("/api/backups/google-drive/disconnect", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await disconnectGoogleDrive(req.user.tenantId) });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/backups", requireAuth, async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await listTenantBackups(req.user.tenantId, req.query.limit) });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/backups", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      return res.status(201).json({ status: "ok", data: await createTenantBackup(req.user.tenantId) });
    } catch (error) {
      if (error.message.includes("not configured") || error.message.includes("not connected") || error.message.includes("maximum size")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  });

  app.get("/api/backups/:backupId/inspect", requireAuth, async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await inspectTenantBackup(req.user.tenantId, req.params.backupId) });
    } catch (error) {
      if (error.message.includes("not found") || error.message.includes("verification") || error.message.includes("mismatch") || error.message.includes("authentication")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  });

  // Additive restore only: existing rows are never overwritten or deleted.
  // This makes restore safe to retry and avoids destructive recovery actions.
  app.post("/api/backups/:backupId/restore", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      if (req.body?.confirm !== "RESTORE") {
        return res.status(400).json({ status: "error", error: "Explicit restore confirmation required" });
      }
      return res.status(200).json({ status: "ok", data: await restoreTenantBackup(req.user.tenantId, req.params.backupId) });
    } catch (error) {
      if (error.message.includes("not found") || error.message.includes("verification") || error.message.includes("mismatch") || error.message.includes("authentication") || error.message.includes("invalid")) {
        return res.status(400).json({ status: "error", error: error.message });
      }
      return next(error);
    }
  });
}
