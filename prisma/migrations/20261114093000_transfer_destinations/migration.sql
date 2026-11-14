-- Encrypted transfer destinations, for a provider with no recipient handles
-- and no refund endpoint.
--
-- All nullable, so this is additive and safe against the rows already there:
-- an existing SellerProfile keeps working under Paystack (it has a real
-- recipient code), and an existing Payment simply has no refund destination,
-- which refundRaffle reports as no_refund_destination rather than guessing.

ALTER TABLE "SellerProfile" ADD COLUMN "payoutDestinationCipher" TEXT;

ALTER TABLE "Payment" ADD COLUMN "refundDestinationCipher" TEXT;
ALTER TABLE "Payment" ADD COLUMN "refundChannel" TEXT;
ALTER TABLE "Payment" ADD COLUMN "payerNameSnapshot" TEXT;
