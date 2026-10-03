import express from "express";
import http from "http";
import { Server } from "socket.io";
import { verifyToken } from "@clerk/backend";
import User from "../models/user.model.js";
import Conversation from "../models/conversation.model.js";
import { markMessagesReadUpTo } from "./read-receipts.js";
import { markReadSocketPayloadSchema } from "./validators/conversation.validators.js";

const app = express();
const server = http.createServer(app);

const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:5173";

const io = new Server(server, { cors: { origin: [allowedOrigin] } });

// online users map = { userId: Set<socketId> }
const userSocketMap = {};

// Joins every currently-connected socket of a conversation's participants
// to that conversation's room. Both the room id and participant list come
// from the same server-side Conversation document.
export function joinConversationRoom(conversation) {
  if (!conversation?._id || !Array.isArray(conversation.participants)) return;

  const room = String(conversation._id);

  for (const participantId of conversation.participants) {
    const sockets = userSocketMap[String(participantId)];
    if (!sockets) continue;

    for (const socketId of sockets) {
      io.in(socketId).socketsJoin(room);
    }
  }
}

// Removes every currently-connected socket belonging to userId from a
// conversation's room. Delivery-state cleanup only — not an authorization
// step. Used when a group member is removed or self-leaves, so they stop
// receiving room events for a conversation they're no longer part of. If
// this is ever skipped, reconnect already rebuilds room membership from
// current DB state, so it cannot become a stale-authorization hole.
export function leaveConversationRoom(conversationId, userId) {
  if (!conversationId || !userId) return;

  const room = String(conversationId);
  const sockets = userSocketMap[String(userId)];
  if (!sockets) return;

  for (const socketId of sockets) {
    io.in(socketId).socketsLeave(room);
  }
}

// Emits a private event to every currently-connected socket of one user (all
// tabs/devices). Not room-based and not persisted: a user with no open socket
// simply does not receive it. The userId must come from server state, never
// from client input.
export function emitToUser(userId, event, payload) {
  const sockets = userSocketMap[String(userId)];
  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized"));

    const { sub: clerkId } = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    const user = await User.findOne({ clerkId });
    if (!user) return next(new Error("Unauthorized"));

    socket.userId = String(user._id);
    next();
  } catch (error) {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.userId;
  if (!userId) return;

  let sockets = userSocketMap[userId];

  if (!sockets) {
    sockets = new Set();
    userSocketMap[userId] = sockets;
  }

  const wasOffline = sockets.size === 0;

  sockets.add(socket.id);

  if (wasOffline) {
    io.emit("getOnlineUsers", Object.keys(userSocketMap));
  }

  socket.on("disconnect", () => {
    const currentSockets = userSocketMap[userId];
    if (!currentSockets) return;

    currentSockets.delete(socket.id);

    if (currentSockets.size === 0) {
      delete userSocketMap[userId];

      io.emit("getOnlineUsers", Object.keys(userSocketMap));

      User.updateOne(
        { _id: userId },
        { $set: { lastSeenAt: new Date() } },
      ).catch((error) => {
        console.error("Error updating lastSeenAt:", error.message);
      });
    }
  });

  // Client -> server: "I have read everything in this conversation up to
  // upToMessageId". Identity is the handshake-derived socket.userId; the
  // payload is only a claim. Authorization is a fresh DB check, never the
  // socket's room membership.
  socket.on("message:read", async (payload, ack) => {
    const respond = (body) => {
      if (typeof ack === "function") ack(body);
    };

    try {
      const parsed = markReadSocketPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return respond({
          ok: false,
          error: parsed.error.issues[0]?.message || "Invalid request",
        });
      }

      const { conversationId, upToMessageId } = parsed.data;

      const [humanUser, conversation] = await Promise.all([
        User.exists({ _id: userId, isSystemUser: { $ne: true } }),
        Conversation.findOne(
          { _id: conversationId, participants: userId },
          { _id: 1 },
        ).lean(),
      ]);

      if (!humanUser) {
        return respond({ ok: false, error: "Forbidden" });
      }

      if (!conversation) {
        return respond({ ok: false, error: "Conversation not found" });
      }

      const result = await markMessagesReadUpTo({
        conversationId: conversation._id,
        userId,
        upToMessageId,
      });

      if (!result) {
        return respond({ ok: false, error: "Message not found" });
      }

      if (result.modifiedCount > 0) {
        // Room name comes from the DB document's _id (canonical lowercase
        // hex), not the client string, so it always matches the join key.
        io.to(String(conversation._id)).emit("message:read", {
          conversationId: String(conversation._id),
          readerId: String(result.readerId),
          upToMessageId: String(result.upToMessageId),
          readAt: result.readAt,
        });
      }

      respond({ ok: true, modifiedCount: result.modifiedCount });
    } catch (error) {
      console.error("Error in message:read handler:", error.message);
      respond({ ok: false, error: "Internal server error" });
    }
  });

  // Join every conversation this authenticated user is actually a
  // participant of. The user ID comes from the verified Clerk identity.
  Conversation.find({ participants: userId }, { _id: 1 })
    .lean()
    .then((conversations) => {
      for (const conversation of conversations) {
        socket.join(String(conversation._id));
      }
    })
    .catch((error) => {
      console.error("Error joining conversation rooms:", error.message);
    });
});

export { app, server, io };
