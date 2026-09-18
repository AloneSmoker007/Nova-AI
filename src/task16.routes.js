import express from "express";
import { requireAuth } from "./middleware/auth.js";
import { requireRole } from "./middleware/require-role.js";
import {
  createPayment,
  listPayments,
  getPayment,
  updatePaymentStatus,
  applyPaymentWebhook,
  verifyPaymentWebhook,
} from "./services/payment.service.js";
import { extractTextFromDocument, listOcrDocuments, getOcrDocument, ALLOWED, MAX_IMAGE_BYTES } from "./services/ocr.service.js";

const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "";

function bad(error) {
  return error.message.startsWith("Invalid") ||
    error.message.includes("too long") ||
    error.message.includes("HTTPS") ||
    error.message.includes("Unsupported");
}

export function registerTask16Routes(app) {
  app.get("/api/payments", requireAuth, async (req, res, next) => {
    try {
      return res.status(200).json({
        status: "ok",
        data: await listPayments(req.user.tenantId, {
          status: req.query.status,
          limit: req.query.limit,
        }),
      });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.get("/api/payments/:paymentId", requireAuth, async (req, res, next) => {
    try {
      const data = await getPayment(req.user.tenantId, req.params.paymentId);
      if (!data) return res.status(404).json({ status: "error", error: "Payment not found" });
      return res.status(200).json({ status: "ok", data });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.post("/api/payments", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const data = await createPayment({
        tenantId: req.user.tenantId,
        provider: req.body?.provider,
        providerPaymentId: req.body?.providerPaymentId,
        amountMinor: req.body?.amountMinor,
        currency: req.body?.currency,
        customerName: req.body?.customerName,
        customerPhone: req.body?.customerPhone,
        description: req.body?.description,
        checkoutUrl: req.body?.checkoutUrl,
        metadata: req.body?.metadata,
      });
      return res.status(201).json({ status: "ok", data });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.patch("/api/payments/:paymentId/status", requireAuth, requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const data = await updatePaymentStatus(req.user.tenantId, req.params.paymentId, req.body?.status);
      if (!data) return res.status(404).json({ status: "error", error: "Payment not found" });
      return res.status(200).json({ status: "ok", data });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.post("/api/payments/webhook/:tenantId", express.raw({ type: "application/json", limit: "64kb" }), async (req, res, next) => {
    try {
      const signature = req.get("x-nova-payment-signature");
      if (!PAYMENT_WEBHOOK_SECRET || !verifyPaymentWebhook(req.body, signature, PAYMENT_WEBHOOK_SECRET)) {
        return res.sendStatus(403);
      }

      const body = JSON.parse(req.body.toString("utf8"));
      const data = await applyPaymentWebhook({
        tenantId: req.params.tenantId,
        provider: body?.provider,
        providerPaymentId: body?.providerPaymentId,
        status: body?.status,
        signatureValid: true,
      });

      if (!data) return res.status(404).json({ status: "error", error: "Payment not found" });
      return res.status(200).json({ status: "ok", data });
    } catch (error) {
      if (error instanceof SyntaxError || bad(error)) return res.status(400).json({ status: "error", error: "Invalid payment webhook" });
      return next(error);
    }
  });

  app.get("/api/ocr/documents", requireAuth, async (req, res, next) => {
    try {
      return res.status(200).json({ status: "ok", data: await listOcrDocuments(req.user.tenantId, req.query.limit) });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.get("/api/ocr/documents/:documentId", requireAuth, async (req, res, next) => {
    try {
      const data = await getOcrDocument(req.user.tenantId, req.params.documentId);
      if (!data) return res.status(404).json({ status: "error", error: "OCR document not found" });
      return res.status(200).json({ status: "ok", data });
    } catch (error) {
      if (bad(error)) return res.status(400).json({ status: "error", error: error.message });
      return next(error);
    }
  });

  app.post(
    "/api/ocr/extract",
    requireAuth,
    express.raw({ type: Array.from(ALLOWED), limit: MAX_IMAGE_BYTES + 256 * 1024 }),
    async (req, res, next) => {
      try {
        if (!Buffer.isBuffer(req.body)) return res.status(400).json({ status: "error", error: "Upload an image or PDF body" });
        const mimeType = req.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const filename = req.get("x-filename") || "upload";
        const data = await extractTextFromDocument({
          tenantId: req.user.tenantId,
          buffer: req.body,
          mimeType,
          filename,
          createdBy: req.user.id,
        });
        return res.status(201).json({ status: "ok", data });
      } catch (error) {
        if (bad(error) || error.message.includes("document size")) {
          return res.status(400).json({ status: "error", error: error.message });
        }
        return next(error);
      }
    },
  );
}
