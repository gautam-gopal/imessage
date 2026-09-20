import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../lib/db.js";
import User from "../models/user.model.js";
import Message from "../models/message.model.js";

const MESSAGE_COUNT = 100_000;

async function seedMessages() {
  await connectDB();

  const userA = await User.findOne({ clerkId: "seed_alex_chen" });
  const userB = await User.findOne({ clerkId: "seed_sam_taylor" });

  if (!userA || !userB) {
    throw new Error("Run `npm run db:seed` first to create seed users.");
  }

  // seed unrelated noise so the messages are not all in one thread, and we can test the "unread" feature
  const otherUsers = await User.find({
    clerkId: { $nin: [userA.clerkId, userB.clerkId] },
  }).limit(10);

  const docs = [];
  const now = Date.now();

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const useTargetPair = i % 3 === 0; // ~33% are the A<->B thread
    const [senderId, receiverId] = useTargetPair
      ? i % 2 === 0
        ? [userA._id, userB._id]
        : [userB._id, userA._id]
      : [
          otherUsers[i % otherUsers.length]._id,
          otherUsers[(i + 1) % otherUsers.length]._id,
        ];

    docs.push({
      senderId,
      receiverId,
      text: `seeded message ${i}`,
      createdAt: new Date(now - (MESSAGE_COUNT - i) * 1000),
      updatedAt: new Date(now - (MESSAGE_COUNT - i) * 1000),
    });
  }

  await Message.insertMany(docs);
  console.log(`Seeded ${docs.length} messages.`);
}

seedMessages()
  .catch((error) => {
    console.error("Failed to seed messages:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
