import crypto from "crypto";
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";
import { generateGeminiReply } from "./services/gemini.service.js";
import { sendWhatsAppMessage } from "./services/whatsapp.service.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

app.disable("x-powered-by");
app.use(helmet());
app.use(compression());

// Capture raw body for Meta webhook signature verification.
app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
);

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

// Verify Meta X-Hub-Signature-256 header.
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) {
    return false;
  }

  const signature = req.get("x-hub-signature-256");

  if (!signature || !req.rawBody) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex")}`;

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// WhatsApp webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      console.warn("Invalid WhatsApp webhook signature");
      return res.sendStatus(403);
    }

    console.log("WhatsApp webhook received");

    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message?.text?.body || !message?.from) {
      return res.sendStatus(200);
    }

    const incomingMessage = message.text.body;
    const senderNumber = message.from;

    console.log("Incoming message:", incomingMessage);

    const reply = await generateGeminiReply(incomingMessage);

    console.log("Gemini reply:", reply);

    if (
      process.env.WHATSAPP_ACCESS_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID
    ) {
      await sendWhatsAppMessage(senderNumber, reply);
      console.log("WhatsApp reply sent");
    } else {
      console.log(
        "WhatsApp credentials not configured. Reply was generated but not sent.",
      );
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(200);
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