import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateGeminiReply } from "./services/gemini.service.js";

// This diagnostic can call a paid external provider. Importing or discovering
// this file with `node --test` must never make a network request.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const explicitlyEnabled = process.env.RUN_GEMINI_LIVE_TEST === "1";
const runningUnderNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);

if (!invokedDirectly || !explicitlyEnabled || runningUnderNodeTest) {
  console.log("Live Gemini diagnostic skipped. Run directly with RUN_GEMINI_LIVE_TEST=1 to opt in.");
} else {
  try {
    const reply = await generateGeminiReply(
      "Reply with exactly: Nova-AI Gemini test successful.",
    );

    console.log("Gemini response:");
    console.log(reply);
  } catch (error) {
    console.error("Gemini test failed:", error.message);
    process.exitCode = 1;
  }
}
