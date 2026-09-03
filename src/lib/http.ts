import type { Response } from "express";
import type { ZodError } from "zod";

export function sendValidationError(res: Response, error: ZodError) {
  return res.status(400).json({
    error: "Validation failed",
    details: error.flatten().fieldErrors,
  });
}

export function paramString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
