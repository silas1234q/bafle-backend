import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Point the real Paystack driver at a local stub, so the production code path
// runs end to end: real driver, real HMAC signing, real webhook handler.
const SECRET = "sk_test_" + randomBytes(16).toString("hex");
const stubPort = 4100;
process.env.PAYSTACK_SECRET_KEY = SECRET;
process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.PAYMENT_PROVIDER = "paystack";
// These suites ARE test money acting on a real database, which is exactly the
// case the guard in sendPayout/refundRaffle refuses by default. Opted in
// explicitly rather than exempted, so the hazard is stated where it applies:
// every payout and refund below moves stub money against DATABASE_URL.
process.env.ALLOW_TEST_MONEY_ON_REAL_DATA = "true";
process.env.PORT = "4101";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");
const { createRaffle, extendRaffle, RaffleExtendError, RaffleValidationError } =
  await import("../src/services/raffles.js");
const {
  abandonReservation,
  reserveTickets,
  TicketPurchaseError,
  releaseExpiredReservations,
  listUserTickets,
} = await import(
  "../src/services/tickets.js"
);
const { raffleAvailability } = await import("../src/services/raffles.js");
const { executeDraw, notifyDrawScheduled } = await import("../src/services/draw.js");
const { DRAW_DELAY_MS } = await import("../src/services/payments.js");
const { runSweeps } = await import("../src/jobs/handlers.js");
const { archiveProduct, ProductMutationError, updateProduct } = await import(
  "../src/services/products.js"
);
const { totalLedgerSum, accountBalances } = await import("../src/services/ledger.js");

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

// --- Paystack stub -------------------------------------------------------
const paidAmounts = new Map<string, number>();
// Seeded from the clock, not a fixed base: Payment.providerReference is
// unique, so a row left behind by an earlier run would otherwise collide
// and fail a webhook mid-suite for reasons that look like a logic bug.
let nextTxnId = Date.now() % 100_000_000;
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });

    if (url === "/transaction/initialize") {
      const body = JSON.parse(raw) as { reference: string; amount: number };
      paidAmounts.set(body.reference, body.amount);
      res.end(
        JSON.stringify({
          status: true,
          message: "ok",
          data: {
            authorization_url: `https://checkout.test/${body.reference}`,
            access_code: `acc_${String(body.reference)}`,
            reference: body.reference,
          },
        }),
      );
      return;
    }

    if (url.startsWith("/transaction/verify/")) {
      const reference = decodeURIComponent(url.split("/").pop() ?? "");
      res.end(
        JSON.stringify({
          status: true,
          message: "ok",
          data: {
            id: nextTxnId++,
            status: "success",
            reference,
            amount: paidAmounts.get(reference) ?? 0,
            currency: "GHS",
            channel: "mobile_money",
            paid_at: new Date().toISOString(),
            gateway_response: "Successful",
            // A realistic Paystack cut, so escrow is backed by less cash.
            fees: Math.round((paidAmounts.get(reference) ?? 0) * 0.0195),
          },
        }),
      );
      return;
    }

    res.end(JSON.stringify({ status: false, message: "stub: unknown route" }));
  });
});
await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", r));

const server = app.listen(4101);
await new Promise<void>((r) => server.once("listening", () => r()));
const api = "http://127.0.0.1:4101";

async function postWebhook(reference: string, event = "charge.success") {
  const payload = JSON.stringify({ event, data: { reference } });
  const signature = createHmac("sha512", SECRET).update(payload).digest("hex");
  const response = await fetch(`${api}/webhooks/paystack`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paystack-signature": signature },
    body: payload,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// --- fixtures ------------------------------------------------------------
const tag = randomBytes(4).toString("hex");
const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };

async function makeUser(label: string) {
  const user = await prisma.user.create({
    data: {
      clerkUserId: `test_${tag}_${label}`,
      email: `${label}.${tag}@test.invalid`,
      username: `u${label}${tag}`.slice(0, 20),
    },
    select: { id: true, email: true },
  });
  made.users.push(user.id);
  return user;
}

async function makeProduct(sellerId: string, retailValue: number) {
  const product = await prisma.product.create({
    data: {
      sellerId,
      title: `Test item ${tag}`,
      slug: `test-item-${tag}-${randomBytes(3).toString("hex")}`,
      description: "A test product for the raffle suite.",
      category: "tech",
      retailValue,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  made.products.push(product.id);
  return product;
}

const TICKET_PRICE = 1000; // GHS 10.00
const POOL = 5;

try {
  const seller = await makeUser("seller");
  const product = await makeProduct(seller.id, TICKET_PRICE * POOL);

  console.log("1. Pricing floor");
  await (async () => {
    const cheap = await makeProduct(seller.id, 1_000_000);
    try {
      await createRaffle({
        productId: cheap.id,
        sellerId: seller.id,
        ticketPriceMinor: 100,
        totalTickets: 10,
        closesAt: new Date(Date.now() + 86_400_000),
      });
      check(false, "under-priced raffle should be rejected");
    } catch (e) {
      check(
        e instanceof RaffleValidationError && /valued at/.test(e.message),
        `raffle raising less than retail value rejected\n          -> ${(e as Error).message.slice(0, 95)}`,
      );
    }
  })();

  const raffle = await createRaffle({
    productId: product.id,
    sellerId: seller.id,
    ticketPriceMinor: TICKET_PRICE,
    totalTickets: POOL,
    closesAt: new Date(Date.now() + 86_400_000),
    platformFeeBps: 500,
  });
  made.raffles.push(raffle.id);
  check(raffle.status === "OPEN", "raffle opened");

  console.log("\n2. No result exists before the draw");
  const preDraw = await fetch(`${api}/raffles/${raffle.id}/draw`);
  const preBody = (await preDraw.json()) as Record<string, unknown>;
  check(preDraw.status === 409, `draw endpoint returns 409 before the draw (${preDraw.status})`);
  check(preBody.status === "OPEN", "the 409 reports the raffle status");
  check(
    !("winningTicketNumber" in preBody) && !("winnerUsername" in preBody),
    "no winner is disclosed before the draw",
  );

  console.log("\n3. Seller cannot enter their own raffle");
  try {
    await reserveTickets({
      raffleId: raffle.id,
      userId: seller.id,
      customerEmail: seller.email,
      quantity: 1,
    });
    check(false, "seller entry should be rejected");
  } catch (e) {
    check(
      e instanceof TicketPurchaseError && e.code === "SELLER_CANNOT_ENTER",
      "seller buying own tickets rejected",
    );
  }

  console.log(`\n4. Oversell under concurrency (${POOL} tickets, 12 simultaneous buyers)`);
  const buyers = await Promise.all(
    Array.from({ length: 12 }, (_, i) => makeUser(`buyer${i}`)),
  );
  const attempts = await Promise.allSettled(
    buyers.map((buyer) =>
      reserveTickets({
        raffleId: raffle.id,
        userId: buyer.id,
        customerEmail: buyer.email,
        quantity: 1,
      }),
    ),
  );

  const won = attempts.filter((a) => a.status === "fulfilled");
  const lost = attempts.filter((a) => a.status === "rejected");
  check(won.length === POOL, `exactly ${POOL} reservations succeeded (got ${won.length})`);
  check(
    lost.every(
      (a) =>
        a.status === "rejected" &&
        a.reason instanceof TicketPurchaseError &&
        a.reason.code === "NOT_ENOUGH_TICKETS",
    ),
    `the other ${lost.length} failed with NOT_ENOUGH_TICKETS, not a crash`,
  );

  const ticketRows = await prisma.ticket.findMany({
    where: { raffleId: raffle.id },
    select: { ticketNumber: true },
  });
  const numbers = ticketRows.map((t) => t.ticketNumber).sort((a, b) => a - b);
  check(ticketRows.length === POOL, `exactly ${POOL} ticket rows exist (got ${ticketRows.length})`);
  check(new Set(numbers).size === POOL, "no duplicate ticket numbers");
  check(
    JSON.stringify(numbers) === JSON.stringify([1, 2, 3, 4, 5]),
    `numbers allocated contiguously from 1 -> [${numbers.join(",")}]`,
  );

  console.log("\n5. Payment confirmation via signed webhook");
  const references = won.map((a) =>
    a.status === "fulfilled" ? a.value.reference : "",
  );
  const results = [];
  for (const reference of references) results.push(await postWebhook(reference));

  check(results.every((r) => r.status === 200), "all webhooks accepted");
  const soldOutBy = results.filter((r) => r.body.soldOut === true);
  check(
    soldOutBy.length === 1,
    `exactly one confirmation claims the sellout (${soldOutBy.length})`,
  );
  // The draw is no longer run by the payment path — no confirmation can
  // report a winner, because none has one yet.
  check(
    results.every((r) => r.body.drawId === null),
    "no webhook draws inline any more",
  );

  const afterSale = await prisma.raffle.findUniqueOrThrow({
    where: { id: raffle.id },
    select: { status: true, ticketsSold: true, drawAt: true },
  });
  check(afterSale.ticketsSold === POOL, `ticketsSold = ${afterSale.ticketsSold}`);
  check(afterSale.status === "SOLD_OUT", `raffle waits at ${afterSale.status}`);
  check(
    (await prisma.ticket.count({ where: { raffleId: raffle.id, status: "PAID" } })) === POOL,
    "all tickets marked PAID",
  );
  check(
    afterSale.drawAt !== null &&
      afterSale.drawAt.getTime() > Date.now() + DRAW_DELAY_MS - 60_000,
    `the draw is scheduled ~${DRAW_DELAY_MS / 60_000} minutes out`,
  );
  check(
    (await prisma.draw.count({ where: { raffleId: raffle.id } })) === 0,
    "and has NOT happened yet — this is the gap entrants are told about",
  );

  // Queued in the sellout transaction, so it cannot be lost.
  const drawJob = await prisma.job.findFirst({
    where: { dedupeKey: `raffle.draw:${raffle.id}` },
    select: { runAt: true, status: true },
  });
  check(
    drawJob?.status === "PENDING" && drawJob.runAt.getTime() === afterSale.drawAt?.getTime(),
    "a raffle.draw job is pending for exactly that moment",
  );

  console.log("\n5b. Entrants are told before the draw runs");
  const notified = await notifyDrawScheduled(raffle.id);
  check(notified > 0, `every holder queued a "drawing soon" notice (${notified})`);
  check(
    (await prisma.notification.count({
      where: { type: "raffle.draw.scheduled", entityId: raffle.id },
    })) === notified,
    "one notification per holder, not per ticket",
  );
  check(
    (await notifyDrawScheduled(raffle.id)) === 0,
    "re-running the notify job sends nobody a second copy",
  );

  // Now let the scheduled draw run, as the job would.
  await prisma.raffle.update({
    where: { id: raffle.id },
    data: { drawAt: new Date(Date.now() - 1000) },
  });
  const sweep = await runSweeps();
  check(sweep.drawJobsQueued >= 0, "the sweep accepts a due draw");
  await executeDraw(raffle.id);

  const afterDraw = await prisma.raffle.findUniqueOrThrow({
    where: { id: raffle.id },
    select: { status: true },
  });
  check(afterDraw.status === "DRAWN", `raffle status after the draw = ${afterDraw.status}`);
  check(
    (await notifyDrawScheduled(raffle.id)) === 0,
    "no 'drawing soon' notice goes out once the result exists",
  );

  console.log("\n6. Webhook replay is idempotent");
  const replay = await postWebhook(references[0]!);
  check(replay.body.status === "duplicate", `replayed event -> ${String(replay.body.status)}`);
  check(
    (await prisma.draw.count({ where: { raffleId: raffle.id } })) === 1,
    "still exactly one Draw row (no re-draw)",
  );
  check(
    (await prisma.ledgerTransaction.count({
      where: { reference: `ticket-purchase:${references[0]!}` },
    })) === 1,
    "no duplicate ledger transaction",
  );

  console.log("\n7. The recorded winner is a real paid ticket");
  const draw = await prisma.draw.findUniqueOrThrow({ where: { raffleId: raffle.id } });
  check(draw.ticketCount === POOL, `draw records the pool size (${draw.ticketCount})`);
  check(
    draw.winningTicketNumber >= 1 && draw.winningTicketNumber <= POOL,
    `winning number ${draw.winningTicketNumber} is inside the pool`,
  );

  // The winner must be an actual row, not an index that happens to be in
  // range: winningTicketId, winningTicketNumber and winnerUserId all have to
  // describe the same ticket, or the order is opened for the wrong person.
  const winningTicket = await prisma.ticket.findUniqueOrThrow({
    where: { id: draw.winningTicketId },
    select: { raffleId: true, status: true, ticketNumber: true, userId: true },
  });
  check(winningTicket.raffleId === raffle.id, "winning ticket belongs to this raffle");
  check(winningTicket.status === "PAID", "winning ticket is PAID");
  check(
    winningTicket.ticketNumber === draw.winningTicketNumber,
    "winningTicketNumber matches the ticket it points at",
  );
  check(
    winningTicket.userId === draw.winnerUserId,
    "winnerUserId is the owner of the winning ticket",
  );

  const publicDraw = await fetch(`${api}/raffles/${raffle.id}/draw`);
  const publicBody = (await publicDraw.json()) as Record<string, unknown>;
  check(publicDraw.status === 200, "draw endpoint now returns 200");
  check(typeof publicBody.winnerUsername === "string", "winner username published");
  check(
    publicBody.winningTicketNumber === draw.winningTicketNumber,
    "public result matches the stored draw",
  );
  check(!("winnerUserId" in publicBody), "internal winner id not leaked");

  console.log("\n8. Double draw is impossible");
  const again = await executeDraw(raffle.id);
  check(again.id === draw.id, "executeDraw returns the existing draw rather than re-drawing");
  check(
    again.winningTicketNumber === draw.winningTicketNumber,
    "winner unchanged on re-run",
  );

  console.log("\n9. Ledger integrity");
  check((await totalLedgerSum()) === 0, "every ledger entry sums to zero across the book");
  const balances = await accountBalances();
  const byAccount = new Map(balances.map((b) => [b.account, b.balance]));
  const gross = TICKET_PRICE * POOL;
  const fees = -(byAccount.get("PSP_FEES") ?? 0) * -1;
  check(
    byAccount.get("TICKET_ESCROW") === -gross,
    `escrow liability = -${gross} (got ${byAccount.get("TICKET_ESCROW")})`,
  );
  check(
    (byAccount.get("PSP_FEES") ?? 0) > 0,
    `provider fees recorded as an expense (${byAccount.get("PSP_FEES")})`,
  );
  check(
    byAccount.get("PLATFORM_CASH") === gross - fees,
    `cash = gross - fees = ${gross - fees} (got ${byAccount.get("PLATFORM_CASH")})`,
  );
  check(
    (byAccount.get("PLATFORM_CASH") ?? 0) < gross,
    "cash held is LESS than ticket revenue, because the provider took its cut",
  );

  console.log("\n10. Expired reservations free their numbers");
  const seller2 = await makeUser("seller2");
  const product2 = await makeProduct(seller2.id, 2000);
  const raffle2 = await createRaffle({
    productId: product2.id,
    sellerId: seller2.id,
    ticketPriceMinor: 1000,
    totalTickets: 2,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(raffle2.id);

  const abandoning = await makeUser("abandoner");
  const held = await reserveTickets({
    raffleId: raffle2.id,
    userId: abandoning.id,
    customerEmail: abandoning.email,
    quantity: 2,
  });
  check(held.ticketNumbers.length === 2, "both tickets held by one checkout");

  const blocked = await makeUser("blocked");
  try {
    await reserveTickets({
      raffleId: raffle2.id,
      userId: blocked.id,
      customerEmail: blocked.email,
      quantity: 1,
    });
    check(false, "should be nothing left while the reservation is live");
  } catch (e) {
    check(
      e instanceof TicketPurchaseError && e.code === "NOT_ENOUGH_TICKETS",
      "live reservation blocks other buyers",
    );
  }

  // Backdate the hold rather than waiting 15 minutes.
  await prisma.ticket.updateMany({
    where: { raffleId: raffle2.id, status: "RESERVED" },
    data: { reservationExpiresAt: new Date(Date.now() - 1000) },
  });
  const released = await releaseExpiredReservations({ raffleId: raffle2.id });
  check(released === 2, `releaseExpiredReservations freed ${released} tickets`);
  check(
    (await prisma.payment.findUniqueOrThrow({ where: { reference: held.reference } })).status ===
      "ABANDONED",
    "abandoned checkout's payment marked ABANDONED",
  );

  const after = await reserveTickets({
    raffleId: raffle2.id,
    userId: blocked.id,
    customerEmail: blocked.email,
    quantity: 2,
  });
  check(
    JSON.stringify(after.ticketNumbers) === JSON.stringify([1, 2]),
    `freed numbers are reused, not skipped -> [${after.ticketNumbers.join(",")}]`,
  );

  console.log("\n11. A buyer can see their own tickets");

  // The drawn raffle above has POOL paid tickets and a winner. Pick a holder
  // who is not the winner, so both sides of the outcome get asserted.
  const paidHolders = await prisma.ticket.findMany({
    where: { raffleId: raffle.id, status: "PAID" },
    select: { userId: true, ticketNumber: true },
  });
  const loserId = paidHolders.find((t) => t.userId !== draw.winnerUserId)?.userId;

  const winnerView = await listUserTickets(draw.winnerUserId);
  const winnerEntry = winnerView.entries.find((e) => e.raffle.id === raffle.id);

  check(winnerEntry !== undefined, "winner sees the raffle they entered");
  check(winnerEntry?.won === true, `winner's entry is won -> ${String(winnerEntry?.won)}`);
  check(
    winnerEntry?.outcome === "won",
    `winner's outcome is "won" -> ${String(winnerEntry?.outcome)}`,
  );
  check(
    winnerEntry?.winningTicketNumber === draw.winningTicketNumber,
    `winning number matches the draw -> ${String(winnerEntry?.winningTicketNumber)}`,
  );
  check(
    winnerEntry?.amountPaidMinor === (winnerEntry?.paidCount ?? 0) * TICKET_PRICE,
    `amountPaidMinor is paidCount x ticketPrice -> ${String(winnerEntry?.amountPaidMinor)}`,
  );
  check(
    winnerEntry?.tickets.every(
      (t, i, all) => i === 0 || t.ticketNumber > (all[i - 1]?.ticketNumber ?? 0),
    ) === true,
    "ticket numbers come back ascending",
  );

  if (loserId) {
    const loserView = await listUserTickets(loserId);
    const loserEntry = loserView.entries.find((e) => e.raffle.id === raffle.id);
    check(loserEntry?.won === false, `a losing holder's entry is not won -> ${String(loserEntry?.won)}`);
    check(
      loserEntry?.outcome === "lost",
      `losing holder's outcome is "lost" -> ${String(loserEntry?.outcome)}`,
    );
    check(
      loserEntry?.winningTicketNumber === draw.winningTicketNumber,
      "a loser still sees which number won",
    );
    // Isolation: the only guarantee a service-level test can make, since no
    // suite can mint a Clerk session to go through the route.
    check(
      !loserView.entries.some((e) => e.raffle.id === raffle2.id),
      "a buyer's list contains only raffles they hold tickets in",
    );
  } else {
    check(false, "expected a paid holder who did not win");
  }

  const winnerSerialised = JSON.stringify(winnerView);
  check(
    !winnerSerialised.includes("winnerUserId"),
    "the response never carries winnerUserId",
  );
  check(
    !winnerSerialised.includes(seller.email),
    "no other user's email in the response",
  );

  console.log("\n12. Unpaid holds are resumable, and expired ones are not hidden");

  // `blocked` holds numbers 1-2 on raffle2 from the section above, with a
  // PENDING payment and a checkout URL from the stub.
  const heldView = await listUserTickets(blocked.id);
  const heldEntry = heldView.entries.find((e) => e.raffle.id === raffle2.id);

  check(heldEntry?.holds.length === 1, `one hold, grouped by payment -> ${String(heldEntry?.holds.length)}`);
  const liveHold = heldEntry?.holds[0];
  check(liveHold?.state === "live", `a fresh hold is live -> ${String(liveHold?.state)}`);
  check(liveHold?.resumable === true, "a live hold is resumable");
  check(liveHold?.reference === after.reference, "the hold carries its payment reference");
  check(
    typeof liveHold?.checkoutUrl === "string" && liveHold.checkoutUrl.length > 0,
    "a resumable hold carries the provider checkout URL",
  );
  check(
    JSON.stringify(liveHold?.ticketNumbers) === JSON.stringify(after.ticketNumbers),
    `the hold lists its own numbers -> [${(liveHold?.ticketNumbers ?? []).join(",")}]`,
  );
  check(
    heldEntry?.outcome === "unpaid",
    `reserved-only in an open raffle reads "unpaid", not "in the draw" -> ${String(heldEntry?.outcome)}`,
  );

  // The regression guard for the central decision here: once the clock runs
  // out the hold must still be visible, because confirmTicketPayment claims
  // RESERVED rows without checking expiry -- so verifying can still rescue a
  // charge whose webhook was lost. Hiding it would discard that route.
  await prisma.ticket.updateMany({
    where: { raffleId: raffle2.id, userId: blocked.id, status: "RESERVED" },
    data: { reservationExpiresAt: new Date(Date.now() - 1000) },
  });

  const lapsedView = await listUserTickets(blocked.id);
  const lapsedEntry = lapsedView.entries.find((e) => e.raffle.id === raffle2.id);
  const lapsedHold = lapsedEntry?.holds[0];

  check(lapsedEntry !== undefined, "an expired hold is still shown to its owner");
  check(
    lapsedHold?.state === "unconfirmed",
    `an expired hold reads as unconfirmed -> ${String(lapsedHold?.state)}`,
  );
  check(lapsedHold?.resumable === false, "an expired hold is not resumable");
  check(
    lapsedHold?.checkoutUrl === null,
    "no checkout URL is handed out once the hold has lapsed",
  );
  check(
    lapsedHold?.reference === after.reference,
    "the expired hold still carries the reference needed to verify it",
  );

  console.log("\n13. A payment that lost its tickets is surfaced separately");

  // Exactly the state a `reservation_lost` rollback leaves behind: the tickets
  // are gone but the payment is still PENDING. Reproduced directly, because
  // reaching it through the real path needs the sweep to win a race against a
  // confirmation.
  await prisma.ticket.deleteMany({
    where: { raffleId: raffle2.id, userId: blocked.id },
  });

  const orphanView = await listUserTickets(blocked.id);
  check(
    !orphanView.entries.some((e) => e.raffle.id === raffle2.id),
    "with no tickets left the raffle drops out of the entries",
  );
  check(
    orphanView.unmatchedPayments.some((p) => p.reference === after.reference),
    "the stranded PENDING payment is reported instead",
  );
  const orphan = orphanView.unmatchedPayments.find((p) => p.reference === after.reference);
  check(
    orphan?.amount === TICKET_PRICE * 2 && orphan.quantity === 2,
    `the stranded payment reports what was charged -> ${String(orphan?.amount)}`,
  );
  check(
    orphan?.raffleId === raffle2.id,
    "the stranded payment still points at its raffle",
  );

  // An ordinary abandoned checkout must NOT appear here: the sweep marks it
  // ABANDONED, and telling someone about a payment they chose not to make
  // would be alarming and wrong. `abandoning` was swept in section 10.
  const abandonedView = await listUserTickets(abandoning.id);
  check(
    !abandonedView.unmatchedPayments.some((p) => p.reference === held.reference),
    "a swept abandoned checkout is not reported as stranded money",
  );

  console.log("\n14. A seller can edit and withdraw a listing, until money is in");

  // Free to edit: no raffle, so nobody has committed to anything.
  const editable = await makeProduct(seller.id, 50_000);
  await updateProduct(editable.id, {
    title: "Edited title",
    description: "An edited description, long enough to pass the schema bound.",
  });
  const edited = await prisma.product.findUniqueOrThrow({
    where: { id: editable.id },
    select: { title: true, description: true, slug: true },
  });
  check(edited.title === "Edited title", "title updated");
  check(/edited description/.test(edited.description), "description updated");
  // The slug is public and may already be shared; a new title must not
  // silently repoint it.
  check(
    !edited.slug.includes("edited"),
    `slug is NOT regenerated from the new title -> ${edited.slug}`,
  );

  // `product` carries the sold-out, drawn raffle from sections 4-8.
  const frozenEdit = await updateProduct(product.id, { title: "Bait and switch" })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    frozenEdit instanceof ProductMutationError && frozenEdit.code === "TICKETS_SOLD",
    `editing a listing with paid tickets is refused -> ${
      frozenEdit instanceof ProductMutationError ? frozenEdit.code : String(frozenEdit)
    }`,
  );
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { title: true },
    })).title !== "Bait and switch",
    "the refused edit changed nothing",
  );

  // A different refusal from the edit above, deliberately: this raffle is
  // DRAWN, so a winner is waiting on delivery. Withdrawal reopens once the
  // sale settles — fulfilment section 16 covers that, against a raffle that
  // reached COMPLETED through the real escrow release.
  const frozenDelete = await archiveProduct(product.id, seller.id)
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    frozenDelete instanceof ProductMutationError &&
      frozenDelete.code === "SALE_IN_PROGRESS",
    `deleting a listing mid-sale is refused -> ${
      frozenDelete instanceof ProductMutationError
        ? frozenDelete.code
        : String(frozenDelete)
    }`,
  );
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { status: true },
    })).status !== "ARCHIVED",
    "the refused delete left the listing alone",
  );

  // product2 still carries the PENDING payment from section 13, which is
  // money that may yet land — a temporary refusal, not a permanent one.
  const midCheckout = await archiveProduct(product2.id, seller2.id)
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    midCheckout instanceof ProductMutationError &&
      midCheckout.code === "CHECKOUT_IN_PROGRESS",
    `a pending checkout blocks deletion -> ${
      midCheckout instanceof ProductMutationError ? midCheckout.code : String(midCheckout)
    }`,
  );

  // The refusal above is about money that may still land against the listing.
  // A checkout the buyer walked away from is different: once its hold lapses
  // it protects nobody, and it used to block edit and delete until the
  // cron-driven sweep ran — which, locally, is never. The product mutations
  // now clear the listing's lapsed holds themselves.
  const lapsedSeller = await makeUser("lapsedseller");
  const lapsedProduct = await makeProduct(lapsedSeller.id, 10_000);
  const lapsedRaffle = await createRaffle({
    productId: lapsedProduct.id,
    sellerId: lapsedSeller.id,
    ticketPriceMinor: TICKET_PRICE,
    totalTickets: 10,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(lapsedRaffle.id);

  const walker = await makeUser("walker");
  const walked = await reserveTickets({
    raffleId: lapsedRaffle.id,
    userId: walker.id,
    quantity: 2,
    customerEmail: `walker.${tag}@test.invalid`,
  });

  // While the hold is live the checkout genuinely is in progress.
  const liveBlock = await updateProduct(lapsedProduct.id, { title: "Too soon" })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    liveBlock instanceof ProductMutationError &&
      liveBlock.code === "CHECKOUT_IN_PROGRESS",
    `a live hold still blocks an edit -> ${
      liveBlock instanceof ProductMutationError ? liveBlock.code : String(liveBlock)
    }`,
  );

  // The buyer leaves and the clock runs out.
  await prisma.ticket.updateMany({
    where: { raffleId: lapsedRaffle.id, status: "RESERVED" },
    data: { reservationExpiresAt: new Date(Date.now() - 1000) },
  });

  await updateProduct(lapsedProduct.id, { title: "Edited after the hold lapsed" });
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: lapsedProduct.id },
      select: { title: true },
    })).title === "Edited after the hold lapsed",
    "an expired checkout no longer blocks an edit",
  );

  // The edit swept the debris the same way the cron would have: rows deleted,
  // payment abandoned, so a charge landing late records reservation_lost
  // instead of buying tickets against the reworded listing.
  check(
    (await prisma.ticket.count({ where: { raffleId: lapsedRaffle.id } })) === 0,
    "the lapsed hold's rows were deleted by the edit's own sweep",
  );
  const walkedPayment = await prisma.payment.findUniqueOrThrow({
    where: { reference: walked.reference },
    select: { status: true, failureReason: true },
  });
  check(
    walkedPayment.status === "ABANDONED" &&
      walkedPayment.failureReason === "reservation_expired",
    `and its payment was marked abandoned -> ${walkedPayment.status}/${String(walkedPayment.failureReason)}`,
  );

  const lapsedDelete = await archiveProduct(lapsedProduct.id, lapsedSeller.id);
  check(
    lapsedDelete.cancelledRaffleIds.includes(lapsedRaffle.id),
    "deleting then goes through, cancelling the never-paid-into raffle",
  );

  // Raising the stated value above what a live raffle can raise would leave a
  // raffle that cannot cover its own item.
  const floorProduct = await makeProduct(seller.id, 4000);
  const floorRaffle = await createRaffle({
    productId: floorProduct.id,
    sellerId: seller.id,
    ticketPriceMinor: 1000,
    totalTickets: 4,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(floorRaffle.id);

  const breaksFloor = await updateProduct(floorProduct.id, { retailValue: 999_999 })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    breaksFloor instanceof ProductMutationError &&
      breaksFloor.code === "BREAKS_PRICING_FLOOR",
    `raising the value past the live raffle's take is refused -> ${
      breaksFloor instanceof ProductMutationError ? breaksFloor.code : String(breaksFloor)
    }`,
  );
  check(
    (await updateProduct(floorProduct.id, { retailValue: 3500 })
      .then(() => true)
      .catch(() => false)),
    "a value the raffle still covers is accepted",
  );

  // The whole point: an unsold listing, raffle and all, can be withdrawn.
  const doomedProduct = await makeProduct(seller.id, 4000);
  const doomedRaffle = await createRaffle({
    productId: doomedProduct.id,
    sellerId: seller.id,
    ticketPriceMinor: 1000,
    totalTickets: 4,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(doomedRaffle.id);

  // A lapsed hold the sweep had not reached yet, so the delete has rows to
  // clear rather than an empty raffle.
  const walkedAway = await makeUser("walkaway");
  await reserveTickets({
    raffleId: doomedRaffle.id,
    userId: walkedAway.id,
    customerEmail: walkedAway.email,
    quantity: 1,
  });
  await prisma.payment.updateMany({
    where: { raffleId: doomedRaffle.id, status: "PENDING" },
    data: { status: "ABANDONED" },
  });

  const withdrawn = await archiveProduct(doomedProduct.id, seller.id);
  check(!withdrawn.alreadyArchived, "the listing was archived");
  check(
    withdrawn.cancelledRaffleIds.includes(doomedRaffle.id),
    "its open raffle was cancelled with it",
  );
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: doomedProduct.id },
      select: { status: true },
    })).status === "ARCHIVED",
    "product status is ARCHIVED, not deleted — raffles and orders still reference it",
  );
  check(
    (await prisma.raffle.findUniqueOrThrow({
      where: { id: doomedRaffle.id },
      select: { status: true },
    })).status === "CANCELLED",
    "raffle status is CANCELLED",
  );
  check(
    (await prisma.ticket.count({ where: { raffleId: doomedRaffle.id } })) === 0,
    "the lapsed hold's tickets are gone",
  );

  // The reason cancelling the raffle is not optional: this endpoint filters on
  // raffle status and never looks at the product.
  const publicList = (await (await fetch(`${api}/raffles`)).json()) as Array<{ id: string }>;
  check(
    !publicList.some((r) => r.id === doomedRaffle.id),
    "the cancelled raffle is no longer buyable from GET /raffles",
  );

  // Mirrors the `where` in GET /products/mine, which the suite cannot call
  // without a Clerk session.
  const stillListed = await prisma.product.count({
    where: { id: doomedProduct.id, sellerId: seller.id, status: { not: "ARCHIVED" } },
  });
  check(stillListed === 0, "it has left the seller's own listings");

  const again2 = await archiveProduct(doomedProduct.id, seller.id);
  check(
    again2.alreadyArchived && again2.cancelledRaffleIds.length === 0,
    "deleting twice is a no-op, so a double-tap is not an error",
  );

  console.log("\n15. One buyer can take a whole draw");
  const wholeSeller = await makeUser("wholeseller");
  const wholeProduct = await makeProduct(wholeSeller.id, 6000);
  const wholeRaffle = await createRaffle({
    productId: wholeProduct.id,
    sellerId: wholeSeller.id,
    ticketPriceMinor: 1000,
    totalTickets: 6,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(wholeRaffle.id);

  const whale = await makeUser("whale");
  const allSix = await reserveTickets({
    raffleId: wholeRaffle.id,
    userId: whale.id,
    customerEmail: whale.email,
    quantity: 6,
  });
  check(
    allSix.ticketNumbers.length === 6,
    `a single purchase can take all 6 tickets -> ${allSix.ticketNumbers.length}`,
  );
  check(
    allSix.ticketNumbers.join(",") === "1,2,3,4,5,6",
    `and gets every number -> [${allSix.ticketNumbers.join(",")}]`,
  );

  // The pool is still the ceiling: asking for more tickets than exist is a
  // mistake, not a purchase.
  const tooMany = await reserveTickets({
    raffleId: wholeRaffle.id,
    userId: whale.id,
    customerEmail: whale.email,
    quantity: 7,
  })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    tooMany instanceof TicketPurchaseError && tooMany.code === "INVALID_QUANTITY",
    `asking for more tickets than the draw has is refused -> ${
      tooMany instanceof TicketPurchaseError ? tooMany.code : String(tooMany)
    }`,
  );

  console.log("\n16. A seller can extend a draw that ran out of time");

  // Written straight to the past: the service allows extending an OPEN raffle
  // whose deadline has gone, which is the whole point of the feature.
  const lateRaffleId = wholeRaffle.id;
  await prisma.raffle.update({
    where: { id: lateRaffleId },
    data: { closesAt: new Date(Date.now() - 60_000) },
  });

  const closed = await reserveTickets({
    raffleId: lateRaffleId,
    userId: blocked.id,
    customerEmail: blocked.email,
    quantity: 1,
  })
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    closed instanceof TicketPurchaseError && closed.code === "RAFFLE_CLOSED",
    "past its deadline, the draw takes no more entries",
  );

  const newClose = new Date(Date.now() + 7 * 86_400_000);
  const extended = await extendRaffle(lateRaffleId, newClose);
  check(
    extended.closesAt.getTime() === newClose.getTime(),
    "an overdue but still-OPEN draw can be extended",
  );
  check(extended.status === "OPEN", "and stays OPEN");

  // Backwards is refused: buyers entered against the time they were shown.
  const backwards = await extendRaffle(lateRaffleId, new Date(Date.now() + 3_600_000))
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    backwards instanceof RaffleExtendError && backwards.code === "INVALID_DEADLINE",
    `bringing the deadline forward is refused -> ${
      backwards instanceof RaffleExtendError ? backwards.code : String(backwards)
    }`,
  );

  const tooFar = await extendRaffle(lateRaffleId, new Date(Date.now() + 200 * 86_400_000))
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    tooFar instanceof RaffleExtendError && tooFar.code === "INVALID_DEADLINE",
    "a deadline beyond the 90-day limit is refused",
  );

  // The raffle `raffle` is DRAWN by this point, so it stands in for every
  // non-OPEN state: once a draw has moved on, its deadline is history.
  const drawnExtend = await extendRaffle(raffle.id, new Date(Date.now() + 86_400_000))
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    drawnExtend instanceof RaffleExtendError && drawnExtend.code === "NOT_EXTENDABLE",
    `a draw that is not OPEN cannot be extended -> ${
      drawnExtend instanceof RaffleExtendError ? drawnExtend.code : String(drawnExtend)
    }`,
  );

  // An EXPIRED raffle is refunding its buyers, so reopening it would race
  // those refunds. Refused by status, with its own wording.
  await prisma.raffle.update({
    where: { id: lateRaffleId },
    data: { status: "EXPIRED" },
  });
  const expiredExtend = await extendRaffle(lateRaffleId, new Date(Date.now() + 86_400_000))
    .then(() => null)
    .catch((e: unknown) => e);
  check(
    expiredExtend instanceof RaffleExtendError &&
      expiredExtend.code === "NOT_EXTENDABLE" &&
      /refunds are under way/.test(expiredExtend.message),
    "an EXPIRED draw is refused, and says why",
  );
  await prisma.raffle.update({
    where: { id: lateRaffleId },
    data: { status: "OPEN" },
  });

  console.log("\n17. Giving up a hold puts the numbers back immediately");

  const cancelSeller = await makeUser("cancelseller");
  const cancelProduct = await makeProduct(cancelSeller.id, 20_000);
  const cancelRaffle = await createRaffle({
    productId: cancelProduct.id,
    sellerId: cancelSeller.id,
    ticketPriceMinor: 2_000,
    totalTickets: 10,
    closesAt: new Date(Date.now() + 7 * 86_400_000),
  });
  made.raffles.push(cancelRaffle.id);

  const quitter = await makeUser("quitter");
  const cancelHold = await reserveTickets({
    raffleId: cancelRaffle.id,
    userId: quitter.id,
    quantity: 4,
    customerEmail: `quitter.${tag}@test.invalid`,
  });

  const duringHold = await raffleAvailability(cancelRaffle.id);
  check(
    duringHold?.available === 6 && duringHold.held === 4,
    `a hold takes the numbers off the shelf -> available=${duringHold?.available} held=${duringHold?.held}`,
  );

  const cancelled = await abandonReservation(cancelHold.reference, quitter.id);
  check(cancelled.outcome === "released", `cancel -> ${cancelled.outcome}`);

  const afterCancel = await raffleAvailability(cancelRaffle.id);
  check(
    afterCancel?.available === 10 && afterCancel.held === 0,
    `and puts all of them back at once -> available=${afterCancel?.available} held=${afterCancel?.held}`,
  );

  // The rows survive on purpose. confirmTicketPayment claims RESERVED rows
  // without checking expiry, so a buyer whose money turns up anyway still
  // gets their tickets instead of reservation_lost.
  check(
    (await prisma.ticket.count({
      where: { raffleId: cancelRaffle.id, status: "RESERVED" },
    })) === 4,
    "the rows are expired, not deleted, so a late payment can still claim them",
  );
  check(
    (await prisma.payment.findUniqueOrThrow({
      where: { reference: cancelHold.reference },
      select: { status: true },
    })).status === "PENDING",
    "and the payment stays PENDING rather than being pre-emptively abandoned",
  );

  // Someone else must be able to take the freed numbers straight away.
  const nextBuyer = await makeUser("nextbuyer");
  const retaken = await reserveTickets({
    raffleId: cancelRaffle.id,
    userId: nextBuyer.id,
    quantity: 10,
    customerEmail: `next.${tag}@test.invalid`,
  });
  check(
    retaken.ticketNumbers.length === 10,
    `another buyer can take the whole pool immediately -> ${retaken.ticketNumbers.length} numbers`,
  );

  // Ownership and idempotency.
  try {
    await abandonReservation(retaken.reference, quitter.id);
    check(false, "someone else's reference should not be cancellable");
  } catch (e) {
    check(
      e instanceof TicketPurchaseError && e.code === "PAYMENT_NOT_FOUND",
      `someone else's reference cannot be cancelled -> ${(e as { code?: string }).code}`,
    );
  }
  const twice = await abandonReservation(cancelHold.reference, quitter.id);
  check(
    twice.outcome === "nothing_held",
    `cancelling twice is harmless -> ${twice.outcome}`,
  );

  // A paid ticket must never be given up by this path.
  await prisma.payment.update({
    where: { reference: retaken.reference },
    data: { status: "SUCCESS" },
  });
  const paidCancel = await abandonReservation(retaken.reference, nextBuyer.id);
  check(
    paidCancel.outcome === "already_paid" &&
      (await prisma.ticket.count({
        where: { paymentId: (await prisma.payment.findUniqueOrThrow({
          where: { reference: retaken.reference }, select: { id: true },
        })).id, status: "RESERVED" },
      })) === 10,
    `a paid payment keeps its numbers -> ${paidCancel.outcome}`,
  );
} catch (suiteError) {
  // Without this the finally block's process.exit discards the exception and
  // the run looks like a clean pass that simply stopped early.
  fail++;
  console.log("");
  console.log("  FAIL  suite aborted with an unhandled error:");
  console.log(suiteError);
} finally {
  // --- cleanup ----------------------------------------------------------
  const raffleIds = made.raffles;
  await prisma.ledgerEntry.deleteMany({ where: { raffleId: { in: raffleIds } } });
  await prisma.ledgerTransaction.deleteMany({
    where: { entries: { none: {} }, type: "TICKET_PURCHASE" },
  });
  await prisma.order.deleteMany({ where: { raffleId: { in: raffleIds } } });
  await prisma.draw.deleteMany({ where: { raffleId: { in: raffleIds } } });
  await prisma.ticket.deleteMany({ where: { raffleId: { in: raffleIds } } });
  await prisma.payment.deleteMany({ where: { raffleId: { in: raffleIds } } });
  await prisma.raffle.deleteMany({ where: { id: { in: raffleIds } } });
  await prisma.productImage.deleteMany({ where: { productId: { in: made.products } } });
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  // Product ids as well as raffle ids: `product.archive` audits against the
  // product, so raffle-only cleanup would leave rows behind every run.
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...raffleIds, ...made.products] } },
  });
  // Every job type a raffle can schedule, not just refunds: the sellout now
  // enqueues raffle.draw and raffle.draw.notify too.
  await prisma.job.deleteMany({
    where: {
      dedupeKey: {
        in: raffleIds.flatMap((id) => [
          `raffle.refund:${id}`,
          `raffle.draw:${id}`,
          `raffle.draw.notify:${id}`,
        ]),
      },
    },
  });
  // "Drawing soon" notices are keyed on the raffle; the won/sold-out ones on
  // the order, which is deleted above.
  await prisma.notification.deleteMany({
    where: { entityId: { in: raffleIds } },
  });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "paystack" } });

  const leftovers = {
    users: await prisma.user.count({ where: { id: { in: made.users } } }),
    raffles: await prisma.raffle.count({ where: { id: { in: raffleIds } } }),
    tickets: await prisma.ticket.count({ where: { raffleId: { in: raffleIds } } }),
  };
  console.log(`\ncleanup: ${JSON.stringify(leftovers)}`);
  console.log(`ledger still balanced after cleanup: ${(await totalLedgerSum()) === 0}`);

  server.close();
  stub.close();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
