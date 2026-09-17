import axios from "axios";

const WHATSAPP_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
]);

function isTransientError(error) {
  if (!error) return false;

  if (TRANSIENT_ERROR_CODES.has(error.code)) {
    return true;
  }

  const status = error.response?.status;
  if (typeof status === "number" && status >= 500) {
    return true;
  }

  return false;
}

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

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
      lastError = error;

      if (!isTransientError(error) || attempt === MAX_RETRIES) {
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

      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.error(
        `WhatsApp API transient error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms`,
        {
          code: error.code,
          status: error.response?.status,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error("WhatsApp API error:", {
    category: "unknown",
    status: lastError?.response?.status,
  });

  throw new Error("Failed to send WhatsApp message");
}
