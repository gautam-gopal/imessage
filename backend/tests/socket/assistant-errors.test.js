import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Message from "../../src/models/message.model.js";
import { handleAssistantMention } from "../../src/lib/ai/assistant.js";
import {
  ASSISTANT_RATE_MAX_CALLS,
} from "../../src/lib/ai/rate-limit.js";
import { resetAssistantQuota } from "../../src/lib/ai/rate-limit.js";
import { generateAssistantReply } from "../../src/lib/ai/openai.js";
import {
  createDirect,
  createMessage,
  createUser,
} from "../helpers/factories.js";
import {
  connectAs,
  disconnectAll,
  settle,
  startSocketServer,
  stopSocketServer,
  waitForRoom,
} from "../helpers/socket-client.js";

vi.mock("../../src/lib/ai/openai.js", () => ({
  generateAssistantReply: vi.fn(),
}));

beforeAll(startSocketServer);
afterAll(stopSocketServer);
afterEach(disconnectAll);

beforeEach(() => {
  resetAssistantQuota();
  vi.mocked(generateAssistantReply).mockReset();
  vi.mocked(generateAssistantReply).mockResolvedValue("AI reply");
});

const mention = (convo, sender, text = "@nextalk help") =>
  createMessage(convo, sender, { text });

describe("assistant:error is private to the triggering user", () => {
  it("OpenAI failure: every tab of the sender gets a reason code, nobody else does, nothing is stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateAssistantReply).mockRejectedValue(
      new Error("provider said: secret internal detail"),
    );
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);
    const [a1, a2, bClient] = [
      await connectAs(a),
      await connectAs(a),
      await connectAs(b),
    ];
    await Promise.all([a1, a2, bClient].map((c) => waitForRoom(convo._id, c)));
    const trigger = await mention(convo, a);

    await handleAssistantMention(trigger);

    const payloads = await Promise.all(
      [a1, a2].map((c) => c.waitForEvent("assistant:error")),
    );
    for (const payload of payloads) {
      expect(payload).toEqual({
        conversationId: String(convo._id),
        messageId: String(trigger._id),
        reason: "unavailable",
      });
      expect(JSON.stringify(payload)).not.toContain("secret");
    }

    await settle();
    expect(bClient.eventsOf("assistant:error")).toHaveLength(0);
    expect(await Message.countDocuments({ conversationId: convo._id })).toBe(1);
    console.error.mockRestore?.();
  });

  it("rate limit: the sender is told, other participants are not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);
    const [aClient, bClient] = [await connectAs(a), await connectAs(b)];
    await Promise.all([aClient, bClient].map((c) => waitForRoom(convo._id, c)));

    for (let i = 0; i < ASSISTANT_RATE_MAX_CALLS; i += 1) {
      await handleAssistantMention(await mention(convo, a));
    }
    expect(aClient.eventsOf("assistant:error")).toHaveLength(0);

    const blocked = await mention(convo, a);
    await handleAssistantMention(blocked);

    const payload = await aClient.waitForEvent("assistant:error");
    expect(payload.reason).toBe("rate_limited");
    expect(payload.messageId).toBe(String(blocked._id));

    await settle();
    expect(bClient.eventsOf("assistant:error")).toHaveLength(0);
    console.warn.mockRestore?.();
  });

  it("an empty model reply is reported as unavailable", async () => {
    vi.mocked(generateAssistantReply).mockResolvedValue("");
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);
    const aClient = await connectAs(a);
    await waitForRoom(convo._id, aClient);

    await handleAssistantMention(await mention(convo, a));

    expect((await aClient.waitForEvent("assistant:error")).reason).toBe("unavailable");
  });

  it("a forged trigger from a non-participant produces no error event for anyone", async () => {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const convo = await createDirect(a, b);
    const clients = [await connectAs(a), await connectAs(b), await connectAs(outsider)];
    await Promise.all(clients.slice(0, 2).map((c) => waitForRoom(convo._id, c)));

    await handleAssistantMention(await mention(convo, outsider));
    await settle();

    for (const client of clients) {
      expect(client.eventsOf("assistant:error")).toHaveLength(0);
    }
    expect(generateAssistantReply).not.toHaveBeenCalled();
  });

  it("success sends no error event", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);
    const aClient = await connectAs(a);
    await waitForRoom(convo._id, aClient);

    await handleAssistantMention(await mention(convo, a));
    await settle();

    expect(aClient.eventsOf("assistant:error")).toHaveLength(0);
  });
});
