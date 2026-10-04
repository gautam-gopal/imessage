import OpenAI from "openai";

// Server-only configuration (set in the backend environment / Render
// dashboard; never in frontend env, a VITE_* variable, a Docker ARG/ENV, or
// source control):
//   OPENAI_API_KEY   required for the assistant; without it the assistant
//                    reports "unavailable" and the rest of the app is
//                    unaffected. It is the key of whichever provider
//                    OPENAI_BASE_URL points at.
//   OPENAI_MODEL     optional, defaults to gpt-4o
//   OPENAI_BASE_URL  optional https:// URL of any OpenAI-compatible API.
//                    Unset = OpenAI. For OpenRouter (free dev/E2E testing):
//                      OPENAI_BASE_URL=https://openrouter.ai/api/v1
//                      OPENAI_MODEL=openrouter/free
//                    There is deliberately no default other than OpenAI, so a
//                    key is never sent to a provider it does not belong to.

const DEFAULT_MODEL = "gpt-4o";
const MAX_REPLY_TOKENS = 700;

let client;

// undefined = the SDK default (OpenAI). Must be https so the bearer key is
// never sent in clear text.
function getBaseURL() {
  const baseURL = process.env.OPENAI_BASE_URL?.trim();

  if (!baseURL) return undefined;

  if (!baseURL.startsWith("https://")) {
    throw new Error("OPENAI_BASE_URL must be an https:// URL");
  }

  return baseURL;
}

// Built lazily so importing this module never throws when the key is absent
// (unlike lib/imagekit.js). The key is read from backend env only.
function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  client ??= new OpenAI({
    apiKey,
    baseURL: getBaseURL(),
    timeout: 30_000,
    maxRetries: 1,
  });
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
