import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";
import {
  createGroupConversation,
  addParticipant,
  removeParticipant,
  normalizeGroupConversation,
} from "../lib/conversations.js";
import { hasImageKitConfig, uploadChatMedia } from "../lib/imagekit.js";
import {
  io,
  joinConversationRoom,
  leaveConversationRoom,
} from "../lib/socket.js";
import { markMessagesReadUpTo } from "../lib/read-receipts.js";
import { getMessagePage } from "../lib/message-history.js";
import { handleAssistantMention } from "../lib/ai/assistant.js";
import { baselineReadWatermark } from "../lib/unread.js";

export async function createGroup(req, res, next) {
  try {
    if (req.user.isSystemUser) {
      const err = new Error("System users cannot create groups");
      err.statusCode = 403;
      return next(err);
    }

    const { name, avatar, participantIds } = req.body;
    const creatorId = req.user._id;

    const uniqueParticipantIds = Array.from(
      new Set(participantIds.map(String)),
    ).filter((id) => id !== String(creatorId));

    if (uniqueParticipantIds.length < 1) {
      const err = new Error("A group needs at least one other participant");
      err.statusCode = 400;
      return next(err);
    }

    const existingCount = await User.countDocuments({
      _id: { $in: uniqueParticipantIds },
      isSystemUser: { $ne: true },
    });

    if (existingCount !== uniqueParticipantIds.length) {
      const err = new Error("One or more participants could not be found");
      err.statusCode = 404;
      return next(err);
    }

    const conversation = await createGroupConversation({
      creatorId,
      participantIds: uniqueParticipantIds,
      name,
      avatar,
    });

    // So members who are already connected start receiving this
    // conversation's events immediately, not just after their next
    // reconnect (existing reconnect-time join already covers that case).
    joinConversationRoom(conversation);

    res.status(201).json(normalizeGroupConversation(conversation));
  } catch (error) {
    next(error);
  }
}

// Requires requireConversationMembership + requireGroupConversation +
// requireGroupAdmin to have already run (conversation.route.js).
export async function addMember(req, res, next) {
  try {
    const { conversation } = req;
    const { memberId } = req.body;

    if (String(memberId) === String(req.user._id)) {
      const err = new Error("You are already a member of this conversation");
      err.statusCode = 400;
      return next(err);
    }

    const alreadyMember = conversation.participants.some(
      (p) => String(p) === String(memberId),
    );

    if (alreadyMember) {
      const err = new Error("User is already a member of this conversation");
      err.statusCode = 400;
      return next(err);
    }

    const memberExists = await User.exists({
      _id: memberId,
      isSystemUser: { $ne: true },
    });

    if (!memberExists) {
      const err = new Error("User not found");
      err.statusCode = 404;
      return next(err);
    }

    try {
      await baselineReadWatermark({
        userId: memberId,
        conversationId: conversation._id,
      });
    } catch (error) {
      console.error("Error baselining read watermark:", error.message);
    }

    const updated = await addParticipant(conversation._id, memberId);

    // Same reasoning as group creation: the newly added member's active
    // sockets need the room now, not just on their next reconnect.
    joinConversationRoom(updated);

    res.status(200).json(normalizeGroupConversation(updated));
  } catch (error) {
    next(error);
  }
}

// Requires requireConversationMembership + requireGroupConversation to have
// already run (conversation.route.js). Admin authorization for removing
// someone *other* than yourself is checked here rather than via middleware,
// since self-leave must be allowed for non-admin participants.
export async function removeMember(req, res, next) {
  try {
    const { conversation } = req;
    const { memberId } = req.params;
    const requesterId = String(req.user._id);
    const isSelfLeave = String(memberId) === requesterId;

    const isRequesterAdmin = conversation.admins.some(
      (a) => String(a) === requesterId,
    );

    if (!isSelfLeave && !isRequesterAdmin) {
      const err = new Error("Only group admins can remove other members");
      err.statusCode = 403;
      return next(err);
    }

    const isMember = conversation.participants.some(
      (p) => String(p) === String(memberId),
    );

    if (!isMember) {
      const err = new Error("User is not a member of this conversation");
      err.statusCode = 404;
      return next(err);
    }

    const isTargetAdmin = conversation.admins.some(
      (a) => String(a) === String(memberId),
    );

    const remainingParticipants = conversation.participants.length - 1;
    const remainingAdmins = isTargetAdmin
      ? conversation.admins.length - 1
      : conversation.admins.length;

    // Covers both rules from the finalized design: a group can never drop
    // below 2 participants, and a sole admin cannot leave (that case falls
    // out of remainingAdmins < 1 automatically).
    if (remainingParticipants < 2) {
      const err = new Error("A group cannot have fewer than 2 participants");
      err.statusCode = 400;
      return next(err);
    }

    if (remainingAdmins < 1) {
      const err = new Error("A group must retain at least one admin");
      err.statusCode = 400;
      return next(err);
    }

    const updated = await removeParticipant(conversation._id, memberId);

    if (!updated) {
      const err = new Error("Group membership changed; please retry");
      err.statusCode = 409;
      return next(err);
    }

    // DB membership is authoritative; this only cleans up delivery state so
    // the removed member's open sockets stop receiving room events. It is
    // not itself an authorization step — REST/room-join checks already
    // enforce membership independently, and reconnect rebuilds rooms from
    // current DB state regardless of whether this cleanup runs.
    leaveConversationRoom(conversation._id, memberId);

    res.status(200).json(normalizeGroupConversation(updated));
  } catch (error) {
    next(error);
  }
}

// Requires requireConversationMembership + requireGroupConversation to have
// already run (conversation.route.js). Group-only: direct-message send
// keeps using POST /messages/send/:id unchanged.
export async function sendConversationMessage(req, res, next) {
  try {
    const { conversation } = req;
    const { text } = req.body;
    const senderId = req.user._id;

    let imageUrl;
    let videoUrl;

    if (req.file) {
      if (!hasImageKitConfig()) {
        const err = new Error("Media upload is not configured");
        err.statusCode = 500;
        return next(err);
      }

      const url = await uploadChatMedia(req.file);
      if (req.file.mimetype.startsWith("video/")) videoUrl = url;
      else imageUrl = url;
    }

    // receiverId is intentionally omitted — a group message has no single
    // receiver. This is the server-side construction that enforces the
    // direct/group receiverId split; there is no schema-level validator for
    // it (Part 1 decision).
    const newMessage = new Message({
      senderId,
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
    next(error);
  }
}

// Requires requireConversationMembership + requireGroupConversation to have
// already run (conversation.route.js). Group-only: direct-message history
// keeps using GET /messages/:id unchanged.
export async function getConversationMessages(req, res, next) {
  try {
    const { conversation } = req;
    const { before, limit } = req.validatedQuery;

    const page = await getMessagePage({
      conversationId: conversation._id,
      before,
      limit,
    });

    res.json(page);
  } catch (error) {
    next(error);
  }
}

// Requires requireConversationMembership to have already run
// (conversation.route.js). Valid for both direct and group conversations.
export async function markConversationRead(req, res, next) {
  try {
    if (req.user.isSystemUser) {
      const err = new Error("System users cannot mark messages as read");
      err.statusCode = 403;
      return next(err);
    }

    const { conversation } = req;
    const { upToMessageId } = req.body;

    const result = await markMessagesReadUpTo({
      conversationId: conversation._id,
      userId: req.user._id,
      upToMessageId,
    });

    if (!result) {
      const err = new Error("Message not found");
      err.statusCode = 404;
      return next(err);
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
