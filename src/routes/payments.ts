import { Router } from "express";

import { param } from "../lib/http.js";
import { localUser, requireUser } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { settleTicketPayment } from "../services/payments.js";

export const paymentsRouter = Router();

paymentsRouter.use(requireUser);

/**
 * Settles a checkout the buyer has just come back from.
 *
 * The provider's webhook is the primary confirmation path, but it is not
 * sufficient on its own: it can be delayed or lost, and in local development
 * it never arrives at all, because the provider has no route to localhost.
 * Without this endpoint a buyer pays, their numbers stay RESERVED, and the
 * reservation sweep quietly releases them — money taken, no ticket.
 *
 * Safe to call repeatedly, and safe to call alongside the webhook: everything
 * underneath is keyed on a unique reference, so the second caller confirms
 * nothing new rather than double-crediting.
 *
 * This endpoint does NOT trust the caller for anything that matters. The
 * reference identifies a payment we issued, ownership is checked against the
 * session, and the amount is re-read from the provider inside
 * `confirmTicketPayment`.
 */
paymentsRouter.post("/:reference/verify", async (req, res) => {
  const user = localUser(req);
  const reference = param(req, "reference");

  const payment = await prisma.payment.findUnique({
    where: { reference },
    select: { id: true, userId: true },
  });

  // Same response whether it is missing or someone else's, so this cannot be
  // used to probe for other people's references.
  if (!payment || payment.userId !== user.id) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  const result = await settleTicketPayment(reference);

  // Read after settling, so a successful confirmation returns the numbers in
  // the same round trip the page already has to make.
  const fresh = await prisma.payment.findUniqueOrThrow({
    where: { reference },
    select: {
      status: true,
      amount: true,
      quantity: true,
      paidAt: true,
      raffleId: true,
      raffle: { select: { id: true, product: { select: { title: true } } } },
      tickets: {
        select: { ticketNumber: true, status: true },
        orderBy: { ticketNumber: "asc" },
      },
    },
  });

  res.json({
    reference,
    outcome: result.outcome,
    status: fresh.status,
    amount: fresh.amount,
    quantity: fresh.quantity,
    paidAt: fresh.paidAt,
    raffleId: fresh.raffleId,
    productTitle: fresh.raffle?.product.title ?? null,
    ticketNumbers: fresh.tickets.map((ticket) => ticket.ticketNumber),
    ticketsPaid: fresh.tickets.filter((ticket) => ticket.status === "PAID")
      .length,
    raffleSoldOut: result.raffleSoldOut,
    drawId: result.drawId,
  });
});
