import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { analyzeCustomerMessage, getCustomerMemory, rememberCustomerPreference } from "../services/advanced-ai.service.js";

const router = Router();

router.get("/contacts/:contactId/ai-memory", requireAuth, async (req, res, next) => {
  try {
    const data = await getCustomerMemory(req.user.tenantId, req.params.contactId);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return next(error);
  }
});

router.post("/contacts/:contactId/ai-memory", requireAuth, async (req, res, next) => {
  try {
    const data = await rememberCustomerPreference(
      req.user.tenantId,
      req.params.contactId,
      req.body?.key,
      req.body?.value,
      req.body?.confidence,
    );
    return res.status(201).json({ status: "ok", data });
  } catch (error) {
    if (error.message.startsWith("Invalid")) return res.status(400).json({ status: "error", error: error.message });
    return next(error);
  }
});

router.post("/ai/analyze", requireAuth, async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 4000) {
    return res.status(400).json({ status: "error", error: "Invalid message" });
  }
  return res.status(200).json({ status: "ok", data: await analyzeCustomerMessage(message) });
});

export default router;
