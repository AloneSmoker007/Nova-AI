import { describe, it, expect } from "@jest/globals";
import { hashPassword, verifyPassword, generateToken, verifyToken } from "../src/services/auth.service.js";

describe("Auth Service Tests", () => {
  it("hashes password and verifies correctly", async () => {
    const password = "SuperSecretPassword123!";
    const hash = await hashPassword(password);
    expect(hash).not.toEqual(password);

    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);

    const isInvalid = await verifyPassword("WrongPassword", hash);
    expect(isInvalid).toBe(false);
  });

  it("hashes identical passwords to different salt hashes", async () => {
    const password = "SamePassword123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toEqual(hash2);
  });

  it("generates and verifies JWT token successfully", () => {
    const user = {
      id: "11111111-1111-1111-1111-111111111111",
      tenant_id: "22222222-2222-2222-2222-222222222222",
      role: "admin",
    };

    const token = generateToken(user);
    expect(typeof token).toBe("string");

    const decoded = verifyToken(token);
    expect(decoded.sub).toBe(user.id);
    expect(decoded.tenantId).toBe(user.tenant_id);
    expect(decoded.role).toBe(user.role);
    expect(decoded.iss).toBe(process.env.JWT_ISSUER);
    expect(decoded.aud).toBe(process.env.JWT_AUDIENCE);
  });

  it("fails verification with invalid token string", () => {
    expect(() => verifyToken("invalid.token.str")).toThrow();
  });
});
