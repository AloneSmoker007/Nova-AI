import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function generateGeminiReply(message) {
  if (!message || typeof message !== "string") {
    throw new Error("Message is required");
  }

  const response = await ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: message,
  });

  return response.text;
}
