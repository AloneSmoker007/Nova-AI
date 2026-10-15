import assert from "node:assert/strict";
import test from "node:test";

import { getTrustProxySetting } from "../src/config/trust-proxy.js";

test("trust proxy is disabled unless deployment explicitly configures trusted hops", () => {
  assert.equal(getTrustProxySetting({}), false);
  assert.equal(getTrustProxySetting({ TRUST_PROXY_HOPS: "" }), false);
  assert.equal(getTrustProxySetting({ TRUST_PROXY_HOPS: "0" }), false);
});

test("trust proxy accepts only bounded explicit hop counts", () => {
  assert.equal(getTrustProxySetting({ TRUST_PROXY_HOPS: "1" }), 1);
  assert.equal(getTrustProxySetting({ TRUST_PROXY_HOPS: "2" }), 2);
  assert.equal(getTrustProxySetting({ TRUST_PROXY_HOPS: "5" }), 5);

  for (const value of ["true", "all", "-1", "6", "1.5", "NaN", "Infinity"]) {
    assert.throws(
      () => getTrustProxySetting({ TRUST_PROXY_HOPS: value }),
      /TRUST_PROXY_HOPS must be an integer between 0 and 5/,
    );
  }
});
