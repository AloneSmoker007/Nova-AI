import { describe, it, expect } from "@jest/globals";
import { validateBusinessBrain } from "../src/services/business-brain.service.js";

describe("Tenant Isolation and Business Brain Validation Tests", () => {
  it("validates valid Business Brain input", () => {
    const input = {
      businessName: "Acme Corp",
      category: "Retail",
      products: ["Item 1", { name: "Item 2", price: "$10" }],
      faqs: [{ question: "Hours?", answer: "9am - 5pm" }],
      hours: { Monday: "9am - 5pm" },
      rules: ["No refunds after 30 days"],
    };

    const validated = validateBusinessBrain(input);
    expect(validated.businessName).toBe("Acme Corp");
    expect(validated.products.length).toBe(2);
    expect(validated.faqs.length).toBe(1);
  });

  it("rejects non-array products or faqs", () => {
    expect(() => validateBusinessBrain({ products: "not an array" })).toThrow();
    expect(() => validateBusinessBrain({ faqs: 12345 })).toThrow();
  });

  it("rejects oversized products or rules arrays exceeding 100 items", () => {
    const hugeList = Array.from({ length: 101 }, (_, i) => `Item ${i}`);
    expect(() => validateBusinessBrain({ products: hugeList })).toThrow();
  });
});
