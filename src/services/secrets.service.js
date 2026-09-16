import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey() {
  const rawKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();

  if (!rawKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  }

  let key;

  if (/^[a-fA-F0-9]{64}$/.test(rawKey)) {
    key = Buffer.from(rawKey, "hex");
  } else {
    try {
      key = Buffer.from(rawKey, "base64");
    } catch {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64 or 64-character hex");
    }
  }

  if (key.length !== KEY_LENGTH) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  return key;
}

export function encryptSecret(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Secret value is required");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(encryptedValue) {
  if (typeof encryptedValue !== "string" || !encryptedValue) {
    throw new Error("Encrypted secret is required");
  }

  const parts = encryptedValue.split(":");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted secret format");
  }

  const [, ivPart, authTagPart, ciphertextPart] = parts;

  let iv;
  let authTag;
  let ciphertext;

  try {
    iv = Buffer.from(ivPart, "base64url");
    authTag = Buffer.from(authTagPart, "base64url");
    ciphertext = Buffer.from(ciphertextPart, "base64url");
  } catch {
    throw new Error("Invalid encrypted secret encoding");
  }

  if (
    iv.length !== IV_LENGTH ||
    authTag.length !== AUTH_TAG_LENGTH ||
    ciphertext.length === 0
  ) {
    throw new Error("Invalid encrypted secret payload");
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt tenant credential");
  }
}
