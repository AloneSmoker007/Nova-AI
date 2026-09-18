import axios from "axios";

const WHATSAPP_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CALLBACK_DATA_LENGTH = 512;

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EAI_AGAIN",
]);

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

function validateCallbackData(callbackData) {
  if (callbackData === undefined || callbackData === null) return null;

  if (
    typeof callbackData !== "string" ||
    !callbackData.trim() ||
    callbackData.trim().length > MAX_CALLBACK_DATA_LENGTH
  ) {
    throw new Error("Invalid WhatsApp callback data");
  }

  return callbackData.trim();
}

function createSendError(message, outcome, originalError) {
  const error = new Error(message);
  error.code = "WHATSAPP_SEND_FAILED";
  error.deliveryOutcome = outcome;
  error.cause = originalError;
  return error;
}

function isAmbiguousTransportError(error) {
  if (!error) return false;

  if (TRANSIENT_ERROR_CODES.has(error.code)) {
    return true;
  }

  const status = error.response?.status;
  return typeof status === "number" && status >= 500;
}

export function isAmbiguousWhatsAppSendError(error) {
  return error?.deliveryOutcome === "unknown";
}

export async function sendWhatsAppMessage({
  to,
  message,
  accessToken,
  phoneNumberId,
  callbackData,
}) {
  validateCredentials(accessToken, phoneNumberId);

  const recipient = validateRecipient(to);
  const body = validateMessage(message);
  const trackingData = validateCallbackData(callbackData);
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        ...(trackingData ? { biz_opaque_callback_data: trackingData } : {}),
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
    const ambiguous = isAmbiguousTransportError(error);
    const status = error.response?.status;

    console.error("WhatsApp API error:", {
      category: ambiguous
        ? "ambiguous_delivery_outcome"
        : status
          ? "api_error"
          : "unknown",
      status,
      code: error.code,
    });

    if (ambiguous) {
      throw createSendError(
        "WhatsApp send outcome is unknown; delivery reconciliation is required",
        "unknown",
        error,
      );
    }

    throw createSendError("Failed to send WhatsApp message", "failed", error);
  }
}
