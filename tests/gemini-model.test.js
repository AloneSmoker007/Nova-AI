import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GEMINI_MODEL,
  getGeminiModel,
} from "../src/config/gemini-model.js";

test("Gemini replies, Copilot and OCR share a supported non-retired default", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.6-flash");
  assert.equal(getGeminiModel({}), DEFAULT_GEMINI_MODEL);
  assert.equal(getGeminiModel({ GEMINI_MODEL: "" }), DEFAULT_GEMINI_MODEL);
  assert.equal(getGeminiModel({ GEMINI_MODEL: "   " }), DEFAULT_GEMINI_MODEL);
});

test("Gemini model may still be explicitly overridden for a supported deployment", () => {
  assert.equal(getGeminiModel({ GEMINI_MODEL: "gemini-3.8-flash" }), "gemini-3.8-flash");
  assert.equal(getGeminiModel({ GEMINI_MODEL: " gemini-3.8-flash " }), "gemini-3.8-flash");
});

test("retired Gemini 2.0 model overrides fail fast rather than spending quota on retries", () => {
  for (const retired of [
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-001",
  ]) {
    assert.throws(
      () => getGeminiModel({ GEMINI_MODEL: retired }),
      /GEMINI_MODEL .* is retired; select a supported model/,
    );
  }
});
