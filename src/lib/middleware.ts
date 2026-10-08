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

/**
 * Attach req.user when a valid Bearer token is present, but let the request
 * through anonymously otherwise. For endpoints that are public yet can
 * personalize a response (the slot picker flagging the caller's own
 * in-progress checkout). A bad or expired token degrades to anonymous
 * instead of failing the request.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = await verifyAccessToken(token);
    if (!payload.sub) return next();
    const sid = payload.sid as string | undefined;
    if (sid && !(await isSessionActive(sid))) return next();
    req.user = { id: payload.sub as string, role: (payload.role as string) || "" };
  } catch {
    // Anonymous - this endpoint never rejects on a bad token.
  }
  next();
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

/**
 * Allows any authenticated user to act as a customer (book a session with
 * another astrologer or ask another astrologer a question). Astrologers may
 * also be customers, so both roles are accepted. Admins are excluded.
 */
export async function requireCustomer(
  req: Request,
  res: Response,
  next: NextFunction
) {
  return requireAuth(req, res, () => {
    const role = req.user?.role;
    if (role !== UserRole.Client && role !== UserRole.Astrologer) {
      return res.status(403).json({ error: "Customer access required" });
    }
    next();
  });
}
