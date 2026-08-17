import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MAX_MESSAGE_LENGTH = 8000;
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL = "gemini-3.6-flash";

let client;

function getClient() {
  if (client) {
    return client;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("Gemini service is not configured correctly");
  }

  client = new GoogleGenAI({
    apiKey,
  });

  return client;
}

export async function generateGeminiReply(message) {
  if (!message || typeof message !== "string") {
    throw new Error("Message is required");
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    throw new Error("Message is required");
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`,
    );
  }

  const ai = getClient();

  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response;

  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: trimmed,
      config: {
        abortSignal: controller.signal,
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Gemini request timed out");
    }

    throw new Error("Gemini request failed");
  } finally {
    clearTimeout(timeoutId);
  }

  const text =
    typeof response?.text === "string" ? response.text.trim() : "";

  if (!text) {
    throw new Error("Gemini returned no usable response");
  }

  return text;
}