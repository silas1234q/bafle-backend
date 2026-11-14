import { clerkClient } from "@clerk/express";

import { Prisma } from "../generated/prisma/client.js";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { normaliseUsername, suggestUsername, validateUsername } from "./username.js";

const MAX_USERNAME_ATTEMPTS = 6;

/** Returns the conflicting field list for a P2002, else null. */
function uniqueConflict(error: unknown): string {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = error.meta?.["target"];
    if (Array.isArray(target)) return target.join(",");
    if (typeof target === "string") return target;
    return "";
  }
  return "";
}

export interface ClerkIdentity {
  clerkUserId: string;
  email: string;
  emailVerified: boolean;
  phone?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Clerk-side username, if the instance collects one. */
  preferredUsername?: string | null;
}

/**
 * Creates the local mirror row for a Clerk user, assigning a default handle.
 *
 * Idempotent: if the row already exists (webhook and a live request racing to
 * provision the same signup) the existing row is returned.
 */
export async function provisionUser(identity: ClerkIdentity): Promise<User> {
  const existing = await prisma.user.findUnique({
    where: { clerkUserId: identity.clerkUserId },
  });
  if (existing) return existing;

  // Honour a Clerk-side username only if it passes our own rules.
  const preferred =
    identity.preferredUsername &&
    validateUsername(identity.preferredUsername) === null
      ? normaliseUsername(identity.preferredUsername)
      : null;

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
    // Widen the random tail each retry so repeated collisions converge.
    const username =
      attempt === 0 && preferred
        ? preferred
        : suggestUsername(identity.email, 4 + attempt);

    try {
      return await prisma.user.create({
        data: {
          clerkUserId: identity.clerkUserId,
          email: identity.email.toLowerCase(),
          phone: identity.phone ?? null,
          username,
          displayName: identity.displayName ?? null,
          avatarUrl: identity.avatarUrl ?? null,
          emailVerifiedAt: identity.emailVerified ? new Date() : null,
        },
      });
    } catch (error) {
      const conflict = uniqueConflict(error);

      // Lost a provisioning race — the other writer's row is authoritative.
      if (conflict.includes("clerkUserId")) {
        const row = await prisma.user.findUnique({
          where: { clerkUserId: identity.clerkUserId },
        });
        if (row) return row;
      }

      if (conflict.includes("username")) continue; // try another handle

      if (conflict.includes("email")) {
        throw new Error(
          `Email ${identity.email} is already linked to a different Clerk user`,
        );
      }

      throw error;
    }
  }

  throw new Error(
    `Could not allocate a unique username for ${identity.clerkUserId} after ${MAX_USERNAME_ATTEMPTS} attempts`,
  );
}

/** Applies a Clerk `user.updated` to the mirror. Never touches username. */
export async function syncUser(identity: ClerkIdentity): Promise<User | null> {
  const existing = await prisma.user.findUnique({
    where: { clerkUserId: identity.clerkUserId },
  });

  // Update arriving before create: provision instead of dropping it.
  if (!existing) return provisionUser(identity);

  return prisma.user.update({
    where: { clerkUserId: identity.clerkUserId },
    data: {
      email: identity.email.toLowerCase(),
      phone: identity.phone ?? existing.phone,
      avatarUrl: identity.avatarUrl ?? existing.avatarUrl,
      displayName: identity.displayName ?? existing.displayName,
      emailVerifiedAt: identity.emailVerified
        ? (existing.emailVerifiedAt ?? new Date())
        : null,
    },
  });
}

/**
 * Handles Clerk `user.deleted`.
 *
 * The row is anonymised, not deleted: it is referenced by tickets, payments,
 * orders and ledger entries, and those records must survive for accounting and
 * dispute history. Identifiers are scrambled so the real email and handle are
 * freed for reuse, and the account is suspended so it cannot transact.
 */
export async function anonymiseUser(clerkUserId: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (!existing) return null;

  return prisma.user.update({
    where: { clerkUserId },
    data: {
      clerkUserId: `deleted:${clerkUserId}`,
      email: `deleted+${existing.id}@deleted.invalid`,
      phone: null,
      username: `deleted_${existing.id.replace(/-/g, "").slice(0, 12)}`,
      displayName: null,
      avatarUrl: null,
      suspendedAt: existing.suspendedAt ?? new Date(),
      suspendedReason: "clerk_user_deleted",
    },
  });
}

/**
 * Resolves the local user for an authenticated Clerk session, provisioning on
 * demand. The lazy path matters: webhook delivery can lag or fail, and a user
 * who just signed up should not get errors while we wait for it.
 */
export async function resolveLocalUser(clerkUserId: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) return existing;

  const clerkUser = await clerkClient.users.getUser(clerkUserId);

  const primary =
    clerkUser.emailAddresses.find(
      (address) => address.id === clerkUser.primaryEmailAddressId,
    ) ?? clerkUser.emailAddresses[0];

  if (!primary) {
    throw new Error(`Clerk user ${clerkUserId} has no email address`);
  }

  const name = [clerkUser.firstName, clerkUser.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return provisionUser({
    clerkUserId,
    email: primary.emailAddress,
    emailVerified: primary.verification?.status === "verified",
    phone: clerkUser.primaryPhoneNumber?.phoneNumber ?? null,
    displayName: name.length > 0 ? name : null,
    avatarUrl: clerkUser.imageUrl ?? null,
    preferredUsername: clerkUser.username ?? null,
  });
}
