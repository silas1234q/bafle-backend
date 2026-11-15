import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const SECRET = "sk_test_" + randomBytes(16).toString("hex");
const stubPort = 4200;
process.env.PAYSTACK_SECRET_KEY = SECRET;
process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.PAYMENT_PROVIDER = "paystack";
// These suites ARE test money acting on a real database, which is exactly the
// case the guard in sendPayout/refundRaffle refuses by default. Opted in
// explicitly rather than exempted, so the hazard is stated where it applies:
// every payout and refund below moves stub money against DATABASE_URL.
process.env.ALLOW_TEST_MONEY_ON_REAL_DATA = "true";
process.env.PORT = "4201";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");
const { createRaffle } = await import("../src/services/raffles.js");
const { reserveTickets } = await import("../src/services/tickets.js");
const { confirmTicketPayment } = await import("../src/services/payments.js");
const { executeDraw } = await import("../src/services/draw.js");
const { accountBalances, totalLedgerSum, raffleEscrowBalance } = await import(
  "../src/services/ledger.js"
);
const orders = await import("../src/services/orders.js");
const payouts = await import("../src/services/payouts.js");
const products = await import("../src/services/products.js");
const { listUserTickets } = await import("../src/services/tickets.js");
const refunds = await import("../src/services/refunds.js");
const sellers = await import("../src/services/sellers.js");
const secrets = await import("../src/lib/payoutSecrets.js");

let pass = 0;
let fail = 0;
const check = (c: boolean, m: string) => {
  if (c) {
    console.log(`  PASS  ${m}`);
    pass++;
  } else {
    console.log(`  FAIL  ${m}`);
    fail++;
  }
};
async function expectErr(label: string, fn: () => unknown, code?: string) {
  try {
    await fn();
    check(false, `${label} - expected rejection`);
  } catch (e) {
    const actual = (e as { code?: string }).code;
    if (code && actual !== code) check(false, `${label} - got code ${String(actual)}`);
    else check(true, `${label} -> ${String(actual ?? (e as Error).message)}`);
  }
}

// --- Paystack stub -------------------------------------------------------
const amounts = new Map<string, number>();
let refundMode: "processed" | "pending" = "processed";
let transferMode: "success" | "failed" = "success";

// Seeded from the clock, not a fixed base: Payment.providerReference is
// unique, so a row left behind by an earlier run would otherwise collide
// and fail a webhook mid-suite for reasons that look like a logic bug.
let nextTxnId = Date.now() % 100_000_000;
// Payout.providerTransferCode is UNIQUE, so a literal code collides with a row
// left by an interrupted run — the same trap as the reference and account
// number seeds below.
let nextTransferId = Date.now() % 100_000_000;
let nextRefundId = Date.now() % 100_000_000;
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url ?? "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    res.writeHead(200, { "content-type": "application/json" });
    const ok = (data: unknown) => res.end(JSON.stringify({ status: true, message: "ok", data }));

    if (url === "/transaction/initialize") {
      amounts.set(body.reference as string, body.amount as number);
      ok({
        authorization_url: `https://checkout.test/${String(body.reference)}`,
        access_code: `acc_${String(body.reference)}`,
        reference: body.reference,
      });
      return;
    }
    if (url.startsWith("/transaction/verify/")) {
      const reference = decodeURIComponent(url.split("/").pop() ?? "");
      const amount = amounts.get(reference) ?? 0;
      ok({
        id: nextTxnId++,
        status: "success",
        reference,
        amount,
        currency: "GHS",
        channel: "mobile_money",
        paid_at: new Date().toISOString(),
        gateway_response: "Successful",
        fees: Math.round(amount * 0.0195),
      });
      return;
    }
    if (url === "/transfer") {
      ok({
        transfer_code: `TRF_${nextTransferId++}`,
        reference: body.reference,
        status: transferMode === "success" ? "success" : "failed",
        amount: body.amount,
      });
      return;
    }
    if (url === "/bank?country=ghana&currency=GHS&type=mobile_money") {
      ok([
        { name: "MTN", code: "MTN" },
        { name: "Vodafone", code: "VOD" },
        { name: "AirtelTigo", code: "ATL" },
      ]);
      return;
    }
    if (url === "/bank?country=ghana&currency=GHS&type=ghipss") {
      ok([{ name: "Absa Bank Ghana Ltd", code: "030100" }]);
      return;
    }
    if (url === "/transferrecipient") {
      // Paystack returns the SAME recipient code for the same account details,
      // which is exactly what makes the unique index a duplicate-account guard.
      const number = String(body.account_number);
      ok({
        recipient_code: `RCP_${number}`,
        details: { account_number: number, account_name: "Stub Account Holder" },
      });
      return;
    }
    if (url === "/refund") {
      ok({ id: nextRefundId++, status: refundMode === "processed" ? "processed" : "pending" });
      return;
    }
    res.end(JSON.stringify({ status: false, message: "stub: unknown route" }));
  });
});
await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", r));

const server = app.listen(4201);
await new Promise<void>((r) => server.once("listening", () => r()));
const api = "http://127.0.0.1:4201";

async function webhook(event: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ event, data });
  const signature = createHmac("sha512", SECRET).update(payload).digest("hex");
  const response = await fetch(`${api}/webhooks/paystack`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paystack-signature": signature },
    body: payload,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const tag = randomBytes(4).toString("hex");
const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };

async function makeUser(label: string) {
  const user = await prisma.user.create({
    data: {
      clerkUserId: `f_${tag}_${label}`,
      email: `${label}.${tag}@test.invalid`,
      username: `f${label}${tag}`.slice(0, 20),
    },
    select: { id: true, email: true },
  });
  made.users.push(user.id);
  return user;
}
async function makeProduct(sellerId: string, retailValue: number) {
  const p = await prisma.product.create({
    data: {
      sellerId,
      title: `Fulfil ${tag}`,
      slug: `fulfil-${tag}-${randomBytes(3).toString("hex")}`,
      description: "Fulfilment suite product.",
      category: "tech",
      retailValue,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  made.products.push(p.id);
  return p;
}

const PRICE = 1000;
const POOL = 2;
const FEE_BPS = 500;

try {
  // ---- build a drawn raffle ---------------------------------------------
  const seller = await makeUser("seller");
  const product = await makeProduct(seller.id, PRICE * POOL);
  const raffle = await createRaffle({
    productId: product.id,
    sellerId: seller.id,
    ticketPriceMinor: PRICE,
    totalTickets: POOL,
    closesAt: new Date(Date.now() + 86_400_000),
    platformFeeBps: FEE_BPS,
  });
  made.raffles.push(raffle.id);

  const buyers = [await makeUser("b1"), await makeUser("b2")];
  for (const buyer of buyers) {
    const held = await reserveTickets({
      raffleId: raffle.id,
      userId: buyer.id,
      customerEmail: buyer.email,
      quantity: 1,
    });
    await confirmTicketPayment(held.reference);
  }
  await executeDraw(raffle.id);

  const order = await prisma.order.findFirstOrThrow({ where: { raffleId: raffle.id } });
  const winnerId = order.winnerUserId;
  const loser = buyers.find((b) => b.id !== winnerId)!;
  check(order.status === "AWAITING_ADDRESS", `order opens as ${order.status}`);

  console.log("1. Address is the winner's to set");
  await expectErr(
    "seller cannot set the delivery address",
    () => orders.setOrderAddress(order.id, seller.id, "00000000-0000-0000-0000-000000000000"),
    "FORBIDDEN",
  );
  await expectErr(
    "a losing entrant cannot even see the order",
    () => orders.setOrderAddress(order.id, loser.id, "00000000-0000-0000-0000-000000000000"),
    "NOT_FOUND",
  );

  const address = await prisma.address.create({
    data: {
      userId: winnerId,
      recipientName: "Test Winner",
      phone: "+233200000000",
      line1: "1 Test Road",
      city: "Accra",
      region: "Greater Accra",
      digitalAddress: "GA-123-4567",
    },
    select: { id: true },
  });
  const addressed = await orders.setOrderAddress(order.id, winnerId, address.id);
  check(addressed.status === "AWAITING_SHIPMENT", `address set -> ${addressed.status}`);

  console.log("\n2. Shipping starts the dispute window");
  await expectErr(
    "winner cannot mark it shipped",
    () => orders.markOrderShipped(order.id, winnerId, { courier: "X" }),
    "FORBIDDEN",
  );
  const shipped = await orders.markOrderShipped(order.id, seller.id, {
    courier: "Test Couriers",
    trackingNumber: "TRK123",
  });
  check(shipped.status === "SHIPPED", `status -> ${shipped.status}`);
  check(shipped.autoReleaseAt !== null, "autoReleaseAt set at ship time, not at draw time");
  const windowDays = Math.round(
    (shipped.autoReleaseAt!.getTime() - shipped.shippedAt!.getTime()) / 86_400_000,
  );
  check(windowDays === orders.AUTO_RELEASE_DAYS, `dispute window = ${windowDays} days`);

  console.log("\n3. Delivery code: winner mints, seller redeems");
  await expectErr(
    "seller cannot mint the code they must redeem",
    () => orders.mintDeliveryCode(order.id, seller.id),
    "FORBIDDEN",
  );
  const minted = await orders.mintDeliveryCode(order.id, winnerId);
  check(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(minted.display), `code format -> ${minted.display}`);
  check(
    !/[01OIL]/.test(minted.display.replace("-", "")),
    "code avoids ambiguous characters (0/O, 1/I/L)",
  );

  const stored = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { deliveryOtpHash: true },
  });
  check(
    stored.deliveryOtpHash !== null &&
      !stored.deliveryOtpHash.includes(minted.display.replace("-", "")),
    "only a hash is stored, never the code itself",
  );

  await expectErr(
    "wrong code rejected",
    () => orders.confirmDelivery(order.id, seller.id, "AAAA-AAAA"),
    "CODE_INVALID",
  );
  const afterWrong = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { deliveryOtpAttempts: true },
  });
  check(afterWrong.deliveryOtpAttempts === 1, "a wrong guess costs an attempt");

  // Burn through the remaining budget.
  for (let i = 0; i < 4; i++) {
    await orders.confirmDelivery(order.id, seller.id, "BBBB-BBBB").catch(() => undefined);
  }
  await expectErr(
    "attempt limit locks the code",
    () => orders.confirmDelivery(order.id, seller.id, minted.display),
    "TOO_MANY_ATTEMPTS",
  );

  // Winner mints again, which resets the budget.
  const minted2 = await orders.mintDeliveryCode(order.id, winnerId);
  const confirmed = await orders.confirmDelivery(order.id, seller.id, minted2.display);
  check(confirmed.order.status === "DELIVERED", `correct code -> ${confirmed.order.status}`);
  check(confirmed.releaseDue, "release is due");

  const burned = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { deliveryOtpHash: true },
  });
  check(burned.deliveryOtpHash === null, "code burned on use, cannot be replayed");
  await expectErr(
    "re-confirming is rejected",
    () => orders.confirmDelivery(order.id, seller.id, minted2.display),
    "WRONG_STATUS",
  );

  console.log("\n4. Escrow release accrues before any transfer");
  const release = await payouts.releaseEscrow(order.id, "delivery_confirmed");
  const gross = PRICE * POOL;
  const expectedFee = Math.floor((gross * FEE_BPS) / 10_000);
  check(release.grossAmount === gross, `gross = ${release.grossAmount}`);
  check(release.platformFee === expectedFee, `platform fee (5%) = ${release.platformFee}`);
  check(release.netAmount === gross - expectedFee, `net to seller = ${release.netAmount}`);

  const afterRelease = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check(afterRelease.status === "CONFIRMED", `order -> ${afterRelease.status}`);
  check(
    (await prisma.raffle.findUniqueOrThrow({ where: { id: raffle.id } })).status === "COMPLETED",
    "raffle -> COMPLETED",
  );

  const repeat = await payouts.releaseEscrow(order.id, "delivery_confirmed");
  check(repeat.alreadyReleased, "releasing twice is idempotent");
  check(
    (await prisma.ledgerTransaction.count({
      where: { reference: `payout-accrual:${order.id}` },
    })) === 1,
    "no duplicate accrual posting",
  );

  console.log("\n5. Payout is blocked, but the debt is not erased");
  const blocked = await payouts.sendPayout(release.payoutId);
  check(blocked.status === "PENDING", `unverified seller -> ${blocked.status}`);
  check(blocked.failureReason === "kyc_not_approved", `reason -> ${blocked.failureReason}`);
  const owedWhileBlocked = (await accountBalances()).find(
    (b) => b.account === "SELLER_PAYABLE" && b.userId === seller.id,
  );
  check(
    owedWhileBlocked?.balance === -(gross - expectedFee),
    `seller still owed ${gross - expectedFee} despite the block (${owedWhileBlocked?.balance})`,
  );

  console.log("\n6. Payout succeeds once the seller is payable");
  // Through the real onboarding service rather than hand-written rows: the
  // point of the assertion is that what a seller can actually do produces the
  // exact state sendPayout demands. Hand-setting kycStatus here is how the
  // suite passed for weeks while no seller could ever be paid.
  // Shared with section 13, which proves a second seller cannot claim it.
  const momoNumber = `02${tag.slice(0, 6)}`.padEnd(10, "0").slice(0, 10);
  const onboarded = await sellers.onboardPayoutDestination(seller.id, {
    kind: "mobile_money",
    accountName: "Ama Owusu",
    accountNumber: momoNumber,
    bankCode: "MTN",
  });
  check(onboarded.payoutsEnabled, "onboarding enables payouts");
  check(
    onboarded.accountName === "Stub Account Holder",
    `provider's account name wins over the typed one -> ${onboarded.accountName}`,
  );

  const onboardedSeller = await prisma.user.findUniqueOrThrow({
    where: { id: seller.id },
    select: { kycStatus: true, kycReviewedAt: true },
  });
  check(
    onboardedSeller.kycStatus === "APPROVED" && onboardedSeller.kycReviewedAt !== null,
    `onboarding approves KYC in the same transaction -> ${onboardedSeller.kycStatus}`,
  );
  check(
    (await prisma.auditLog.count({
      where: { action: "seller.payout_destination_set", entityId: seller.id },
    })) === 1,
    "onboarding is audited",
  );

  const visible = await sellers.getPayoutDestination(seller.id);
  check(
    !JSON.stringify(visible).includes("RCP_"),
    "the recipient code is never returned to the seller",
  );
  check(
    visible?.accountNumberLast4?.length === 4,
    `only the last 4 digits are kept -> ${visible?.accountNumberLast4}`,
  );

  const sent = await payouts.sendPayout(release.payoutId);
  check(sent.status === "PAID", `payout -> ${sent.status}`);
  const paidOut = await prisma.payout.findUniqueOrThrow({ where: { id: release.payoutId } });
  check(paidOut.paidAt !== null, "paidAt recorded");

  console.log("\n7. Ledger after a completed sale");
  check((await totalLedgerSum()) === 0, "whole book still sums to zero");
  const balances = new Map(
    (await accountBalances()).map((b) => [`${b.account}:${b.userId ?? ""}`, b.balance]),
  );
  const pspFees = balances.get("PSP_FEES:") ?? 0;
  check(balances.get("TICKET_ESCROW:") === 0, `escrow fully discharged (${balances.get("TICKET_ESCROW:")})`);
  check(
    balances.get(`SELLER_PAYABLE:${seller.id}`) === 0,
    `seller settled (${balances.get(`SELLER_PAYABLE:${seller.id}`)})`,
  );
  check(
    balances.get("PLATFORM_REVENUE:") === -expectedFee,
    `platform revenue = ${balances.get("PLATFORM_REVENUE:")}`,
  );
  check(
    balances.get("PLATFORM_CASH:") === expectedFee - pspFees,
    `cash left = revenue(${expectedFee}) - pspFees(${pspFees}) = ${balances.get("PLATFORM_CASH:")}`,
  );

  console.log("\n8. Transfer webhooks");
  const dup = await webhook("transfer.success", {
    reference: paidOut.reference,
    transfer_code: `TRF_${nextTransferId++}`,
  });
  check(dup.status === 200, "transfer.success accepted");
  check(
    (await prisma.ledgerTransaction.count({
      where: { reference: `seller-payout:${release.payoutId}` },
    })) === 1,
    "webhook did not double-post the cash movement",
  );
  const unknown = await webhook("transfer.success", { reference: "pay-doesnotexist000000" });
  check(unknown.body.reason === "unknown_payout", "unknown payout acknowledged, not retried forever");

  console.log("\n9. Dispute freezes the auto-release");
  const s2 = await makeUser("seller2");
  const p2 = await makeProduct(s2.id, PRICE * POOL);
  const r2 = await createRaffle({
    productId: p2.id,
    sellerId: s2.id,
    ticketPriceMinor: PRICE,
    totalTickets: POOL,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(r2.id);
  for (const label of ["c1", "c2"]) {
    const buyer = await makeUser(label);
    const held = await reserveTickets({
      raffleId: r2.id,
      userId: buyer.id,
      customerEmail: buyer.email,
      quantity: 1,
    });
    await confirmTicketPayment(held.reference);
  }
  await executeDraw(r2.id);
  const o2 = await prisma.order.findFirstOrThrow({ where: { raffleId: r2.id } });
  const addr2 = await prisma.address.create({
    data: {
      userId: o2.winnerUserId,
      recipientName: "W2",
      phone: "+233200000001",
      line1: "2 Road",
      city: "Accra",
      region: "Greater Accra",
    },
    select: { id: true },
  });
  await orders.setOrderAddress(o2.id, o2.winnerUserId, addr2.id);
  await orders.markOrderShipped(o2.id, s2.id, { courier: "C" });
  await orders.openDispute(o2.id, o2.winnerUserId, "Item arrived damaged and unusable.");

  const disputed = await prisma.order.findUniqueOrThrow({ where: { id: o2.id } });
  check(disputed.status === "DISPUTED", `order -> ${disputed.status}`);
  check(
    disputed.autoReleaseAt === null,
    "autoReleaseAt cleared, so the auto-release query cannot select it",
  );
  await expectErr(
    "cannot mint a delivery code while disputed",
    () => orders.mintDeliveryCode(o2.id, o2.winnerUserId),
    "DISPUTED",
  );
  // Backdate every order and confirm the disputed one is still skipped.
  await prisma.order.updateMany({
    where: { id: o2.id },
    data: { status: "DISPUTED" },
  });
  const autoReleased = await payouts.autoReleaseDueOrders(10);
  check(
    !autoReleased.includes(o2.id),
    `auto-release skipped the disputed order (released: ${autoReleased.length})`,
  );

  console.log("\n10. Expired raffle refunds every paid ticket");
  const s3 = await makeUser("seller3");
  const p3 = await makeProduct(s3.id, PRICE * 4);
  const r3 = await createRaffle({
    productId: p3.id,
    sellerId: s3.id,
    ticketPriceMinor: PRICE,
    totalTickets: 4,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(r3.id);
  const d1 = await makeUser("d1");
  const held3 = await reserveTickets({
    raffleId: r3.id,
    userId: d1.id,
    customerEmail: d1.email,
    quantity: 1,
  });
  await confirmTicketPayment(held3.reference);

  // Backdate the deadline instead of waiting.
  await prisma.raffle.update({
    where: { id: r3.id },
    data: { closesAt: new Date(Date.now() - 1000) },
  });
  const expired = await refunds.expireOverdueRaffles(10);
  check(expired.includes(r3.id), "overdue raffle claimed for expiry");
  check(
    (await prisma.raffle.findUniqueOrThrow({ where: { id: r3.id } })).status === "EXPIRED",
    "raffle -> EXPIRED",
  );
  check(
    (await refunds.expireOverdueRaffles(10)).includes(r3.id) === false,
    "a second worker cannot claim the same raffle",
  );

  const run = await refunds.refundRaffle(r3.id);
  check(run.initiated === 1, `${run.initiated} refund initiated`);
  check(run.settled === 1, `${run.settled} settled`);
  check(run.remaining === 0, "nothing outstanding");
  check(run.raffleStatus === "REFUNDED", `raffle -> ${run.raffleStatus}`);
  check(
    (await prisma.ticket.count({ where: { raffleId: r3.id, status: "REFUNDED" } })) === 1,
    "ticket marked REFUNDED",
  );

  const rerun = await refunds.refundRaffle(r3.id);
  check(rerun.initiated === 0, "re-running refunds initiates nothing new (resumable, not repeating)");

  // Scoped to this raffle: the global escrow balance still legitimately holds
  // money for the disputed raffle from section 9.
  const r3Escrow = await raffleEscrowBalance(r3.id);
  check(r3Escrow === 0, `escrow for this raffle back to zero after refund (${r3Escrow})`);
  check((await totalLedgerSum()) === 0, "book still balanced after refunds");

  console.log("\n11. Refunds that settle asynchronously");
  refundMode = "pending";
  const s4 = await makeUser("seller4");
  const p4 = await makeProduct(s4.id, PRICE * 4);
  const r4 = await createRaffle({
    productId: p4.id,
    sellerId: s4.id,
    ticketPriceMinor: PRICE,
    totalTickets: 4,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(r4.id);
  const e1 = await makeUser("e1");
  const held4 = await reserveTickets({
    raffleId: r4.id,
    userId: e1.id,
    customerEmail: e1.email,
    quantity: 1,
  });
  await confirmTicketPayment(held4.reference);
  await prisma.raffle.update({
    where: { id: r4.id },
    data: { closesAt: new Date(Date.now() - 1000), status: "EXPIRED" },
  });

  const asyncRun = await refunds.refundRaffle(r4.id);
  check(asyncRun.settled === 0, "a pending refund does not settle immediately");
  check(asyncRun.remaining === 1, "still outstanding until the provider confirms");
  const escrowMid = await raffleEscrowBalance(r4.id);
  check(
    escrowMid === -PRICE,
    `escrow still held while the refund is in flight (${escrowMid})`,
  );

  const settled = await webhook("refund.processed", {
    transaction_reference: held4.reference,
    id: 999,
  });
  check(settled.body.outcome === "settled", `refund.processed -> ${String(settled.body.outcome)}`);
  check(
    (await prisma.raffle.findUniqueOrThrow({ where: { id: r4.id } })).status === "REFUNDED",
    "raffle finalised to REFUNDED by the webhook",
  );
  const escrowEnd = await raffleEscrowBalance(r4.id);
  check(escrowEnd === 0, `escrow released on settlement (${escrowEnd})`);

  const replayRefund = await webhook("refund.processed", {
    transaction_reference: held4.reference,
    id: 999,
  });
  check(
    replayRefund.body.status === "duplicate" || replayRefund.body.reason === "no_open_refund",
    "replayed refund webhook does not double-reverse",
  );
  check((await totalLedgerSum()) === 0, "book balanced after async refund");

  console.log("\n12. Platform absorbs the provider fee on a refund");
  const finalCash = (await accountBalances()).find((b) => b.account === "PLATFORM_CASH");
  const finalPsp = (await accountBalances()).find((b) => b.account === "PSP_FEES");
  check(
    (finalPsp?.balance ?? 0) > 0,
    `provider fees booked as a real expense (${finalPsp?.balance})`,
  );
  check(
    typeof finalCash?.balance === "number",
    `cash position = ${finalCash?.balance} (refunds paid back in full while fees were kept by the provider)`,
  );
  console.log("");
  console.log("13. Payout onboarding refuses what it should");
  const otherSeller = await makeUser("rival");

  await expectErr(
    "a bank code the provider does not list",
    () =>
      sellers.onboardPayoutDestination(otherSeller.id, {
        kind: "mobile_money",
        accountName: "Kojo Boateng",
        accountNumber: "0551110000",
        bankCode: "NOT_A_NETWORK",
      }),
    "UNKNOWN_BANK",
  );
  check(
    (await prisma.sellerProfile.findUnique({ where: { userId: otherSeller.id } })) === null,
    "a rejected bank code writes no profile",
  );
  check(
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: otherSeller.id },
        select: { kycStatus: true },
      })
    ).kycStatus === "UNSUBMITTED",
    "and does not approve KYC",
  );

  // The stub keys the recipient code on the account number, exactly as
  // Paystack does, so this is a second seller claiming the first one's wallet.
  await expectErr(
    "an account already registered to another seller",
    () =>
      sellers.onboardPayoutDestination(otherSeller.id, {
        kind: "mobile_money",
        accountName: "Ama Owusu",
        accountNumber: momoNumber,
        bankCode: "MTN",
      }),
    "DESTINATION_TAKEN",
  );

  const bankOptions = await sellers.listPayoutBanks("bank");
  check(
    bankOptions.length > 0 && bankOptions.every((b) => b.kind === "bank"),
    `the bank rail lists its own destinations -> ${bankOptions.length}`,
  );

  // Replacing a destination must work: a seller who changes network or loses
  // a SIM cannot be stranded on an account they no longer control.
  // Derived from the per-run tag, not a fixed literal. The stub mints the
  // recipient code from the account number and that column is unique, so a
  // constant here fails against any row an interrupted run left behind —
  // the same trap the Paystack reference seeds already avoid.
  const bankNumber = `1${tag}`.padEnd(10, "0").slice(0, 10);
  const replaced = await sellers.onboardPayoutDestination(seller.id, {
    kind: "bank",
    accountName: "Ama Owusu",
    accountNumber: bankNumber,
    bankCode: "030100",
  });
  check(
    replaced.kind === "bank" && replaced.accountNumberLast4 === bankNumber.slice(-4),
    `destination can be replaced -> ${replaced.kind} ${replaced.accountNumberLast4}`,
  );
  check(
    (await prisma.sellerProfile.count({ where: { userId: seller.id } })) === 1,
    "replacing updates the one profile rather than adding another",
  );

  console.log("");
  console.log("14. Payout destinations at rest");

  // Moolre's transfer endpoint takes the raw receiver on every call, so unlike
  // Paystack there is no opaque provider handle to hold instead of the number.
  // These assertions are the whole justification for storing one at all.
  const spellings = ["0241234567", "+233 24 123 4567", "233241234567", "241234567"];
  const canonical = spellings.map((f) => secrets.normaliseAccountNumber(f, "mobile_money"));
  check(
    canonical.every((c) => c === "0241234567"),
    `every spelling of one number converges -> ${JSON.stringify(canonical)}`,
  );
  // The webhook reports the payer as 233..., the transfer API demands 0...,
  // and a refund has to bridge the two or it pays the wrong account.
  check(
    secrets.normaliseAccountNumber("233242097401", "mobile_money") === "0242097401",
    "the webhook's payer spelling becomes the form a transfer accepts",
  );
  check(
    secrets.normaliseAccountNumber("0012-3456", "bank") === "00123456",
    "bank numbers keep their digits, with no mobile prefix rules invented",
  );
  for (const bad of ["", "abc", "01234", "0241234567890"]) {
    await expectErr(
      `refuses ${JSON.stringify(bad)} rather than transferring to it`,
      () => secrets.normaliseAccountNumber(bad, "mobile_money"),
      "INVALID_ACCOUNT_NUMBER",
    );
  }

  const cipherA = secrets.encryptDestination("0241234567", "mobile_money");
  const cipherB = secrets.encryptDestination("+233 24 123 4567", "mobile_money");
  check(cipherA !== cipherB, "a fresh IV per call, so equal numbers do not share a ciphertext");
  check(
    secrets.decryptDestination(cipherA) === "0241234567" &&
      secrets.decryptDestination(cipherB) === "0241234567",
    "both round-trip to the canonical number",
  );
  check(!cipherA.includes("0241234567"), "the plaintext does not survive in the ciphertext");

  // GCM's tag is the point: a corrupted row must fail loudly rather than send
  // real money to whatever the bytes happen to decode to.
  const cipherParts = cipherA.split(".");
  await expectErr(
    "a tampered ciphertext is rejected, not silently decrypted",
    () =>
      secrets.decryptDestination(
        [cipherParts[0], cipherParts[1], cipherParts[2], Buffer.from("0509999999").toString("base64url")].join("."),
      ),
    "MALFORMED_CIPHERTEXT",
  );
  for (const bad of ["", "nope", "v2.a.b.c", "v1.a.b"]) {
    await expectErr(
      `malformed ciphertext ${JSON.stringify(bad)} is rejected`,
      () => secrets.decryptDestination(bad),
      "MALFORMED_CIPHERTEXT",
    );
  }

  // Deterministic on purpose: this is what makes the unique index fire and
  // DESTINATION_TAKEN catch a seller registering someone else's wallet.
  const codeA = secrets.deriveRecipientCode("mobile_money", "1", "0241234567");
  check(
    codeA === secrets.deriveRecipientCode("mobile_money", "1", "+233 24 123 4567"),
    "one account in two spellings derives one recipient code",
  );
  check(
    codeA !== secrets.deriveRecipientCode("mobile_money", "6", "0241234567") &&
      codeA !== secrets.deriveRecipientCode("mobile_money", "1", "0241234568"),
    "a different network or number derives a different code",
  );
  check(
    codeA.startsWith("moolre_") && !codeA.includes("241234567"),
    `the code is opaque and does not embed the number -> ${codeA}`,
  );
  check(
    secrets.accountNumberLast4("+233 24 123 4567", "mobile_money") === "4567",
    "last4 is taken from the canonical form, not the typed one",
  );

  console.log("");
  console.log("15. An outbound fee is charged on top, and has to be booked");

  // Measured against the Moolre sandbox on 2026-11-14: a GHS 5.00 transfer
  // debited GHS 5.05. A collection fee is deducted from what we receive, but
  // an outbound one is additional cash leaving. Unbooked, PLATFORM_CASH drifts
  // below the real wallet by the fee on every payout — and the ledger would
  // still sum to zero while being wrong about the money, which is precisely
  // the failure totalLedgerSum() cannot catch on its own.
  // Payout.orderId is UNIQUE — one payout per order — so this borrows the
  // disputed order from section 9, which has none precisely because a dispute
  // freezes its auto-release.
  const feePayout = await prisma.payout.create({
    data: {
      sellerId: s2.id,
      orderId: o2.id,
      reference: `pay-fee-${tag}`,
      amount: 50_000,
      status: "PROCESSING",
    },
    select: { id: true },
  });

  await payouts.markPayoutPaid(feePayout.id, `TRF_${nextTransferId++}`, 500);

  const feeLegs = await prisma.ledgerEntry.findMany({
    where: { transaction: { reference: `seller-payout:${feePayout.id}` } },
    select: { amount: true, account: { select: { type: true } } },
  });
  const byAccount = new Map(feeLegs.map((l) => [l.account.type, l.amount]));

  check(feeLegs.length === 3, `a fee adds a third leg -> ${feeLegs.length}`);
  check(
    byAccount.get("SELLER_PAYABLE") === 50_000,
    `the seller is settled for the full amount, not amount minus fee -> ${byAccount.get("SELLER_PAYABLE")}`,
  );
  check(byAccount.get("PSP_FEES") === 500, `the fee is booked as an expense -> ${byAccount.get("PSP_FEES")}`);
  check(
    byAccount.get("PLATFORM_CASH") === -50_500,
    `cash out is amount + fee, not amount -> ${byAccount.get("PLATFORM_CASH")}`,
  );
  check(
    (await prisma.payout.findUniqueOrThrow({
      where: { id: feePayout.id },
      select: { feeMinor: true },
    })).feeMinor === 500,
    "the fee is recorded on the payout for reconciliation",
  );
  check((await totalLedgerSum()) === 0, "ledger still balances with a fee leg");

  // The no-fee path needs no new case here: section 6 pays out through the
  // Paystack stub, which reports no fee, and asserted two legs already.
  check(
    (await prisma.ledgerEntry.count({
      where: { transaction: { reference: `seller-payout:${release.payoutId}` } },
    })) === 2,
    "a provider reporting no fee still posts exactly two legs",
  );

  console.log("");
  console.log("16. A finished sale can be taken off the seller's shelf");

  // The point of putting this here rather than in the raffle suite: `raffle`
  // reached COMPLETED through the real `releaseEscrow` in section 4, with a
  // real order, real paid tickets and a real payout behind it. Until now a
  // paid ticket froze the listing forever, so a seller who had sold, shipped
  // and been paid could never clear the item out of `/sell`.

  // Editing is still refused, and that asymmetry is the whole design: the
  // listing is the record of what those two buyers paid for. Asserted before
  // the archive, since an archived product reads as NOT_FOUND to an edit.
  const soldEdit = await products
    .updateProduct(product.id, { title: "Something else entirely" })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    soldEdit instanceof products.ProductMutationError &&
      soldEdit.code === "TICKETS_SOLD",
    `a completed sale still cannot be edited -> ${
      soldEdit instanceof products.ProductMutationError ? soldEdit.code : String(soldEdit)
    }`,
  );

  // The disputed sale from section 9 is the counter-case: its raffle is still
  // DRAWN, so somebody is owed either the item or their money.
  const disputedWithdraw = await products
    .archiveProduct(p2.id, s2.id)
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    disputedWithdraw instanceof products.ProductMutationError &&
      disputedWithdraw.code === "SALE_IN_PROGRESS",
    `an unfinished sale still refuses withdrawal -> ${
      disputedWithdraw instanceof products.ProductMutationError
        ? disputedWithdraw.code
        : String(disputedWithdraw)
    }`,
  );
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: p2.id },
      select: { status: true },
    })).status !== "ARCHIVED",
    "the refused withdrawal left that listing alone",
  );

  const soldWithdraw = await products.archiveProduct(product.id, seller.id);
  check(!soldWithdraw.alreadyArchived, "the completed listing was withdrawn");
  check(
    soldWithdraw.cancelledRaffleIds.length === 0,
    `nothing was cancelled on the way out -> ${soldWithdraw.cancelledRaffleIds.length}`,
  );
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { status: true },
    })).status === "ARCHIVED",
    "the product is ARCHIVED, not deleted",
  );

  // Everything the sale consists of has to survive untouched. An archive that
  // quietly cancelled the raffle or dropped its tickets would rewrite history
  // a buyer and a payout both still read through.
  check(
    (await prisma.raffle.findUniqueOrThrow({
      where: { id: raffle.id },
      select: { status: true },
    })).status === "COMPLETED",
    "its raffle is still COMPLETED",
  );
  check(
    (await prisma.ticket.count({ where: { raffleId: raffle.id, status: "PAID" } })) === POOL,
    `the paid tickets are still there -> ${await prisma.ticket.count({
      where: { raffleId: raffle.id, status: "PAID" },
    })}`,
  );
  check(
    (await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    })).status === "CONFIRMED",
    "the order is still CONFIRMED",
  );
  check(
    (await prisma.payout.count({ where: { orderId: order.id } })) === 1,
    "the payout row survives, so the money is still accounted for",
  );
  check((await totalLedgerSum()) === 0, "the ledger is untouched by a withdrawal");

  // The winner's own record of what they won must not disappear because the
  // seller tidied their shelf. `listUserTickets` roots on Raffle and never
  // reads Product.status, which is what makes this hold.
  const winnerHistory = await listUserTickets(winnerId);
  check(
    winnerHistory.entries.some((e) => e.raffle.id === raffle.id),
    "the winner's ticket history still shows the raffle",
  );

  // Mirrors the `where` in GET /products/mine, which this suite cannot call
  // without a Clerk session.
  check(
    (await prisma.product.count({
      where: { id: product.id, sellerId: seller.id, status: { not: "ARCHIVED" } },
    })) === 0,
    "and it has left the seller's listings",
  );
} catch (suiteError) {
  // Without this the finally block's process.exit discards the exception and
  // the run looks like a clean pass that simply stopped early.
  fail++;
  console.log("");
  console.log("  FAIL  suite aborted with an unhandled error:");
  console.log(suiteError);
} finally {
  const rIds = made.raffles;
  // The draw now queues notifications, so this suite leaves Notification
  // rows and notification.send jobs behind unless they are cleared. They
  // were being claimed by the jobs suite's concurrency test as extra work.
  await prisma.notification.deleteMany({
    where: { recipientUserId: { in: made.users } },
  });
  await prisma.job.deleteMany({ where: { type: { startsWith: "notification." } } });
  await prisma.ledgerEntry.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.ledgerEntry.deleteMany({
    where: { order: { raffleId: { in: rIds } } },
  });
  await prisma.ledgerTransaction.deleteMany({ where: { entries: { none: {} } } });
  // Audit rows are keyed by the entity they describe, which for escrow
  // release and delivery is the ORDER, not the raffle. Resolved here, while
  // the orders still exist — reading them after the delete below returned an
  // empty list every run, so those rows were never actually cleared.
  const auditOrderIds = (
    await prisma.order.findMany({ where: { raffleId: { in: rIds } }, select: { id: true } })
  ).map((o) => o.id);
  await prisma.payout.deleteMany({ where: { order: { raffleId: { in: rIds } } } });
  await prisma.dispute.deleteMany({ where: { order: { raffleId: { in: rIds } } } });
  await prisma.order.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.draw.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.refund.deleteMany({ where: { payment: { raffleId: { in: rIds } } } });
  await prisma.ticket.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.payment.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.raffle.deleteMany({ where: { id: { in: rIds } } });
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...rIds, ...auditOrderIds, ...made.users] } },
  });
  await prisma.address.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "paystack" } });

  console.log(
    `\ncleanup: users=${await prisma.user.count({ where: { id: { in: made.users } } })} ` +
      `raffles=${await prisma.raffle.count({ where: { id: { in: rIds } } })}`,
  );
  console.log(`ledger balanced after cleanup: ${(await totalLedgerSum()) === 0}`);

  server.close();
  stub.close();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
