export const ASSISTANT_MENTION_HANDLE = "nextalk";

// "@nextalk" as its own token: not preceded by a word char or "@" (so
// "me@nextalk.com" does not match) and not followed by a word char or "-".
const MENTION_RE = new RegExp(
  `(?<![\\w@])@${ASSISTANT_MENTION_HANDLE}(?![\\w-])`,
  "i",
);

export function containsAssistantMention(text) {
  return typeof text === "string" && MENTION_RE.test(text);
}
