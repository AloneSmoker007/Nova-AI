import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIncomingWebhookContent } from "../src/services/webhook-inbox.service.js";

test("normalizes text messages without changing their message type", () => {
  assert.deepEqual(
    normalizeIncomingWebhookContent({ type: "text", text: { body: "  Hello there  " } }),
    { messageType: "text", body: "Hello there", isText: true },
  );
});

test("preserves media captions and uses safe placeholders when media has no caption", () => {
  assert.deepEqual(
    normalizeIncomingWebhookContent({ type: "image", image: { caption: "My damaged parcel" } }),
    { messageType: "image", body: "My damaged parcel", isText: false },
  );
  assert.deepEqual(
    normalizeIncomingWebhookContent({ type: "image", image: { id: "media-123" } }),
    { messageType: "image", body: "[Image received]", isText: false },
  );
  assert.equal(
    normalizeIncomingWebhookContent({ type: "video", video: {} }).body,
    "[Video received]",
  );
  assert.equal(
    normalizeIncomingWebhookContent({ type: "audio", audio: {} }).body,
    "[Audio message received]",
  );
  assert.equal(
    normalizeIncomingWebhookContent({ type: "document", document: {} }).body,
    "[Document received]",
  );
});

test("preserves user intent for supported interactive message types", () => {
  assert.deepEqual(
    normalizeIncomingWebhookContent({
      type: "interactive",
      interactive: { button_reply: { title: "Track my order" } },
    }),
    { messageType: "interactive", body: "Selected option: Track my order", isText: false },
  );
  assert.equal(
    normalizeIncomingWebhookContent({ type: "location", location: { latitude: 31.4, longitude: 73.1 } }).body,
    "[Location shared]",
    "the placeholder confirms a location was shared without exposing coordinates in the text field",
  );
  assert.equal(
    normalizeIncomingWebhookContent({ type: "reaction", reaction: { emoji: "👍" } }).body,
    "Reaction received: 👍",
  );
});

test("unknown and missing message types are represented instead of silently dropped", () => {
  assert.deepEqual(
    normalizeIncomingWebhookContent({ type: "poll_update", poll_update: {} }),
    { messageType: "unsupported", body: "[Unsupported WhatsApp message received]", isText: false },
  );
  assert.deepEqual(
    normalizeIncomingWebhookContent({ type: "text", text: {} }),
    { messageType: "unsupported", body: "[Message content unavailable]", isText: false },
  );
});

test("normalizer removes NUL and other forbidden control characters from stored text", () => {
  const normalized = normalizeIncomingWebhookContent({
    type: "image",
    image: { caption: "broken\u0000 parcel\u0007 photo" },
  });
  assert.equal(normalized.body, "broken  parcel  photo");
  assert.equal(normalized.messageType, "image");
  assert.equal(normalized.isText, false);
});
