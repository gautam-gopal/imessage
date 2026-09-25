import mongoose from "mongoose";
import {
  findDirectConversation,
  resolveOrCreateDirectConversation,
} from "../lib/conversations.js";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";
import { hasImageKitConfig, uploadChatMedia } from "../lib/imagekit.js";
import { getReceiverSocketId, io } from "../lib/socket.js";

export async function getUsersForSidebar(req, res) {
  try {
    const loggedInUserId = req.user._id;

    const filteredUsers = await User.find({
      _id: { $ne: loggedInUserId },
    }).select("-clerkId");

    res.status(200).json(filteredUsers);
  } catch (error) {
    console.error("Error in getUsersForSidebar:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}

export async function getConversationsForSidebar(req, res) {
  try {
    const loggedInUserId = req.user._id;

    const conversations = await Conversation.find({
      type: "direct",
      participants: loggedInUserId,
    })
      .sort({ lastMessageAt: -1 })
      .lean();

    const otherIds = conversations.map((c) =>
      c.participants.find((p) => String(p) !== String(loggedInUserId)),
    );

    const users = await User.find({ _id: { $in: otherIds } })
      .select("-clerkId")
      .lean();

    const userById = new Map(users.map((u) => [String(u._id), u]));

    const result = conversations
      .map((c) => {
        const otherId = c.participants.find(
          (p) => String(p) !== String(loggedInUserId),
        );

        return userById.get(String(otherId));
      })
      .filter(Boolean);

    res.json(result);
  } catch (error) {
    console.error("Error in getConversationsForSidebar:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}

export async function getMessages(req, res) {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    new mongoose.Types.ObjectId(userToChatId);

    const conversation = await findDirectConversation(myId, userToChatId);

    if (!conversation) {
      return res.json([]);
    }

    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(myId),
    );

    if (!isParticipant) {
      return res.json([]);
    }

    const messages = await Message.find({
      conversationId: conversation._id,
    }).sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    console.error("Error in getMessages:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}

export async function sendMessage(req, res) {
  try {
    const { text } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    let imageUrl;
    let videoUrl;

    if (req.file) {
      if (!hasImageKitConfig()) {
        return res
          .status(500)
          .json({ message: "Media upload is not configured" });
      }

      const url = await uploadChatMedia(req.file);
      if (req.file.mimetype.startsWith("video/")) videoUrl = url;
      else imageUrl = url;
    }

    const conversation = await resolveOrCreateDirectConversation(
      senderId,
      receiverId,
    );

    const newMessage = new Message({
      senderId,
      receiverId,
      conversationId: conversation._id,
      text,
      image: imageUrl,
      video: videoUrl,
    });

    await newMessage.save();

    await Conversation.updateOne(
      { _id: conversation._id },
      { $max: { lastMessageAt: newMessage.createdAt } },
    );

    const receiverSocketId = getReceiverSocketId(receiverId);
    // only send the message in realtime if user is online
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json(newMessage);
  } catch (error) {
    console.error("Error in sendMessage:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}
