/**
 * HIRO reconstructor — synthesizes a HIRO-like institutional flow indicator
 * from historical flow data.
 *
 * HIRO = rolling sum of net-delta-flow per symbol, percentile-ranked vs same-hour distribution.
 *
 * Output: percentile 0-100 per symbol at any given timestamp.
 *  >P90 = very bullish flow
 *  <P10 = very bearish flow
 */
import { flowBucketsUpToSync, loadFlowDay } from "./flow-reader.js";

const WINDOW_BUCKETS = 6; // 6 × 5min = 30min rolling window
const PERCENTILE_LOOKBACK_MINUTES = 90; // 90-min of prior buckets for ranking

export interface HiroValue {
  sym: string;
  value: number;    // rolling sum of netDelta × sign (more = bullish)
  percentile: number; // 0-100
  trend: "bullish" | "bearish" | "neutral";
}

/** Compute HIRO for a symbol at timestamp T (requires flow loaded for date).
 *  Returns null if no data yet. */
export function getHiro(sym: string, date: string, t: number): HiroValue | null {
  const buckets = flowBucketsUpToSync(sym, date, t);
  if (buckets.length === 0) return null;

  // Rolling sum of last WINDOW_BUCKETS of netDelta
  const recent = buckets.slice(-WINDOW_BUCKETS);
  const rollingSum = recent.reduce((s, b) => s + b.netDelta, 0);

  // Percentile: compute rolling sums for all windows in today's data up to t
  // and rank the current one.
  const windowSums: number[] = [];
  for (let i = WINDOW_BUCKETS; i <= buckets.length; i++) {
    const w = buckets.slice(i - WINDOW_BUCKETS, i);
    windowSums.push(w.reduce((s, b) => s + b.netDelta, 0));
  }
  if (windowSums.length < 3) {
    // Not enough data to rank; return neutral
    return { sym, value: rollingSum, percentile: 50, trend: "neutral" };
  }

  // Percentile rank of last window
  const sorted = [...windowSums].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= rollingSum);
  const percentile = Math.round((rank / sorted.length) * 100);

  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  if (percentile >= 70) trend = "bullish";
  else if (percentile <= 30) trend = "bearish";

  return { sym, value: rollingSum, percentile, trend };
}

/** Get HIRO for all relevant symbols at timestamp T */
export function getAllHiro(date: string, t: number): Record<string, HiroValue | null> {
  const symbols = ["SPX", "QQQ", "SPY", "DIA", "GLD", "VIX"];
  const result: Record<string, HiroValue | null> = {};
  for (const sym of symbols) {
    result[sym] = getHiro(sym, date, t);
  }
  return result;
}

/** Ensure flow is loaded for a given date (async). Call once before running cycles of that date. */
export async function ensureFlowLoaded(date: string): Promise<void> {
  await loadFlowDay(date);
}
