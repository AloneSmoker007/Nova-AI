const PROCESSING_TTL_MS = 10 * 60 * 1000;
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const processingMessages = new Map();
const completedMessages = new Map();

function pruneExpired(map, now) {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) {
      map.delete(key);
    }
  }
}

function enforceLimit(map) {
  while (map.size > MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

export function claimMessage(messageId) {
  if (typeof messageId !== "string" || !messageId.trim()) {
    return { claimed: false, reason: "invalid" };
  }

  const id = messageId.trim();
  const now = Date.now();

  pruneExpired(processingMessages, now);
  pruneExpired(completedMessages, now);

  if (processingMessages.has(id)) {
    return { claimed: false, reason: "processing" };
  }

  if (completedMessages.has(id)) {
    return { claimed: false, reason: "completed" };
  }

  processingMessages.set(id, now + PROCESSING_TTL_MS);
  enforceLimit(processingMessages);

  return { claimed: true, reason: "new" };
}

export function markMessageCompleted(messageId) {
  if (typeof messageId !== "string" || !messageId.trim()) {
    return;
  }

  const id = messageId.trim();
  processingMessages.delete(id);
  completedMessages.set(id, Date.now() + COMPLETED_TTL_MS);
  enforceLimit(completedMessages);
}

export function releaseMessage(messageId) {
  if (typeof messageId !== "string" || !messageId.trim()) {
    return;
  }

  processingMessages.delete(messageId.trim());
}
