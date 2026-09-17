import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "ci-test-secret-minimum-32-chars-long";
process.env.JWT_ISSUER = "nova-ai";
process.env.JWT_AUDIENCE = "nova-ai-api";

const { hashPassword, verifyPassword, generateToken, verifyToken } = await import("../src/services/auth.service.js");

test("password hashing verifies the correct password and rejects the wrong one", async () => {
  const password = "SuperSecretPassword123!";
  const hash = await hashPassword(password);

  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("WrongPassword", hash), false);
});

test("identical passwords receive different salted hashes", async () => {
  const password = "SamePassword123!";
  const hash1 = await hashPassword(password);
  const hash2 = await hashPassword(password);

  assert.notEqual(hash1, hash2);
});

test("JWT contains the expected tenant and role claims", () => {
  const user = {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "22222222-2222-2222-2222-222222222222",
    role: "admin",
  };

  const token = generateToken(user);
  const decoded = verifyToken(token);

  assert.equal(decoded.sub, user.id);
  assert.equal(decoded.tenantId, user.tenant_id);
  assert.equal(decoded.role, user.role);
  assert.equal(decoded.iss, process.env.JWT_ISSUER);
  assert.equal(decoded.aud, process.env.JWT_AUDIENCE);
});

test("invalid JWT is rejected", () => {
  assert.throws(() => verifyToken("invalid.token.string"));
});
