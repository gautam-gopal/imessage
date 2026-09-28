import mongoose from "mongoose";
import Message from "../models/message.model.js";

// Caller MUST have already authorized access to conversationId.
// `_id` is the pagination boundary (unique, totally ordered); `createdAt`
// stays a display field. Fetches limit + 1 to detect hasMore without a
// separate count query.
export async function getMessagePage({ conversationId, before, limit }) {
  const filter = { conversationId };

  if (before) {
    filter._id = { $lt: new mongoose.Types.ObjectId(before) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1);

  const hasMore = docs.length > limit;
  const messages = hasMore ? docs.slice(0, limit) : docs;

  return {
    messages,
    pageInfo: {
      limit,
      hasMore,
      nextCursor: hasMore ? String(messages[messages.length - 1]._id) : null,
    },
  };
}

export function emptyMessagePage(limit) {
  return {
    messages: [],
    pageInfo: { limit, hasMore: false, nextCursor: null },
  };
}
