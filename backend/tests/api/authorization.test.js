import { describe, it, expect } from "vitest";
import Conversation from "../../src/models/conversation.model.js";
import Message from "../../src/models/message.model.js";
import {
  api,
  createUser,
  createSystemUser,
  createDirect,
  createGroup,
  createMessages,
  oid,
} from "../helpers/factories.js";

// Trust boundary under test: the caller's identity comes only from the
// verified auth layer (stubbed as the x-test-clerk-id header). Ids in URLs,
// bodies, or queries are claims and must never widen what the caller can do.

describe("authentication gate", () => {
  it("returns 401 for every protected route without an identity", async () => {
    const anon = api(null);
    const id = oid();
    const results = await Promise.all([
      anon.get("/api/messages/users"),
      anon.get("/api/messages/conversations"),
      anon.get(`/api/messages/${id}`),
      anon.post(`/api/messages/send/${id}`).send({ text: "x" }),
      anon.post("/api/conversations").send({ name: "G", participantIds: [id] }),
      anon.get(`/api/conversations/${id}/messages`),
      anon.post(`/api/conversations/${id}/read`).send({ upToMessageId: id }),
    ]);
    for (const res of results) expect(res.status).toBe(401);
  });

  it("does not accept an identity that has no matching user profile", async () => {
    const ghost = { clerkId: "clerk_does_not_exist" };
    const res = await api(ghost).get("/api/messages/conversations");
    expect(res.status).toBe(404);
  });
});

describe("conversation membership boundary", () => {
  async function scene() {
    const [a, b, outsider] = [await createUser(), await createUser(), await createUser()];
    const direct = await createDirect(a, b);
    const group = await createGroup(a, [b]);
    const directMsgs = await createMessages(direct, [a, b], 3);
    const groupMsgs = await createMessages(group, [a, b], 3);
    return { a, b, outsider, direct, group, directMsgs, groupMsgs };
  }

  it("hides group history from a non-member (404, no content leaked)", async () => {
    const { outsider, group } = await scene();
    const res = await api(outsider).get(`/api/conversations/${group._id}/messages`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("m1");
  });

  it("blocks a non-member from posting to a group", async () => {
    const { outsider, group } = await scene();
    const before = await Message.countDocuments({ conversationId: group._id });

    const res = await api(outsider)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "intruder" });

    expect(res.status).toBe(404);
    expect(await Message.countDocuments({ conversationId: group._id })).toBe(before);
  });

  it("blocks a non-member from marking messages read, leaving readBy untouched", async () => {
    const { outsider, direct, directMsgs } = await scene();

    const res = await api(outsider)
      .post(`/api/conversations/${direct._id}/read`)
      .send({ upToMessageId: String(directMsgs[2]._id) });

    expect(res.status).toBe(404);
    for (const m of await Message.find({ conversationId: direct._id }).lean()) {
      expect(m.readBy ?? []).toHaveLength(0);
    }
  });

  it("blocks a non-member from reading someone else's direct conversation by id", async () => {
    const { outsider, direct } = await scene();
    const res = await api(outsider).get(`/api/conversations/${direct._id}/messages`);
    expect(res.status).toBe(404);
  });
});

describe("client-supplied ids cannot override the authenticated identity", () => {
  it("history lookup is scoped to the caller: a third party sees nothing of A<->B via either id", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const direct = await createDirect(a, b);
    await createMessages(direct, [a, b], 3);

    for (const peerId of [a._id, b._id]) {
      const res = await api(c).get(`/api/messages/${peerId}`);
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
    }
  });

  it("rejects a body senderId and stores the message under the caller", async () => {
    const [a, b, victim] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, victim]);

    const spoofed = await api(a)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "as victim", senderId: String(victim._id) });
    expect(spoofed.status).toBe(400);
    expect(await Message.countDocuments({})).toBe(0);

    const honest = await api(a)
      .post(`/api/conversations/${group._id}/messages`)
      .send({ text: "as me" });
    expect(String(honest.body.senderId)).toBe(String(a._id));
  });

  it("rejects a body senderId on direct send", async () => {
    const [a, b, victim] = [await createUser(), await createUser(), await createUser()];
    const res = await api(a)
      .post(`/api/messages/send/${b._id}`)
      .send({ text: "x", senderId: String(victim._id) });
    expect(res.status).toBe(400);
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("rejects a body userId on read and records the read for the caller only", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, c]);
    const [m] = await createMessages(group, [a], 1);

    const spoofed = await api(b)
      .post(`/api/conversations/${group._id}/read`)
      .send({ upToMessageId: String(m._id), userId: String(c._id) });
    expect(spoofed.status).toBe(400);

    await api(b)
      .post(`/api/conversations/${group._id}/read`)
      .send({ upToMessageId: String(m._id) });

    const stored = await Message.findById(m._id).lean();
    expect(stored.readBy.map((r) => String(r.userId))).toEqual([String(b._id)]);
  });

  it("does not let a member use another conversation's message as a read anchor", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const mine = await createDirect(a, b);
    const theirs = await createDirect(b, c);
    const [foreign] = await createMessages(theirs, [c], 1);

    const res = await api(a)
      .post(`/api/conversations/${mine._id}/read`)
      .send({ upToMessageId: String(foreign._id) });

    expect(res.status).toBe(404);
    expect((await Message.findById(foreign._id).lean()).readBy ?? []).toHaveLength(0);
  });
});

describe("group membership operations", () => {
  async function scene() {
    const [admin, member, other, outsider] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const group = await createGroup(admin, [member, other]);
    return { admin, member, other, outsider, group };
  }

  const participants = async (group) =>
    (await Conversation.findById(group._id)).participants.map(String);

  it("lets an admin add a member", async () => {
    const { admin, outsider, group } = await scene();

    const res = await api(admin)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(outsider._id) });

    expect(res.status).toBe(200);
    expect(await participants(group)).toContain(String(outsider._id));
  });

  it("blocks a non-admin member from adding anyone", async () => {
    const { member, outsider, group } = await scene();

    const res = await api(member)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(outsider._id) });

    expect(res.status).toBe(403);
    expect(await participants(group)).not.toContain(String(outsider._id));
  });

  it("blocks a non-member from adding anyone (membership checked before admin)", async () => {
    const { outsider, group } = await scene();
    const res = await api(outsider)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(outsider._id) });
    expect(res.status).toBe(404);
    expect(await participants(group)).not.toContain(String(outsider._id));
  });

  it("rejects adding a system user or an existing member", async () => {
    const { admin, member, group } = await scene();
    const bot = await createSystemUser();

    const botRes = await api(admin)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(bot._id) });
    const dupRes = await api(admin)
      .post(`/api/conversations/${group._id}/members`)
      .send({ memberId: String(member._id) });

    expect(botRes.status).toBe(404);
    expect(dupRes.status).toBe(400);
    expect(await participants(group)).not.toContain(String(bot._id));
  });

  it("blocks a non-admin from removing another member", async () => {
    const { member, other, group } = await scene();
    const res = await api(member).delete(`/api/conversations/${group._id}/members/${other._id}`);
    expect(res.status).toBe(403);
    expect(await participants(group)).toContain(String(other._id));
  });

  it("lets an admin remove a member, and the removed member loses access", async () => {
    const { admin, member, group } = await scene();

    const res = await api(admin).delete(`/api/conversations/${group._id}/members/${member._id}`);
    expect(res.status).toBe(200);

    expect((await api(member).get(`/api/conversations/${group._id}/messages`)).status).toBe(404);
    expect(
      (await api(member).post(`/api/conversations/${group._id}/messages`).send({ text: "still here?" })).status,
    ).toBe(404);
    expect(await Message.countDocuments({ conversationId: group._id })).toBe(0);
  });

  it("lets a non-admin leave on their own", async () => {
    const { member, group } = await scene();
    const res = await api(member).delete(`/api/conversations/${group._id}/members/${member._id}`);
    expect(res.status).toBe(200);
    expect(await participants(group)).not.toContain(String(member._id));
  });

  it("stops the sole admin from leaving", async () => {
    const { admin, group } = await scene();
    const res = await api(admin).delete(`/api/conversations/${group._id}/members/${admin._id}`);
    expect(res.status).toBe(400);
    expect(await participants(group)).toContain(String(admin._id));
  });

  it("never lets a group drop below 2 participants", async () => {
    const [admin, only] = [await createUser(), await createUser()];
    const group = await createGroup(admin, [only]);

    const res = await api(admin).delete(`/api/conversations/${group._id}/members/${only._id}`);

    expect(res.status).toBe(400);
    expect(await participants(group)).toHaveLength(2);
  });

  it("returns 404 when removing someone who is not a member", async () => {
    const { admin, outsider, group } = await scene();
    const res = await api(admin).delete(`/api/conversations/${group._id}/members/${outsider._id}`);
    expect(res.status).toBe(404);
  });

  it("rejects membership operations on a direct conversation", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const direct = await createDirect(a, b);

    const res = await api(a)
      .post(`/api/conversations/${direct._id}/members`)
      .send({ memberId: String(c._id) });

    expect(res.status).toBe(400);
    expect((await Conversation.findById(direct._id)).participants).toHaveLength(2);
  });
});

describe("system users", () => {
  it("cannot create groups", async () => {
    const [bot, a] = [await createSystemUser(), await createUser()];
    const res = await api(bot)
      .post("/api/conversations")
      .send({ name: "G", participantIds: [String(a._id)] });
    expect(res.status).toBe(403);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  it("cannot be included as a group participant at creation", async () => {
    const [a, bot] = [await createUser(), await createSystemUser()];
    const res = await api(a)
      .post("/api/conversations")
      .send({ name: "G", participantIds: [String(bot._id)] });
    expect(res.status).toBe(404);
  });

  it("cannot mark messages read", async () => {
    const [a, bot] = [await createUser(), await createSystemUser()];
    const direct = await createDirect(a, bot); // fixture-only: bypasses the API rule on purpose
    const [m] = await createMessages(direct, [a], 1);

    const res = await api(bot)
      .post(`/api/conversations/${direct._id}/read`)
      .send({ upToMessageId: String(m._id) });

    expect(res.status).toBe(403);
    expect((await Message.findById(m._id).lean()).readBy ?? []).toHaveLength(0);
  });
});
