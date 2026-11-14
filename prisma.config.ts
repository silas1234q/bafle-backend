import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations use the DIRECT endpoint, not the pooler.
    //
    // Prisma Migrate needs a session-level connection (advisory locks, DDL),
    // and Neon's pooled endpoint intermittently refused the CLI with P1001
    // while a plain pg client connected to the same URL successfully. The
    // application keeps using the pooled URL at runtime, which is what the
    // pooler is actually for.
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
});
