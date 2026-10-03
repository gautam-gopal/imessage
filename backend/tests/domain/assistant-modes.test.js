import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Message from "../../src/models/message.model.js";
import { io } from "../../src/lib/socket.js";
import { handleAssistantMention } from "../../src/lib/ai/assistant.js";
import { resetAssistantQuota } from "../../src/lib/ai/rate-limit.js";
import { generateAssistantReply } from "../../src/lib/ai/openai.js";
import {
  ASSISTANT_MODES,
  detectAssistantMode,
} from "../../src/lib/ai/mode.js";
import {
  MODE_CONFIG,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_MESSAGES,
} from "../../src/lib/ai/context.js";
import {
  createDirect,
  createMessage,
  createMessages,
  createUser,
} from "../helpers/factories.js";

vi.mock("../../src/lib/ai/openai.js", () => ({
  generateAssistantReply: vi.fn(),
}));

let toSpy;

beforeEach(() => {
  resetAssistantQuota();
  vi.mocked(generateAssistantReply).mockReset();
  vi.mocked(generateAssistantReply).mockResolvedValue("AI reply");
  toSpy = vi.spyOn(io, "to").mockReturnValue({ emit: vi.fn() });
});

afterEach(() => {
  toSpy.mockRestore();
});

// [system, user] message contents of the nth OpenAI call.
const promptOf = (call = 0) => {
  const [system, user] = vi.mocked(generateAssistantReply).mock.calls[call][0];
  return { system: system.content, user: user.content };
};

const setup = async () => {
  const [a, b] = [await createUser(), await createUser()];
  return { a, b, convo: await createDirect(a, b) };
};

describe("detectAssistantMode", () => {
  it.each([
    ["@nextalk what do you think?", ASSISTANT_MODES.REPLY],
    ["@nextalk summarise this", ASSISTANT_MODES.SUMMARY],
    ["@nextalk Summarize the thread", ASSISTANT_MODES.SUMMARY],
    ["@nextalk tl;dr", ASSISTANT_MODES.SUMMARY],
    ["@nextalk recap please", ASSISTANT_MODES.SUMMARY],
    ["@nextalk what does this do?\n```js\nfoo()\n```", ASSISTANT_MODES.CODE],
    ["@nextalk explain this function", ASSISTANT_MODES.CODE],
    ["@nextalk how does this regex work", ASSISTANT_MODES.CODE],
    // code wins over summary
    ["@nextalk summarise this\n```\nx\n```", ASSISTANT_MODES.CODE],
    // explain alone, with no code noun, is an ordinary reply
    ["@nextalk explain the plan", ASSISTANT_MODES.REPLY],
    [undefined, ASSISTANT_MODES.REPLY],
  ])("%j -> %s", (text, expected) => {
    expect(detectAssistantMode(text)).toBe(expected);
  });
});

describe("contextual reply (default)", () => {
  it("uses the reply instruction and the preceding conversation", async () => {
    const { a, b, convo } = await setup();
    await createMessage(convo, b, { text: "the deploy failed at 3pm" });
    const trigger = await createMessage(convo, a, {
      text: "@nextalk why might that be?",
    });

    await handleAssistantMention(trigger);

    const { system, user } = promptOf();
    expect(system).toContain(MODE_CONFIG.reply.instruction);
    expect(system).not.toContain(MODE_CONFIG.code.instruction);
    expect(system).not.toContain(MODE_CONFIG.summary.instruction);
    expect(user).toContain("the deploy failed at 3pm");
  });
});

describe("code explanation", () => {
  it("fenced code: code instruction, full code in the request, chat kept as context", async () => {
    const { a, b, convo } = await setup();
    await createMessage(convo, b, { text: "login keeps returning 401" });
    const code = "```js\nfunction add(a, b) {\n  return a - b;\n}\n```";
    const trigger = await createMessage(convo, a, {
      text: `@nextalk what is wrong here?\n${code.replace(/\n/g, "\n")}`,
    });

    await handleAssistantMention(trigger);

    const { system, user } = promptOf();
    expect(system).toContain(MODE_CONFIG.code.instruction);
    expect(system).not.toContain(MODE_CONFIG.reply.instruction);
    expect(user).toContain("login keeps returning 401");
    expect(user.split("<request>")[1]).toContain("return a - b;");
  });

  it("no fence, but an explain-this-function request, is still a code request", async () => {
    const { a, convo } = await setup();
    const trigger = await createMessage(convo, a, {
      text: "@nextalk explain this function",
    });

    await handleAssistantMention(trigger);

    expect(promptOf().system).toContain(MODE_CONFIG.code.instruction);
  });
});

describe("thread summarisation", () => {
  it("reaches history that an ordinary reply would not, and says nothing about partial history when everything fits", async () => {
    const { a, b, convo } = await setup();
    await createMessages(convo, [a, b], 4);
    await createMessage(convo, b, { text: "DECISION: ship on Friday" });
    await createMessages(convo, [a, b], 55);

    const summaryTrigger = await createMessage(convo, a, {
      text: "@nextalk summarise the thread",
    });
    await handleAssistantMention(summaryTrigger);

    const summary = promptOf(0);
    expect(summary.system).toContain(MODE_CONFIG.summary.instruction);
    expect(summary.user).toContain("DECISION: ship on Friday");
    expect(summary.user).not.toContain("only the most recent part");

    const replyTrigger = await createMessage(convo, a, {
      text: "@nextalk thoughts?",
    });
    await handleAssistantMention(replyTrigger);

    // same conversation, ordinary reply: the early decision is outside the
    // 20-message window
    expect(promptOf(1).user).not.toContain("DECISION: ship on Friday");
  });

  it("is bounded by message and character budgets, flags partial history, and stays chronological and conversation-scoped", async () => {
    const { a, b, convo } = await setup();
    const other = await createDirect(a, await createUser());

    await Message.create({
      senderId: a._id,
      conversationId: other._id,
      text: "OTHER-CONVERSATION-SECRET",
    });

    const body = "y".repeat(190);
    await Message.insertMany(
      Array.from({ length: 400 }, (_, i) => ({
        senderId: i % 2 ? a._id : b._id,
        conversationId: convo._id,
        text: `n${String(i + 1).padStart(3, "0")} ${body}`,
      })),
    );

    const trigger = await createMessage(convo, a, { text: "@nextalk recap" });
    await createMessage(convo, b, { text: "LATER-MESSAGE" });

    await handleAssistantMention(trigger);

    const { user } = promptOf();
    const transcript = user.split("<conversation>")[1].split("</conversation>")[0];
    const lines = transcript.trim().split("\n");

    expect(user.startsWith("Note: only the most recent part")).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(SUMMARY_MAX_MESSAGES);
    expect(transcript.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 500);
    expect(user).toContain("n400");
    expect(user).not.toContain("n001");
    expect(user).not.toContain("LATER-MESSAGE");
    expect(user).not.toContain("OTHER-CONVERSATION-SECRET");
    expect(transcript.indexOf("n399")).toBeLessThan(transcript.indexOf("n400"));
  });
});

describe("trigger stays anchored when newer messages arrive", () => {
  it("40 messages after the mention do not evict the surrounding context", async () => {
    const { a, b, convo } = await setup();
    await createMessages(convo, [a, b], 30);
    const trigger = await createMessage(convo, a, { text: "@nextalk thoughts?" });
    await createMessages(convo, [a, b], 40);

    await handleAssistantMention(trigger);

    const { user } = promptOf();
    expect(user).toContain("m30");
    expect(user).toMatch(/<request>\n.+@nextalk thoughts\?\n<\/request>/);
  });
});
