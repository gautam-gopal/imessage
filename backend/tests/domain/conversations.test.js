import { describe, it, expect } from "vitest";
import Conversation from "../../src/models/conversation.model.js";
import Message from "../../src/models/message.model.js";
import {
  computeDirectKey,
  resolveOrCreateDirectConversation,
  createGroupConversation,
} from "../../src/lib/conversations.js";
import { createUser, oid } from "../helpers/factories.js";

describe("direct conversation resolution", () => {
  it("computes an order-independent directKey", async () => {
    const [a, b] = [await createUser(), await createUser()];
    expect(computeDirectKey(a._id, b._id)).toBe(computeDirectKey(b._id, a._id));
  });

  it("resolves the same conversation regardless of argument order", async () => {
    const [a, b] = [await createUser(), await createUser()];

    const ab = await resolveOrCreateDirectConversation(a._id, b._id);
    const ba = await resolveOrCreateDirectConversation(b._id, a._id);

    expect(String(ab._id)).toBe(String(ba._id));
    expect(ab.type).toBe("direct");
    expect(ab.participants.map(String).sort()).toEqual(
      [String(a._id), String(b._id)].sort(),
    );
    expect(await Conversation.countDocuments({ type: "direct" })).toBe(1);
  });

  it("creates exactly one conversation under concurrent first-message races", async () => {
    const [a, b] = [await createUser(), await createUser()];

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2
          ? resolveOrCreateDirectConversation(a._id, b._id)
          : resolveOrCreateDirectConversation(b._id, a._id),
      ),
    );

    expect(new Set(results.map((c) => String(c._id))).size).toBe(1);
    expect(await Conversation.countDocuments({ type: "direct" })).toBe(1);
  });

  it("keeps different user pairs in different conversations", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];

    const ab = await resolveOrCreateDirectConversation(a._id, b._id);
    const ac = await resolveOrCreateDirectConversation(a._id, c._id);

    expect(String(ab._id)).not.toBe(String(ac._id));
  });

  it("enforces directKey uniqueness at the database level", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const doc = {
      type: "direct",
      participants: [a._id, b._id],
      directKey: computeDirectKey(a._id, b._id),
      lastMessageAt: new Date(0),
    };

    await Conversation.create(doc);
    await expect(Conversation.create(doc)).rejects.toMatchObject({ code: 11000 });
  });
});

describe("group conversation creation", () => {
  it("includes the creator as participant and sole admin, with no directKey", async () => {
    const [creator, m1] = [await createUser(), await createUser()];

    const group = await createGroupConversation({
      creatorId: creator._id,
      participantIds: [m1._id],
      name: "G",
    });

    expect(group.type).toBe("group");
    expect(group.participants.map(String)).toEqual(
      expect.arrayContaining([String(creator._id), String(m1._id)]),
    );
    expect(group.admins.map(String)).toEqual([String(creator._id)]);
    expect(group.directKey).toBeUndefined();
  });

  it("allows several groups with the same members (no directKey collision)", async () => {
    const [creator, m1] = [await createUser(), await createUser()];
    const make = () =>
      createGroupConversation({
        creatorId: creator._id,
        participantIds: [m1._id],
        name: "G",
      });

    await make();
    await expect(make()).resolves.toBeTruthy();
    expect(await Conversation.countDocuments({ type: "group" })).toBe(2);
  });
});

describe("Conversation schema invariants", () => {
  const base = { lastMessageAt: new Date(0) };

  it("rejects a direct conversation without directKey", async () => {
    await expect(
      Conversation.create({ ...base, type: "direct", participants: [oid(), oid()] }),
    ).rejects.toThrow();
  });

  it("rejects a group conversation that carries a directKey", async () => {
    await expect(
      Conversation.create({
        ...base,
        type: "group",
        participants: [oid(), oid()],
        directKey: "x_y",
      }),
    ).rejects.toThrow();
  });

  it("rejects fewer than 2 participants and duplicate participants", async () => {
    const id = oid();
    await expect(
      Conversation.create({ ...base, type: "group", participants: [id], name: "G" }),
    ).rejects.toThrow();
    await expect(
      Conversation.create({ ...base, type: "group", participants: [id, id], name: "G" }),
    ).rejects.toThrow();
  });
});

describe("Message schema invariants", () => {
  it("rejects a message with no conversationId", async () => {
    await expect(
      Message.create({ senderId: oid(), text: "orphan" }),
    ).rejects.toThrow();
  });
});
