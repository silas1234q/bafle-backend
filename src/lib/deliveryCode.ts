import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";

import { env } from "../env.js";

/**
 * One-time delivery codes.
 *
 * The winner mints a code when the courier arrives and reads it out; the
 * seller redeems it. Redemption is therefore evidence the winner physically
 * had the goods in front of them, which is what justifies releasing escrow.
 *
 * Only the HMAC is stored. A plain SHA-256 of a short code would be useless
 * against a database leak — six digits is a million guesses, which is instant
 * offline. Keying the hash with a server secret means a leaked row cannot be
 * turned into a working code without also stealing the secret.
 */

// Unambiguous over the phone: no 0/O, 1/I/L, or 5/S confusion.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export const DELIVERY_CODE_TTL_MS = 30 * 60_000;
export const MAX_DELIVERY_CODE_ATTEMPTS = 5;

/**
 * Derived rather than configured, so there is no new required secret and no
 * weak default. HKDF with a distinct `info` label keeps this key
 * cryptographically independent of the Clerk key it comes from, so it cannot
 * be used to forge anything on the auth side.
 */
const CODE_KEY: Buffer = Buffer.from(
  hkdfSync(
    "sha256",
    env.DELIVERY_CODE_SECRET ?? env.CLERK_SECRET_KEY,
    "bafle-delivery-code-salt",
    "bafle-delivery-code-v1",
    32,
  ),
);

/** Generates a code for display. Grouped for readability when spoken aloud. */
export function generateDeliveryCode(): { code: string; display: string } {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    // randomInt is rejection-sampled, so no modulo bias.
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return { code, display: `${code.slice(0, 4)}-${code.slice(4)}` };
}

/** Accepts the grouped or ungrouped form, any case. */
export function normaliseDeliveryCode(input: string): string {
  return input.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

export function hashDeliveryCode(code: string): string {
  return createHmac("sha256", CODE_KEY)
    .update(normaliseDeliveryCode(code), "utf8")
    .digest("hex");
}

/** Constant-time comparison, so timing cannot reveal a partial match. */
export function deliveryCodeMatches(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashDeliveryCode(code), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
