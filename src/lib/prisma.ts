import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../env.js";
import { PrismaClient } from "../generated/prisma/client.js";

// Prisma 7 is Rust-free: a driver adapter is mandatory. `new PrismaClient()`
// with no adapter throws.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// Import this one instance everywhere — a client per request would exhaust the
// connection pool.
export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
