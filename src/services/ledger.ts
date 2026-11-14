import { assertMinorAmount } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import {
  Prisma,
  type AccountType,
  type LedgerTransactionType,
} from "../generated/prisma/client.js";

/**
 * Double-entry ledger.
 *
 * Escrow means holding money that is not ours, so `order.status` and
 * `raffle.status` are workflow flags, not accounting. This is the only record
 * of whose money is where.
 *
 * Sign convention: positive is a debit, negative is a credit, and the legs of
 * one transaction must sum to zero. A deferred trigger in the database enforces
 * that at COMMIT; the checks here exist to fail with a message that names the
 * actual problem instead of a constraint violation.
 */

export type LedgerTx = Prisma.TransactionClient;

export interface LedgerLeg {
  account: AccountType;
  /** Required for per-user accounts (SELLER_PAYABLE, BUYER_REFUND_PAYABLE). */
  userId?: string | null;
  /** Signed pesewas. */
  amount: number;
  // Provenance, for reconciliation queries.
  raffleId?: string | null;
  paymentId?: string | null;
  orderId?: string | null;
  payoutId?: string | null;
}

export interface PostLedgerParams {
  type: LedgerTransactionType;
  /**
   * Idempotency key for money movement. A retried webhook that reuses this
   * reference hits a unique violation instead of posting twice.
   */
  reference: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  legs: LedgerLeg[];
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** Account types that belong to a specific user rather than the platform. */
const PER_USER_ACCOUNTS: ReadonlySet<AccountType> = new Set([
  "SELLER_PAYABLE",
  "BUYER_REFUND_PAYABLE",
]);

function validate(legs: LedgerLeg[]): void {
  if (legs.length < 2) {
    throw new LedgerError(
      `Double-entry requires at least 2 legs, got ${legs.length}`,
    );
  }

  let sum = 0;
  for (const leg of legs) {
    assertMinorAmount(leg.amount);

    if (leg.amount === 0) {
      throw new LedgerError(
        `Zero-amount leg on ${leg.account} is always a bug; omit the leg instead`,
      );
    }

    const needsUser = PER_USER_ACCOUNTS.has(leg.account);
    if (needsUser && !leg.userId) {
      throw new LedgerError(`${leg.account} requires a userId`);
    }
    if (!needsUser && leg.userId) {
      throw new LedgerError(
        `${leg.account} is a platform-level account and must not carry a userId`,
      );
    }

    sum += leg.amount;
  }

  if (sum !== 0) {
    throw new LedgerError(
      `Unbalanced transaction: legs sum to ${sum}, must be 0`,
    );
  }
}

interface AccountKey {
  account: AccountType;
  userId: string | null;
}

/**
 * Resolves every account the transaction touches in as few round trips as
 * possible.
 *
 * The previous version resolved one account at a time, which meant two or
 * three queries per leg. On a remote database a four-leg posting cost a dozen
 * sequential round trips inside an open transaction, and under load that blew
 * the transaction timeout outright. Accounts are created once in the lifetime
 * of the system, so the steady-state cost here is a single SELECT.
 */
async function resolveAccountIds(
  tx: LedgerTx,
  keys: AccountKey[],
): Promise<Map<string, string>> {
  const mapKey = (account: AccountType, userId: string | null) =>
    `${account}:${userId ?? ""}`;

  const wanted = new Map<string, AccountKey>();
  for (const key of keys) wanted.set(mapKey(key.account, key.userId), key);

  const found = await tx.account.findMany({
    where: {
      OR: [...wanted.values()].map((key) => ({
        type: key.account,
        userId: key.userId,
      })),
    },
    select: { id: true, type: true, userId: true },
  });

  const resolved = new Map<string, string>();
  for (const row of found) {
    resolved.set(mapKey(row.type, row.userId), row.id);
  }

  const missing = [...wanted.entries()].filter(([k]) => !resolved.has(k));
  if (missing.length === 0) return resolved;

  // First ever use of these accounts. skipDuplicates covers the race where a
  // concurrent posting creates the same account first; the index is
  // NULLS NOT DISTINCT, so platform singletons genuinely collide.
  await tx.account.createMany({
    data: missing.map(([, key]) => ({ type: key.account, userId: key.userId })),
    skipDuplicates: true,
  });

  const backfilled = await tx.account.findMany({
    where: {
      OR: missing.map(([, key]) => ({ type: key.account, userId: key.userId })),
    },
    select: { id: true, type: true, userId: true },
  });

  for (const row of backfilled) {
    resolved.set(mapKey(row.type, row.userId), row.id);
  }

  return resolved;
}

/**
 * Posts one balanced transaction. Must be called inside the caller's
 * transaction so domain state and its accounting commit together — a raffle
 * marked paid without its ledger entries is corruption, not a retryable error.
 */
export async function postLedgerTransaction(
  tx: LedgerTx,
  params: PostLedgerParams,
): Promise<string> {
  validate(params.legs);

  const transaction = await tx.ledgerTransaction.create({
    data: {
      type: params.type,
      reference: params.reference,
      description: params.description ?? null,
      metadata: params.metadata,
    },
    select: { id: true },
  });

  const accountIds = await resolveAccountIds(
    tx,
    params.legs.map((leg) => ({
      account: leg.account,
      userId: leg.userId ?? null,
    })),
  );

  // One insert for every leg: the balance trigger is deferred to COMMIT, so
  // the intermediate unbalanced state is never visible.
  await tx.ledgerEntry.createMany({
    data: params.legs.map((leg) => {
      const key = `${leg.account}:${leg.userId ?? ""}`;
      const accountId = accountIds.get(key);
      if (!accountId) {
        throw new LedgerError(`Could not resolve account ${key}`);
      }
      return {
        transactionId: transaction.id,
        accountId,
        amount: leg.amount,
        raffleId: leg.raffleId ?? null,
        paymentId: leg.paymentId ?? null,
        orderId: leg.orderId ?? null,
        payoutId: leg.payoutId ?? null,
      };
    }),
  });

  return transaction.id;
}

/** True when this reference has already been posted. */
export async function ledgerTransactionExists(
  tx: LedgerTx,
  reference: string,
): Promise<boolean> {
  const found = await tx.ledgerTransaction.findUnique({
    where: { reference },
    select: { id: true },
  });
  return found !== null;
}

export interface AccountBalance {
  account: AccountType;
  userId: string | null;
  balance: number;
}

/** Current balance per account. For reconciliation and tests. */
export async function accountBalances(): Promise<AccountBalance[]> {
  const rows = await prisma.$queryRaw<
    Array<{ type: AccountType; userId: string | null; balance: bigint }>
  >`
    SELECT a."type", a."userId", COALESCE(SUM(e."amount"), 0)::bigint AS balance
      FROM "Account" a
      LEFT JOIN "LedgerEntry" e ON e."accountId" = a."id"
     GROUP BY a."type", a."userId"
     ORDER BY a."type"
  `;

  return rows.map((row) => ({
    account: row.type,
    userId: row.userId,
    balance: Number(row.balance),
  }));
}

/**
 * Every entry in the book must sum to zero. If this is ever false, money has
 * been invented or destroyed and the only safe response is to stop paying out.
 */
export async function totalLedgerSum(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM("amount"), 0)::bigint AS total FROM "LedgerEntry"
  `;
  return Number(row?.total ?? 0);
}

/**
 * Escrow still held for one raffle.
 *
 * Distinct from the global TICKET_ESCROW balance, which aggregates every
 * open raffle at once. Reconciling or releasing a single raffle needs this
 * scoped view, not the platform total.
 */
export async function raffleEscrowBalance(raffleId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(e."amount"), 0)::bigint AS total
      FROM "LedgerEntry" e
      JOIN "Account" a ON a."id" = e."accountId"
     WHERE e."raffleId" = ${raffleId}
       AND a."type" = 'TICKET_ESCROW'::"AccountType"
  `;
  return Number(row?.total ?? 0);
}
