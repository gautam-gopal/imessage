import { z } from "zod";

export const sendMessageParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid receiver ID"),
});

export const sendMessageBodySchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Message cannot be empty")
      .max(5000, "Message is too long")
      .optional(),
  })
  .strict();

export const MESSAGE_PAGE_DEFAULT_LIMIT = 30;
export const MESSAGE_PAGE_MAX_LIMIT = 100;

export const messageHistoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int("limit must be an integer")
      .min(1, "limit must be at least 1")
      .max(
        MESSAGE_PAGE_MAX_LIMIT,
        `limit cannot exceed ${MESSAGE_PAGE_MAX_LIMIT}`,
      )
      .default(MESSAGE_PAGE_DEFAULT_LIMIT),
    before: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, "Invalid cursor")
      .optional(),
  })
  .strict();
