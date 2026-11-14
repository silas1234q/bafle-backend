import { Router } from "express";

import { prisma } from "../lib/prisma.js";

export const usersRouter = Router();

// Read-only for now. Account creation belongs to the auth module (password
// hashing, email verification, sessions) rather than here.
//
// `select` is explicit on purpose: never let passwordHash reach a response.
const publicUserFields = {
  id: true,
  displayName: true,
  avatarUrl: true,
  role: true,
  kycStatus: true,
  createdAt: true,
} as const;

usersRouter.get("/", async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { suspendedAt: null },
    select: publicUserFields,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(users);
});

usersRouter.get("/:id", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: publicUserFields,
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});
