import mongoose from "mongoose";
import request from "supertest";
import User from "../../src/models/user.model.js";
import Message from "../../src/models/message.model.js";
import {
  resolveOrCreateDirectConversation,
  createGroupConversation,
} from "../../src/lib/conversations.js";
import { createTestApp } from "./app.js";

let seq = 0;

export async function createUser(overrides = {}) {
  seq += 1;
  return User.create({
    clerkId: `clerk_${seq}_${Date.now()}`,
    email: `user${seq}_${Date.now()}@test.dev`,
    fullName: `Test User ${seq}`,
    ...overrides,
  });
}

export const createSystemUser = (overrides = {}) =>
  createUser({ isSystemUser: true, ...overrides });

export const createDirect = (a, b) =>
  resolveOrCreateDirectConversation(a._id, b._id);

// creator is auto-included as participant and sole admin.
export const createGroup = (creator, members, name = "Test Group") =>
  createGroupConversation({
    creatorId: creator._id,
    participantIds: members.map((m) => m._id),
    name,
  });

// Pass { receiverId } in `extra` for direct-message shape; group messages omit it.
export async function createMessage(conversation, sender, extra = {}) {
  const fields = {
    senderId: sender._id,
    conversationId: conversation._id,
    text: "hello",
    ...extra,
  };
  return Message.create(fields);
}

// n messages, oldest first, alternating senders. _id is strictly increasing
// within one process, so array order == _id order.
export async function createMessages(conversation, senders, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      await createMessage(conversation, senders[i % senders.length], {
        text: `m${i + 1}`,
      }),
    );
  }
  return out;
}

// supertest wrapper: api(user).get(path) etc. api(null) is unauthenticated.
const app = createTestApp();

export function api(user) {
  const authed = (req) =>
    user ? req.set("x-test-clerk-id", user.clerkId) : req;
  return {
    get: (path) => authed(request(app).get(path)),
    post: (path) => authed(request(app).post(path)),
    delete: (path) => authed(request(app).delete(path)),
  };
}

export const tokenFor = (user) => `test-token:${user.clerkId}`;

export const oid = () => new mongoose.Types.ObjectId().toString();
