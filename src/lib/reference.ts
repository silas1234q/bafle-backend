import { randomBytes } from "node:crypto";

// Paystack applies two DIFFERENT charset rules, and a reference has to satisfy
// whichever endpoint it reaches:
//
//   transaction reference  — alphanumerics plus  -  .  =
//   transfer reference     — LOWERCASE alphanumerics plus  -  _  , min 16 chars
//
// The intersection is: lowercase alphanumerics and "-", at least 16 characters.
// Generating inside that intersection means one generator works everywhere and
// a reference can never be rejected for the wrong reason.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 18;

/**
 * Creates a provider-safe idempotency key, e.g. `tkt-k3f9x2m1q8ablz04nd`.
 *
 * @param prefix lowercase letters only; becomes a readable tag in dashboards.
 */
export function newReference(prefix: string): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) {
    throw new RangeError(`Reference prefix must be 2-8 lowercase letters, got "${prefix}"`);
  }

  // Rejection-free sampling: 36 does not divide 256, so modulo would bias the
  // alphabet. Drawing extra bytes and masking to 5 bits with a retry keeps it
  // uniform without a measurable cost at this size.
  let out = "";
  while (out.length < RANDOM_LENGTH) {
    for (const byte of randomBytes(RANDOM_LENGTH)) {
      if (out.length === RANDOM_LENGTH) break;
      const index = byte % 36;
      // Only accept bytes from the unbiased range.
      if (byte < 252) out += ALPHABET[index];
    }
  }

  return `${prefix}-${out}`;
}

/** True when a string is safe for both Paystack reference charsets. */
export function isProviderSafeReference(value: string): boolean {
  return /^[a-z0-9-]{16,100}$/.test(value);
}
