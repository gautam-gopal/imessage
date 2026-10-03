import { beforeEach, describe, expect, it, vi } from "vitest";
import User from "../../src/models/user.model.js";
import Message from "../../src/models/message.model.js";
import Conversation from "../../src/models/conversation.model.js";
import { ASSISTANT_CLERK_ID } from "../../src/lib/ai/assistant-user.js";
import { resetAssistantQuota } from "../../src/lib/ai/rate-limit.js";
import { generateAssistantReply } from "../../src/lib/ai/openai.js";
import { api, createDirect, createGroup, createUser } from "../helpers/factories.js";

vi.mock("../../src/lib/ai/openai.js", () => ({
  generateAssistantReply: vi.fn(),
}));

beforeEach(() => {
  resetAssistantQuota();
  vi.mocked(generateAssistantReply).mockReset();
  vi.mocked(generateAssistantReply).mockResolvedValue("AI reply");
});

const aiReplies = (conversationId) =>
  Message.find({ conversationId, text: "AI reply" });

describe("assistant is wired into both send paths", () => {
  it("direct send route: @mention gets an AI reply in the same conversation", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);

    const res = await api(a)
      .post(`/api/messages/send/${b._id}`)
      .send({ text: "@nextalk hello" });
    expect(res.status).toBe(201);

    await vi.waitFor(async () => {
      expect(await aiReplies(convo._id)).toHaveLength(1);
    });

    const ai = await User.findOne({ clerkId: ASSISTANT_CLERK_ID });
    const [reply] = await aiReplies(convo._id);
    expect(String(reply.senderId)).toBe(String(ai._id));
    expect(
      (await Conversation.findById(convo._id)).participants.map(String),
    ).toContain(String(ai._id));
  });

  it("group send route: @mention gets an AI reply", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createGroup(a, [b]);

    const res = await api(b)
      .post(`/api/conversations/${convo._id}/messages`)
      .send({ text: "@nextalk summarise" });
    expect(res.status).toBe(201);

    await vi.waitFor(async () => {
      expect(await aiReplies(convo._id)).toHaveLength(1);
    });
  });

  it("a plain message never calls OpenAI", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await createDirect(a, b);

    const res = await api(a)
      .post(`/api/messages/send/${b._id}`)
      .send({ text: "just chatting" });

    expect(res.status).toBe(201);
    expect(generateAssistantReply).not.toHaveBeenCalled();
  });

  it("the send response does not wait on OpenAI", async () => {
    let release;
    vi.mocked(generateAssistantReply).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve("AI reply");
      }),
    );
    const [a, b] = [await createUser(), await createUser()];
    const convo = await createDirect(a, b);

    const res = await api(a)
      .post(`/api/messages/send/${b._id}`)
      .send({ text: "@nextalk slow one" });

    expect(res.status).toBe(201);
    expect(await Message.countDocuments({ conversationId: convo._id })).toBe(1);

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();

    await vi.waitFor(async () => {
      expect(await aiReplies(convo._id)).toHaveLength(1);
    });
  });
});
