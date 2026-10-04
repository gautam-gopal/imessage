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
import { getMessagePage, emptyMessagePage } from "../lib/message-history.js";
import { handleAssistantMention } from "../lib/ai/assistant.js";
import { getUnreadCounts } from "../lib/unread.js";

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

    // A direct conversation can also contain system participants (the AI),
    // so the peer is the human participant other than the caller.
    const candidateIds = [
      ...new Set(
        directConversations.flatMap((c) => c.participants.map(String)),
      ),
    ].filter((id) => id !== String(loggedInUserId));

    const candidates = await User.find({ _id: { $in: candidateIds } })
      .select("-clerkId")
      .lean();

    const peerById = new Map(
      candidates.filter((u) => !u.isSystemUser).map((u) => [String(u._id), u]),
    );

    // System participants (the AI) are not "members" a user should see
    // counted, so participantCount excludes them. `participants` itself still
    // lists them: the client needs their ids to exclude them from read counts.
    const groupParticipantIds = [
      ...new Set(
        conversations
          .filter((c) => c.type === "group")
          .flatMap((c) => c.participants.map(String)),
      ),
    ];

    const systemParticipants = await User.find({
      _id: { $in: groupParticipantIds },
      isSystemUser: true,
    })
      .select("_id")
      .lean();

    const systemIds = new Set(systemParticipants.map((u) => String(u._id)));

    // Server-derived from the caller's own watermarks; conversations were
    // already filtered by { participants: loggedInUserId } above.
    const unreadByConversation = await getUnreadCounts({
      userId: loggedInUserId,
      conversationIds: conversations.map((c) => c._id),
    });

    const result = conversations
      .map((c) => {
        if (c.type === "direct") {
          const peer = c.participants
            .map((p) => peerById.get(String(p)))
            .find(Boolean);

          // A direct conversation whose peer no longer resolves to a real
          // user is dropped from the sidebar rather than shown broken.
          if (!peer) return null;

          return {
            _id: c._id,
            type: "direct",
            peer,
            lastMessageAt: c.lastMessageAt,
            unreadCount: unreadByConversation[String(c._id)] ?? 0,
          };
        }

        return {
          _id: c._id,
          type: "group",
          name: c.name,
          avatar: c.avatar ?? null,
          participantCount: c.participants.filter(
            (p) => !systemIds.has(String(p)),
          ).length,
          participants: c.participants,
          admins: c.admins,
          lastMessageAt: c.lastMessageAt,
          unreadCount: unreadByConversation[String(c._id)] ?? 0,
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
    const { before, limit } = req.validatedQuery;
    const myId = req.user._id;

    new mongoose.Types.ObjectId(userToChatId);

    const conversation = await findDirectConversation(myId, userToChatId);

    if (!conversation) {
      return res.json(emptyMessagePage(limit));
    }

    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(myId),
    );

    if (!isParticipant) {
      return res.json(emptyMessagePage(limit));
    }

    const page = await getMessagePage({
      conversationId: conversation._id,
      before,
      limit,
    });

    res.json(page);
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

    // Fire-and-forget: the send never waits on OpenAI. Handles its own errors.
    void handleAssistantMention(newMessage);
  } catch (error) {
    console.error("Error in sendMessage:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
}
