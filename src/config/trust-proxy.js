/**
 * Resolve the Express trusted proxy hop count from explicit deployment config.
 * Never trust all forwarding headers by default: that lets direct callers spoof
 * client IPs and bypass IP-based abuse controls.
 */
export function getTrustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") return false;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
  }

  return value === 0 ? false : value;
}
