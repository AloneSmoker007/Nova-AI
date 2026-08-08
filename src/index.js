import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";
import { generateGeminiReply } from "./services/gemini.service.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Basic security
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "100kb" }));

// Health check
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Nova-AI",
    message: "Nova-AI server is running",
  });
});

// WhatsApp webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// WhatsApp webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    console.log("WhatsApp webhook received");

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message?.text?.body) {
      return res.sendStatus(200);
    }

    const incomingMessage = message.text.body;

    console.log("Incoming message:", incomingMessage);

    const reply = await generateGeminiReply(incomingMessage);

    console.log("Gemini reply:", reply);

    return res.status(200).json({
      status: "ok",
      reply,
    });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({
      status: "error",
      message: "Webhook processing failed",
    });
  }
});

// Gemini test endpoint
app.post("/api/test/gemini", async (req, res) => {
  try {
    const reply = await generateGeminiReply(req.body?.message);

    return res.status(200).json({
      status: "ok",
      reply,
    });
  } catch (error) {
    console.error("Gemini test error:", error);

    return res.status(500).json({
      status: "error",
      message: "Gemini request failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Nova-AI server running on port ${PORT}`);
});
