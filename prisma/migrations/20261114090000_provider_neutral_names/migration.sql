-- Provider-neutral column names, ahead of replacing Paystack with Moolre.
--
-- Hand-written as RENAME COLUMN rather than generated. `prisma migrate dev`
-- emits DROP + ADD for a field rename, which would silently discard the
-- provider references on every real Payment, Refund and Payout already in the
-- database — the exact ids needed to reconcile against a settlement report.
--
-- The unique indexes are renamed too. Postgres keeps an index working under its
-- old name after a column rename, but Prisma derives the expected name from the
-- column, so leaving them would make every later `migrate diff` want to churn
-- them.

ALTER TABLE "SellerProfile" RENAME COLUMN "paystackRecipientCode" TO "providerRecipientCode";
ALTER INDEX "SellerProfile_paystackRecipientCode_key" RENAME TO "SellerProfile_providerRecipientCode_key";

ALTER TABLE "Payment" RENAME COLUMN "paystackReference" TO "providerReference";
ALTER INDEX "Payment_paystackReference_key" RENAME TO "Payment_providerReference_key";

ALTER TABLE "Refund" RENAME COLUMN "paystackRefundId" TO "providerRefundId";
ALTER INDEX "Refund_paystackRefundId_key" RENAME TO "Refund_providerRefundId_key";

ALTER TABLE "Payout" RENAME COLUMN "paystackTransferCode" TO "providerTransferCode";
ALTER INDEX "Payout_paystackTransferCode_key" RENAME TO "Payout_providerTransferCode_key";

ALTER TABLE "Payout" RENAME COLUMN "paystackRecipientCode" TO "providerRecipientCode";
