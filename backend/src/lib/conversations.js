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
