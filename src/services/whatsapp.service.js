import axios from "axios";

const WHATSAPP_API_VERSION = "v23.0";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 4096;

export async function sendWhatsAppMessage(to, message) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!to || typeof to !== "string") {
    throw new Error("Valid recipient is required");
  }

  const trimmedTo = to.trim();

  if (!/^\d{7,15}$/.test(trimmedTo)) {
    throw new Error("Invalid WhatsApp recipient number");
  }

  if (!message || typeof message !== "string") {
    throw new Error("Valid message is required");
  }

  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    throw new Error("Valid message is required");
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new Error("WhatsApp message is too long");
  }

  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp credentials are not configured");
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: trimmedTo,
        type: "text",
        text: {
          body: trimmedMessage,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );

    return response.data;
  } catch (error) {
    const isTimeout = error.code === "ECONNABORTED";

    // Safe diagnostics only: never log tokens, phone numbers,
    // message content, or the raw Meta response body.
    console.error("WhatsApp API error:", {
      category: isTimeout
        ? "timeout"
        : error.response
          ? "api_error"
          : "unknown",
      status: error.response?.status,
    });

    throw new Error("Failed to send WhatsApp message");
  }
}
