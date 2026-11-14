import express, { Router } from "express";
import { Webhook } from "svix";

import { env } from "../env.js";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  anonymiseUser,
  provisionUser,
  syncUser,
  type ClerkIdentity,
} from "../lib/users.js";

export const clerkWebhookRouter = Router();

interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: { status?: string | null } | null;
}

interface ClerkPhoneNumber {
  id: string;
  phone_number: string;
}

interface ClerkUserData {
  id: string;
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
  phone_numbers?: ClerkPhoneNumber[];
  primary_phone_number_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
}

interface ClerkWebhookEvent {
  type: string;
  data: ClerkUserData;
}

function toIdentity(data: ClerkUserData): ClerkIdentity | null {
  const emails = data.email_addresses ?? [];
  const primaryEmail =
    emails.find((entry) => entry.id === data.primary_email_address_id) ??
    emails[0];

  if (!primaryEmail) return null;

  const phones = data.phone_numbers ?? [];
  const primaryPhone =
    phones.find((entry) => entry.id === data.primary_phone_number_id) ??
    phones[0];

  const name = [data.first_name, data.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    clerkUserId: data.id,
    email: primaryEmail.email_address,
    emailVerified: primaryEmail.verification?.status === "verified",
    phone: primaryPhone?.phone_number ?? null,
    displayName: name.length > 0 ? name : null,
    avatarUrl: data.image_url ?? null,
    preferredUsername: data.username ?? null,
  };
}

// express.raw is mounted here, not globally: svix verifies the exact bytes
// Clerk signed, and express.json() would have already replaced them with a
// parsed object.
clerkWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const svixId = req.header("svix-id");
    const svixTimestamp = req.header("svix-timestamp");
    const svixSignature = req.header("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      res.status(400).json({ error: "Missing svix signature headers" });
      return;
    }

    const rawBody = req.body as Buffer;

    let event: ClerkWebhookEvent;
    try {
      // svix 2.x `verify` returns undefined — it asserts by throwing, so the
      // body is parsed separately once the signature is known to be good.
      new Webhook(env.CLERK_WEBHOOK_SIGNING_SECRET).verify(rawBody, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });

      event = JSON.parse(rawBody.toString("utf8")) as ClerkWebhookEvent;
    } catch {
      // Deliberately not recorded: an unauthenticated caller could otherwise
      // fill WebhookEvent with junk rows.
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // Idempotency. `processedAt` is the real guard — a row that exists but was
    // never processed is a previous failed attempt and must be retried, not
    // skipped as a duplicate.
    const seen = await prisma.webhookEvent.findUnique({
      where: { eventId: svixId },
    });

    if (seen?.processedAt) {
      res.status(200).json({ status: "duplicate" });
      return;
    }

    if (!seen) {
      try {
        await prisma.webhookEvent.create({
          data: {
            provider: "clerk",
            eventId: svixId,
            eventType: event.type,
            signatureValid: true,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        // Concurrent delivery of the same event won the race.
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
      switch (event.type) {
        case "user.created": {
          const identity = toIdentity(event.data);
          if (!identity) throw new Error("user.created payload has no email");
          await provisionUser(identity);
          break;
        }
        case "user.updated": {
          const identity = toIdentity(event.data);
          if (!identity) throw new Error("user.updated payload has no email");
          await syncUser(identity);
          break;
        }
        case "user.deleted": {
          await anonymiseUser(event.data.id);
          break;
        }
        default:
          // Unhandled event types are still marked processed so Clerk stops
          // retrying them.
          break;
      }

      await prisma.webhookEvent.update({
        where: { eventId: svixId },
        data: {
          processedAt: new Date(),
          processingError: null,
          attempts: { increment: 1 },
        },
      });

      res.status(200).json({ status: "ok" });
    } catch (error) {
      await prisma.webhookEvent.update({
        where: { eventId: svixId },
        data: {
          processingError: error instanceof Error ? error.message : String(error),
          attempts: { increment: 1 },
        },
      });

      // 5xx so Clerk retries with backoff.
      res.status(500).json({ error: "Webhook processing failed" });
    }
  },
);
