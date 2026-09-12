import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, isSessionActive } from "./auth";
import { UserRole } from "@prisma/client";

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

    // If the token carries a session id, make sure that session wasn't revoked
    // by a newer login on another device. Tokens without `sid` (issued before
    // this policy existed, or by internal flows) are accepted as-is.
    const sid = payload.sid as string | undefined;
    if (sid && !(await isSessionActive(sid))) {
      return res.status(401).json({ error: "Session expired" });
    }

    req.user = { id: payload.sub as string, role: (payload.role as string) || "" };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function requireClient(
  req: Request,
  res: Response,
  next: NextFunction
) {
  return requireAuth(req, res, () => {
    if (!req.user || req.user.role !== UserRole.Client) {
      return res.status(403).json({ error: "Client access required" });
    }
    next();
  });
}
