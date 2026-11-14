import { randomInt } from "node:crypto";

import { prisma } from "../lib/prisma.js";
import { NOTIFICATION_TYPES } from "../notifications/templates.js";
import { queueNotification } from "./notifications.js";
import type { Draw } from "../generated/prisma/client.js";

/**
 * The draw. The platform picks the winner from the paid ticket set.
 *
 * `randomInt` is used rather than `Math.random`: it draws from the OS CSPRNG
 * and rejection-samples, so the distribution over the pool is uniform with no
 * modulo bias. The chosen index is never stored — what is recorded is the
 * winning ticket itself, and `Draw.raffleId` is unique, so the outcome is
 * written exactly once and cannot be re-rolled.
 */

export class DrawError extends Error {
  readonly code: "RAFFLE_NOT_FOUND" | "NOT_SOLD_OUT" | "TICKET_COUNT_MISMATCH";

  constructor(code: DrawError["code"], message: string) {
    super(message);
    this.name = "DrawError";
    this.code = code;
  }
}

/**
 * Tells every entrant the draw is about to run.
 *
 * Driven by the `raffle.draw.notify` job, queued in the same transaction that
 * marks the raffle SOLD_OUT. One notification per holder, not per ticket:
 * someone with forty numbers gets one email, and `Notification`'s unique
 * (type, entityId, recipientUserId) enforces that even if the job retries.
 *
 * Returns how many were queued. Zero is a legitimate answer for a raffle
 * whose entrants have all been notified already.
 */
export async function notifyDrawScheduled(raffleId: string): Promise<number> {
  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: {
      id: true,
      drawAt: true,
      status: true,
      product: { select: { title: true } },
    },
  });

  // Nothing to announce once the draw has happened — a "drawing soon" email
  // arriving after the result would be worse than none.
  if (!raffle || raffle.status !== "SOLD_OUT") return 0;

  const holders = await prisma.ticket.findMany({
    where: { raffleId, status: "PAID" },
    select: { userId: true, ticketNumber: true },
    orderBy: { ticketNumber: "asc" },
  });

  const lowestByHolder = new Map<string, number>();
  for (const ticket of holders) {
    if (!lowestByHolder.has(ticket.userId)) {
      lowestByHolder.set(ticket.userId, ticket.ticketNumber);
    }
  }

  let queued = 0;
  for (const [userId, ticketNumber] of lowestByHolder) {
    // One transaction each, so a single bad recipient cannot discard the
    // notifications already written for everyone else.
    const created = await prisma.$transaction((tx) =>
      queueNotification(tx, {
        type: NOTIFICATION_TYPES.RAFFLE_DRAW_SCHEDULED,
        recipientUserId: userId,
        entityType: "Raffle",
        entityId: raffleId,
        payload: {
          productTitle: raffle.product.title,
          raffleId,
          ticketNumber,
          // Formatted at queue time, with the rest of the rendering inputs,
          // so a retry sends the same wording.
          ...(raffle.drawAt
            ? {
                drawAt: raffle.drawAt.toLocaleString("en-GB", {
                  timeZone: "Africa/Accra",
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              }
            : {}),
        },
      }),
    );

    if (created) queued++;
  }

  return queued;
}

/**
 * Executes the draw for a sold-out raffle and opens the resulting order.
 *
 * Idempotent: `Draw.raffleId` is unique, and an existing draw is returned
 * rather than replaced. Re-running a draw to get a different winner must be
 * impossible, including by accident.
 */
export async function executeDraw(raffleId: string): Promise<Draw> {
  // Generous timeout: this transaction locks the raffle, reads every ticket,
  // writes the draw, the order, two notifications and an audit row. The 5s
  // default is not enough against a remote database.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Raffle" WHERE "id" = ${raffleId} FOR UPDATE`;

    const raffle = await tx.raffle.findUnique({
      where: { id: raffleId },
      select: {
        id: true,
        productId: true,
        sellerId: true,
        status: true,
        totalTickets: true,
        product: { select: { title: true } },
      },
    });

    if (!raffle) {
      throw new DrawError("RAFFLE_NOT_FOUND", "Raffle not found");
    }

    const existing = await tx.draw.findUnique({ where: { raffleId } });
    if (existing) return existing;

    if (raffle.status !== "SOLD_OUT") {
      throw new DrawError(
        "NOT_SOLD_OUT",
        `Raffle is ${raffle.status}; only a SOLD_OUT raffle can be drawn`,
      );
    }

    // Stable order. Nothing downstream depends on it now that the winner is
    // not derived from the set, but an ordered read keeps the recorded
    // ticketCount and the audit row reproducible for the same inputs.
    const tickets = await tx.ticket.findMany({
      where: { raffleId, status: "PAID" },
      orderBy: { ticketNumber: "asc" },
      select: { id: true, ticketNumber: true, userId: true },
    });

    if (tickets.length !== raffle.totalTickets) {
      throw new DrawError(
        "TICKET_COUNT_MISMATCH",
        `Raffle is SOLD_OUT but has ${tickets.length} paid tickets of ${raffle.totalTickets}`,
      );
    }

    // Uniform over [0, tickets.length).
    const winningIndex = randomInt(tickets.length);

    const winner = tickets[winningIndex];
    if (!winner) {
      // Unreachable given randomInt's exclusive bound, but an out-of-range
      // winner must never be written rather than silently coerced.
      throw new DrawError(
        "TICKET_COUNT_MISMATCH",
        `Winning index ${winningIndex} is outside the ticket set`,
      );
    }

    const draw = await tx.draw.create({
      data: {
        raffleId,
        ticketCount: tickets.length,
        winningTicketNumber: winner.ticketNumber,
        winningTicketId: winner.id,
        winnerUserId: winner.userId,
      },
    });

    await tx.raffle.update({
      where: { id: raffleId },
      data: { status: "DRAWN" },
    });

    const order = await tx.order.create({
      data: {
        raffleId,
        productId: raffle.productId,
        winnerUserId: winner.userId,
        sellerId: raffle.sellerId,
        status: "AWAITING_ADDRESS",
      },
      select: { id: true },
    });

    // Queued inside the draw transaction. A winner who is never told has, as
    // far as they know, simply lost — so the intent to notify has to commit
    // with the draw itself.
    await queueNotification(tx, {
      type: NOTIFICATION_TYPES.RAFFLE_WON,
      recipientUserId: winner.userId,
      entityType: "Order",
      entityId: order.id,
      payload: {
        productTitle: raffle.product.title,
        raffleId,
        orderId: order.id,
        ticketNumber: winner.ticketNumber,
      },
    });

    await queueNotification(tx, {
      type: NOTIFICATION_TYPES.RAFFLE_DRAWN_SELLER,
      recipientUserId: raffle.sellerId,
      entityType: "Order",
      entityId: order.id,
      payload: { productTitle: raffle.product.title, raffleId, orderId: order.id },
    });

    await tx.auditLog.create({
      data: {
        action: "raffle.draw",
        entityType: "Raffle",
        entityId: raffleId,
        metadata: {
          drawId: draw.id,
          winningTicketNumber: winner.ticketNumber,
          ticketCount: tickets.length,
        },
      },
    });

    return draw;
  }, { timeout: 20_000, maxWait: 10_000 });
}
