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

export const sendQuestionMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

/** Birth/identity details a client supplies so answers can be accurate. */
export const questionClientDetailsSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  birthDate: z.string().trim().min(1).max(20),
  birthTime: z.string().trim().min(1).max(20),
  birthPlace: z.string().trim().min(1).max(120),
});

/** Order multiple questions at once; settled through a single covering payment. */
export const orderQuestionsSchema = z.object({
  astrologerId: z.string().uuid(),
  clientDetails: questionClientDetailsSchema.optional(),
  items: z
    .array(
      z.object({
        questionText: z.string().trim().min(3).max(1000),
        category: z.string().trim().max(40).optional(),
      })
    )
    .min(1)
    .max(20),
});