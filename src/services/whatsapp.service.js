import axios from "axios";
import logger from "../config/logger.js";

const WHATSAPP_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

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

function shouldRetry(error) {
  if (error.code === "ECONNABORTED" || !error.response) {
    return true;
  }
  const status = error.response.status;
  return status >= 500 || status === 429;
}

export async function sendWhatsAppMessage({
  to,
  message,
  accessToken,
  phoneNumberId,
  requestId,
}) {
  validateCredentials(accessToken, phoneNumberId);

  const recipient = validateRecipient(to);
  const body = validateMessage(message);
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  if (requestId && typeof requestId === "string") {
    headers["X-Request-ID"] = requestId;
  }

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
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
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      return response.data;
    } catch (error) {
      const isRetryable = shouldRetry(error);
      const isTimeout = error.code === "ECONNABORTED";

      logger.error({
        attempt,
        category: isTimeout
          ? "timeout"
          : error.response
            ? "api_error"
            : "network_error",
        status: error.response?.status,
        retryable: isRetryable && attempt < MAX_RETRIES,
      }, "WhatsApp API error");

      if (!isRetryable || attempt >= MAX_RETRIES) {
        throw new Error("Failed to send WhatsApp message");
      }

      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw new Error("Failed to send WhatsApp message");
}
