import { describe, it, expect } from "vitest";
import Message from "../../src/models/message.model.js";
import { markMessagesReadUpTo } from "../../src/lib/read-receipts.js";
import {
  createUser,
  createDirect,
  createGroup,
  createMessages,
  createMessage,
  oid,
} from "../helpers/factories.js";

async function setup() {
  const [a, b] = [await createUser(), await createUser()];
  const conversation = await createDirect(a, b);
  // m1(A) m2(B) m3(A) m4(B) m5(A)
  const msgs = await createMessages(conversation, [a, b], 5);
  return { a, b, conversation, msgs };
}

const reload = (msgs) =>
  Promise.all(msgs.map((m) => Message.findById(m._id).lean()));
const readers = (m) => (m.readBy ?? []).map((r) => String(r.userId));

describe("markMessagesReadUpTo", () => {
  it("marks only messages up to and including the anchor", async () => {
    const { b, conversation, msgs } = await setup();

    const result = await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[2]._id, // m3
    });

    const [m1, m2, m3, m4, m5] = await reload(msgs);
    expect(readers(m1)).toEqual([String(b._id)]);
    expect(readers(m3)).toEqual([String(b._id)]);
    expect(readers(m2)).toEqual([]); // B's own message
    expect(readers(m4)).toEqual([]); // beyond anchor
    expect(readers(m5)).toEqual([]);
    expect(result.modifiedCount).toBe(2);
  });

  it("never marks the reader's own messages as read by them", async () => {
    const { a, conversation, msgs } = await setup();

    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: a._id,
      upToMessageId: msgs[4]._id,
    });

    const [m1, m2, m3, m4, m5] = await reload(msgs);
    for (const own of [m1, m3, m5]) expect(readers(own)).toEqual([]);
    for (const other of [m2, m4]) expect(readers(other)).toEqual([String(a._id)]);
  });

  it("does not add a duplicate reader on repeat calls", async () => {
    const { b, conversation, msgs } = await setup();
    const args = {
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[4]._id,
    };

    await markMessagesReadUpTo(args);
    const second = await markMessagesReadUpTo(args);

    expect(second.modifiedCount).toBe(0);
    const [m1, , m3, , m5] = await reload(msgs);
    for (const m of [m1, m3, m5]) expect(readers(m)).toEqual([String(b._id)]);
  });

  it("keeps a single entry per reader under concurrent calls", async () => {
    const { b, conversation, msgs } = await setup();

    await Promise.all(
      Array.from({ length: 8 }, () =>
        markMessagesReadUpTo({
          conversationId: conversation._id,
          userId: b._id,
          upToMessageId: msgs[4]._id,
        }),
      ),
    );

    const [m1, , m3, , m5] = await reload(msgs);
    for (const m of [m1, m3, m5]) expect(readers(m)).toEqual([String(b._id)]);
  });

  it("is first-read-wins: an earlier readAt is never overwritten", async () => {
    const { b, conversation, msgs } = await setup();

    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[0]._id, // m1 only
    });
    const [firstM1] = await reload(msgs);
    const originalReadAt = firstM1.readBy[0].readAt.getTime();

    await new Promise((r) => setTimeout(r, 20));

    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[2]._id, // m1 + m3
    });
    const [m1, , m3] = await reload(msgs);

    expect(m1.readBy).toHaveLength(1);
    expect(m1.readBy[0].readAt.getTime()).toBe(originalReadAt);
    expect(m3.readBy[0].readAt.getTime()).toBeGreaterThan(originalReadAt);
  });

  it("does not change message updatedAt", async () => {
    const { b, conversation, msgs } = await setup();
    const before = (await reload([msgs[0]]))[0].updatedAt.getTime();

    await new Promise((r) => setTimeout(r, 20));
    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[0]._id,
    });

    expect((await reload([msgs[0]]))[0].updatedAt.getTime()).toBe(before);
  });

  it("returns null and writes nothing when the anchor is in another conversation", async () => {
    const { a, b, conversation, msgs } = await setup();
    const c = await createUser();
    const other = await createDirect(a, c);
    const foreign = await createMessage(other, c);

    const result = await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: foreign._id,
    });

    expect(result).toBeNull();
    for (const m of await reload([...msgs, foreign])) expect(readers(m)).toEqual([]);
  });

  it("returns null when the anchor does not exist", async () => {
    const { b, conversation } = await setup();
    const result = await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: oid(),
    });
    expect(result).toBeNull();
  });

  it("tracks multiple group readers independently", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, c]);
    const [m1] = await createMessages(group, [a], 1);

    await markMessagesReadUpTo({ conversationId: group._id, userId: b._id, upToMessageId: m1._id });
    await markMessagesReadUpTo({ conversationId: group._id, userId: c._id, upToMessageId: m1._id });

    const [stored] = await reload([m1]);
    expect(readers(stored).sort()).toEqual([String(b._id), String(c._id)].sort());
  });
});
