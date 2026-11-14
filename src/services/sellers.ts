import { prisma } from "../lib/prisma.js";
import { encryptDestination } from "../lib/payoutSecrets.js";
import { paymentProvider } from "../payments/index.js";
import { PaymentProviderError, type PayoutBank, type RecipientRequest } from "../payments/provider.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * How a seller tells us where to send their money.
 *
 * Until this runs, a seller is unpayable: `sendPayout` blocks on
 * `kyc_not_approved`, then `payouts_not_enabled`, then `no_payout_recipient`,
 * leaving the payout PENDING forever while the ledger correctly insists we owe
 * it. This service is the only thing that clears all three.
 *
 * Whether we hold an account number depends on the rail, and the difference is
 * worth understanding rather than skimming. A provider that issues its own
 * recipient handle (Paystack) takes the details, confirms the account exists
 * and hands back an opaque code; that code and the last four digits are all we
 * keep, so a database leak cannot be used to drain the seller's wallet. A
 * provider whose transfer endpoint takes the raw receiver every time (Moolre)
 * leaves no such option: the number is retained, encrypted, because every
 * future payout needs it again. `transfersNeedDestination` is what decides,
 * and the weaker property is forced by the provider's API, not chosen.
 *
 * **What "KYC approved" means here.** Onboarding sets `kycStatus: APPROVED`,
 * and the whole of that verification is "the provider accepted this account".
 * No identity document is checked anywhere in this codebase. The enum and the
 * blocker in `sendPayout` are kept so a real review has somewhere to live, but
 * do not read the field as more than it is.
 */

export type PayoutKind = RecipientRequest["kind"];

export class SellerOnboardingError extends Error {
  readonly code: "UNKNOWN_BANK" | "RECIPIENT_REJECTED" | "DESTINATION_TAKEN";

  constructor(code: SellerOnboardingError["code"], message: string) {
    super(message);
    this.name = "SellerOnboardingError";
    this.code = code;
  }
}

/** Valid destinations of one kind, for the onboarding form. */
export function listPayoutBanks(kind: PayoutKind): Promise<PayoutBank[]> {
  return paymentProvider().listPayoutBanks(kind);
}

export interface PayoutDestination {
  kind: string | null;
  bankCode: string | null;
  accountName: string | null;
  accountNumberLast4: string | null;
  payoutsEnabled: boolean;
}

/**
 * What the seller sees about their own payout setup.
 *
 * `providerRecipientCode` is deliberately not selected. It is not a secret the
 * way an account number is, but it is a provider-side handle that can be
 * transferred to, and no screen needs it.
 */
export async function getPayoutDestination(
  userId: string,
): Promise<PayoutDestination | null> {
  const profile = await prisma.sellerProfile.findUnique({
    where: { userId },
    select: {
      recipientType: true,
      bankCode: true,
      accountNameSnapshot: true,
      accountNumberLast4: true,
      payoutsEnabled: true,
    },
  });

  if (!profile) return null;

  return {
    kind: profile.recipientType,
    bankCode: profile.bankCode,
    accountName: profile.accountNameSnapshot,
    accountNumberLast4: profile.accountNumberLast4,
    payoutsEnabled: profile.payoutsEnabled,
  };
}

export interface OnboardPayoutInput {
  kind: PayoutKind;
  accountName: string;
  accountNumber: string;
  bankCode: string;
}

/**
 * Registers a payout destination and makes the seller payable.
 *
 * Replacing an existing destination is allowed and simply mints a new
 * recipient — a seller who changes network or loses a SIM must not be stranded.
 */
export async function onboardPayoutDestination(
  userId: string,
  input: OnboardPayoutInput,
): Promise<PayoutDestination> {
  // Checked against the provider's own list first. An unknown code otherwise
  // reaches Paystack and comes back as an opaque 400 that we would have to
  // show the seller verbatim.
  const banks = await listPayoutBanks(input.kind);
  const bank = banks.find((candidate) => candidate.code === input.bankCode);
  if (!bank) {
    throw new SellerOnboardingError(
      "UNKNOWN_BANK",
      `${input.bankCode} is not a ${input.kind === "mobile_money" ? "mobile money network" : "bank"} we can pay out to`,
    );
  }

  // Outside the transaction on purpose: this is a network call to Paystack,
  // and holding a Postgres transaction open across one is how the pool gets
  // exhausted under any real load.
  let recipient;
  try {
    recipient = await paymentProvider().createRecipient({
      kind: input.kind,
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      currency: "GHS",
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new SellerOnboardingError(
        "RECIPIENT_REJECTED",
        error.providerMessage ?? "The payment provider rejected these details",
      );
    }
    throw error;
  }

  // Only retained when the rail actually needs it back — see the header.
  const destinationCipher = paymentProvider().transfersNeedDestination
    ? encryptDestination(input.accountNumber, input.kind)
    : null;

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.sellerProfile.upsert({
        where: { userId },
        create: {
          userId,
          providerRecipientCode: recipient.recipientCode,
          recipientType: input.kind,
          bankCode: input.bankCode,
          // Prefer the provider's name over the typed one: it is what the
          // account actually belongs to, where the provider tells us.
          accountNameSnapshot: recipient.accountName ?? input.accountName,
          accountNumberLast4: recipient.accountNumberLast4,
          payoutDestinationCipher: destinationCipher,
          payoutsEnabled: true,
        },
        update: {
          providerRecipientCode: recipient.recipientCode,
          recipientType: input.kind,
          bankCode: input.bankCode,
          accountNameSnapshot: recipient.accountName ?? input.accountName,
          accountNumberLast4: recipient.accountNumberLast4,
          // Overwritten, not merged: replacing a destination must not leave
          // the previous account reachable for a payout.
          payoutDestinationCipher: destinationCipher,
          payoutsEnabled: true,
        },
      });

      // Same transaction as the profile: a seller who is payouts-enabled but
      // still UNSUBMITTED is blocked by `sendPayout` anyway, so committing one
      // without the other produces a setup that looks complete and pays
      // nobody.
      await tx.user.update({
        where: { id: userId },
        data: { kycStatus: "APPROVED", kycReviewedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          action: "seller.payout_destination_set",
          entityType: "User",
          entityId: userId,
          metadata: {
            kind: input.kind,
            bankCode: input.bankCode,
            bankName: bank.name,
            accountNumberLast4: recipient.accountNumberLast4,
          },
        },
      });

      return {
        kind: input.kind,
        bankCode: input.bankCode,
        accountName: recipient.accountName ?? input.accountName,
        accountNumberLast4: recipient.accountNumberLast4,
        payoutsEnabled: true,
      };
    });
  } catch (error) {
    // `SellerProfile.providerRecipientCode` is unique, and Paystack returns the
    // same code for the same account details. So this fires exactly when a
    // second seller registers an account that already belongs to another one —
    // which is worth refusing on its own merits, not just reporting as a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new SellerOnboardingError(
        "DESTINATION_TAKEN",
        "That payout account is already registered to another seller",
      );
    }
    throw error;
  }
}
