import Conversation from "../models/conversation.model.js";

export async function requireConversationMembership(req, res, next) {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.user._id,
    });

    if (!conversation) {
      const err = new Error("Conversation not found");
      err.statusCode = 404;
      return next(err);
    }

    req.conversation = conversation;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireGroupConversation(req, res, next) {
  if (req.conversation.type !== "group") {
    const err = new Error(
      "This operation is only valid for group conversations",
    );
    err.statusCode = 400;
    return next(err);
  }

  next();
}

export function requireGroupAdmin(req, res, next) {
  const isAdmin = req.conversation.admins.some(
    (adminId) => String(adminId) === String(req.user._id),
  );

  if (!isAdmin) {
    const err = new Error("Only group admins can perform this action");
    err.statusCode = 403;
    return next(err);
  }

  next();
}
