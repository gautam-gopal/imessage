import OpenAI from "openai";

// Server-only configuration (set in the backend environment / Render
// dashboard; never in frontend env, a VITE_* variable, a Docker ARG/ENV, or
// source control):
//   OPENAI_API_KEY  required for the assistant; without it the assistant
//                   reports "unavailable" and the rest of the app is unaffected
//   OPENAI_MODEL    optional, defaults to gpt-4o

const DEFAULT_MODEL = "gpt-4o";
const MAX_REPLY_TOKENS = 700;

let client;

// Built lazily so importing this module never throws when the key is absent
// (unlike lib/imagekit.js). The key is read from backend env only.
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  client ??= new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  return client;
}

// Non-streaming. Returns the reply text ("" if the model returned none).
export async function generateAssistantReply(messages) {
  const completion = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    messages,
    max_completion_tokens: MAX_REPLY_TOKENS,
  });

  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}
