/**
 * Formats a JSON-serializable value as a pretty-printed text block for MCP
 * tool responses. Handles BigInt safely.
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(
    data,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/**
 * Wraps a text payload in the MCP tool content shape.
 */
export function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

/**
 * Converts a BigInt-like string with `decimals` fractional digits into a
 * JavaScript number. Safe for display; not for financial math.
 */
export function fromUnits(raw: string | bigint, decimals: number): number {
  const n = typeof raw === "bigint" ? raw : BigInt(raw);
  if (decimals === 0) return Number(n);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0");
  const asNumber = Number(`${whole}.${fracStr}`);
  return negative ? -asNumber : asNumber;
}

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/**
 * Convert an AAVE rate stored as a Ray (1e27) APR into an APY.
 * AAVE v3 rates are continuously compounded per second, so the effective
 * APY is (1 + APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR - 1.
 */
export function rayRateToApy(rayApr: string | bigint): number {
  const raw = typeof rayApr === "bigint" ? rayApr : BigInt(rayApr);
  const apr = Number(raw) / Number(RAY);
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
}

/** Format a number as a percentage string with 2 decimals. */
export function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Format a USD amount. */
export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
