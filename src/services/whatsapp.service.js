import axios from "axios";

const WHATSAPP_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 4096;

function validateCredentials(accessToken, phoneNumberId) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("WhatsApp access token is required");
  }

  if (
    typeof phoneNumberId !== "string" ||
    !/^\d{5,30}$/.test(phoneNumberId)
  ) {
    throw new Error("Invalid WhatsApp phone number ID");
  }
}

function validateRecipient(to) {
  if (typeof to !== "string" || !/^\d{7,15}$/.test(to.trim())) {
    throw new Error("Invalid WhatsApp recipient number");
  }

  return to.trim();
}

function validateMessage(message) {
  if (typeof message !== "string") {
    throw new Error("Valid message is required");
  }

  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    throw new Error("Valid message is required");
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new Error("WhatsApp message is too long");
  }

  return trimmedMessage;
}

export async function sendWhatsAppMessage({
  to,
  message,
  accessToken,
  phoneNumberId,
}) {
  validateCredentials(accessToken, phoneNumberId);

  const recipient = validateRecipient(to);
  const body = validateMessage(message);
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: {
          body,
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
