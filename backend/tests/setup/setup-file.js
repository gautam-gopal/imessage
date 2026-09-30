import crypto from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, inject, vi } from "vitest";

// lib/imagekit.js constructs its client at import time and throws without a
// key. No test uploads media; this only lets the module graph load.
process.env.IMAGEKIT_PRIVATE_KEY ||= "test-imagekit-key";

// Clerk token verification is third-party and out of scope. Everything that
// is ours (protectRoute's DB lookup, membership, admin checks) still runs.
// Tests choose the caller with the `x-test-clerk-id` header, which stands in
// for "identity established by a verified Clerk session".
vi.mock("@clerk/express", () => ({
  getAuth: (req) => ({ userId: req.headers["x-test-clerk-id"] || null }),
  clerkMiddleware: () => (req, res, next) => next(),
}));

// Socket.IO handshake verification. Token format "test-token:<clerkId>" is
// accepted; anything else is rejected exactly as a bad Clerk token would be.
// The io.use() handshake logic, the User lookup and everything after it in
// src/lib/socket.js run for real.
vi.mock("@clerk/backend", () => ({
  verifyToken: async (token) => {
    const match = /^test-token:(.+)$/.exec(String(token));
    if (!match) throw new Error("Invalid token");
    return { sub: match[1] };
  },
}));

beforeAll(async () => {
  const dbName = `nextalk_test_${crypto.randomBytes(6).toString("hex")}`;
  await mongoose.connect(inject("mongoUri"), { dbName });

  // Build declared indexes (notably the partial-unique directKey) up front
  // so uniqueness behaviour is deterministic.
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.deleteMany({})),
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
