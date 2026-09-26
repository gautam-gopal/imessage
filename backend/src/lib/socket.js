import express from "express";
import http from "http";
import { Server } from "socket.io";
import { verifyToken } from "@clerk/backend";
import User from "../models/user.model.js";
import Conversation from "../models/conversation.model.js";

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
