import "dotenv/config";
import { generateGeminiReply } from "./services/gemini.service.js";

try {
  const reply = await generateGeminiReply(
    "Reply with exactly: Nova-AI Gemini test successful."
  );

  console.log("Gemini response:");
  console.log(reply);
} catch (error) {
  console.error("Gemini test failed:", error.message);
  process.exitCode = 1;
}