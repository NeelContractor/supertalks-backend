// validation/questions.ts
import { z } from "zod";

export const createQuestionSchema = z.object({
  astrologerId: z.string().uuid(),
  questionText: z.string().trim().min(10).max(1000),
  category: z.string().max(40).optional(),
});

export const answerQuestionSchema = z.object({
  answerText: z.string().trim().min(1).max(5000),
});

export const rejectQuestionSchema = z.object({
  reason: z.string().max(300),
});