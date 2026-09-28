import mongoose from "mongoose";

const readReceiptSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    readAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    text: {
      type: String,
    },

    image: {
      type: String,
    },

    video: {
      type: String,
    },

    readBy: {
      type: [readReceiptSchema],
    },
  },
  {
    timestamps: true,
  },
);

messageSchema.index({
  senderId: 1,
  receiverId: 1,
  createdAt: -1,
});

messageSchema.index({
  receiverId: 1,
  senderId: 1,
  createdAt: -1,
});

messageSchema.index({
  conversationId: 1,
  _id: -1,
});

const Message = mongoose.model("Message", messageSchema);

export default Message;
