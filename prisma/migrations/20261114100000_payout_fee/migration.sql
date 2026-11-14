-- What the provider charged us to send a payout.
--
-- Nullable and additive: existing rows keep NULL, which the ledger treats as
-- "no fee reported" rather than zero. Measured against the Moolre sandbox on
-- 2026-11-14 — a GHS 5.00 transfer debited GHS 5.05, so an outbound fee is
-- charged ON TOP of the amount, unlike a collection fee which is deducted from
-- what we receive. Without booking it, PLATFORM_CASH drifts below the real
-- wallet balance by the fee on every single payout.

ALTER TABLE "Payout" ADD COLUMN "feeMinor" INTEGER;
