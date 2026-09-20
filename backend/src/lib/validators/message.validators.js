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
