import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../lib/db.js";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";

function sortedPair(a, b) {
  return [String(a), String(b)].sort();
}

async function backfillUsers() {
  const result = await User.updateMany(
    { isSystemUser: { $exists: false } },
    { $set: { isSystemUser: false } },
  );
  return result.modifiedCount;
}

async function countSelfPairs() {
  const rows = await Message.aggregate([
    { $match: { $expr: { $eq: ["$senderId", "$receiverId"] } } },
    { $group: { _id: "$senderId" } },
    { $count: "count" },
  ]);
  return rows[0]?.count ?? 0;
}

async function discoverPairs() {
  return Message.aggregate([
    { $match: { $expr: { $ne: ["$senderId", "$receiverId"] } } },
    {
      $project: {
        pairKey: {
          $cond: [
            { $lt: [{ $toString: "$senderId" }, { $toString: "$receiverId" }] },
            { low: "$senderId", high: "$receiverId" },
            { low: "$receiverId", high: "$senderId" },
          ],
        },
      },
    },
    { $group: { _id: "$pairKey" } },
  ]);
}

async function resolveOrCreateConversation(low, high, directKey) {
  try {
    const result = await Conversation.findOneAndUpdate(
      { directKey },
      {
        $setOnInsert: {
          type: "direct",
          participants: [low, high],
          directKey,
          lastMessageAt: new Date(0),
        },
      },
      {
        upsert: true,
        new: true,
        includeResultMetadata: true,
        setDefaultsOnInsert: true,
      },
    );
    const wasCreated = Boolean(result.lastErrorObject?.upserted);
    return { conversation: result.value, wasCreated };
  } catch (error) {
    if (error.code === 11000) {
      const conversation = await Conversation.findOne({ directKey });
      return { conversation, wasCreated: false };
    }
    throw error;
  }
}

async function classifyPair(low, high) {
  const [lowIsHuman, highIsHuman] = await Promise.all([
    User.exists({ _id: low, isSystemUser: { $ne: true } }),
    User.exists({ _id: high, isSystemUser: { $ne: true } }),
  ]);
  return !lowIsHuman || !highIsHuman; // true => orphaned-participant pair
}

async function backfillMessagesForConversation(low, high, conversationId) {
  const result = await Message.updateMany(
    {
      $or: [
        { senderId: low, receiverId: high },
        { senderId: high, receiverId: low },
      ],
      conversationId: { $exists: false },
    },
    { $set: { conversationId } },
  );
  return result.modifiedCount;
}

async function syncLastMessageAt(conversationId) {
  const [row] = await Message.aggregate([
    { $match: { conversationId } },
    { $group: { _id: null, maxCreatedAt: { $max: "$createdAt" } } },
  ]);
  if (row?.maxCreatedAt) {
    await Conversation.updateOne(
      { _id: conversationId },
      { $max: { lastMessageAt: row.maxCreatedAt } },
    );
  }
}

async function run() {
  const summary = {
    usersUpdated: 0,
    conversationsCreated: 0,
    conversationsReused: 0,
    messagesMigrated: 0,
    selfPairsSkipped: 0,
    orphanedParticipantPairsMigrated: 0,
  };

  summary.usersUpdated = await backfillUsers();
  summary.selfPairsSkipped = await countSelfPairs();

  const pairs = await discoverPairs();

  for (const { _id: pairKey } of pairs) {
    const [low, high] = sortedPair(pairKey.low, pairKey.high);
    const directKey = `${low}_${high}`;

    const isOrphaned = await classifyPair(low, high);
    if (isOrphaned) {
      summary.orphanedParticipantPairsMigrated += 1;
    }

    const { conversation, wasCreated } = await resolveOrCreateConversation(
      low,
      high,
      directKey,
    );

    if (wasCreated) {
      summary.conversationsCreated += 1;
    } else {
      summary.conversationsReused += 1;
    }

    const migratedCount = await backfillMessagesForConversation(
      low,
      high,
      conversation._id,
    );
    summary.messagesMigrated += migratedCount;

    await syncLastMessageAt(conversation._id);
  }

  console.log("Conversation backfill migration summary:");
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  try {
    await connectDB();
    await run();
  } finally {
    await mongoose.connection.close();
  }
}

main();
