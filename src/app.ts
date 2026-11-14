import { clerkMiddleware } from "@clerk/express";
import cors from "cors";
import express from "express";
import type { ErrorRequestHandler } from "express";
import helmet from "helmet";

import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { globalLimiter } from "./middleware/rateLimit.js";
import { requestLog } from "./middleware/requestLog.js";
import { cloudinaryConfigured } from "./images/cloudinary.js";
import { emailProviderStatus } from "./notifications/index.js";
import { paymentProviderStatus } from "./payments/index.js";
import { addressesRouter } from "./routes/addresses.js";
import { clerkWebhookRouter } from "./routes/clerkWebhook.js";
import { internalJobsRouter } from "./routes/internalJobs.js";
import { ordersRouter } from "./routes/orders.js";
import { paymentsRouter } from "./routes/payments.js";
import { providerWebhookRouter } from "./routes/providerWebhook.js";
import { productsRouter } from "./routes/products.js";
import { rafflesRouter } from "./routes/raffles.js";
import { sellersRouter } from "./routes/sellers.js";
import { ticketsRouter } from "./routes/tickets.js";
import { meRouter } from "./routes/me.js";
import { uploadsRouter } from "./routes/uploads.js";
import { usersRouter } from "./routes/users.js";

export const app = express();

// Behind Render's load balancer every request appears to come from the proxy.
// Without this, rate limiting by IP would put the entire internet in one
// bucket. Exactly one hop is trusted — trusting all of them would let a
// client spoof X-Forwarded-For and dodge the limits entirely.
app.set("trust proxy", 1);

// First in the stack, deliberately. Mounted any later and the lines it cannot
// produce are exactly the ones worth having: a CORS preflight refused before
// it reaches a route, a webhook rejected on its signature, a body over the
// size cap. It only reads method, URL and status, so running it this early
// costs nothing.
app.use(requestLog);

// Security headers. This is a JSON API with no browser-rendered HTML, so CSP
// is disabled rather than configured for markup that does not exist.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Early so preflight OPTIONS is answered before anything else runs.
// An explicit allowlist, not `origin: true` — credentials are sent on these
// requests, and reflecting any origin would let any site call the API as the
// signed-in user.
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and server-to-server callers send no Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, env.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Mounted before express.json() on purpose: signature verification needs the
// raw request bytes, and a global JSON parser would consume them first.
//
// Also ahead of the global rate limiter: provider events are not user traffic,
// and dropping a charge.success under load would mean paid tickets that never
// become tickets.
app.use("/webhooks/clerk", clerkWebhookRouter);
// One router, mounted twice. The handler verifies through the *active*
// provider, so the path only decides which URL a provider was told to call:
// Paystack has this URL configured in its dashboard, while Moolre is handed
// a `callback` per checkout. The legacy path stays until the Paystack
// dashboard entry is retired, so a cutover cannot drop a live charge event.
app.use("/webhooks/payments", providerWebhookRouter);
app.use("/webhooks/paystack", providerWebhookRouter);

// A size cap, not the default unlimited. The largest legitimate body is a
// product listing with ten image URLs, which is a few kilobytes; without a
// limit a single request can exhaust memory.
app.use(express.json({ limit: "100kb" }));

// Ahead of clerkMiddleware deliberately: a malformed Clerk key makes that
// middleware throw for every request it touches, and an uptime probe should
// still be able to report whether the process and database are alive.
app.get("/health", async (_req, res) => {
  // Round-trips to the database so this fails when the DB is unreachable.
  await prisma.$queryRaw`SELECT 1`;
  // Surfacing the payment driver makes a misconfigured deploy visible and
  // alertable rather than silently faking money movement.
  res.json({
    status: "ok",
    payments: paymentProviderStatus(),
    email: emailProviderStatus(),
    images: { cloudinary: cloudinaryConfigured() },
  });
});

// Excluded from the global limiter: cron calls this on a fixed schedule and
// it is already gated by a shared secret.
app.use("/internal/jobs", internalJobsRouter);

// Attaches the Clerk session (if any) to the request. It does not reject
// unauthenticated requests — route-level `requireUser` does that.
app.use(clerkMiddleware());

app.use(globalLimiter);

app.use("/me", meRouter);
app.use("/addresses", addressesRouter);
app.use("/orders", ordersRouter);
app.use("/payments", paymentsRouter);
app.use("/products", productsRouter);
app.use("/raffles", rafflesRouter);
app.use("/sellers", sellersRouter);
app.use("/tickets", ticketsRouter);
app.use("/uploads", uploadsRouter);
app.use("/users", usersRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // A body that exceeded the limit or was not valid JSON is a client mistake,
  // not a server fault, and must not be reported as a 500.
  if (err instanceof Error && "type" in err) {
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON body" });
      return;
    }
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);
