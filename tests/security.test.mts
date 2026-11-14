import { randomBytes } from "node:crypto";

import express from "express";

process.env.PAYSTACK_SECRET_KEY = "sk_test_" + randomBytes(16).toString("hex");
process.env.PAYMENT_PROVIDER = "paystack";
process.env.JOBS_TRIGGER_SECRET = randomBytes(16).toString("hex");
process.env.PORT = "4401";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");
const limiters = await import("../src/middleware/rateLimit.js");

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

const server = app.listen(4401);
await new Promise<void>((r) => server.once("listening", () => r()));
const api = "http://127.0.0.1:4401";

const tag = randomBytes(4).toString("hex");
const made = { users: [] as string[], products: [] as string[], raffles: [] as string[] };

/** Anything that must never appear in a response to someone else. */
const SENSITIVE_KEYS = [
  "email",
  "phone",
  "passwordHash",
  "clerkUserId",
  "deliveryOtpHash",
  "suspendedReason",
  "moderationNotes",
];

function findSensitive(value: unknown, path = "$"): string[] {
  const hits: string[] = [];

  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findSensitive(item, `${path}[${i}]`)));
    return hits;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEYS.includes(key) && child !== null && child !== undefined) {
        hits.push(`${path}.${key}`);
      }
      hits.push(...findSensitive(child, `${path}.${key}`));
    }
  }
  return hits;
}

try {
  console.log("1. Security headers");
  const head = await fetch(`${api}/health`);
  const h = (name: string) => head.headers.get(name);
  check(h("x-content-type-options") === "nosniff", `x-content-type-options -> ${h("x-content-type-options")}`);
  check(h("x-frame-options") !== null, `x-frame-options -> ${h("x-frame-options")}`);
  check(h("strict-transport-security") !== null, "strict-transport-security present");
  check(
    h("x-powered-by") === null,
    "x-powered-by removed (does not advertise Express version)",
  );

  console.log("\n2. Request body limits");
  const huge = JSON.stringify({ description: "x".repeat(200_000) });
  const tooBig = await fetch(`${api}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  });
  check(tooBig.status === 413, `200KB body -> ${tooBig.status} (not 500, not accepted)`);
  const bigBody = (await tooBig.json()) as Record<string, unknown>;
  check(bigBody.error === "Request body too large", `message -> ${String(bigBody.error)}`);

  const malformed = await fetch(`${api}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not valid json",
  });
  check(malformed.status === 400, `malformed JSON -> ${malformed.status} (client error, not 500)`);

  console.log("\n3. Rate limiters actually trigger");
  // Mounted on a bare app so the limits can be exercised without Clerk
  // sessions. Same middleware instances the real routes use.
  const probe = express();
  probe.set("trust proxy", 1);
  probe.post("/purchase", limiters.purchaseLimiter, (_q, res) => res.json({ ok: true }));
  probe.post("/content", limiters.contentLimiter, (_q, res) => res.json({ ok: true }));
  const probeServer = probe.listen(4402);
  await new Promise<void>((r) => probeServer.once("listening", () => r()));

  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) {
    const r = await fetch("http://127.0.0.1:4402/purchase", { method: "POST" });
    statuses.push(r.status);
  }
  const allowed = statuses.filter((s) => s === 200).length;
  const blocked = statuses.filter((s) => s === 429).length;
  check(allowed === 10, `purchase limiter allowed exactly 10 (${allowed})`);
  check(blocked === 4, `and blocked the remaining ${blocked} with 429`);

  const limited = await fetch("http://127.0.0.1:4402/purchase", { method: "POST" });
  const limitBody = (await limited.json()) as Record<string, unknown>;
  check(
    typeof limitBody.error === "string" && /ticket purchases/.test(limitBody.error),
    `429 carries a useful message -> ${String(limitBody.error)}`,
  );
  check(
    limited.headers.get("ratelimit") !== null ||
      limited.headers.get("ratelimit-remaining") !== null,
    "standard RateLimit headers emitted so clients can back off",
  );
  probeServer.close();

  console.log("\n4. Public endpoints leak nothing personal");
  const seller = await prisma.user.create({
    data: {
      clerkUserId: `sec_${tag}_seller`,
      email: `leaky.${tag}@test.invalid`,
      phone: `+23320${Date.now().toString().slice(-7)}`,
      username: `sec${tag}`.slice(0, 20),
      suspendedReason: null,
    },
    select: { id: true, email: true },
  });
  made.users.push(seller.id);

  const product = await prisma.product.create({
    data: {
      sellerId: seller.id,
      title: `Security probe ${tag}`,
      slug: `sec-${tag}`,
      description: "A product used to probe for data leaks.",
      category: "tech",
      retailValue: 5000,
      status: "ACTIVE",
      moderationNotes: "INTERNAL ONLY - should never be public",
    },
    select: { id: true },
  });
  made.products.push(product.id);

  const endpoints = [
    ["GET /users", `${api}/users`],
    ["GET /products", `${api}/products`],
    [`GET /products/:id`, `${api}/products/${product.id}`],
    ["GET /raffles", `${api}/raffles`],
  ] as const;

  for (const [label, url] of endpoints) {
    const response = await fetch(url);
    const body: unknown = await response.json();
    const leaks = findSensitive(body);
    check(leaks.length === 0, `${label} leaks nothing${leaks.length ? ` -> ${leaks.join(", ")}` : ""}`);
  }

  const productBody = (await (await fetch(`${api}/products/${product.id}`)).json()) as Record<
    string,
    unknown
  >;
  check(
    !("moderationNotes" in productBody),
    "moderation notes not exposed on the public product view",
  );
  check(
    !JSON.stringify(productBody).includes(seller.email),
    "seller email nowhere in the product payload",
  );

  console.log("\n5. Authentication is required where it should be");
  const protectedRoutes = [
    ["GET /me", `${api}/me`, "GET"],
    ["GET /orders", `${api}/orders`, "GET"],
    ["GET /tickets", `${api}/tickets`, "GET"],
    ["GET /addresses", `${api}/addresses`, "GET"],
    ["POST /products", `${api}/products`, "POST"],
    ["POST /raffles", `${api}/raffles`, "POST"],
    // Editing and withdrawing someone's listing. Ownership is checked in the
    // route, which no suite can reach without a Clerk session; what is
    // verifiable here is that an anonymous caller never gets that far.
    ["PATCH /products/:id", `${api}/products/${product.id}`, "PATCH"],
    ["DELETE /products/:id", `${api}/products/${product.id}`, "DELETE"],
    // Payout setup. The PUT mints a transfer recipient at the provider, so an
    // unauthenticated caller reaching it would be both a data leak and a way
    // to make us call Paystack for free.
    ["GET /sellers/payouts", `${api}/sellers/payouts`, "GET"],
    ["GET /sellers/banks", `${api}/sellers/banks?kind=mobile_money`, "GET"],
    ["PUT /sellers/payouts", `${api}/sellers/payouts`, "PUT"],
  ] as const;

  for (const [label, url, method] of protectedRoutes) {
    const response = await fetch(url, {
      method,
      ...(method === "POST" || method === "PATCH" || method === "PUT"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    check(response.status === 401, `${label} without a session -> ${response.status}`);
  }

  // The listing must still be there: a 401 that nonetheless archived the row
  // would be the worst possible outcome of this probe.
  check(
    (await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { status: true },
    })).status !== "ARCHIVED",
    "the rejected DELETE did not archive the listing",
  );

  const forged = await fetch(`${api}/me`, {
    headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrIn0.sig" },
  });
  check(forged.status === 401, `forged JWT -> ${forged.status}`);

  console.log("\n6. Unknown routes and methods");
  check((await fetch(`${api}/nope`)).status === 404, "unknown path -> 404");
  const wrongMethod = await fetch(`${api}/health`, { method: "DELETE" });
  check(wrongMethod.status === 404, `DELETE /health -> ${wrongMethod.status}`);

  console.log("\n7. Internal job trigger is not reachable without the secret");
  const noSecret = await fetch(`${api}/internal/jobs/tick`, { method: "POST" });
  check(noSecret.status === 401, `POST /internal/jobs/tick -> ${noSecret.status}`);
  const statusProbe = await fetch(`${api}/internal/jobs/status`);
  check(statusProbe.status === 401, `GET /internal/jobs/status -> ${statusProbe.status}`);

  console.log("\n8. Webhooks reject unsigned bodies");
  for (const path of ["clerk", "paystack"]) {
    const response = await fetch(`${api}/webhooks/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "user.created", data: { id: "x" } }),
    });
    check(response.status === 400, `POST /webhooks/${path} unsigned -> ${response.status}`);
  }
  check(
    (await prisma.webhookEvent.count({ where: { signatureValid: false } })) === 0,
    "no rows recorded for unsigned attempts (no junk-row DoS)",
  );

  console.log("\n9. Audit trail is private and carries no personal data");
  // Self-contained: asserting on rows other suites happen to leave behind
  // would make this pass or fail depending on run order.
  const probeAudit = await prisma.auditLog.create({
    data: {
      actorUserId: seller.id,
      action: `security.probe.${tag}`,
      entityType: "Product",
      entityId: product.id,
      metadata: { note: "probe" },
      ip: "203.0.113.1",
    },
    select: { id: true },
  });

  check(
    (await prisma.auditLog.count({ where: { id: probeAudit.id } })) === 1,
    "audit rows are written and queryable",
  );

  // There is deliberately no public audit endpoint. If one is ever added,
  // this turns red.
  for (const path of ["/audit", "/auditlog", "/audit-logs", "/logs"]) {
    const response = await fetch(`${api}${path}`);
    check(response.status === 404, `${path} is not exposed -> ${response.status}`);
  }

  // Audit metadata is hand-written throughout the services, so it is worth
  // checking none of it has started carrying identifiers it should not.
  const recentAudits = await prisma.auditLog.findMany({
    select: { action: true, metadata: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const auditLeaks = findSensitive(recentAudits.map((a) => a.metadata));
  check(
    auditLeaks.length === 0,
    `audit metadata carries nothing sensitive${auditLeaks.length ? ` -> ${auditLeaks.join(", ")}` : ""}`,
  );

  await prisma.auditLog.delete({ where: { id: probeAudit.id } });
} catch (suiteError) {
  fail++;
  console.log("");
  console.log("  FAIL  suite aborted with an unhandled error:");
  console.log(suiteError);
} finally {
  await prisma.product.deleteMany({ where: { id: { in: made.products } } });
  await prisma.account.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });

  console.log(
    `\ncleanup: users=${await prisma.user.count({ where: { id: { in: made.users } } })} ` +
      `products=${await prisma.product.count({ where: { id: { in: made.products } } })}`,
  );

  server.close();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
