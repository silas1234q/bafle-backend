import { randomInt } from "node:crypto";

// Handles are lowercase: start with a letter, then letters/digits/underscore.
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

// Names that would let someone impersonate the platform or shadow a route.
const RESERVED = new Set([
  "admin",
  "administrator",
  "bafle",
  "support",
  "help",
  "root",
  "system",
  "moderator",
  "mod",
  "staff",
  "official",
  "security",
  "billing",
  "payments",
  "payment",
  "paystack",
  "api",
  "www",
  "me",
  "user",
  "users",
  "raffle",
  "raffles",
  "product",
  "products",
  "order",
  "orders",
  "winner",
  "null",
  "undefined",
  "deleted",
  "anonymous",
]);

export type UsernameRejection =
  | "format"
  | "reserved";

/** Validates a user-chosen handle. Returns null when acceptable. */
export function validateUsername(candidate: string): UsernameRejection | null {
  const value = candidate.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(value)) return "format";
  if (RESERVED.has(value)) return "reserved";
  return null;
}

export function normaliseUsername(candidate: string): string {
  return candidate.trim().toLowerCase();
}

/**
 * Builds a default handle from the email local part, since signup collects
 * nothing else. Not guaranteed unique — callers must retry on collision,
 * which is why `suffixDigits` widens the random tail on each attempt.
 */
export function suggestUsername(email: string, suffixDigits = 4): string {
  const localPart = email.split("@")[0] ?? "";

  let stem = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, ""); // must start with a letter

  if (stem.length < 3) stem = "bafler";
  stem = stem.slice(0, 12);

  const max = 10 ** suffixDigits;
  const suffix = String(randomInt(0, max)).padStart(suffixDigits, "0");

  const candidate = `${stem}${suffix}`;
  // A generated handle must satisfy the same rules we enforce on user input.
  return RESERVED.has(candidate) ? `bafler${suffix}` : candidate;
}
