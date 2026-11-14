import { Router } from "express";
import { z } from "zod";

import { Prisma } from "../generated/prisma/client.js";
import { localUser, requireUser } from "../middleware/auth.js";
import { usernameLimiter } from "../middleware/rateLimit.js";
import { prisma } from "../lib/prisma.js";
import { USERNAME_PATTERN, normaliseUsername, validateUsername } from "../lib/username.js";

export const meRouter = Router();

meRouter.use(requireUser);

/** Days a user must wait between handle changes. */
const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

// Schema-first, matching every other route. The pattern lives in
// lib/username.ts so the client, this schema and the service cannot drift.
const usernameSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      USERNAME_PATTERN,
      "3-20 characters, start with a letter, then letters, numbers or underscores",
    ),
});

meRouter.get("/", (req, res) => {
  const user = localUser(req);

  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    // Lets the client prompt for a real handle on first sign-in.
    usernameIsDefault: user.usernameUpdatedAt === null,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    kycStatus: user.kycStatus,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  });
});

meRouter.patch("/username", usernameLimiter, async (req, res) => {
  const parsed = usernameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid username",
      issues: z.treeifyError(parsed.error),
    });
    return;
  }

  const user = localUser(req);
  const username = normaliseUsername(parsed.data.username);

  // The reserved-word list is enforced in one place, not duplicated here.
  if (validateUsername(username) === "reserved") {
    res.status(400).json({ error: "That username is reserved" });
    return;
  }

  if (username === user.username) {
    res.status(400).json({ error: "That is already your username" });
    return;
  }

  // Cooldown applies only once they've set one themselves — the generated
  // default can always be replaced immediately.
  if (user.usernameUpdatedAt) {
    const nextAllowed = new Date(user.usernameUpdatedAt);
    nextAllowed.setDate(nextAllowed.getDate() + USERNAME_CHANGE_COOLDOWN_DAYS);

    if (nextAllowed > new Date()) {
      res.status(429).json({
        error: "Username was changed recently",
        nextAllowedAt: nextAllowed.toISOString(),
      });
      return;
    }
  }

  try {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { username, usernameUpdatedAt: new Date() },
    });

    res.json({ username: updated.username, usernameIsDefault: false });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      res.status(409).json({ error: "That username is taken" });
      return;
    }
    throw error;
  }
});
