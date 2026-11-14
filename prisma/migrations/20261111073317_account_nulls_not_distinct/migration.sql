-- Fix duplicate platform-level ledger accounts.
--
-- Prisma's @@unique([type, userId]) emits a plain UNIQUE index, and Postgres
-- treats NULLs as distinct in those. Platform singletons (PLATFORM_CASH,
-- TICKET_ESCROW, PLATFORM_REVENUE, PSP_FEES) all carry userId = NULL, so the
-- constraint did not actually constrain them: two PLATFORM_CASH rows were
-- accepted, which would silently split the ledger across both and make any
-- balance query wrong.
--
-- NULLS NOT DISTINCT (Postgres 15+) makes NULL equal to NULL for uniqueness.
-- Prisma cannot express this, so it lives here.

-- Collapse any duplicates that already exist, keeping the oldest row and
-- repointing its entries, so the new index can be created.
WITH ranked AS (
    SELECT id,
           type,
           "userId",
           row_number() OVER (PARTITION BY type, "userId" ORDER BY "createdAt", id) AS rn,
           first_value(id) OVER (PARTITION BY type, "userId" ORDER BY "createdAt", id) AS keep_id
      FROM "Account"
)
UPDATE "LedgerEntry" e
   SET "accountId" = r.keep_id
  FROM ranked r
 WHERE e."accountId" = r.id
   AND r.rn > 1;

WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY type, "userId" ORDER BY "createdAt", id) AS rn
      FROM "Account"
)
DELETE FROM "Account" a
 USING ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

DROP INDEX IF EXISTS "Account_type_userId_key";

CREATE UNIQUE INDEX "Account_type_userId_key"
    ON "Account" (type, "userId") NULLS NOT DISTINCT;
