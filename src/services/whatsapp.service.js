import axios from "axios";

export async function sendWhatsAppMessage(to, message) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!to || !message) {
    throw new Error("Recipient and message are required");
  }

  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp credentials are not configured");
  }

  const url = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;

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
      },
    );

    return response.data;
  } catch (error) {
    console.error(
      "WhatsApp API error:",
      error.response?.data || error.message,
    );

    throw new Error("Failed to send WhatsApp message");
  }
}