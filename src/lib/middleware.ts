import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./auth";

export interface AuthUser {
  id: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    const payload = await verifyAccessToken(token);
    if (!payload.sub) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = { id: payload.sub as string, role: (payload.role as string) || "" };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
