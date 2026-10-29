import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

import {
  isAmbiguousWhatsAppSendError,
  sendWhatsAppMessage,
} from "../src/services/whatsapp.service.js";

const TEST_TOKEN = "SYNTHETIC_NOT_A_REAL_META_TOKEN";

function params(overrides = {}) {
  return {
    to: "15551234567",
    message: "  Hello from Nova  ",
    accessToken: TEST_TOKEN,
    phoneNumberId: "123456789012345",
    callbackData: "  inbox-demo  ",
    ...overrides,
  };
}

// No external API calls. A failing assertion still restores the shared client.
async function withPostStub(stub, run) {
  const original = axios.post;
  axios.post = stub;
  try {
    return await run();
  } finally {
    axios.post = original;
  }
}

test("WhatsApp send constructs the authorized, bounded Cloud API request", async () => {
  let sent;
  const response = { messages: [{ id: "wamid-synthetic" }] };
  await withPostStub(async (...args) => {
    sent = args;
    return { data: response };
  }, async () => {
    assert.deepEqual(await sendWhatsAppMessage(params()), response);
  });

  const [url, body, options] = sent;
  const target = new URL(url);
  assert.equal(target.protocol, "https:");
  assert.equal(target.hostname, "graph.facebook.com");
  assert.equal(target.pathname.endsWith("/123456789012345/messages"), true);
  assert.deepEqual(body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "15551234567",
    type: "text",
    biz_opaque_callback_data: "inbox-demo",
    text: { body: "Hello from Nova" },
  });
  assert.equal(options.headers.Authorization, "Bearer " + TEST_TOKEN);
  assert.equal(options.timeout, 15_000);
});

test("definitive provider errors never retain bearer tokens or raw Axios config", async () => {
  const syntheticSecret = "SYNTHETIC_ACCESS_TOKEN_DO_NOT_USE";
  const upstream = Object.assign(new Error("Bearer " + syntheticSecret), {
    code: "ERR_BAD_REQUEST",
    response: { status: 400, data: { detail: syntheticSecret } },
    config: { headers: { Authorization: "Bearer " + syntheticSecret } },
  });

  const logs = [];
  const originalLog = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    await withPostStub(async () => { throw upstream; }, async () => {
      await assert.rejects(
        sendWhatsAppMessage(params({ accessToken: syntheticSecret })),
        (error) => {
          assert.equal(error.message, "Failed to send WhatsApp message");
          assert.equal(error.code, "WHATSAPP_SEND_FAILED");
          assert.equal(error.deliveryOutcome, "failed");
          assert.equal(error.providerStatus, 400);
          assert.equal(error.transportCode, "ERR_BAD_REQUEST");
          assert.equal(error.cause, undefined, "do not attach the raw Axios error");
          assert.equal(isAmbiguousWhatsAppSendError(error), false);
          assert.ok(!JSON.stringify(error).includes(syntheticSecret));
          return true;
        },
      );
    });
  } finally {
    console.error = originalLog;
  }
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes(syntheticSecret));
});

test("timeouts and HTTP 5xx preserve ambiguous-delivery outcome without raw provider data", async () => {
  for (const upstream of [
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("HTTP 503"), { code: "ERR_BAD_RESPONSE", response: { status: 503 } }),
  ]) {
    const originalLog = console.error;
    console.error = () => {};
    try {
      await withPostStub(async () => { throw upstream; }, async () => {
        await assert.rejects(
          sendWhatsAppMessage(params()),
          (error) => {
            assert.equal(error.code, "WHATSAPP_SEND_FAILED");
            assert.equal(error.deliveryOutcome, "unknown");
            assert.equal(isAmbiguousWhatsAppSendError(error), true);
            assert.equal(error.cause, undefined);
            return true;
          },
        );
      });
    } finally {
      console.error = originalLog;
    }
  }
});

test("invalid credentials, recipients, messages and callback data never call Meta", async () => {
  let networkCalls = 0;
  await withPostStub(async () => {
    networkCalls += 1;
    throw new Error("Unexpected network call");
  }, async () => {
    const invalid = [
      { accessToken: " " },
      { phoneNumberId: "not-numeric" },
      { to: "not-a-number" },
      { message: "   " },
      { message: "x".repeat(4097) },
      { callbackData: "x".repeat(513) },
    ];
    for (const override of invalid) {
      await assert.rejects(sendWhatsAppMessage(params(override)));
    }
  });
  assert.equal(networkCalls, 0);
});
