import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provider configuration only: the real openai.js runs; the SDK is replaced by
// a recorder so nothing touches the network.
const sdk = vi.hoisted(() => ({ ctor: vi.fn(), create: vi.fn() }));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    constructor(options) {
      sdk.ctor(options);
      this.chat = { completions: { create: sdk.create } };
    }
  },
}));

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  sdk.ctor.mockClear();
  sdk.create.mockReset();
  sdk.create.mockResolvedValue({ choices: [{ message: { content: "  hi  " } }] });
  vi.resetModules(); // openai.js caches its client at module level
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

const load = async () => (await import("../../src/lib/ai/openai.js")).generateAssistantReply;
const prompt = [{ role: "user", content: "hello" }];

describe("provider configuration", () => {
  it("defaults to OpenAI: no baseURL override, gpt-4o", async () => {
    process.env.OPENAI_API_KEY = "key-1";
    const generate = await load();

    expect(await generate(prompt)).toBe("hi");

    expect(sdk.ctor).toHaveBeenCalledTimes(1);
    expect(sdk.ctor.mock.calls[0][0]).toMatchObject({ apiKey: "key-1", baseURL: undefined });
    expect(sdk.create.mock.calls[0][0]).toMatchObject({
      model: "gpt-4o",
      messages: prompt,
      max_completion_tokens: 700,
    });
  });

  it("targets OpenRouter when configured, with the configured model", async () => {
    process.env.OPENAI_API_KEY = "or-key";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_MODEL = "openrouter/free";
    const generate = await load();

    await generate(prompt);

    expect(sdk.ctor.mock.calls[0][0]).toMatchObject({
      apiKey: "or-key",
      baseURL: "https://openrouter.ai/api/v1",
    });
    expect(sdk.create.mock.calls[0][0].model).toBe("openrouter/free");
  });

  it("treats a blank base URL as unset", async () => {
    process.env.OPENAI_API_KEY = "key-1";
    process.env.OPENAI_BASE_URL = "   ";
    const generate = await load();

    await generate(prompt);

    expect(sdk.ctor.mock.calls[0][0].baseURL).toBeUndefined();
  });

  it("refuses a non-https base URL and never builds a client", async () => {
    process.env.OPENAI_API_KEY = "key-1";
    process.env.OPENAI_BASE_URL = "http://openrouter.ai/api/v1";
    const generate = await load();

    await expect(generate(prompt)).rejects.toThrow(/https/);
    expect(sdk.ctor).not.toHaveBeenCalled();
  });

  it("still requires a key, whatever the base URL", async () => {
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    const generate = await load();

    await expect(generate(prompt)).rejects.toThrow(/OPENAI_API_KEY/);
    expect(sdk.ctor).not.toHaveBeenCalled();
  });

  it("returns an empty string when the model returns no content", async () => {
    process.env.OPENAI_API_KEY = "key-1";
    sdk.create.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const generate = await load();

    expect(await generate(prompt)).toBe("");
  });
});
