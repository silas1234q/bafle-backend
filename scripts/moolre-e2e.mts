/**
 * End-to-end check of the two money-out paths against the Moolre SANDBOX.
 *
 *   npm run moolre:e2e
 *
 * Proves the parts that stubs cannot: that a seller payout and a buyer refund
 * both reach a real provider, come back settled, and leave the ledger balanced
 * with the outbound fee booked.
 *
 * Why this exists as a script and not a test suite: the six suites replace the
 * remote host with a local stub on purpose, so they verify our request building
 * and never the provider's behaviour. This does the opposite — real HTTP, real
 * transfers, real fee — which makes it too slow and too external to belong in
 * `npm test`, and means it must be run deliberately.
 *
 * Safety, in order of how much each one matters:
 *
 * 1. **Refuses any host that is not the sandbox.** Nothing here should ever
 *    move real money.
 * 2. **Creates its own throwaway rows and deletes them by id**, including on
 *    failure. It never touches an existing payout, refund or payment — in
 *    particular not the real GHS 4,000 payout, which a sandbox transfer would
 *    otherwise mark PAID with money that never moved.
 * 3. Amounts are a few cedis, so the sandbox float lasts.
 *
 * It sets ALLOW_TEST_MONEY_ON_REAL_DATA itself, because that guard exists to
 * stop exactly this happening by accident — here it is the intent.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

const baseUrl = process.env.MOOLRE_BASE_URL ?? "";
if (!baseUrl.includes("sandbox")) {
  console.error(
    `Refusing to run: MOOLRE_BASE_URL is ${baseUrl || "(unset)"}.\n` +
      "This script performs real transfers. Point it at https://sandbox.moolre.com.",
  );
  process.exit(1);
}

for (const key of [
  "MOOLRE_API_USER",
  "MOOLRE_API_KEY",
  "MOOLRE_PUBLIC_KEY",
  "MOOLRE_ACCOUNT_NUMBER",
]) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in backend/.env`);
    process.exit(1);
  }
}

process.env.PAYMENT_PROVIDER = "moolre";
process.env.ALLOW_TEST_MONEY_ON_REAL_DATA = "true";

const { prisma } = await import("../src/lib/prisma.js");
const { encryptDestination } = await import("../src/lib/payoutSecrets.js");
const { paymentProvider } = await import("../src/payments/index.js");
const payouts = await import("../src/services/payouts.js");
const refunds = await import("../src/services/refunds.js");
const sellers = await import("../src/services/sellers.js");
const { totalLedgerSum } = await import("../src/services/ledger.js");

let pass = 0;
let fail = 0;
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${message}`);
  if (ok) pass++;
  else fail++;
};

const tag = randomBytes(4).toString("hex");
// A sandbox MoMo number. Seeded from the tag so a row left by an interrupted
// run cannot collide on providerRecipientCode, which is unique and derived
// deterministically from the number — the trap the suites hit twice.
const sellerMomo = `02${tag.replace(/\D/g, "").padEnd(8, "4").slice(0, 8)}`;
const buyerMomo = `055${tag.replace(/\D/g, "").padEnd(7, "7").slice(0, 7)}`;

const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };

try {
  console.log(`host:   ${baseUrl}`);
  console.log(`tag:    ${tag}`);
  console.log(`seller momo: ${sellerMomo}   buyer momo: ${buyerMomo}`);

  const startingBalance = await (
    paymentProvider() as unknown as { walletBalanceMinor(): Promise<number | null> }
  ).walletBalanceMinor();
  console.log(`wallet: ${startingBalance} pesewas\n`);

  async function makeUser(label: string) {
    const user = await prisma.user.create({
      data: {
        clerkUserId: `e2e_${tag}_${label}`,
        email: `e2e_${tag}_${label}@test.invalid`,
        username: `e2e_${tag}_${label}`,
      },
      select: { id: true },
    });
    made.users.push(user.id);
    return user;
  }

  // -----------------------------------------------------------------------
  console.log("1. Seller onboarding reaches the provider");

  const seller = await makeUser("seller");
  const destination = await sellers.onboardPayoutDestination(seller.id, {
    kind: "mobile_money",
    accountName: "E2E Seller",
    accountNumber: sellerMomo,
    bankCode: "1", // MTN, transfer channel
  });

  check(
    destination.payoutsEnabled && destination.accountNumberLast4 === sellerMomo.slice(-4),
    `onboarded -> enabled=${destination.payoutsEnabled} last4=${destination.accountNumberLast4}`,
  );
  check(
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: seller.id },
        select: { kycStatus: true },
      })
    ).kycStatus === "APPROVED",
    "KYC flipped in the same transaction, so the seller is actually payable",
  );

  const profile = await prisma.sellerProfile.findUniqueOrThrow({
    where: { userId: seller.id },
    select: { payoutDestinationCipher: true, providerRecipientCode: true },
  });
  check(
    profile.payoutDestinationCipher !== null &&
      !profile.payoutDestinationCipher.includes(sellerMomo),
    "the account number is stored encrypted, not in the clear",
  );
  check(
    (profile.providerRecipientCode ?? "").startsWith("moolre_"),
    `a recipient code was derived locally -> ${profile.providerRecipientCode}`,
  );

  // -----------------------------------------------------------------------
  console.log("\n2. Seller payout: a real transfer, with its fee booked");

  const winner = await makeUser("winner");
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      title: `E2E ${tag}`,
      slug: `e2e-${tag}`,
      description: "End-to-end provider check. Safe to delete.",
      category: "electronics",
      retailValue: 50_000,
      status: "ARCHIVED",
    },
    select: { id: true },
  });
  made.products.push(product.id);

  const raffle = await prisma.raffle.create({
    data: {
      productId: product.id,
      sellerId: seller.id,
      ticketPrice: 1_000,
      totalTickets: 5,
      status: "DRAWN",
      closesAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  made.raffles.push(raffle.id);

  const order = await prisma.order.create({
    data: {
      raffleId: raffle.id,
      productId: product.id,
      winnerUserId: winner.id,
      sellerId: seller.id,
      status: "DELIVERED",
    },
    select: { id: true },
  });

  // A payout of GHS 3.00. Created directly rather than through the full
  // raffle-to-delivery flow: this script is testing the provider boundary, and
  // the suites already cover how a payout comes to exist.
  const payout = await prisma.payout.create({
    data: {
      sellerId: seller.id,
      orderId: order.id,
      reference: `e2e-pay-${tag}`,
      amount: 300,
      status: "PENDING",
    },
    select: { id: true },
  });

  const sent = await payouts.sendPayout(payout.id);
  check(
    sent.status === "PAID",
    `payout -> ${sent.status}${sent.failureReason ? ` (${sent.failureReason})` : ""}`,
  );

  const settledPayout = await prisma.payout.findUniqueOrThrow({
    where: { id: payout.id },
    select: { status: true, feeMinor: true, providerTransferCode: true },
  });
  check(
    settledPayout.providerTransferCode !== null,
    `the provider's transaction id was recorded -> ${settledPayout.providerTransferCode}`,
  );
  check(
    settledPayout.feeMinor !== null && settledPayout.feeMinor > 0,
    `an outbound fee was reported and stored -> ${settledPayout.feeMinor} pesewas`,
  );

  const payoutLegs = await prisma.ledgerEntry.findMany({
    where: { transaction: { reference: `seller-payout:${payout.id}` } },
    select: { amount: true, account: { select: { type: true } } },
  });
  const payoutByAccount = new Map(payoutLegs.map((l) => [l.account.type, l.amount]));
  check(
    payoutByAccount.get("SELLER_PAYABLE") === 300,
    `the seller is settled for the full amount -> ${payoutByAccount.get("SELLER_PAYABLE")}`,
  );
  check(
    payoutByAccount.get("PLATFORM_CASH") === -(300 + (settledPayout.feeMinor ?? 0)),
    `cash out is amount + fee -> ${payoutByAccount.get("PLATFORM_CASH")}`,
  );
  check((await totalLedgerSum()) === 0, "ledger balances after the payout");

  // -----------------------------------------------------------------------
  console.log("\n3. Refund: no destination means blocked, not silently lost");

  const buyer = await makeUser("buyer");
  const noDestination = await prisma.payment.create({
    data: {
      userId: buyer.id,
      raffleId: raffle.id,
      reference: `e2e-nodest-${tag}`,
      amount: 200,
      quantity: 1,
      status: "SUCCESS",
    },
    select: { id: true },
  });

  await prisma.raffle.update({ where: { id: raffle.id }, data: { status: "EXPIRED" } });

  const blockedRun = await refunds.refundRaffle(raffle.id);
  check(
    blockedRun.blocked === 1 && blockedRun.initiated === 0,
    `a payment with no payer on file is blocked, not attempted -> blocked=${blockedRun.blocked} initiated=${blockedRun.initiated}`,
  );
  check(
    (await prisma.refund.count({ where: { paymentId: noDestination.id } })) === 0,
    "and writes no Refund row, so a sweep cannot mint one per tick forever",
  );
  check(
    blockedRun.raffleStatus !== "REFUNDED",
    `the raffle cannot finish while a buyer is still owed -> ${blockedRun.raffleStatus}`,
  );

  // -----------------------------------------------------------------------
  console.log("\n4. Refund: a real transfer back to the payer");

  await prisma.payment.update({
    where: { id: noDestination.id },
    data: {
      // Exactly what recordRefundDestination writes from a verified callback.
      refundDestinationCipher: encryptDestination(buyerMomo, "mobile_money"),
      refundChannel: "1",
      payerNameSnapshot: "E2E Buyer",
    },
  });

  const refundRun = await refunds.refundRaffle(raffle.id);
  check(
    refundRun.initiated === 1 && refundRun.blocked === 0,
    `a payment with a payer on file is refunded -> initiated=${refundRun.initiated} settled=${refundRun.settled} blocked=${refundRun.blocked}`,
  );

  const refund = await prisma.refund.findFirstOrThrow({
    where: { paymentId: noDestination.id },
    select: {
      id: true,
      status: true,
      providerRefundId: true,
      reference: true,
      failureReason: true,
    },
  });

  // The sandbox refuses some transfers at random (code APY17, "Pay out
  // Failed") regardless of amount — GHS 2.00 failed once and then succeeded
  // on a later identical attempt. So a refusal is a legitimate outcome here
  // and asserting "always SUCCEEDED" would make this script flaky.
  //
  // What must hold either way is that the outcome is recorded truthfully:
  // money out gets an id, a refusal gets a readable reason, and neither
  // leaves the row claiming something that did not happen.

  if (refund.status === "FAILED") {
    check(
      typeof refund.failureReason === "string" &&
        refund.failureReason.length > 0 &&
        !refund.failureReason.includes("object"),
      `a refusal records a readable reason -> ${JSON.stringify(refund.failureReason)}`,
    );
  } else {
    check(
      refund.providerRefundId !== null,
      `money out records the provider's id -> ${refund.providerRefundId}`,
    );
  }

  // Whichever way it landed, the poll must agree rather than contradict. A
  // poll that "upgraded" a failure to success would be the worst outcome
  // available, so this asserts agreement, not a particular status.
  const polled = await refunds.reconcileRefund(refund.id);
  check(
    refund.status === "FAILED"
      ? polled.status === "FAILED"
      : polled.status === "SUCCEEDED" || polled.status === "PROCESSING",
    `the status poll agrees rather than contradicting -> ${refund.status} then ${polled.status}`,
  );
  check((await totalLedgerSum()) === 0, "ledger balances after the refund");

  const endingBalance = await (
    paymentProvider() as unknown as { walletBalanceMinor(): Promise<number | null> }
  ).walletBalanceMinor();
  if (startingBalance !== null && endingBalance !== null) {
    console.log(
      `\nwallet moved ${startingBalance} -> ${endingBalance} ` +
        `(${startingBalance - endingBalance} pesewas out for GHS 5.00 of transfers plus fees)`,
    );
  }
} catch (error) {
  fail++;
  console.log("\n  FAIL  aborted with an unhandled error:");
  console.log(error);
} finally {
  // By id, always, including after a failure — a half-cleaned run leaves rows
  // that collide with the next one on a unique index.
  const paymentIds = (
    await prisma.payment.findMany({
      where: { raffleId: { in: made.raffles } },
      select: { id: true },
    })
  ).map((p) => p.id);

  await prisma.ledgerEntry.deleteMany({
    where: {
      OR: [
        { raffleId: { in: made.raffles } },
        { payout: { seller: { id: { in: made.users } } } },
      ],
    },
  });
  await prisma.refund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.payout.deleteMany({ where: { sellerId: { in: made.users } } });
  await prisma.order.deleteMany({ where: { raffleId: { in: made.raffles } } });
  await prisma.ticket.deleteMany({ where: { raffleId: { in: made.raffles } } });
  await prisma.raffle.deleteMany({ where: { id: { in: made.raffles } } });
  await prisma.productImage.deleteMany({ where: { productId: { in: made.products } } });
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: made.users } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: made.users } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });

  // An orphaned ledger transaction would leave totalLedgerSum() non-zero for
  // every later run and look like real corruption.
  await prisma.ledgerTransaction.deleteMany({
    where: { reference: { contains: tag }, entries: { none: {} } },
  });

  const balanced = (await totalLedgerSum()) === 0;
  console.log(`\ncleanup: users=${await prisma.user.count({ where: { id: { in: made.users } } })}`);
  console.log(`ledger balanced after cleanup: ${balanced}`);
  if (!balanced) fail++;

  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
