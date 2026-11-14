import { Router } from "express";
import { z } from "zod";

import { prisma } from "../lib/prisma.js";
import { localUser, requireUser } from "../middleware/auth.js";

export const addressesRouter = Router();

addressesRouter.use(requireUser);

const addressSchema = z.object({
  recipientName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(20),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().min(2).max(80),
  // GhanaPost GPS digital address, e.g. "GA-123-4567".
  digitalAddress: z.string().trim().max(30).optional(),
  isDefault: z.boolean().default(false),
});

addressesRouter.get("/", async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: localUser(req).id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  res.json(addresses);
});

addressesRouter.post("/", async (req, res) => {
  const parsed = addressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid address", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);
  const input = parsed.data;

  const address = await prisma.$transaction(async (tx) => {
    // Exactly one default per user; demote the others rather than letting two
    // addresses both claim it.
    if (input.isDefault) {
      await tx.address.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    return tx.address.create({
      data: {
        userId: user.id,
        recipientName: input.recipientName,
        phone: input.phone,
        line1: input.line1,
        line2: input.line2 ?? null,
        city: input.city,
        region: input.region,
        digitalAddress: input.digitalAddress ?? null,
        isDefault: input.isDefault,
      },
    });
  });

  res.status(201).json(address);
});
