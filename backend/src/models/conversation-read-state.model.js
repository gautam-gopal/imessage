import mongoose from "mongoose";

// Per-user, per-conversation read watermark: the newest message _id this user
// has read in this conversation. Unread count = messages with _id greater than
// the watermark that someone else sent. A missing document means "nothing read
// yet". This is separate from Message.readBy (the per-message receipt shown to
// senders); the watermark exists so unread counts are an index range scan
// instead of a scan over every message's readBy array.
const conversationReadStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    lastReadMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
  },
  { timestamps: true },
);

conversationReadStateSchema.index(
  { userId: 1, conversationId: 1 },
  { unique: true },
);

const ConversationReadState = mongoose.model(
  "ConversationReadState",
  conversationReadStateSchema,
);

export default ConversationReadState;
