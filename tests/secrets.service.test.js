import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { decryptSecret, encryptSecret } from "../src/services/secrets.service.js";

const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

test.after(() => {
  if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

test("encryptSecret and decryptSecret round-trip with a base64 key", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  const encrypted = encryptSecret("tenant-whatsapp-token");
  assert.equal(decryptSecret(encrypted), "tenant-whatsapp-token");
});

test("rejects malformed base64 key instead of silently decoding it", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64") + "!";

  assert.throws(
    () => encryptSecret("tenant-whatsapp-token"),
    /CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex/,
  );
});

test("rejects malformed base64url ciphertext components", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

  const encrypted = encryptSecret("tenant-whatsapp-token");
  const parts = encrypted.split(":");
  parts[1] = parts[1] + "!";

  assert.throws(
    () => decryptSecret(parts.join(":")),
    /Invalid encrypted secret encoding/,
  );
});

test("rejects non-canonical base64url padding", () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

  const encrypted = encryptSecret("tenant-whatsapp-token");
  const parts = encrypted.split(":");
  parts[1] = parts[1] + "=";

  assert.throws(
    () => decryptSecret(parts.join(":")),
    /Invalid encrypted secret encoding/,
  );
});
