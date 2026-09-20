import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { decryptSecret, encryptSecret } from "../src/services/secrets.service.js";

const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

test.after(() => {
  if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

test("round-trips with a 32-byte padded base64 key", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  const encrypted = encryptSecret("tenant-whatsapp-token");
  assert.equal(decryptSecret(encrypted), "tenant-whatsapp-token");
});

test("round-trips with a 32-byte unpadded base64 key", () => {
  const padded = crypto.randomBytes(32).toString("base64");
  process.env.CREDENTIAL_ENCRYPTION_KEY = padded.replace(/=+$/, "");
  const encrypted = encryptSecret("tenant-whatsapp-token");
  assert.equal(decryptSecret(encrypted), "tenant-whatsapp-token");
});

test("round-trips with a 64-character hex key", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const encrypted = encryptSecret("tenant-whatsapp-token");
  assert.equal(decryptSecret(encrypted), "tenant-whatsapp-token");
});

test("rejects illegal base64 characters in the encryption key", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64") + "!";
  assert.throws(
    () => encryptSecret("tenant-whatsapp-token"),
    /CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex/,
  );
});

test("rejects malformed base64 padding in the encryption key", () => {
  const valid = crypto.randomBytes(32).toString("base64").replace(/=+$/, "");
  process.env.CREDENTIAL_ENCRYPTION_KEY = valid + "=";
  assert.throws(
    () => encryptSecret("tenant-whatsapp-token"),
    /CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex/,
  );
});

test("rejects impossible base64 length in the encryption key", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "A";
  assert.throws(
    () => encryptSecret("tenant-whatsapp-token"),
    /CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex/,
  );
});

test("rejects malformed base64url ciphertext components", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const parts = encryptSecret("tenant-whatsapp-token").split(":");
  parts[1] += "!";
  assert.throws(
    () => decryptSecret(parts.join(":")),
    /Invalid encrypted secret encoding/,
  );
});

test("rejects non-canonical base64url padding", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const parts = encryptSecret("tenant-whatsapp-token").split(":");
  parts[1] += "=";
  assert.throws(
    () => decryptSecret(parts.join(":")),
    /Invalid encrypted secret encoding/,
  );
});

test("rejects tampered ciphertext", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const parts = encryptSecret("tenant-whatsapp-token").split(":");
  const last = parts[3];
  parts[3] = (last[0] === "A" ? "B" : "A") + last.slice(1);
  assert.throws(() => decryptSecret(parts.join(":")), /Failed to decrypt tenant credential/);
});
