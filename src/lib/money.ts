// Every amount in this codebase is an integer count of pesewas (GHS minor
// units, 100 per cedi). Floats are never used for money: 0.1 + 0.2 is not 0.3
// in binary floating point, and a raffle that silently loses a pesewa per
// ticket loses real money.

export const PESEWAS_PER_CEDI = 100;

export const CURRENCY = "GHS" as const;
export type Currency = typeof CURRENCY;

/** Parses user-entered cedis ("12.50") into pesewas. Throws on nonsense. */
export function cedisToPesewas(cedis: number | string): number {
  const value = typeof cedis === "string" ? Number(cedis) : cedis;

  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Not a valid cedi amount: ${String(cedis)}`);
  }

  // Round rather than truncate so 12.505 doesn't become 12.50.
  const pesewas = Math.round(value * PESEWAS_PER_CEDI);

  if (!Number.isSafeInteger(pesewas)) {
    throw new RangeError(`Cedi amount out of range: ${String(cedis)}`);
  }

  return pesewas;
}

/**
 * Pesewas as a plain decimal string of cedis, e.g. 1250 -> "12.50".
 *
 * For providers whose API speaks major units. Built by integer division and a
 * padded remainder rather than `pesewas / 100`, because the float form of an
 * amount is exactly what the rest of this file exists to keep out of requests
 * that move money — 0.1 + 0.2 reaching a transfer endpoint as 0.30000000000000004
 * is a rejected payout at best.
 *
 * Unlike formatGhs this carries no currency symbol or grouping, so it is safe
 * to put in a request body.
 */
export function pesewasToCedis(pesewas: number): string {
  assertMinorAmount(pesewas);
  const sign = pesewas < 0 ? "-" : "";
  const absolute = Math.abs(pesewas);
  const cedis = Math.floor(absolute / PESEWAS_PER_CEDI);
  const remainder = absolute % PESEWAS_PER_CEDI;
  return `${sign}${cedis}.${String(remainder).padStart(2, "0")}`;
}

/** For display only — never feed this back into a calculation. */
export function formatGhs(pesewas: number): string {
  assertMinorAmount(pesewas);
  const sign = pesewas < 0 ? "-" : "";
  const absolute = Math.abs(pesewas);
  const cedis = Math.floor(absolute / PESEWAS_PER_CEDI);
  const remainder = absolute % PESEWAS_PER_CEDI;
  return `${sign}GHS ${cedis.toLocaleString("en-GH")}.${String(remainder).padStart(2, "0")}`;
}

/** Guards the `Int` column contract: a whole number inside PostgreSQL int4. */
export function assertMinorAmount(pesewas: number): void {
  if (!Number.isInteger(pesewas)) {
    throw new RangeError(`Amount must be whole pesewas, got ${pesewas}`);
  }
  if (pesewas > 2_147_483_647 || pesewas < -2_147_483_648) {
    throw new RangeError(`Amount exceeds the Int column range: ${pesewas}`);
  }
}

export function assertPositiveMinorAmount(pesewas: number): void {
  assertMinorAmount(pesewas);
  if (pesewas <= 0) {
    throw new RangeError(`Amount must be positive, got ${pesewas}`);
  }
}

/** Basis points of an amount, rounded down so the platform never over-takes. */
export function applyBasisPoints(pesewas: number, bps: number): number {
  assertPositiveMinorAmount(pesewas);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`Basis points must be an integer 0-10000, got ${bps}`);
  }
  return Math.floor((pesewas * bps) / 10_000);
}
