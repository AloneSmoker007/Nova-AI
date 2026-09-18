import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryStatusToMessageStatus,
} from "../src/services/whatsapp-delivery.service.js";
import {
  isAmbiguousWhatsAppSendError,
} from "../src/services/whatsapp.service.js";

test("delivery status mapping preserves provider lifecycle", () => {
  assert.equal(deliveryStatusToMessageStatus("SENT"), "sent");
  assert.equal(deliveryStatusToMessageStatus("DELIVERED"), "delivered");
  assert.equal(deliveryStatusToMessageStatus("READ"), "read");
  assert.equal(deliveryStatusToMessageStatus("FAILED"), "failed");
  assert.equal(deliveryStatusToMessageStatus("SENDING"), null);
});

test("ambiguous WhatsApp errors are isolated from definitive failures", () => {
  assert.equal(
    isAmbiguousWhatsAppSendError({ deliveryOutcome: "unknown" }),
    true,
  );
  assert.equal(
    isAmbiguousWhatsAppSendError({ deliveryOutcome: "failed" }),
    false,
  );
  assert.equal(isAmbiguousWhatsAppSendError(new Error("failed")), false);
});
