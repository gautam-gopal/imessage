import express from "express";
import messageRoutes from "../../src/routes/message.route.js";
import conversationRoutes from "../../src/routes/conversation.route.js";
import { errorHandler } from "../../src/middleware/error.middleware.js";

// Same routers and error handler as src/index.js, without listen(), Clerk
// middleware, CORS, or the DB bootstrap. Importing src/index.js would start
// a real server, so it is deliberately not used.
export function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  app.use("/api/conversations", conversationRoutes);
  app.use(errorHandler);
  return app;
}
