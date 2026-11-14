import { Router } from "express";
import { z } from "zod";

import { localUser, requireUser } from "../middleware/auth.js";
import { payoutSetupLimiter } from "../middleware/rateLimit.js";
import { PaymentProviderError } from "../payments/provider.js";
import {
  getPayoutDestination,
  listPayoutBanks,
  onboardPayoutDestination,
  SellerOnboardingError,
} from "../services/sellers.js";

/**
 * The seller's own payout setup.
 *
 * Router-wide auth and no ids in any path, matching ticketsRouter: everything
 * here is about the caller, so there is nothing to own-check beyond the
 * session.
 */
export const sellersRouter = Router();

sellersRouter.use(requireUser);

const kindSchema = z.enum(["mobile_money", "bank"]);

const destinationSchema = z.object({
  kind: kindSchema,
  accountName: z.string().trim().min(2).max(100),
  // Digits only, deliberately loose on length: a Ghanaian mobile money number
  // is a 10-digit MSISDN, but bank account numbers vary by institution and
  // over-specifying here would reject valid sellers.
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{8,20}$/, "Account number must be 8-20 digits"),
  bankCode: z.string().trim().min(1).max(20),
});

const ONBOARDING_STATUS: Record<SellerOnboardingError["code"], number> = {
  UNKNOWN_BANK: 400,
  RECIPIENT_REJECTED: 422,
  DESTINATION_TAKEN: 409,
};

sellersRouter.get("/banks", async (req, res) => {
  const parsed = kindSchema.safeParse(req.query.kind);
  if (!parsed.success) {
    res.status(400).json({ error: "kind must be mobile_money or bank" });
    return;
  }

  try {
    res.json({ banks: await listPayoutBanks(parsed.data) });
  } catch (error) {
    // The provider being unreachable is not the seller's fault and is not
    // permanent, so it must not read as a validation error.
    if (error instanceof PaymentProviderError) {
      res.status(502).json({
        error: "Could not load payout destinations; try again shortly",
      });
      return;
    }
    throw error;
  }
});

sellersRouter.get("/payouts", async (req, res) => {
  const user = localUser(req);
  res.json({ destination: await getPayoutDestination(user.id) });
});

sellersRouter.put("/payouts", payoutSetupLimiter, async (req, res) => {
  const parsed = destinationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid payout details",
      issues: z.treeifyError(parsed.error),
    });
    return;
  }

  const user = localUser(req);

  try {
    const destination = await onboardPayoutDestination(user.id, parsed.data);
    res.json({ destination });
  } catch (error) {
    if (error instanceof SellerOnboardingError) {
      res
        .status(ONBOARDING_STATUS[error.code])
        .json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});
