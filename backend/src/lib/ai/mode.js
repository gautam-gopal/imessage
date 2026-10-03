// Which prompt variant a mention gets. Deterministic keyword/shape rules, not
// an extra model call: cheap, testable, and no added cost or latency. All
// three modes run through the same pipeline (auth, rate limit, context, one
// OpenAI call, ordinary Message); they differ only in prompt construction.
export const ASSISTANT_MODES = Object.freeze({
  REPLY: "reply",
  CODE: "code",
  SUMMARY: "summary",
});

const FENCED_CODE = /```/;
const EXPLAIN_VERB = /\b(explain|walk me through|what does|how does)\b/i;
const CODE_NOUN = /\b(code|function|snippet|script|regex|query)\b/i;
const SUMMARY_WORD = /\b(summari[sz]e|summary|tl;?dr|recap|catch me up)\b/i;

// Order matters: a request that contains code ("summarise this code") is a
// code request, so code is checked before summary.
export function detectAssistantMode(text) {
  const value = typeof text === "string" ? text : "";

  if (FENCED_CODE.test(value)) return ASSISTANT_MODES.CODE;
  if (EXPLAIN_VERB.test(value) && CODE_NOUN.test(value)) {
    return ASSISTANT_MODES.CODE;
  }
  if (SUMMARY_WORD.test(value)) return ASSISTANT_MODES.SUMMARY;

  return ASSISTANT_MODES.REPLY;
}
