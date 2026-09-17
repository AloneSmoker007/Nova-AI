import crypto from "node:crypto";
import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import app, { extractWebhookMessages } from "../src/index.js";

describe("Webhook Verification & Endpoint Tests", () => {
  it("verifies GET /webhook with valid token and challenge", async () => {
    const response = await request(app)
      .get("/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": process.env.WEBHOOK_VERIFY_TOKEN,
        "hub.challenge": "test_challenge_12345",
      });

    expect(response.status).toBe(200);
    expect(response.text).toBe("test_challenge_12345");
  });

  it("rejects GET /webhook with invalid verify token", async () => {
    const response = await request(app)
      .get("/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong_token",
        "hub.challenge": "test_challenge_12345",
      });

    expect(response.status).toBe(403);
  });

  it("rejects POST /webhook with missing signature", async () => {
    const response = await request(app)
      .post("/webhook")
      .send({ entry: [] });

    expect(response.status).toBe(403);
  });

  it("accepts POST /webhook with valid HMAC signature", async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  { id: "wamid.123", from: "1234567890", text: { body: "Hello AI" } },
                ],
              },
            },
          ],
        },
      ],
    });

    const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;

    const response = await request(app)
      .post("/webhook")
      .set("x-hub-signature-256", signature)
      .set("Content-Type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
  });

  it("extracts multiple messages from nested entry webhook payload", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "100200300" },
                contacts: [{ profile: { name: "Alice" } }],
                messages: [
                  { id: "m1", from: "1111", text: { body: "Msg 1" } },
                  { id: "m2", from: "1111", text: { body: "Msg 2" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const extracted = extractWebhookMessages(payload);
    expect(extracted.length).toBe(2);
    expect(extracted[0].id).toBe("m1");
    expect(extracted[1].id).toBe("m2");
    expect(extracted[0].phoneNumberId).toBe("100200300");
  });
});
