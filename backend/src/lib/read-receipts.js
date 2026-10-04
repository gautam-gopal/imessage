import mongoose from "mongoose";
import Message from "../models/message.model.js";
import { advanceReadWatermark } from "./unread.js";

// Domain operation only. The caller MUST have already verified that userId
// is a current participant of conversationId (REST: requireConversationMembership;
// a future socket handler needs its own equivalent DB check).
//
// Marks every message in the conversation with _id <= upToMessageId, sent by
// someone other than userId, as read by userId. First read wins: a user who is
// already in a message's readBy is skipped, so readAt never changes and
// repeated/concurrent calls cannot create duplicate entries (the
// "readBy.userId": { $ne } predicate is evaluated atomically per document).
//
// Returns null if upToMessageId is not a message in this conversation.
export async function markMessagesReadUpTo({
  conversationId,
  userId,
  upToMessageId,
}) {
  const anchorId = new mongoose.Types.ObjectId(String(upToMessageId));

  const anchorExists = await Message.exists({
    _id: anchorId,
    conversationId,
  });

  if (!anchorExists) return null;

  const readAt = new Date();

  const result = await Message.updateMany(
    {
      conversationId,
      _id: { $lte: anchorId },
      senderId: { $ne: userId },
      "readBy.userId": { $ne: userId },
    },
    { $push: { readBy: { userId, readAt } } },
    { timestamps: false },
  );

  // Watermark advances after the receipts are written, and even when no
  // receipt changed (e.g. messages already marked before the watermark
  // existed). If the process dies between the two writes the count is merely
  // too high until the next read; it is never too low.
  await advanceReadWatermark({
    userId,
    conversationId,
    messageId: anchorId,
  });

  return {
    conversationId,
    readerId: userId,
    upToMessageId: anchorId,
    readAt,
    modifiedCount: result.modifiedCount,
  };
}
