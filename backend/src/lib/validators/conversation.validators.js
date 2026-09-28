import { z } from "zod";

const objectId = (label) =>
  z.string().regex(/^[0-9a-fA-F]{24}$/, `Invalid ${label}`);

export const conversationIdParamsSchema = z.object({
  conversationId: objectId("conversation ID"),
});

export const memberParamsSchema = z.object({
  conversationId: objectId("conversation ID"),
  memberId: objectId("member ID"),
});

export const createGroupBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Group name is required")
      .max(100, "Group name is too long"),
    avatar: z.string().trim().url("Invalid avatar URL").optional(),
    participantIds: z
      .array(objectId("participant ID"))
      .min(1, "A group needs at least one other participant")
      .max(99, "Too many participants"),
  })
  .strict();

export const addMemberBodySchema = z
  .object({
    memberId: objectId("member ID"),
  })
  .strict();
