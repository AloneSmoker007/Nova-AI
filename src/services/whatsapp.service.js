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

  if (!/^\d{7,15}$/.test(to)) {
    throw new Error("Invalid WhatsApp recipient number");
  }

  if (!message || typeof message !== "string") {
    throw new Error("Valid message is required");
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
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
        to,
        type: "text",
        text: {
          body: message,
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
    const apiError = error.response?.data;

    console.error("WhatsApp API error:", {
      status: error.response?.status,
      data: apiError || error.message,
    });

    throw new Error("Failed to send WhatsApp message");
  }
}