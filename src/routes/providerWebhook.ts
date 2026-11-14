import express, { Router } from "express";

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { paymentProvider } from "../payments/index.js";
import { payerDestinationFromWebhook } from "../payments/moolre.js";
import {
  recordRefundDestination,
  settleTicketPayment,
} from "../services/payments.js";
import { markPayoutFailed, markPayoutPaid } from "../services/payouts.js";
import { settleRefund } from "../services/refunds.js";

export const providerWebhookRouter = Router();

interface ChargePayload {
  data?: { reference?: unknown };
}

interface TransferPayload {
  data?: { reference?: unknown; transfer_code?: unknown; reason?: unknown };
}

interface MoolrePayload {
  data?: { externalref?: unknown; reason?: unknown };
}

interface RefundPayload {
  data?: {
    transaction_reference?: unknown;
    transaction?: unknown;
    reference?: unknown;
    id?: unknown;
  };
}

/** Reads whichever reference field the provider actually populated. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Same structure as the Clerk handler: raw body mounted locally (the global
// JSON parser would destroy the bytes the signature covers), signature checked
// before anything is recorded, and `processedAt` as the duplicate guard so a
// previously failed attempt still gets retried.
providerWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body as Buffer;

    const envelope = paymentProvider().verifyWebhook(rawBody, req.headers);

    if (!envelope) {
      // Nothing recorded: an unauthenticated caller could otherwise fill
      // WebhookEvent with junk rows.
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const seen = await prisma.webhookEvent.findUnique({
      where: { eventId: envelope.eventId },
    });

    if (seen?.processedAt) {
      res.status(200).json({ status: "duplicate" });
      return;
    }

    if (!seen) {
      try {
        await prisma.webhookEvent.create({
          data: {
            // The driver that verified it, not a constant: both providers are
            // selectable during the migration and the suites clean up by it.
            provider: paymentProvider().name,
            eventId: envelope.eventId,
            eventType: envelope.eventType,
            signatureValid: true,
            payload: envelope.payload as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          res.status(200).json({ status: "duplicate" });
          return;
        }
        throw error;
      }
    }

    try {
      let detail: Record<string, unknown> = {};

      switch (envelope.eventType) {
        case "charge.success": {
          const reference = (envelope.payload as ChargePayload).data?.reference;
          if (typeof reference !== "string") {
            throw new Error("charge.success payload has no reference");
          }

          // Re-queries the provider rather than trusting these bytes, then
          // draws if that was the last ticket. Shared with the buyer's return
          // page so the two paths cannot drift apart.
          const result = await settleTicketPayment(reference);
          detail = {
            outcome: result.outcome,
            soldOut: result.raffleSoldOut,
            drawId: result.drawId,
          };
          break;
        }

        // Moolre's payment callbacks. P01 is a successful collection, P02 a
        // failed one; it sends no transfer events at all, which is why
        // payouts and refunds are settled by polling instead.
        case "P01": {
          const reference = (envelope.payload as MoolrePayload).data?.externalref;
          if (typeof reference !== "string") {
            throw new Error("P01 payload has no externalref");
          }

          // Captured before settling, because this callback is the only place
          // the payer is ever disclosed and settling can return early.
          const destination = payerDestinationFromWebhook(envelope.payload);
          const destinationStored = destination
            ? await recordRefundDestination(reference, destination)
            : false;

          const settled = await settleTicketPayment(reference);
          detail = {
            outcome: settled.outcome,
            soldOut: settled.raffleSoldOut,
            drawId: settled.drawId,
            // Surfaced so a refund that will need a human is visible in the
            // response and the request log, not only once a raffle expires.
            refundDestination: destination
              ? destinationStored
                ? "stored"
                : "already_known"
              : "unavailable",
          };
          break;
        }

        case "P02": {
          const data = (envelope.payload as MoolrePayload).data;
          const reference = firstString(data?.externalref);
          if (!reference) throw new Error("P02 payload has no externalref");

          // Re-queried rather than trusted, exactly as the success path is: a
          // callback claiming failure must not be able to abandon a payment
          // that actually went through.
          const settled = await settleTicketPayment(reference);
          detail = { outcome: settled.outcome, reason: firstString(data?.reason) };
          break;
        }

        case "transfer.success": {
          const data = (envelope.payload as TransferPayload).data;
          const reference = firstString(data?.reference);
          if (!reference) throw new Error("transfer.success has no reference");

          const payout = await prisma.payout.findUnique({
            where: { reference },
            select: { id: true },
          });
          if (!payout) {
            // Not ours. Acknowledge rather than retrying forever.
            detail = { handled: false, reason: "unknown_payout" };
            break;
          }

          await markPayoutPaid(payout.id, firstString(data?.transfer_code));
          detail = { payoutId: payout.id, outcome: "paid" };
          break;
        }

        case "transfer.failed":
        case "transfer.reversed": {
          const data = (envelope.payload as TransferPayload).data;
          const reference = firstString(data?.reference);
          if (!reference) throw new Error(`${envelope.eventType} has no reference`);

          await markPayoutFailed(
            reference,
            firstString(data?.reason) ?? envelope.eventType,
          );
          detail = { outcome: "payout_failed" };
          break;
        }

        case "refund.processed":
        case "refund.pending":
        case "refund.failed": {
          const data = (envelope.payload as RefundPayload).data;
          // Paystack's refund payload shape varies by event; match on the
          // original transaction reference, which is always present in one of
          // these fields, rather than guessing a refund id key.
          const transactionReference = firstString(
            data?.transaction_reference,
            data?.transaction,
            data?.reference,
          );

          if (!transactionReference) {
            detail = { handled: false, reason: "no_transaction_reference" };
            break;
          }

          const refund = await prisma.refund.findFirst({
            where: {
              payment: { reference: transactionReference },
              status: { in: ["PENDING", "PROCESSING"] },
            },
            select: { id: true },
            orderBy: { createdAt: "desc" },
          });

          if (!refund) {
            detail = { handled: false, reason: "no_open_refund" };
            break;
          }

          if (envelope.eventType === "refund.processed") {
            await settleRefund(refund.id, firstString(data?.id ? String(data.id) : null));
            detail = { refundId: refund.id, outcome: "settled" };
          } else if (envelope.eventType === "refund.failed") {
            await prisma.refund.update({
              where: { id: refund.id },
              data: { status: "FAILED", failureReason: "provider_reported_failure" },
            });
            detail = { refundId: refund.id, outcome: "failed" };
          } else {
            detail = { refundId: refund.id, outcome: "pending" };
          }
          break;
        }

        default:
          // Recorded and acknowledged so Paystack stops retrying an event we
          // have no handler for.
          detail = { handled: false };
          break;
      }

      await prisma.webhookEvent.update({
        where: { eventId: envelope.eventId },
        data: {
          processedAt: new Date(),
          processingError: null,
          attempts: { increment: 1 },
        },
      });

      res.status(200).json({ status: "ok", ...detail });
    } catch (error) {
      await prisma.webhookEvent.update({
        where: { eventId: envelope.eventId },
        data: {
          processingError:
            error instanceof Error ? error.message : String(error),
          attempts: { increment: 1 },
        },
      });

      console.error("paystack webhook failed", error);
      // 5xx so Paystack retries with backoff.
      res.status(500).json({ error: "Webhook processing failed" });
    }
  },
);
