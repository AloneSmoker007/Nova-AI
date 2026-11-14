import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiGenerator } from "../src/services/gemini.service.js";

const prompt = {
  systemInstruction: "trusted test policy",
  contents: [{ role: "user", parts: [{ text: "test" }] }],
};

test("client initialization failure happens before provider dispatch", async () => {
  let dispatched = false;
  const generate = createGeminiGenerator({
    getClientFn() {
      throw new Error("local client configuration failed");
    },
  });

  await assert.rejects(
    generate(prompt, { onProviderDispatch: () => { dispatched = true; } }),
    /local client configuration failed/,
  );
  assert.equal(dispatched, false);
});

test("dispatch callback fires exactly once immediately before the Gemini SDK call", async () => {
  const order = [];
  const generate = createGeminiGenerator({
    getClientFn() {
      return {
        models: {
          async generateContent() {
            order.push("sdk");
            return { text: "safe reply" };
          },
        },
      };
    },
  });

  const result = await generate(prompt, {
    onProviderDispatch: () => { order.push("dispatch"); },
  });

  assert.equal(result, "safe reply");
  assert.deepEqual(order, ["dispatch", "sdk"]);
});

test("provider rejection after dispatch preserves the uncertain-spend signal", async () => {
  let dispatchCount = 0;
  const generate = createGeminiGenerator({
    getClientFn() {
      return {
        models: {
          async generateContent() {
            throw new Error("provider unavailable");
          },
        },
      };
    },
  });

  await assert.rejects(
    generate(prompt, { onProviderDispatch: () => { dispatchCount += 1; } }),
    /Gemini request failed/,
  );
  assert.equal(dispatchCount, 1);
});
