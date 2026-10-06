import User from "../../models/user.model.js";

// Reserved identity for the AI system user.
// - A real Clerk user id looks like "user_...", so no Clerk session (REST via
//   protectRoute, socket via io.use) can ever resolve to this clerkId.
// - ".invalid" is a reserved TLD (RFC 2606), so no real account can hold this
//   email and collide with the unique index in the Clerk webhook upsert.
// - No user-facing API writes isSystemUser (the webhook sets explicit fields
//   only, and there is no profile-update route).
export const ASSISTANT_CLERK_ID = "system:nextalk-ai";
export const ASSISTANT_EMAIL = "nextalk-ai@system.invalid";
export const ASSISTANT_NAME = "NexTalk AI";

// Idempotent upsert: safe on every server start and on every @mention.
// Not cached in memory on purpose (the test suite wipes collections between
// tests, so a cached _id would go stale); this is one indexed lookup.
export async function ensureAssistantUser() {
  const update = {
    $set: { isSystemUser: true },
    $setOnInsert: {
      email: ASSISTANT_EMAIL,
      fullName: ASSISTANT_NAME,
      profilePic: "",
    },
  };

  try {
    return await User.findOneAndUpdate(
      { clerkId: ASSISTANT_CLERK_ID },
      update,
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    // Two concurrent first calls can race on the unique clerkId index.
    if (error.code === 11000) {
      return User.findOne({ clerkId: ASSISTANT_CLERK_ID });
    }
    throw error;
  }
}
