import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const SECRET = "sk_test_" + randomBytes(16).toString("hex");
const stubPort = 4500;
process.env.PAYSTACK_SECRET_KEY = SECRET;
process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.PAYMENT_PROVIDER = "paystack";
// These suites ARE test money acting on a real database, which is exactly the
// case the guard in sendPayout/refundRaffle refuses by default. Opted in
// explicitly rather than exempted, so the hazard is stated where it applies:
// every payout and refund below moves stub money against DATABASE_URL.
process.env.ALLOW_TEST_MONEY_ON_REAL_DATA = "true";
process.env.JOBS_TRIGGER_SECRET = randomBytes(16).toString("hex");
process.env.EMAIL_PROVIDER = "console";
process.env.APP_URL = "https://bafle.test";
process.env.CLOUDINARY_CLOUD_NAME = "bafle-test-cloud";
process.env.CLOUDINARY_API_KEY = "123456789012345";
process.env.CLOUDINARY_API_SECRET = "cloudinary-test-secret";
process.env.PORT = "4501";

const { prisma } = await import("../src/lib/prisma.js");
const { createRaffle } = await import("../src/services/raffles.js");
const { reserveTickets } = await import("../src/services/tickets.js");
const { confirmTicketPayment } = await import("../src/services/payments.js");
const { executeDraw } = await import("../src/services/draw.js");
const orders = await import("../src/services/orders.js");
const notifications = await import("../src/services/notifications.js");
const { runTick } = await import("../src/jobs/runner.js");
const emails = await import("../src/notifications/index.js");
const { NOTIFICATION_TYPES, renderNotification } = await import(
  "../src/notifications/templates.js"
);
const cloudinary = await import("../src/images/cloudinary.js");
const { BrevoProvider } = await import("../src/notifications/brevo.js");
const { SmtpProvider } = await import("../src/notifications/smtp.js");

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
      ok({ authorization_url: "https://c.test/x", access_code: `acc_${String(body.reference)}`, reference: body.reference });
      return;
    }
    if (url.startsWith("/transaction/verify/")) {
      const reference = decodeURIComponent(url.split("/").pop() ?? "");
      const amount = amounts.get(reference) ?? 0;
      ok({ id: nextTxnId++, status: "success", reference, amount, currency: "GHS", channel: "mobile_money", paid_at: new Date().toISOString(), gateway_response: "Successful", fees: Math.round(amount * 0.0195) });
      return;
    }
    res.end(JSON.stringify({ status: false, message: "stub: unknown route" }));
  });
});
await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", r));

/** Captures sends instead of delivering, so assertions see real content. */
const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
emails.setEmailProviderForTesting({
  name: "console",
  delivers: true,
  send: (message) => {
    sent.push({ to: message.to, subject: message.subject, text: message.text, html: message.html });
    return Promise.resolve({ providerMessageId: "test-" + sent.length });
  },
});

const tag = randomBytes(4).toString("hex");
const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };

async function makeUser(label: string) {
  const u = await prisma.user.create({
    data: {
      clerkUserId: `n_${tag}_${label}`,
      email: `${label}.${tag}@test.invalid`,
      username: `n${label}${tag}`.slice(0, 20),
    },
    select: { id: true, email: true },
  });
  made.users.push(u.id);
  return u;
}

try {
  console.log("1. Cloudinary signature");
  const signature = cloudinary.createUploadSignature("user-123");
  check(signature.cloudName === "bafle-test-cloud", `cloud name -> ${signature.cloudName}`);
  check(signature.uploadUrl.includes("/bafle-test-cloud/image/upload"), "upload URL targets our cloud");
  check(!JSON.stringify(signature).includes("cloudinary-test-secret"), "api secret never leaves the server");

  // Recompute the signature the way Cloudinary does, to prove it is correct
  // rather than merely present.
  const toSign = Object.keys(signature.signedParams)
    .sort()
    .map((k) => `${k}=${String(signature.signedParams[k])}`)
    .join("&");
  const expected = createHash("sha1").update(`${toSign}cloudinary-test-secret`).digest("hex");
  check(signature.signature === expected, "signature matches Cloudinary's documented scheme");
  check(
    String(signature.signedParams.context) === "uploader=user-123",
    `uploader pinned into the signed params -> ${String(signature.signedParams.context)}`,
  );
  check(
    Object.keys(signature.signedParams).includes("folder"),
    "folder is signed, so a client cannot upload outside it",
  );

  console.log("\n2. Image URL validation (the half that matters)");
  const good = "https://res.cloudinary.com/bafle-test-cloud/image/upload/v1/bafle/products/abc.jpg";
  check(cloudinary.isOwnCloudinaryUrl(good), "our own upload accepted");
  const rejections: Array<[string, string]> = [
    ["http (not https)", good.replace("https:", "http:")],
    ["another cloudinary account", good.replace("bafle-test-cloud", "someone-else")],
    ["lookalike host suffix", good.replace("res.cloudinary.com", "res.cloudinary.com.evil.test")],
    ["arbitrary host", "https://evil.test/bafle/products/abc.jpg"],
    ["outside our folder", good.replace("/bafle/products/", "/other/")],
    ["not an image", good.replace(".jpg", ".svg")],
    ["query string appended", `${good}?x=1`],
    ["not a URL at all", "javascript:alert(1)"],
    ["empty", ""],
  ];
  for (const [label, url] of rejections) {
    check(!cloudinary.isOwnCloudinaryUrl(url), `rejected: ${label}`);
  }

  console.log("\n3. Templates render");
  for (const type of Object.values(NOTIFICATION_TYPES)) {
    const rendered = renderNotification(type, {
      productTitle: "Test Phone",
      orderId: "order-1",
      amountMinor: 190000,
      ticketNumber: 7,
      appUrl: "https://bafle.test",
    });
    check(
      rendered !== null && rendered.subject.length > 0 && rendered.text.length > 0 && rendered.html.length > 0,
      `${type} renders subject + text + html`,
    );
  }
  const won = renderNotification(NOTIFICATION_TYPES.RAFFLE_WON, {
    productTitle: "Test Phone",
    orderId: "order-1",
    ticketNumber: 7,
    appUrl: "https://bafle.test",
  })!;
  check(won.text.includes("https://bafle.test/orders/order-1"), "links use APP_URL, not localhost");
  check(
    /do not share it before you have the item/.test(won.text),
    "winner email warns against sharing the code early",
  );

  const escaped = renderNotification(NOTIFICATION_TYPES.RAFFLE_WON, {
    productTitle: '<img src=x onerror="alert(1)">',
    orderId: "o",
    appUrl: "https://bafle.test",
  })!;
  check(
    !escaped.html.includes("<img src=x"),
    "a product title cannot inject HTML into the email body",
  );

  console.log("\n4. Winning a raffle notifies the winner and the seller");
  const seller = await makeUser("seller");
  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      title: `Notify ${tag}`,
      slug: `notify-${tag}`,
      description: "Notification suite product.",
      category: "tech",
      retailValue: 2000,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  made.products.push(product.id);

  const raffle = await createRaffle({
    productId: product.id,
    sellerId: seller.id,
    ticketPriceMinor: 1000,
    totalTickets: 2,
    closesAt: new Date(Date.now() + 86_400_000),
  });
  made.raffles.push(raffle.id);

  for (const label of ["b1", "b2"]) {
    const buyer = await makeUser(label);
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
  const queued = await prisma.notification.findMany({
    where: { entityId: order.id },
    select: { type: true, recipientUserId: true, status: true },
  });
  check(queued.length === 2, `${queued.length} notifications queued by the draw`);
  check(
    queued.some((n) => n.type === NOTIFICATION_TYPES.RAFFLE_WON && n.recipientUserId === order.winnerUserId),
    "winner queued for raffle.won",
  );
  check(
    queued.some((n) => n.type === NOTIFICATION_TYPES.RAFFLE_DRAWN_SELLER && n.recipientUserId === seller.id),
    "seller queued for raffle.drawn.seller",
  );
  check(queued.every((n) => n.status === "PENDING"), "queued, not yet sent");

  console.log("\n5. The job runner delivers them");
  sent.length = 0;
  const tick = await runTick({ batch: 20, budgetMs: 20_000 });
  check(tick.succeeded >= 2, `${tick.succeeded} job(s) succeeded`);
  check(sent.length >= 2, `${sent.length} email(s) actually sent`);
  const winnerRow = await prisma.user.findUniqueOrThrow({ where: { id: order.winnerUserId } });
  check(
    sent.some((e) => e.to === winnerRow.email && /You won/.test(e.subject)),
    `winner received "You won" at ${winnerRow.email}`,
  );
  check(
    sent.some((e) => e.to === seller.email && /Sold out/.test(e.subject)),
    "seller received the sold-out notice",
  );
  const afterSend = await prisma.notification.findMany({ where: { entityId: order.id } });
  check(afterSend.every((n) => n.status === "SENT" && n.sentAt !== null), "all marked SENT");

  console.log("\n6. Nobody is emailed twice");
  sent.length = 0;
  const secondTick = await runTick({ batch: 20, budgetMs: 20_000 });
  check(sent.length === 0, `second tick sent ${sent.length} emails`);

  // Re-running the draw (idempotent) must not re-queue either.
  await executeDraw(raffle.id);
  check(
    (await prisma.notification.count({ where: { entityId: order.id } })) === 2,
    "re-running the draw queues no duplicates",
  );

  const requeued = await notifications.queueNotification(prisma, {
    type: NOTIFICATION_TYPES.RAFFLE_WON,
    recipientUserId: order.winnerUserId,
    entityType: "Order",
    entityId: order.id,
  });
  check(
    requeued === null,
    "queueNotification refuses an already-recorded send (permanent dedupe, unlike Job.dedupeKey)",
  );
  check(secondTick.failed === 0, "no failures on the quiet tick");

  console.log("\n7. Address entry tells the seller to ship");
  const address = await prisma.address.create({
    data: {
      userId: order.winnerUserId,
      recipientName: "W",
      phone: "+233200000000",
      line1: "1 Road",
      city: "Accra",
      region: "Greater Accra",
    },
    select: { id: true },
  });
  sent.length = 0;
  await orders.setOrderAddress(order.id, order.winnerUserId, address.id);
  await runTick({ batch: 20, budgetMs: 20_000 });
  check(
    sent.some((e) => e.to === seller.email && /ship/i.test(e.subject)),
    `seller told to ship (${sent.map((e) => e.subject).join(" | ")})`,
  );

  console.log("\n8. Anonymised recipients are skipped, not bounced");
  const ghost = await makeUser("ghost");
  await prisma.user.update({
    where: { id: ghost.id },
    data: { email: `deleted+${ghost.id}@deleted.invalid` },
  });
  const ghostNotification = await notifications.queueNotification(prisma, {
    type: NOTIFICATION_TYPES.PAYOUT_PAID,
    recipientUserId: ghost.id,
    entityType: "Payout",
    entityId: `ghost-${tag}`,
    payload: { amountMinor: 100 },
  });
  sent.length = 0;
  const ghostResult = await notifications.sendNotification(ghostNotification!);
  check(ghostResult.status === "skipped", `deleted recipient -> ${ghostResult.status}`);
  check(sent.length === 0, "no email attempted to a @deleted.invalid address");

  console.log("\n9. Brevo driver maps errors correctly");
  const brevoStub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const asked = JSON.parse(raw) as { subject?: string };
      if (asked.subject === "retryable") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "temporarily unavailable" }));
        return;
      }
      if (asked.subject === "permanent") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Invalid sender" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ messageId: "<brevo-123>" }));
    });
  });
  await new Promise<void>((r) => brevoStub.listen(4502, "127.0.0.1", r));

  const brevo = new BrevoProvider({
    apiKey: "test-key",
    fromEmail: "from@test.invalid",
    baseUrl: "http://127.0.0.1:4502",
  });
  const okSend = await brevo.send({
    to: "x@test.invalid",
    subject: "fine",
    text: "t",
    html: "<p>t</p>",
  });
  check(okSend.providerMessageId === "<brevo-123>", `message id captured -> ${okSend.providerMessageId}`);

  for (const [label, subject, retryable] of [
    ["503", "retryable", true],
    ["400", "permanent", false],
  ] as Array<[string, string, boolean]>) {
    try {
      await brevo.send({ to: "x@test.invalid", subject, text: "t", html: "t" });
      check(false, `${label} should have thrown`);
    } catch (e) {
      const err = e as { retryable?: boolean };
      check(
        err.retryable === retryable,
        `${label} -> retryable=${String(err.retryable)} (expected ${String(retryable)})`,
      );
    }
  }
  brevoStub.close();

  console.log("");
  console.log("10. SMTP driver maps errors correctly");
  // A fake transport rather than a real SMTP server: what is under test is the
  // retryable classification, which is what sendNotification rethrows on, not
  // the wire protocol. Getting it wrong either abandons a deliverable "you
  // won" email or retries an impossible one until the attempt cap.
  type SmtpFailure = {
    message: string;
    code?: string;
    responseCode?: number;
    permanent?: boolean;
    response?: string;
  };
  let nextFailure: SmtpFailure | null = null;
  const smtpSeen: Array<{ from: unknown; to: unknown }> = [];
  const fakeTransport = {
    sendMail(message: { from: unknown; to: unknown; subject: string }) {
      smtpSeen.push({ from: message.from, to: message.to });
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        return Promise.reject(Object.assign(new Error(failure.message), failure));
      }
      return Promise.resolve({ messageId: "<smtp-123>" });
    },
  };

  // fromEmail omitted on purpose: it must fall back to the authenticated user,
  // because Gmail will not send as an address it has not authenticated.
  const smtp = new SmtpProvider({
    user: "robot@gmail.invalid",
    pass: "app-password",
    transport: fakeTransport,
  });

  const smtpOk = await smtp.send({
    to: "winner@test.invalid",
    toName: "winner",
    subject: "fine",
    text: "t",
    html: "<p>t</p>",
  });
  check(
    smtpOk.providerMessageId === "<smtp-123>",
    `message id captured -> ${smtpOk.providerMessageId}`,
  );
  const envelope = smtpSeen[0];
  const envelopeFrom = envelope?.from as { name?: string; address?: string } | undefined;
  check(
    envelopeFrom?.address === "robot@gmail.invalid",
    `EMAIL_FROM unset falls back to SMTP_USER -> ${String(envelopeFrom?.address)}`,
  );
  const envelopeTo = envelope?.to as { name?: string; address?: string } | undefined;
  check(
    envelopeTo?.name === "winner" && envelopeTo?.address === "winner@test.invalid",
    "recipient username is carried into the envelope",
  );

  const smtpNamedSender = new SmtpProvider({
    user: "robot@gmail.invalid",
    pass: "app-password",
    fromEmail: "hello@bafle.test",
    transport: fakeTransport,
  });
  await smtpNamedSender.send({ to: "x@test.invalid", subject: "s", text: "t", html: "t" });
  check(
    (smtpSeen[1]?.from as { address?: string } | undefined)?.address === "hello@bafle.test",
    "an explicit EMAIL_FROM overrides the fallback",
  );

  for (const [label, failure, retryable] of [
    // Nodemailer sets `permanent` from the SMTP reply class whenever the server
    // answered. It is trusted over a bare 4xx/5xx split because it already
    // knows 503 is transient despite being a 5xx.
    ["4xx reply", { message: "try later", responseCode: 450, permanent: false }, true],
    ["5xx reply", { message: "no such user", responseCode: 550, permanent: true }, false],
    // The expensive one: a wrong App Password looks like a flaky network, and
    // retrying it buries a one-line config fix under attempt counts.
    ["EAUTH", { message: "auth failed", code: "EAUTH" }, false],
    ["EENVELOPE", { message: "bad address", code: "EENVELOPE" }, false],
    ["ECONNECTION", { message: "connection closed", code: "ECONNECTION" }, true],
    ["ETIMEDOUT", { message: "timed out", code: "ETIMEDOUT" }, true],
    // No code at all: assume the network, same as the Brevo driver does.
    ["bare error", { message: "something broke" }, true],
  ] as Array<[string, SmtpFailure, boolean]>) {
    nextFailure = failure;
    try {
      await smtp.send({ to: "x@test.invalid", subject: "s", text: "t", html: "t" });
      check(false, `${label} should have thrown`);
    } catch (e) {
      const err = e as { retryable?: boolean; status?: number | null; provider?: string };
      check(
        err.retryable === retryable && err.provider === "smtp",
        `${label} -> retryable=${String(err.retryable)} (expected ${String(retryable)})`,
      );
      if (failure.responseCode) {
        check(
          err.status === failure.responseCode,
          `${label} -> SMTP code carried as status=${String(err.status)}`,
        );
      }
    }
  }
} catch (suiteError) {
  fail++;
  console.log("");
  console.log("  FAIL  suite aborted with an unhandled error:");
  console.log(suiteError);
} finally {
  const rIds = made.raffles;
  // Scoped to this suite's own notifications. An unscoped
  // `type: { startsWith: "notification." }` delete reaches every queued send in
  // the database, including real ones a human parked on purpose — which is how
  // a real notification.send job was destroyed on 2026-11-12. The Notification
  // row survives such a delete, but nothing will ever pick it up again.
  const suiteNotificationIds = (
    await prisma.notification.findMany({
      where: { recipientUserId: { in: made.users } },
      select: { id: true },
    })
  ).map((n) => n.id);
  const suiteNotificationIdSet = new Set(suiteNotificationIds);
  const strayJobs = await prisma.job.findMany({
    where: { type: { startsWith: "notification." } },
    select: { id: true, payload: true },
  });
  const suiteJobIds = strayJobs
    .filter((job) => {
      const payload = job.payload as { notificationId?: unknown } | null;
      return (
        typeof payload?.notificationId === "string" &&
        suiteNotificationIdSet.has(payload.notificationId)
      );
    })
    .map((job) => job.id);
  await prisma.job.deleteMany({ where: { id: { in: suiteJobIds } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: made.users } } });
  await prisma.ledgerEntry.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.ledgerTransaction.deleteMany({ where: { entries: { none: {} } } });
  const orderIds = (
    await prisma.order.findMany({ where: { raffleId: { in: rIds } }, select: { id: true } })
  ).map((o) => o.id);
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...rIds, ...orderIds] } } });
  await prisma.order.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.draw.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.ticket.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.payment.deleteMany({ where: { raffleId: { in: rIds } } });
  await prisma.raffle.deleteMany({ where: { id: { in: rIds } } });
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  await prisma.address.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });

  console.log(
    `\ncleanup: users=${await prisma.user.count({ where: { id: { in: made.users } } })} ` +
      `notifications=${await prisma.notification.count({ where: { recipientUserId: { in: made.users } } })}`,
  );

  stub.close();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
