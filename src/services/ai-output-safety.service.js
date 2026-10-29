/**
 * Deterministic, fail-closed checks for high-confidence model-output leaks.
 *
 * This is a last-line output policy, not a substitute for red-team testing or
 * business-specific validation. Unsafe/ambiguous output must never cross into
 * persistence, a customer-facing message, or a copilot draft.
 */
export const SAFE_AI_FALLBACK =
  "I'm sorry, I can't safely answer that. Please contact the business directly for assistance.";

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i;
const PROVIDER_TOKEN = /\b(?:AIza[0-9A-Za-z_-]{25,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/;
// JSON and quoted object fields put a closing quote between the label and colon.
const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[\s_-]?key|client[\s_-]?secret|access[\s_-]?token|refresh[\s_-]?token|password)["']?\s*[:=]\s*["']?[^\s"'<>]{12,}/i;
// Quoted JSON/object credential values may contain spaces and still be secrets.
// Detect the entire quoted field; do not require a long whitespace-free first token.
const QUOTED_CREDENTIAL_FIELD =
  /\b(?:api[\s_-]?key|client[\s_-]?secret|access[\s_-]?token|refresh[\s_-]?token|password)["']\s*:\s*(["'])(?:(?!\1)[^\r\n])+\1/i;
const INSTRUCTION_DISCLOSURE =
  /\b(?:here(?:'s| is)|below is|my|the)\s+(?:the\s+)?(?:hidden\s+)?(?:system prompt|system instructions|developer instructions)\b/i;
const INTERNAL_MEMORY_MARKUP = /<\/?(?:customer_memory|memory)(?:\s|>|\/)/i;

function hasUnsafeInvisibleControls(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x200b ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export function inspectGeneratedAiOutput(value, maxLength = 4096) {
  if (typeof value !== "string" || value.trim() === "") {
    return { safe: false, reason: "empty_or_non_string" };
  }

  const output = value.trim();
  if (output.length > maxLength) {
    return { safe: false, reason: "response_too_long" };
  }

  if (hasUnsafeInvisibleControls(output)) {
    return { safe: false, reason: "control_or_bidi_character" };
  }

  const patterns = [
    ["private_key", PRIVATE_KEY],
    ["jwt", JWT],
    ["bearer_token", BEARER_TOKEN],
    ["provider_token", PROVIDER_TOKEN],
    ["credential_assignment", CREDENTIAL_ASSIGNMENT],
    ["credential_assignment", QUOTED_CREDENTIAL_FIELD],
    ["system_instruction_disclosure", INSTRUCTION_DISCLOSURE],
    ["internal_memory_markup", INTERNAL_MEMORY_MARKUP],
  ];

  for (const [reason, pattern] of patterns) {
    if (pattern.test(output)) return { safe: false, reason };
  }

  return { safe: true, reason: null };
}

export function enforceGeneratedAiOutput(value, maxLength = 4096) {
  const decision = inspectGeneratedAiOutput(value, maxLength);
  if (!decision.safe) {
    return { ...decision, text: SAFE_AI_FALLBACK };
  }
  return { ...decision, text: value.trim() };
}
