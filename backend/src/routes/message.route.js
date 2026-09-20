import express from "express";
import {
  getMessages,
  getUsersForSidebar,
  getConversationsForSidebar,
  sendMessage,
} from "../controllers/message.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import {
  requireReceiverExists,
  requireTextOrFile,
} from "../middleware/message.middleware.js";
import {
  sendMessageBodySchema,
  sendMessageParamsSchema,
} from "../lib/validators/message.validators.js";

const router = express.Router();

router.use(protectRoute);

router.get("/users", getUsersForSidebar);
router.get("/conversations", getConversationsForSidebar);
router.get("/:id", getMessages);

router.post(
  "/send/:id",
  validate(sendMessageParamsSchema, "params"),
  requireReceiverExists,
  upload.single("media"),
  requireTextOrFile,
  validate(sendMessageBodySchema, "body"),
  sendMessage,
);

export default router;
