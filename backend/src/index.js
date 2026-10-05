import "./lib/load-env.js";

import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import fs from "fs";
import path from "path";

import { clerkMiddleware } from "@clerk/express";

import { errorHandler } from "./middleware/error.middleware.js";

import { connectDB } from "./lib/db.js";
import { ensureAssistantUser } from "./lib/ai/assistant-user.js";
import { getPort } from "./lib/env.js";
import { createShutdown } from "./lib/shutdown.js";
import job from "./lib/cron.js";

import clerkWebhook from "./webhooks/clerk.webhook.js";
import authRoutes from "./routes/auth.route.js";
import messageRoutes from "./routes/message.route.js";
import conversationRoutes from "./routes/conversation.route.js";

import { app, server, io } from "./lib/socket.js";

const PORT = getPort();
const FRONTEND_URL = process.env.FRONTEND_URL;

const publicDir = path.join(process.cwd(), "public");

const { shutdown, isShuttingDown } = createShutdown({
  stopJobs: () => job.stop(),
  // io.close() also closes the underlying HTTP server and disconnects every
  // socket; clients reconnect to the next instance and run the Stage 10
  // catch-up.
  closeServer: () => io.close(),
  // Only a live connection needs draining. close() blocks while the initial
  // connect is still pending, and there is nothing to drain in that state.
  closeDb: async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.close();
  },
});

// Probes are registered before CORS / body parsing / Clerk so they never
// depend on any of them.
// Liveness: the process is up and serving HTTP. Always 200. Also the target
// of the keep-alive self-ping in lib/cron.js.
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Readiness: safe to receive traffic. 503 until MongoDB is connected, and
// again from the moment shutdown starts, so a load balancer stops routing here.
app.get("/ready", (req, res) => {
  const db = mongoose.connection.readyState === 1;
  const shuttingDown = isShuttingDown();

  if (!db || shuttingDown) {
    return res.status(503).json({ ok: false, db, shuttingDown });
  }
  res.status(200).json({ ok: true });
});

// it's important that you don't parse the webhook event data, it should be in the raw format
app.use(
  "/api/webhooks/clerk",
  express.raw({ type: "application/json" }),
  clerkWebhook,
);

app.use(express.json());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(clerkMiddleware());

app.use("/api/auth", authRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/conversations", conversationRoutes);

// if the public directory exists, serve the static files
// this is for the production build
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));

  app.get("/{*any}", (req, res, next) => {
    res.sendFile(path.join(publicDir, "index.html"), (err) => next(err));
  });
}

app.use(errorHandler);

server.listen(PORT, () => {
  connectDB()
    .then(() => ensureAssistantUser())
    .catch((error) => {
      console.error("Failed to ensure assistant user:", error.message);
    });
  console.log(`Server is running on port ${PORT}`);

  if (process.env.NODE_ENV === "production") job.start();
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
