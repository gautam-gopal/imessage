import User from "../../models/user.model.js";
import Message from "../../models/message.model.js";
import Conversation from "../../models/conversation.model.js";
import { io, emitToUser } from "../socket.js";
import { addSystemParticipant } from "../conversations.js";
import { containsAssistantMention } from "./mention.js";
import { ensureAssistantUser } from "./assistant-user.js";
import { tryConsumeAssistantQuota } from "./rate-limit.js";
import { buildAssistantPrompt } from "./context.js";
import { generateAssistantReply } from "./openai.js";

// Entry point, called after a human's message has been persisted and the HTTP
// response sent. Never throws (callers do not await it); returns the persisted
// assistant Message, or null if nothing was posted.
//
// Failures after the trigger is authorized are reported only to the triggering
// user, as a private, non-persisted "assistant:error" socket event carrying a
// reason code (never provider error text). Nothing is stored or broadcast, so
// history and other participants are untouched.
export async function handleAssistantMention(triggerMessage) {
  let notify = null;

  try {
    if (!containsAssistantMention(triggerMessage?.text)) return null;

    // Triggering-user authorization: fresh DB checks, independent of whichever
    // route persisted the message. Sender must be a human AND a current
    // participant. (A system sender can never trigger, so no AI->AI loops.)
    const [sender, conversation] = await Promise.all([
      User.exists({
        _id: triggerMessage.senderId,
        isSystemUser: { $ne: true },
      }),
      Conversation.findOne({
        _id: triggerMessage.conversationId,
        participants: triggerMessage.senderId,
      }),
    ]);

    if (!sender || !conversation) return null;

    notify = (reason) => {
      try {
        emitToUser(triggerMessage.senderId, "assistant:error", {
          conversationId: String(conversation._id),
          messageId: String(triggerMessage._id),
          reason,
        });
      } catch (error) {
        console.error("Failed to send assistant:error:", error.message);
      }
    };

    if (!tryConsumeAssistantQuota(triggerMessage.senderId)) {
      console.warn(
        `Assistant rate limit hit for user ${String(triggerMessage.senderId)}`,
      );
      notify("rate_limited");
      return null;
    }

    const prompt = await buildAssistantPrompt({
      conversationId: conversation._id,
      triggerMessage,
    });

    const replyText = await generateAssistantReply(prompt);
    if (!replyText) {
      notify("unavailable");
      return null;
    }

    // The AI must be a participant before it posts, so the ordinary
    // "sender is a participant" rule holds for it. Added after a successful
    // reply so failed/rate-limited attempts leave membership untouched.
    const assistant = await ensureAssistantUser();
    const updated = await addSystemParticipant(conversation._id, assistant._id);
    if (!updated) return null;

    // Same persistence sequence as the human send paths. receiverId is omitted:
    // a reply in a conversation with 2+ humans has no single receiver.
    const message = new Message({
      senderId: assistant._id,
      conversationId: conversation._id,
      text: replyText,
    });

    await message.save();

    await Conversation.updateOne(
      { _id: conversation._id },
      { $max: { lastMessageAt: message.createdAt } },
    );

    io.to(String(conversation._id)).emit("newMessage", message);

    return message;
  } catch (error) {
    console.error("Error in handleAssistantMention:", error.message);
    notify?.("unavailable");
    return null;
  }
}
