// Per-user sliding-window limit on assistant invocations. In-memory is
// sufficient for the single-instance deployment (roadmap §9.2); it resets on
// restart and is not shared across instances.
export const ASSISTANT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const ASSISTANT_RATE_MAX_CALLS = 10;

const hitsByUser = new Map(); // userId -> number[] (timestamps, ms)

export function tryConsumeAssistantQuota(userId, now = Date.now()) {
  const key = String(userId);
  const recent = (hitsByUser.get(key) ?? []).filter(
    (t) => now - t < ASSISTANT_RATE_WINDOW_MS,
  );

  if (recent.length >= ASSISTANT_RATE_MAX_CALLS) {
    hitsByUser.set(key, recent);
    return false;
  }

  recent.push(now);
  hitsByUser.set(key, recent);
  return true;
}

// Test helper.
export function resetAssistantQuota() {
  hitsByUser.clear();
}
