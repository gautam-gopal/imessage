import "dotenv/config";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDB } from "../lib/db.js";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";
import ConversationReadState from "../models/conversation-read-state.model.js";

// Stage 10 baseline. Before unread counts existed, nobody had a watermark, so
// every historical message would read as unread. This gives each existing
// human participant a watermark at their conversation's current newest
// message: history that existed when the feature shipped counts as read.
//
// It deliberately does NOT touch Message.readBy (that would falsely tell
// senders their old messages were read). Insert-only ($setOnInsert): an
// existing watermark (lastReadMessageId) is never changed, so rerunning this
// after the feature is live cannot mark newer unread messages as read.

export async function run() {
  const summary = {
    conversationsScanned: 0,
    conversationsWithMessages: 0,
    statesInserted: 0,
    systemParticipantsSkipped: 0,
  };

  const systemIds = new Set(
    (await User.find({ isSystemUser: true }, { _id: 1 }).lean()).map((u) =>
      String(u._id),
    ),
  );

  const cursor = Conversation.find({}, { _id: 1, participants: 1 })
    .lean()
    .cursor();

  for await (const conversation of cursor) {
    summary.conversationsScanned += 1;

    const newest = await Message.findOne(
      { conversationId: conversation._id },
      { _id: 1 },
    )
      .sort({ _id: -1 })
      .lean();

    if (!newest) continue;
    summary.conversationsWithMessages += 1;

    const operations = [];
    for (const participantId of conversation.participants) {
      if (systemIds.has(String(participantId))) {
        summary.systemParticipantsSkipped += 1;
        continue;
      }

      operations.push({
        updateOne: {
          filter: {
            userId: participantId,
            conversationId: conversation._id,
          },
          update: { $setOnInsert: { lastReadMessageId: newest._id } },
          upsert: true,
        },
      });
    }

    if (operations.length === 0) continue;

    const result = await ConversationReadState.bulkWrite(operations, {
      ordered: false,
    });
    summary.statesInserted += result.upsertedCount;
  }

  summary.totalStateDocuments = await ConversationReadState.countDocuments();

  console.log("Read-state baseline migration summary:");
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  try {
    await connectDB();
    await ConversationReadState.init();
    await run();
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly (npm run db:migrate:read-state), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
