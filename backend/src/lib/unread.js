import mongoose from "mongoose";
import Message from "../models/message.model.js";
import ConversationReadState from "../models/conversation-read-state.model.js";

// Counts are capped so a huge backlog costs a bounded index scan; the UI
// shows "99+" when a count reaches the cap.
export const UNREAD_COUNT_CAP = 100;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

// Moves the user's watermark forward, never backward ($max is atomic and
// monotonic, so concurrent reads from several devices converge on the newest
// anchor). Upsert races on the unique index are retried once.
export async function advanceReadWatermark({
  userId,
  conversationId,
  messageId,
}) {
  const filter = {
    userId: toObjectId(userId),
    conversationId: toObjectId(conversationId),
  };
  const update = { $max: { lastReadMessageId: toObjectId(messageId) } };

  try {
    await ConversationReadState.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    await ConversationReadState.updateOne(filter, update, { upsert: true });
  }
}

// Starts a user's watermark at the conversation's current newest message so
// pre-existing history does not appear unread (used when a member joins a
// group). No-op for an empty conversation. Monotonic, so re-adding a former
// member never moves an older watermark backward.
export async function baselineReadWatermark({ userId, conversationId }) {
  const newest = await Message.findOne({ conversationId }, { _id: 1 })
    .sort({ _id: -1 })
    .lean();

  if (!newest) return false;

  await advanceReadWatermark({
    userId,
    conversationId,
    messageId: newest._id,
  });
  return true;
}

// Unread counts for one user across several conversations, keyed by
// conversation id string. The caller MUST have already restricted
// conversationIds to conversations the user belongs to. Own messages never
// count. Each count is a capped range scan on { conversationId, _id }.
export async function getUnreadCounts({ userId, conversationIds }) {
  const userObjectId = toObjectId(userId);
  const ids = conversationIds.map(toObjectId);

  if (ids.length === 0) return {};

  const states = await ConversationReadState.find(
    { userId: userObjectId, conversationId: { $in: ids } },
    { conversationId: 1, lastReadMessageId: 1 },
  ).lean();

  const watermarkByConversation = new Map(
    states.map((s) => [String(s.conversationId), s.lastReadMessageId]),
  );

  const entries = await Promise.all(
    ids.map(async (conversationId) => {
      // Aggregation pipelines are not cast by Mongoose: ids must already be
      // ObjectIds here.
      const match = {
        conversationId,
        senderId: { $ne: userObjectId },
      };

      const watermark = watermarkByConversation.get(String(conversationId));
      if (watermark) match._id = { $gt: watermark };

      const [row] = await Message.aggregate([
        { $match: match },
        { $limit: UNREAD_COUNT_CAP },
        { $count: "n" },
      ]);

      return [String(conversationId), row?.n ?? 0];
    }),
  );

  return Object.fromEntries(entries);
}
