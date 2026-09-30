import { describe, it, expect } from "vitest";
import Conversation from "../../src/models/conversation.model.js";
import Message from "../../src/models/message.model.js";
import {
  api,
  createUser,
  createSystemUser,
  createDirect,
  createGroup,
  oid,
} from "../helpers/factories.js";

describe("direct send: POST /api/messages/send/:id", () => {
  it("creates the direct conversation on first send and stores the message in it", async () => {
    const [a, b] = [await createUser(), await createUser()];

    const res = await api(a).post(`/api/messages/send/${b._id}`).send({ text: "hi" });

    expect(res.status).toBe(201);
    const conversation = await Conversation.findOne({ type: "direct" });
    expect(conversation.participants.map(String).sort()).toEqual(
      [String(a._id), String(b._id)].sort(),
    );
    expect(String(res.body.conversationId)).toBe(String(conversation._id));
    expect(String(res.body.senderId)).toBe(String(a._id));
    expect(String(res.body.receiverId)).toBe(String(b._id));
  });

  it("reuses the same conversation for replies and repeat sends", async () => {
    const [a, b] = [await createUser(), await createUser()];

    await api(a).post(`/api/messages/send/${b._id}`).send({ text: "1" });
    await api(b).post(`/api/messages/send/${a._id}`).send({ text: "2" });
    await api(a).post(`/api/messages/send/${b._id}`).send({ text: "3" });

    expect(await Conversation.countDocuments({ type: "direct" })).toBe(1);
    expect(await Message.countDocuments({})).toBe(3);
  });

  it("advances the conversation's lastMessageAt to the newest message", async () => {
    const [a, b] = [await createUser(), await createUser()];

    const res = await api(a).post(`/api/messages/send/${b._id}`).send({ text: "hi" });

    const conversation = await Conversation.findOne({ type: "direct" });
    expect(conversation.lastMessageAt.getTime()).toBe(
      new Date(res.body.createdAt).getTime(),
    );
  });

  it("rejects a receiver that does not exist", async () => {
    const a = await createUser();
    const res = await api(a).post(`/api/messages/send/${oid()}`).send({ text: "hi" });
    expect(res.status).toBe(404);
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("rejects a system user as a direct-message receiver", async () => {
    const [a, bot] = [await createUser(), await createSystemUser()];
    const res = await api(a).post(`/api/messages/send/${bot._id}`).send({ text: "hi" });
    expect(res.status).toBe(404);
    expect(await Conversation.countDocuments({})).toBe(0);
  });
});

describe("group send: POST /api/conversations/:conversationId/messages", () => {
  it("stores the message in the group with the authenticated sender and no receiverId", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, c]);

    const res = await api(b)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "hello group" });

    expect(res.status).toBe(201);
    const stored = await Message.findById(res.body._id).lean();
    expect(String(stored.conversationId)).toBe(String(group._id));
    expect(String(stored.senderId)).toBe(String(b._id));
    expect(stored.receiverId).toBeUndefined();
  });

  it("advances the group's lastMessageAt", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const group = await createGroup(a, [b]);

    const res = await api(a)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "x" });

    const updated = await Conversation.findById(group._id);
    expect(updated.lastMessageAt.getTime()).toBe(new Date(res.body.createdAt).getTime());
  });

  it("rejects using the group endpoint against a direct conversation", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const direct = await createDirect(a, b);

    const res = await api(a)
      .post(`/api/conversations/${direct._id}/messages`)
      .send({ text: "x" });

    expect(res.status).toBe(400);
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("rejects an unknown conversation id", async () => {
    const a = await createUser();
    const res = await api(a).post(`/api/conversations/${oid()}/messages`).send({ text: "x" });
    expect(res.status).toBe(404);
  });
});

describe("sidebar: GET /api/messages/conversations", () => {
  it("lists only the caller's conversations, newest activity first", async () => {
    const [a, b, c, outsider] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    await api(a).post(`/api/messages/send/${b._id}`).send({ text: "older" });
    await new Promise((r) => setTimeout(r, 10));
    await api(a).post(`/api/messages/send/${c._id}`).send({ text: "newer" });
    await api(outsider).post(`/api/messages/send/${b._id}`).send({ text: "not a's" });

    const res = await api(a).get("/api/messages/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(String(res.body[0].peer._id)).toBe(String(c._id));
    expect(String(res.body[1].peer._id)).toBe(String(b._id));
  });
});
