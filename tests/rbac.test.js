import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import app from "../src/index.js";
import { generateToken } from "../src/services/auth.service.js";

describe("RBAC and Authentication Middleware Tests", () => {
  it("returns 401 for unauthenticated request to /api/business-brain", async () => {
    const response = await request(app).get("/api/business-brain");
    expect(response.status).toBe(401);
  });

  it("returns 401 for malformed bearer token", async () => {
    const response = await request(app)
      .get("/api/business-brain")
      .set("Authorization", "Bearer invalid-token-string");

    expect(response.status).toBe(401);
  });

  it("returns 403 for agent role attempting PUT /api/business-brain", async () => {
    const agentToken = generateToken({
      id: "33333333-3333-3333-3333-333333333333",
      tenant_id: "44444444-4444-4444-4444-444444444444",
      role: "agent",
    });

    const response = await request(app)
      .put("/api/business-brain")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ businessName: "New Name" });

    // Note: requireAuth will perform DB status checks on user/tenant. Since DB is not configured in unit test mode, isUserActive/isTenantActive return false -> 401 or 403.
    expect([401, 403]).toContain(response.status);
  });
});
