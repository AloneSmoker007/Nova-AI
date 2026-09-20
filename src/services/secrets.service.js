import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function decodeBase64Strict(value, encoding) {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid encrypted secret encoding");
  }

  const isBase64Url = encoding === "base64url";
  const pattern = isBase64Url
    ? /^[A-Za-z0-9_-]*$/
    : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!pattern.test(value)) {
    throw new Error("Invalid encrypted secret encoding");
  }

  if (isBase64Url && value.length % 4 === 1) {
    throw new Error("Invalid encrypted secret encoding");
  }

  const decoded = Buffer.from(value, encoding);
  const canonical = decoded.toString(encoding);

  if (canonical !== value) {
    throw new Error("Invalid encrypted secret encoding");
  }

  return decoded;
}

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
      key = decodeBase64Strict(rawKey, "base64");
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
    iv = decodeBase64Strict(ivPart, "base64url");
    authTag = decodeBase64Strict(authTagPart, "base64url");
    ciphertext = decodeBase64Strict(ciphertextPart, "base64url");
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
