// One shared default for WhatsApp replies, Copilot drafts and OCR.
// Google shut down the Gemini 2.0 Flash family on 2026-06-01.
// Keep the operator override for supported models, but fail fast on the known
// retired identifiers instead of repeatedly burning AI reservations on 404s.
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
]);

export function getGeminiModel(env = process.env) {
  const configured = typeof env.GEMINI_MODEL === "string"
    ? env.GEMINI_MODEL.trim()
    : "";
  const model = configured || DEFAULT_GEMINI_MODEL;
  if (RETIRED_GEMINI_MODELS.has(model)) {
    throw new Error(
      `GEMINI_MODEL "${model}" is retired; select a supported model such as ${DEFAULT_GEMINI_MODEL}`,
    );
  }
  return model;
}
