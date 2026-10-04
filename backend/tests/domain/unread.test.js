import { describe, it, expect } from "vitest";
import Message from "../../src/models/message.model.js";
import ConversationReadState from "../../src/models/conversation-read-state.model.js";
import { markMessagesReadUpTo } from "../../src/lib/read-receipts.js";
import {
  UNREAD_COUNT_CAP,
  advanceReadWatermark,
  baselineReadWatermark,
  getUnreadCounts,
} from "../../src/lib/unread.js";
import { run as runBaselineMigration } from "../../src/migrations/002-read-state-baseline.js";
import {
  createUser,
  createSystemUser,
  createDirect,
  createGroup,
  createMessage,
  createMessages,
} from "../helpers/factories.js";

async function unreadFor(user, conversation) {
  const counts = await getUnreadCounts({
    userId: user._id,
    conversationIds: [conversation._id],
  });
  return counts[String(conversation._id)];
}

async function direct() {
  const [a, b] = [await createUser(), await createUser()];
  const conversation = await createDirect(a, b);
  return { a, b, conversation };
}

describe("getUnreadCounts", () => {
  it("counts everyone else's messages and never the caller's own", async () => {
    const { a, b, conversation } = await direct();
    await createMessages(conversation, [a, b], 5); // a,b,a,b,a

    expect(await unreadFor(b, conversation)).toBe(3);
    expect(await unreadFor(a, conversation)).toBe(2);
  });

  it("returns zero for a conversation with no messages", async () => {
    const { a, conversation } = await direct();
    expect(await unreadFor(a, conversation)).toBe(0);
  });

  it("returns an empty object for an empty id list", async () => {
    const { a } = await direct();
    expect(await getUnreadCounts({ userId: a._id, conversationIds: [] })).toEqual({});
  });

  it("caps the count at UNREAD_COUNT_CAP", async () => {
    const { a, b, conversation } = await direct();
    await Message.insertMany(
      Array.from({ length: UNREAD_COUNT_CAP + 20 }, (_, i) => ({
        senderId: a._id,
        conversationId: conversation._id,
        text: `m${i}`,
      })),
    );

    expect(await unreadFor(b, conversation)).toBe(UNREAD_COUNT_CAP);
  });

  it("counts per conversation and per user independently in a group", async () => {
    const [a, b, c] = [await createUser(), await createUser(), await createUser()];
    const group = await createGroup(a, [b, c]);
    const other = await createDirect(a, b);
    const msgs = await createMessages(group, [a], 4);
    await createMessages(other, [a], 2);

    await markMessagesReadUpTo({
      conversationId: group._id,
      userId: b._id,
      upToMessageId: msgs[1]._id,
    });

    const bCounts = await getUnreadCounts({
      userId: b._id,
      conversationIds: [group._id, other._id],
    });
    expect(bCounts).toEqual({
      [String(group._id)]: 2,
      [String(other._id)]: 2,
    });
    expect(await unreadFor(c, group)).toBe(4);
  });

  it("counts messages from a system user (the AI) like any other sender", async () => {
    const { a, conversation } = await direct();
    const ai = await createSystemUser();
    await createMessage(conversation, ai, { text: "ai reply" });

    expect(await unreadFor(a, conversation)).toBe(1);
  });
});

describe("read watermark", () => {
  it("markMessagesReadUpTo advances the watermark and lowers the count", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 4);

    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[1]._id,
    });
    expect(await unreadFor(b, conversation)).toBe(2);

    await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[3]._id,
    });
    expect(await unreadFor(b, conversation)).toBe(0);

    await createMessage(conversation, a);
    expect(await unreadFor(b, conversation)).toBe(1);
  });

  it("never moves backward when an older anchor is read later", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 4);

    await markMessagesReadUpTo({ conversationId: conversation._id, userId: b._id, upToMessageId: msgs[3]._id });
    await markMessagesReadUpTo({ conversationId: conversation._id, userId: b._id, upToMessageId: msgs[0]._id });

    const state = await ConversationReadState.findOne({ userId: b._id, conversationId: conversation._id }).lean();
    expect(String(state.lastReadMessageId)).toBe(String(msgs[3]._id));
    expect(await unreadFor(b, conversation)).toBe(0);
  });

  it("converges to the newest anchor under concurrent reads and keeps one document", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 6);

    await Promise.all(
      msgs.map((m) =>
        markMessagesReadUpTo({ conversationId: conversation._id, userId: b._id, upToMessageId: m._id }),
      ),
    );

    const states = await ConversationReadState.find({ userId: b._id, conversationId: conversation._id }).lean();
    expect(states).toHaveLength(1);
    expect(String(states[0].lastReadMessageId)).toBe(String(msgs[5]._id));
  });

  it("concurrent first-time upserts create a single document", async () => {
    const { a, b, conversation } = await direct();
    const [m] = await createMessages(conversation, [a], 1);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        advanceReadWatermark({ userId: b._id, conversationId: conversation._id, messageId: m._id }),
      ),
    );

    expect(await ConversationReadState.countDocuments({ userId: b._id })).toBe(1);
  });

  it("still advances when no receipt changed (receipts already existed)", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 2);
    // Simulate Stage 5 era data: receipts exist, no watermark yet.
    await Message.updateMany(
      { conversationId: conversation._id },
      { $push: { readBy: { userId: b._id, readAt: new Date() } } },
    );
    expect(await unreadFor(b, conversation)).toBe(2);

    const result = await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: b._id,
      upToMessageId: msgs[1]._id,
    });

    expect(result.modifiedCount).toBe(0);
    expect(await unreadFor(b, conversation)).toBe(0);
  });
});

describe("baselineReadWatermark", () => {
  it("starts a user at the newest existing message", async () => {
    const { a, b, conversation } = await direct();
    await createMessages(conversation, [a], 3);

    expect(await baselineReadWatermark({ userId: b._id, conversationId: conversation._id })).toBe(true);
    expect(await unreadFor(b, conversation)).toBe(0);

    await createMessage(conversation, a);
    expect(await unreadFor(b, conversation)).toBe(1);
  });

  it("is a no-op for an empty conversation", async () => {
    const { b, conversation } = await direct();
    expect(await baselineReadWatermark({ userId: b._id, conversationId: conversation._id })).toBe(false);
    expect(await ConversationReadState.countDocuments()).toBe(0);
  });

  it("does not move an existing newer watermark backward", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 3);
    await advanceReadWatermark({ userId: b._id, conversationId: conversation._id, messageId: msgs[2]._id });
    // Simulate a later-removed/re-added member: baseline at an older newest id.
    await Message.deleteOne({ _id: msgs[2]._id });

    await baselineReadWatermark({ userId: b._id, conversationId: conversation._id });

    const state = await ConversationReadState.findOne({ userId: b._id }).lean();
    expect(String(state.lastReadMessageId)).toBe(String(msgs[2]._id));
  });
});

describe("migration 002: read-state baseline", () => {
  it("baselines human participants, skips system users, and leaves readBy untouched", async () => {
    const { a, b, conversation } = await direct();
    const ai = await createSystemUser();
    const group = await createGroup(a, [b]);
    group.participants.push(ai._id);
    await group.save();
    await createMessages(conversation, [a, b], 4);
    const groupMsgs = await createMessages(group, [a], 2);
    await createDirect(a, await createUser()); // empty conversation

    const summary = await runBaselineMigration();

    expect(await unreadFor(a, conversation)).toBe(0);
    expect(await unreadFor(b, conversation)).toBe(0);
    expect(await unreadFor(b, group)).toBe(0);
    expect(await ConversationReadState.countDocuments({ userId: ai._id })).toBe(0);
    expect(summary.statesInserted).toBe(4); // a,b in direct + a,b in group
    expect(summary.systemParticipantsSkipped).toBe(1);

    const stored = await Message.find({}).lean();
    expect(stored.every((m) => (m.readBy ?? []).length === 0)).toBe(true);

    await createMessage(group, a, { text: "after" });
    expect(await unreadFor(b, group)).toBe(1);
    expect(groupMsgs).toHaveLength(2);
  });

  it("is idempotent and never overwrites an existing watermark", async () => {
    const { a, b, conversation } = await direct();
    const msgs = await createMessages(conversation, [a], 3);
    await advanceReadWatermark({ userId: b._id, conversationId: conversation._id, messageId: msgs[0]._id });

    await runBaselineMigration();
    const afterFirst = await ConversationReadState.findOne({ userId: b._id }).lean();
    expect(String(afterFirst.lastReadMessageId)).toBe(String(msgs[0]._id));

    await createMessage(conversation, a);
    const second = await runBaselineMigration();

    expect(second.statesInserted).toBe(0);
    expect(await ConversationReadState.countDocuments({ userId: b._id })).toBe(1);
    expect(await unreadFor(b, conversation)).toBe(3);
  });
});
