import mongoose from "mongoose";
import {
  findDirectConversation,
  resolveOrCreateDirectConversation,
} from "../lib/conversations.js";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";
import { hasImageKitConfig, uploadChatMedia } from "../lib/imagekit.js";
import { io, joinConversationRoom } from "../lib/socket.js";

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
      participants: loggedInUserId,
    })
      .sort({ lastMessageAt: -1 })
      .lean();

    const directConversations = conversations.filter(
      (c) => c.type === "direct",
    );

    const peerIds = directConversations.map((c) =>
      c.participants.find((p) => String(p) !== String(loggedInUserId)),
    );

    const peers = await User.find({ _id: { $in: peerIds } })
      .select("-clerkId")
      .lean();

    const peerById = new Map(peers.map((u) => [String(u._id), u]));

    const result = conversations
      .map((c) => {
        if (c.type === "direct") {
          const peerId = c.participants.find(
            (p) => String(p) !== String(loggedInUserId),
          );
          const peer = peerById.get(String(peerId));

          // A direct conversation whose peer no longer resolves to a real
          // user is dropped from the sidebar rather than shown broken.
          if (!peer) return null;

          return {
            _id: c._id,
            type: "direct",
            peer,
            lastMessageAt: c.lastMessageAt,
          };
        }

        return {
          _id: c._id,
          type: "group",
          name: c.name,
          avatar: c.avatar ?? null,
          participantCount: c.participants.length,
          participants: c.participants,
          admins: c.admins,
          lastMessageAt: c.lastMessageAt,
        };
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

    joinConversationRoom(conversation);

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

    io.to(String(conversation._id)).emit("newMessage", newMessage);

    res.status(201).json(newMessage);
  } catch (error) {
    console.error("Error in sendMessage:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}
