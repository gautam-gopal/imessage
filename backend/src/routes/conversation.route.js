import express from "express";
import {
  createGroup,
  addMember,
  removeMember,
  sendConversationMessage,
  getConversationMessages,
} from "../controllers/conversation.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { upload } from "../middleware/upload.middleware.js";
import { verifyFileType } from "../middleware/file-type.middleware.js";
import { requireTextOrFile } from "../middleware/message.middleware.js";
import {
  requireConversationMembership,
  requireGroupConversation,
  requireGroupAdmin,
} from "../middleware/conversation.middleware.js";
import {
  createGroupBodySchema,
  conversationIdParamsSchema,
  memberParamsSchema,
  addMemberBodySchema,
} from "../lib/validators/conversation.validators.js";
import { sendMessageBodySchema } from "../lib/validators/message.validators.js";

const router = express.Router();

router.use(protectRoute);

router.post("/", validate(createGroupBodySchema, "body"), createGroup);

router.post(
  "/:conversationId/members",
  validate(conversationIdParamsSchema, "params"),
  requireConversationMembership,
  requireGroupConversation,
  requireGroupAdmin,
  validate(addMemberBodySchema, "body"),
  addMember,
);

router.delete(
  "/:conversationId/members/:memberId",
  validate(memberParamsSchema, "params"),
  requireConversationMembership,
  requireGroupConversation,
  removeMember,
);

// Group-only. Direct-message send/history keeps using the existing
// receiver-oriented routes (POST /messages/send/:id, GET /messages/:id)
// unchanged.
router.post(
  "/:conversationId/messages",
  validate(conversationIdParamsSchema, "params"),
  requireConversationMembership,
  requireGroupConversation,
  upload.single("media"),
  verifyFileType,
  requireTextOrFile,
  validate(sendMessageBodySchema, "body"),
  sendConversationMessage,
);

router.get(
  "/:conversationId/messages",
  validate(conversationIdParamsSchema, "params"),
  requireConversationMembership,
  requireGroupConversation,
  getConversationMessages,
);

export default router;
