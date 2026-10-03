import mongoose from "mongoose";
import User from "../models/user.model.js";
import Conversation from "../models/conversation.model.js";

function sortedPair(userIdA, userIdB) {
  return [String(userIdA), String(userIdB)].sort();
}

export function computeDirectKey(userIdA, userIdB) {
  const [low, high] = sortedPair(userIdA, userIdB);
  return `${low}_${high}`;
}

export async function findDirectConversation(userIdA, userIdB) {
  const directKey = computeDirectKey(userIdA, userIdB);
  return Conversation.findOne({ directKey });
}

export async function resolveOrCreateDirectConversation(userIdA, userIdB) {
  const [low, high] = sortedPair(userIdA, userIdB);
  const directKey = `${low}_${high}`;

  try {
    return await Conversation.findOneAndUpdate(
      { directKey },
      {
        $setOnInsert: {
          type: "direct",
          participants: [low, high],
          directKey,
          lastMessageAt: new Date(0),
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (error.code === 11000) {
      return Conversation.findOne({ directKey });
    }
    throw error;
  }
}

// Creates a new group Conversation. The creator is always included in
// participants (even if omitted from participantIds) and is the sole
// initial admin, per the Stage 4 creator/admins-gated membership model.
export async function createGroupConversation({
  creatorId,
  participantIds,
  name,
  avatar,
}) {
  const uniqueParticipantIds = Array.from(
    new Set([String(creatorId), ...participantIds.map(String)]),
  );

  return Conversation.create({
    type: "group",
    participants: uniqueParticipantIds,
    name,
    avatar,
    createdBy: creatorId,
    admins: [creatorId],
    lastMessageAt: new Date(0),
  });
}

// Low-level membership mutation only — callers are responsible for
// authorization and invariant checks (min participants, min admins,
// system-user exclusion) before calling this.
export async function addParticipant(conversationId, userId) {
  return Conversation.findOneAndUpdate(
    { _id: conversationId, type: "group" },
    { $addToSet: { participants: userId } },
    { new: true },
  );
}

// Adds a SYSTEM user (e.g. the AI assistant) to a conversation of either type.
// Separate from addParticipant on purpose: that one is the group-only human
// flow. This one refuses any user that is not isSystemUser, so it cannot be
// used to add a human without the admin/authorization checks, and it never
// touches `admins`. Returns null if userId is not a system user or the
// conversation does not exist.
export async function addSystemParticipant(conversationId, systemUserId) {
  const isSystem = await User.exists({ _id: systemUserId, isSystemUser: true });
  if (!isSystem) return null;

  return Conversation.findOneAndUpdate(
    { _id: conversationId },
    { $addToSet: { participants: systemUserId } },
    { new: true },
  );
}

// Low-level membership mutation only — removes the user from both
// participants and admins (a departing/removed admin should not remain
// an admin of a group they're no longer in). Callers are responsible for
// authorization and invariant checks before calling this.
export async function removeParticipant(conversationId, userId) {
  const objectUserId = new mongoose.Types.ObjectId(String(userId));

  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      type: "group",
      participants: objectUserId,
      $expr: {
        $and: [
          // At least 2 participants must remain after this removal.
          { $gte: [{ $size: "$participants" }, 3] },
          // At least 1 admin must remain after this removal.
          {
            $gte: [
              {
                $subtract: [
                  { $size: "$admins" },
                  { $cond: [{ $in: [objectUserId, "$admins"] }, 1, 0] },
                ],
              },
              1,
            ],
          },
        ],
      },
    },
    {
      $pull: {
        participants: objectUserId,
        admins: objectUserId,
      },
    },
    { new: true },
  );
}

// Shapes a group Conversation document into the API-facing representation
// used by conversation.controller.js responses and the sidebar's group rows.
export function normalizeGroupConversation(conversation) {
  if (!conversation) return null;

  return {
    _id: conversation._id,
    type: "group",
    name: conversation.name,
    avatar: conversation.avatar ?? null,
    createdBy: conversation.createdBy,
    participants: conversation.participants,
    admins: conversation.admins,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
