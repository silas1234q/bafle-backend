import { Router } from "express";
import { z } from "zod";

import { param } from "../lib/http.js";
import { localUser, requireUser } from "../middleware/auth.js";
import { contentLimiter, purchaseLimiter } from "../middleware/rateLimit.js";
import { prisma } from "../lib/prisma.js";
import {
  createRaffle,
  extendRaffle,
  PUBLIC_RAFFLE_FIELDS,
  raffleAvailability,
  RaffleExtendError,
  RaffleValidationError,
} from "../services/raffles.js";
import { reserveTickets, TicketPurchaseError } from "../services/tickets.js";

export const rafflesRouter = Router();

const createRaffleSchema = z.object({
  productId: z.uuid(),
  /** Pesewas per ticket. */
  ticketPrice: z.int().positive().max(2_147_483_647),
  totalTickets: z.int().min(2).max(10_000),
  closesAt: z.coerce.date(),
  platformFeeBps: z.int().min(0).max(10_000).optional(),
});

rafflesRouter.get("/", async (_req, res) => {
  const raffles = await prisma.raffle.findMany({
    where: { status: "OPEN", closesAt: { gt: new Date() } },
    select: {
      ...PUBLIC_RAFFLE_FIELDS,
      product: {
        select: {
          id: true,
          title: true,
          slug: true,
          retailValue: true,
          // Cover only. The card shows one image, and pulling all ten for
          // fifty raffles would be the bulk of this response for nothing.
          images: {
            select: { url: true, alt: true, position: true },
            orderBy: { position: "asc" },
            take: 1,
          },
        },
      },
    },
    orderBy: { closesAt: "asc" },
    take: 50,
  });

  res.json(raffles);
});

rafflesRouter.get("/:id", async (req, res) => {
  const raffle = await prisma.raffle.findUnique({
    where: { id: param(req, "id") },
    select: {
      ...PUBLIC_RAFFLE_FIELDS,
      product: {
        select: {
          id: true,
          title: true,
          slug: true,
          description: true,
          retailValue: true,
          // Ordered, so position 0 is genuinely the cover the seller chose.
          images: {
            select: { url: true, alt: true, position: true },
            orderBy: { position: "asc" },
          },
        },
      },
    },
  });

  if (!raffle) {
    res.status(404).json({ error: "Raffle not found" });
    return;
  }

  res.json({ ...raffle, availability: await raffleAvailability(raffle.id) });
});

rafflesRouter.post("/", requireUser, contentLimiter, async (req, res) => {
  const parsed = createRaffleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid raffle", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);

  try {
    const raffle = await createRaffle({
      productId: parsed.data.productId,
      sellerId: user.id,
      ticketPriceMinor: parsed.data.ticketPrice,
      totalTickets: parsed.data.totalTickets,
      closesAt: parsed.data.closesAt,
      platformFeeBps: parsed.data.platformFeeBps,
    });

    // Re-read through the public projection so the response cannot
    // accidentally carry an internal field.
    const safe = await prisma.raffle.findUniqueOrThrow({
      where: { id: raffle.id },
      select: PUBLIC_RAFFLE_FIELDS,
    });

    res.status(201).json(safe);
  } catch (error) {
    if (error instanceof RaffleValidationError) {
      res.status(400).json({ error: error.message, field: error.field });
      return;
    }
    throw error;
  }
});

const extendRaffleSchema = z.object({
  closesAt: z.coerce.date(),
});

const EXTEND_STATUS: Record<RaffleExtendError["code"], number> = {
  RAFFLE_NOT_FOUND: 404,
  NOT_EXTENDABLE: 409,
  INVALID_DEADLINE: 400,
};

/**
 * Seller pushes their draw's closing time back.
 *
 * For the draw that hit its deadline without selling out: extending it keeps
 * the tickets already bought valid, where letting it expire refunds everyone.
 */
rafflesRouter.post("/:id/extend", requireUser, contentLimiter, async (req, res) => {
  const parsed = extendRaffleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid closing time", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);

  const raffle = await prisma.raffle.findUnique({
    where: { id: param(req, "id") },
    select: { id: true, sellerId: true },
  });

  // 404 for someone else's raffle as well as a missing one: the raffle id is
  // public, but whether you own it should not be probeable.
  if (!raffle || raffle.sellerId !== user.id) {
    res.status(404).json({ error: "Raffle not found" });
    return;
  }

  try {
    await extendRaffle(raffle.id, parsed.data.closesAt);
  } catch (error) {
    if (error instanceof RaffleExtendError) {
      res.status(EXTEND_STATUS[error.code]).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    throw error;
  }

  const safe = await prisma.raffle.findUniqueOrThrow({
    where: { id: raffle.id },
    select: PUBLIC_RAFFLE_FIELDS,
  });

  res.json(safe);
});

const buyTicketsSchema = z.object({
  // 10,000 is `MAX_TICKETS` in services/raffles.ts — the largest pool a raffle
  // can have, so the largest meaningful purchase. The real bound is the
  // raffle's own ticket count, which only `reserveTickets` can know; this just
  // keeps an absurd number out of the service.
  quantity: z.int().min(1).max(10_000),
});

const PURCHASE_STATUS: Record<TicketPurchaseError["code"], number> = {
  RAFFLE_NOT_FOUND: 404,
  RAFFLE_CLOSED: 409,
  NOT_ENOUGH_TICKETS: 409,
  SELLER_CANNOT_ENTER: 403,
  INVALID_QUANTITY: 400,
  CHECKOUT_FAILED: 502,
};

// Limiter after requireUser so it keys on the user, not a shared NAT IP.
rafflesRouter.post("/:id/tickets", requireUser, purchaseLimiter, async (req, res) => {
  const parsed = buyTicketsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid quantity", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);

  try {
    // Note what is NOT taken from the request: the price. It is read from the
    // raffle row inside the transaction.
    const result = await reserveTickets({
      raffleId: param(req, "id"),
      userId: user.id,
      customerEmail: user.email,
      quantity: parsed.data.quantity,
    });

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof TicketPurchaseError) {
      res.status(PURCHASE_STATUS[error.code]).json({
        error: error.message,
        code: error.code,
        ...(error.available !== undefined ? { available: error.available } : {}),
      });
      return;
    }
    throw error;
  }
});

/**
 * Public draw result.
 *
 * Deliberately narrow: the winning number, the winner's username and the pool
 * size. `winnerUserId` is never selected — the username is the only identity
 * a stranger gets.
 */
rafflesRouter.get("/:id/draw", async (req, res) => {
  const draw = await prisma.draw.findUnique({
    where: { raffleId: param(req, "id") },
    select: {
      raffleId: true,
      ticketCount: true,
      winningTicketNumber: true,
      drawnAt: true,
      winner: { select: { username: true } },
    },
  });

  if (!draw) {
    const raffle = await prisma.raffle.findUnique({
      where: { id: param(req, "id") },
      select: { status: true },
    });

    if (!raffle) {
      res.status(404).json({ error: "Raffle not found" });
      return;
    }

    res.status(409).json({
      error: "Raffle has not been drawn yet",
      status: raffle.status,
    });
    return;
  }

  res.json({
    ...draw,
    winnerUsername: draw.winner.username,
    winner: undefined,
  });
});
