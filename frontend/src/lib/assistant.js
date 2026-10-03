// Client-side constants/helpers for the AI assistant. The mention handle must
// match ASSISTANT_MENTION_HANDLE on the backend (backend/src/lib/ai/mention.js).
export const ASSISTANT_MENTION = "@nextalk";

// "@nextalk" as its own token (not "me@nextalk.com", "@nextalks", "@nextalk-x").
const MENTION_RE = /(?<![\w@])@nextalk(?![\w-])/i;

// Adds the mention to the front of the composer text unless one is already
// there, so pressing the assistant button twice does not duplicate it.
export function withAssistantMention(text) {
  const value = typeof text === "string" ? text : "";
  if (MENTION_RE.test(value)) return value;
  return `${ASSISTANT_MENTION} ${value}`;
}

const ASSISTANT_ERROR_MESSAGES = {
  rate_limited:
    "You've reached the assistant limit. Try again in a few minutes.",
  unavailable: "The assistant is unavailable right now.",
};

// Maps the server's reason code (never provider error text) to user copy.
export function assistantErrorMessage(reason) {
  return (
    ASSISTANT_ERROR_MESSAGES[reason] ?? ASSISTANT_ERROR_MESSAGES.unavailable
  );
}
