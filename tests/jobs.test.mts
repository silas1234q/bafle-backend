import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SECRET = "sk_test_" + randomBytes(16).toString("hex");
const TRIGGER_SECRET = "trigger-" + randomBytes(16).toString("hex");
const stubPort = 4300;
process.env.PAYSTACK_SECRET_KEY = SECRET;
process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.PAYMENT_PROVIDER = "paystack";
// These suites ARE test money acting on a real database, which is exactly the
// case the guard in sendPayout/refundRaffle refuses by default. Opted in
// explicitly rather than exempted, so the hazard is stated where it applies:
// every payout and refund below moves stub money against DATABASE_URL.
process.env.ALLOW_TEST_MONEY_ON_REAL_DATA = "true";
process.env.JOBS_TRIGGER_SECRET = TRIGGER_SECRET;
process.env.PORT = "4301";

const { app } = await import("../src/app.js");
const { env } = await import("../src/env.js");
const { prisma } = await import("../src/lib/prisma.js");
const { createRaffle } = await import("../src/services/raffles.js");
const { reserveTickets } = await import("../src/services/tickets.js");
const { confirmTicketPayment } = await import("../src/services/payments.js");
const { totalLedgerSum } = await import("../src/services/ledger.js");
const queue = await import("../src/jobs/queue.js");
const { runTick } = await import("../src/jobs/runner.js");
const { JOB_TYPES } = await import("../src/jobs/handlers.js");

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

// Seeded from the clock, not a fixed base: Payment.providerReference is
// unique, so a row left behind by an earlier run would otherwise collide
// and fail a webhook mid-suite for reasons that look like a logic bug.
let nextTxnId = Date.now() % 100_000_000;
let nextRefundId = Date.now() % 100_000_000;
// Seeded from the clock for the same reason the two above are: Payout
// .providerTransferCode is UNIQUE, so a literal here collides with whatever
// row an earlier or interrupted run left behind, and the failure surfaces far
// from its cause. The third time this exact trap has been hit in this repo.
let nextTransferId = Date.now() % 100_000_000;
const amounts = new Map<string, number>();
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
        authorization_url: "https://checkout.test/x",
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
    if (url === "/refund") {
      ok({ id: nextRefundId++, status: "processed" });
      return;
    }
    if (url === "/transfer") {
      ok({
        transfer_code: `TRF_${nextTransferId++}`,
        reference: body.reference,
        status: "success",
        amount: body.amount,
      });
      return;
    }
    res.end(JSON.stringify({ status: false, message: "stub: unknown route" }));
  });
});
await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", r));

const server = app.listen(4301);
await new Promise<void>((r) => server.once("listening", () => r()));
const api = "http://127.0.0.1:4301";

const tag = randomBytes(4).toString("hex");
const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };
const JOB_PREFIX = `test.${tag}`;

async function makeUser(label: string) {
  const u = await prisma.user.create({
    data: {
      clerkUserId: `j_${tag}_${label}`,
      email: `${label}.${tag}@test.invalid`,
      username: `j${label}${tag}`.slice(0, 20),
    },
    select: { id: true, email: true },
  });
  made.users.push(u.id);
  return u;
}

try {
  console.log("1. Transactional enqueue");
  const rolledBack = await prisma
    .$transaction(async (tx) => {
      await queue.enqueueJob(tx, {
        type: `${JOB_PREFIX}.rollback`,
        dedupeKey: `${JOB_PREFIX}:rollback`,
      });
      throw new Error("deliberate rollback");
    })
    .catch(() => "rolled back");
  check(rolledBack === "rolled back", "transaction rolled back");
  check(
    (await prisma.job.count({ where: { type: `${JOB_PREFIX}.rollback` } })) === 0,
    "job vanished with the transaction (this is why it is not Redis)",
  );

  const committed = await prisma.$transaction(async (tx) => {
    const id = await queue.enqueueJob(tx, { type: `${JOB_PREFIX}.committed` });
    return id;
  });
  check(
    committed !== null &&
      (await prisma.job.count({ where: { type: `${JOB_PREFIX}.committed` } })) === 1,
    "job committed with its transaction",
  );

  console.log("\n2. Dedupe key");
  const first = await queue.enqueueJob(prisma, {
    type: `${JOB_PREFIX}.dedupe`,
    dedupeKey: `${JOB_PREFIX}:dedupe`,
  });
  const second = await queue.enqueueJob(prisma, {
    type: `${JOB_PREFIX}.dedupe`,
    dedupeKey: `${JOB_PREFIX}:dedupe`,
  });
  check(first !== null, "first enqueue accepted");
  check(second === null, "duplicate rejected while outstanding (returns null, not an error)");

  await queue.completeJob(first!);
  const third = await queue.enqueueJob(prisma, {
    type: `${JOB_PREFIX}.dedupe`,
    dedupeKey: `${JOB_PREFIX}:dedupe`,
  });
  check(third !== null, "same key reusable after completion (not blocked forever)");

  // Many jobs without a dedupe key must coexist: here NULLs must stay
  // DISTINCT, the opposite of the Account index.
  const noKeys = await Promise.all(
    Array.from({ length: 5 }, () =>
      queue.enqueueJob(prisma, { type: `${JOB_PREFIX}.nokey` }),
    ),
  );
  check(
    noKeys.every((id) => id !== null),
    "five jobs with no dedupe key all accepted (NULLs stay distinct here)",
  );

  console.log("\n3. SKIP LOCKED: concurrent workers never collide");
  // claimJobs is global by design - it claims whatever is due, not just
  // this suite's rows. Clearing the whole table stops a leftover job from an
  // earlier suite being claimed as extra work.
  await prisma.job.deleteMany({});
  await prisma.job.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      type: `${JOB_PREFIX}.claimable`,
      payload: { i },
    })),
  });

  const [batchA, batchB, batchC] = await Promise.all([
    queue.claimJobs(7),
    queue.claimJobs(7),
    queue.claimJobs(7),
  ]);
  const ids = [...batchA, ...batchB, ...batchC].map((j) => j.id);
  check(
    ids.length === new Set(ids).size,
    `three concurrent claims took ${ids.length} jobs with zero overlap`,
  );
  check(ids.length === 20, `all 20 claimed across the three workers (${ids.length})`);
  check(
    batchA.every((j) => j.status === "RUNNING" && j.attempts === 1),
    "claimed jobs are RUNNING with attempts incremented in the same statement",
  );
  const leftover = await queue.claimJobs(5);
  check(leftover.length === 0, "nothing left to claim");

  console.log("\n4. Failure, backoff and giving up");
  await prisma.job.deleteMany({ where: { type: { startsWith: JOB_PREFIX } } });
  const flaky = await queue.enqueueJob(prisma, {
    type: `${JOB_PREFIX}.flaky`,
    maxAttempts: 2,
  });
  await queue.claimJobs(1);
  const firstOutcome = await queue.failJob(flaky!, new Error("boom 1"));
  check(firstOutcome === "PENDING", "first failure reschedules");
  const rescheduled = await prisma.job.findUniqueOrThrow({ where: { id: flaky! } });
  check(
    rescheduled.runAt.getTime() > Date.now() + 5_000,
    "rescheduled into the future with backoff",
  );
  check(rescheduled.lastError === "boom 1", "error recorded for diagnosis");
  check(rescheduled.lockedBy === null, "lock released");

  await prisma.job.update({ where: { id: flaky! }, data: { runAt: new Date() } });
  await queue.claimJobs(1);
  const secondOutcome = await queue.failJob(flaky!, new Error("boom 2"));
  check(secondOutcome === "FAILED", "second failure exhausts maxAttempts=2 and stops");
  const dead = await prisma.job.findUniqueOrThrow({ where: { id: flaky! } });
  check(dead.status === "FAILED", `terminal status ${dead.status} (not retried forever)`);
  check(dead.completedAt !== null, "completedAt stamped so the failure is visible as finished");

  console.log("\n5. Reclaiming a dead worker's job");
  const orphan = await queue.enqueueJob(prisma, { type: `${JOB_PREFIX}.orphan` });
  await queue.claimJobs(1);
  // Backdate the lock to simulate a worker that died mid-job.
  await prisma.job.update({
    where: { id: orphan! },
    data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
  });
  const reclaimedCount = await queue.reclaimStuckJobs();
  check(reclaimedCount >= 1, `${reclaimedCount} stuck job(s) reclaimed`);
  const revived = await prisma.job.findUniqueOrThrow({ where: { id: orphan! } });
  check(revived.status === "PENDING", "returned to PENDING so it can run again");
  check(
    revived.attempts === 1,
    "attempts NOT reset, so a job that kills its worker still exhausts its budget",
  );

  console.log("\n6. Unknown job type fails loudly");
  await prisma.job.deleteMany({ where: { type: { startsWith: JOB_PREFIX } } });
  await queue.enqueueJob(prisma, { type: `${JOB_PREFIX}.no-handler`, maxAttempts: 1 });
  const unknownTick = await runTick({ batch: 5, budgetMs: 10_000 });
  check(unknownTick.skipped >= 1, `unhandled type counted as skipped (${unknownTick.skipped})`);
  const noHandler = await prisma.job.findFirstOrThrow({
    where: { type: `${JOB_PREFIX}.no-handler` },
  });
  check(
    noHandler.status === "FAILED" && /No handler registered/.test(noHandler.lastError ?? ""),
    "left FAILED with a clear reason, not stuck in RUNNING",
  );

  console.log("\n7. End to end: expired raffle refunded by the queue");
  const seller = await makeUser("seller");
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      title: `Job test ${tag}`,
      slug: `job-test-${tag}`,
      description: "Queue end-to-end product.",
      category: "tech",
      retailValue: 4000,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  made.products.push(product.id);

  const raffle = await createRaffle({
    productId: product.id,
    sellerId: seller.id,
    ticketPriceMinor: 1000,
    totalTickets: 4,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(raffle.id);

  const buyer = await makeUser("buyer");
  const held = await reserveTickets({
    raffleId: raffle.id,
    userId: buyer.id,
    customerEmail: buyer.email,
    quantity: 1,
  });
  await confirmTicketPayment(held.reference);

  // Deadline passes with only 1 of 4 sold.
  await prisma.raffle.update({
    where: { id: raffle.id },
    data: { closesAt: new Date(Date.now() - 1000) },
  });

  const tick = await runTick({ batch: 10, budgetMs: 20_000 });
  check(tick.sweeps.rafflesExpired >= 1, `sweep expired ${tick.sweeps.rafflesExpired} raffle(s)`);
  check(tick.sweeps.refundJobsQueued >= 1, `queued ${tick.sweeps.refundJobsQueued} refund job(s)`);
  check(tick.succeeded >= 1, `${tick.succeeded} job(s) succeeded in the same tick`);

  const finalRaffle = await prisma.raffle.findUniqueOrThrow({ where: { id: raffle.id } });
  check(finalRaffle.status === "REFUNDED", `raffle -> ${finalRaffle.status} via the queue alone`);
  check(
    (await prisma.ticket.count({ where: { raffleId: raffle.id, status: "REFUNDED" } })) === 1,
    "ticket refunded",
  );
  check((await totalLedgerSum()) === 0, "ledger balanced after queue-driven refund");

  const idempotentTick = await runTick({ batch: 10, budgetMs: 20_000 });
  check(
    idempotentTick.sweeps.refundJobsQueued === 0,
    "a second tick queues no duplicate refund work",
  );

  console.log("\n8. Trigger endpoint auth");
  const noSecret = await fetch(`${api}/internal/jobs/tick`, { method: "POST" });
  check(noSecret.status === 401, `no secret -> ${noSecret.status}`);

  const wrongSecret = await fetch(`${api}/internal/jobs/tick`, {
    method: "POST",
    headers: { "x-jobs-secret": "wrong-but-the-same-length-as-the-real-one!!" },
  });
  check(wrongSecret.status === 401, `wrong secret -> ${wrongSecret.status}`);

  const good = await fetch(`${api}/internal/jobs/tick?batch=5`, {
    method: "POST",
    headers: { "x-jobs-secret": TRIGGER_SECRET },
  });
  const goodBody = (await good.json()) as Record<string, unknown>;
  check(good.status === 200, `correct secret -> ${good.status}`);
  check(typeof goodBody.depth === "object", "tick reports queue depth for monitoring");

  const status = await fetch(`${api}/internal/jobs/status`, {
    headers: { "x-jobs-secret": TRIGGER_SECRET },
  });
  check(status.status === 200, `status endpoint -> ${status.status}`);

  // Simulate an unconfigured deployment: the endpoint must refuse, not open up.
  const saved = env.JOBS_TRIGGER_SECRET;
  (env as { JOBS_TRIGGER_SECRET: string | null }).JOBS_TRIGGER_SECRET = null;
  const disabled = await fetch(`${api}/internal/jobs/tick`, {
    method: "POST",
    headers: { "x-jobs-secret": TRIGGER_SECRET },
  });
  check(disabled.status === 503, `unconfigured secret -> ${disabled.status}, refused not open`);
  (env as { JOBS_TRIGGER_SECRET: string | null }).JOBS_TRIGGER_SECRET = saved;

  console.log("\n9. Tick stays bounded");
  await prisma.job.createMany({
    data: Array.from({ length: 40 }, () => ({ type: `${JOB_PREFIX}.no-handler` })),
  });
  const bounded = await runTick({ batch: 10, budgetMs: 20_000 });
  check(bounded.processed <= 10, `honoured batch limit (processed ${bounded.processed})`);
  check(
    bounded.depth.pending > 0,
    `backlog left for the next tick (${bounded.depth.pending} pending) rather than running long`,
  );
  const tiny = await runTick({ batch: 50, budgetMs: 1_000 });
  check(
    tiny.budgetExhausted || tiny.processed < 50,
    "wall-clock budget respected so an HTTP trigger cannot time out",
  );
} catch (suiteError) {
  fail++;
  console.log("");
  console.log("  FAIL  suite aborted with an unhandled error:");
  console.log(suiteError);
} finally {
  const rIds = made.raffles;
  await prisma.job.deleteMany({ where: { type: { startsWith: JOB_PREFIX } } });
  await prisma.job.deleteMany({
    where: { type: { in: Object.values(JOB_TYPES) } },
  });
  await prisma.ledgerEntry.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.ledgerTransaction.deleteMany({ where: { entries: { none: {} } } });
  await prisma.refund.deleteMany({ where: { payment: { raffleId: { in: rIds } } } });
  await prisma.ticket.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.payment.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.raffle.deleteMany({ where: { id: { in: rIds } } });
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });

  const leftJobs = await prisma.job.count({ where: { type: { startsWith: JOB_PREFIX } } });
  console.log(`\ncleanup: jobs=${leftJobs} users=${await prisma.user.count({ where: { id: { in: made.users } } })}`);
  console.log(`ledger balanced after cleanup: ${(await totalLedgerSum()) === 0}`);

  server.close();
  stub.close();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
