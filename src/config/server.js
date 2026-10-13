const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function getServerPort(env = process.env) {
  const raw = env.PORT;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return DEFAULT_PORT;
  }

  return port;
}
