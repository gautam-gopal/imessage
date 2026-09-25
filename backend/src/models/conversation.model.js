import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["direct", "group"],
      required: true,
      immutable: true,
    },
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      required: true,
      validate: {
        validator: (arr) => {
          if (!Array.isArray(arr) || arr.length < 2) return false;

          const ids = arr.map((participant) => String(participant));
          return new Set(ids).size === ids.length;
        },
        message: "Conversation participants must be at least 2 and unique",
      },
    },
    directKey: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "direct";
      },
      validate: {
        validator: function (value) {
          if (this.type === "group") return value === undefined;

          return typeof value === "string" && value.length > 0;
        },
        message:
          "directKey is required for direct conversations and forbidden for group conversations",
      },
    },
    name: {
      type: String,
    },
    avatar: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    admins: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    },
    lastMessageAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

conversationSchema.index(
  { directKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: "direct",
      directKey: { $type: "string" },
    },
  },
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
