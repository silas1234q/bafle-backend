import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { env } from "../env.js";

/**
 * Payout and refund destinations at rest.
 *
 * Paystack handed us an opaque recipient code and kept the account number
 * itself, so this file had no reason to exist: a database leak could not be
 * turned into a mobile money number. Moolre's transfer endpoint takes the raw
 * `receiver` on every call, so there is no provider-side handle to hold
 * instead — the number has to survive between onboarding and payout, and
 * between a ticket purchase and a refund weeks later.
 *
 * **Be clear about what this costs.** The property drops from "we structurally
 * cannot leak an account number" to "a leak needs the database *and* the
 * encryption key". That is forced by the provider's API shape, not chosen. It
 * is why the ciphertext is never selected into any response payload.
 *
 * Two derived keys, two different jobs:
 *
 * - encryption is **non-deterministic** (fresh IV per call), because a
 *   deterministic cipher would let anyone holding the database confirm a
 *   guessed number by comparing ciphertexts.
 * - the recipient code is **deterministic**, because `DESTINATION_TAKEN`
 *   depends on it: the same account details must collide on
 *   `SellerProfile.providerRecipientCode`'s unique index so a second seller
 *   registering someone else's account is refused rather than silently
 *   accepted.
 *
 * Distinct HKDF `info` labels keep the two cryptographically independent, so
 * the encryption key cannot be used to forge a recipient code or vice versa.
 */

const SOURCE_SECRET = env.PAYOUT_ENCRYPTION_KEY ?? env.CLERK_SECRET_KEY;

function derive(label: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", SOURCE_SECRET, "bafle-payout-salt", label, 32),
  );
}

const DESTINATION_KEY = derive("bafle-payout-destination-v1");
const RECIPIENT_CODE_KEY = derive("bafle-payout-recipient-code-v1");

/** Tagged so a future key rotation can tell old ciphertexts from new ones. */
const CIPHER_VERSION = "v1";

export class PayoutSecretError extends Error {
  readonly code: "MALFORMED_CIPHERTEXT" | "INVALID_ACCOUNT_NUMBER";

  constructor(code: PayoutSecretError["code"], message: string) {
    super(message);
    this.name = "PayoutSecretError";
    this.code = code;
  }
}

/**
 * Canonical form of a Ghanaian destination, applied before both encrypting and
 * hashing.
 *
 * This is load-bearing for two separate reasons, and getting it wrong breaks
 * each in a different way:
 *
 * 1. Moolre's transfer API wants a mobile number **beginning with 0**, but its
 *    payment webhook reports the payer as `233242097401`. The same human
 *    account therefore arrives in two different spellings depending on which
 *    direction it came from, and a refund has to transfer back to the form the
 *    transfer endpoint accepts.
 * 2. A seller typing `+233 24 123 4567` and `0241234567` must derive the *same*
 *    recipient code, or the uniqueness check that powers `DESTINATION_TAKEN`
 *    silently stops detecting duplicates.
 */
export function normaliseAccountNumber(
  input: string,
  kind: "mobile_money" | "bank",
): string {
  const digits = input.replace(/\D/g, "");

  if (digits.length === 0) {
    throw new PayoutSecretError(
      "INVALID_ACCOUNT_NUMBER",
      "Account number contains no digits",
    );
  }

  // Bank account numbers have no national-prefix convention to normalise and
  // vary in length by bank, so digits-only is as far as we can safely go.
  if (kind === "bank") return digits;

  // 233XXXXXXXXX -> 0XXXXXXXXX
  if (digits.startsWith("233") && digits.length === 12) {
    return `0${digits.slice(3)}`;
  }

  // 24XXXXXXX (someone dropped the leading zero) -> 0XXXXXXXXX
  if (digits.length === 9) return `0${digits}`;

  if (digits.length !== 10 || !digits.startsWith("0")) {
    throw new PayoutSecretError(
      "INVALID_ACCOUNT_NUMBER",
      `"${input}" is not a recognisable Ghanaian mobile money number`,
    );
  }

  return digits;
}

/** Last four digits of the canonical form — safe to display and to store. */
export function accountNumberLast4(
  input: string,
  kind: "mobile_money" | "bank",
): string {
  return normaliseAccountNumber(input, kind).slice(-4);
}

/**
 * AES-256-GCM, authenticated: `decryptDestination` throws rather than
 * returning a wrong number if a row was tampered with. Transferring real money
 * to a silently-corrupted destination is the failure this prevents.
 */
export function encryptDestination(
  accountNumber: string,
  kind: "mobile_money" | "bank",
): string {
  const canonical = normaliseAccountNumber(accountNumber, kind);
  const iv = randomBytes(12); // 96 bits, the size GCM is specified for
  const cipher = createCipheriv("aes-256-gcm", DESTINATION_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(canonical, "utf8"),
    cipher.final(),
  ]);

  return [
    CIPHER_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptDestination(packed: string): string {
  const parts = packed.split(".");
  const [version, ivPart, tagPart, ciphertextPart] = parts;

  if (
    parts.length !== 4 ||
    version !== CIPHER_VERSION ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    throw new PayoutSecretError(
      "MALFORMED_CIPHERTEXT",
      "Stored payout destination is not in the expected format",
    );
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    DESTINATION_KEY,
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    // GCM's tag check failed: either the key changed or the row was edited.
    throw new PayoutSecretError(
      "MALFORMED_CIPHERTEXT",
      "Stored payout destination failed its authenticity check",
    );
  }
}

/**
 * The opaque handle Moolre does not give us.
 *
 * Deterministic on purpose — see the header. Keyed with a server secret rather
 * than a plain hash because the input space is tiny: Ghanaian mobile numbers
 * are ten digits with a handful of valid prefixes, so an unkeyed digest would
 * be trivially reversible by brute force, which would undo the encryption
 * sitting next to it.
 */
export function deriveRecipientCode(
  kind: "mobile_money" | "bank",
  bankCode: string,
  accountNumber: string,
): string {
  const canonical = normaliseAccountNumber(accountNumber, kind);
  const digest = createHmac("sha256", RECIPIENT_CODE_KEY)
    .update(`${kind}:${bankCode}:${canonical}`, "utf8")
    .digest("base64url");

  // Truncated to 128 bits of the digest: still far beyond collision range for
  // the number of payout accounts this will ever hold, and short enough to
  // read in a log line.
  return `moolre_${digest.slice(0, 22)}`;
}
