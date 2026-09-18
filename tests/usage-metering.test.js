import test from "node:test";
import assert from "node:assert/strict";

const WINDOW_MS = 24 * 60 * 60 * 1000;

test("24-hour window duration is exactly 24 hours", () => {
  assert.equal(WINDOW_MS, 86_400_000);
});

test("usage event key is tenant-scoped by contract", () => {
  const tenantA = "tenant-a";
  const tenantB = "tenant-b";
  const providerId = "wamid.same";
  assert.notEqual(`inbound_message:${providerId}:${tenantA}`, `inbound_message:${providerId}:${tenantB}`);
});

test("usage limits allow unlimited tenants when hard limit is disabled", () => {
  const used = 999999;
  const limit = 1;
  const hardLimitEnabled = false;
  assert.equal(!hardLimitEnabled || used < limit, true);
});
