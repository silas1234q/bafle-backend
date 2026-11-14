import { getAuth } from "@clerk/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { User, UserRole } from "../generated/prisma/client.js";
import { resolveLocalUser } from "../lib/users.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      localUser?: User;
    }
  }
}

/**
 * Requires a valid Clerk session and attaches the local mirror row.
 *
 * Clerk's own `requireAuth` only proves the session is valid; domain code needs
 * our internal user id, because every foreign key points at User.id rather
 * than at a Clerk id.
 */
export const requireUser: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { isAuthenticated, userId } = getAuth(req);

  if (!isAuthenticated || !userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const user = await resolveLocalUser(userId);

    if (user.suspendedAt) {
      res.status(403).json({ error: "Account suspended" });
      return;
    }

    req.localUser = user;
    next();
  } catch (error) {
    next(error);
  }
};

/** Reads the user attached by `requireUser`. Throws if used without it. */
export function localUser(req: Request): User {
  if (!req.localUser) {
    throw new Error("localUser() used on a route without requireUser");
  }
  return req.localUser;
}

/** Role gate. Must be mounted after `requireUser`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    const user = req.localUser;

    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}
