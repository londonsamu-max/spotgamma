/**
 * Risk Reversal loader — reads /v1/rr historical data per symbol.
 * Provides daily RR value + trend detection (improving/deteriorating).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RR_DIR = path.resolve(process.cwd(), "data/historical/risk-reversal");

interface RREntry { trade_date: string; rr: number | null; upx: number }

const cache = new Map<string, RREntry[]>();

function loadSym(sym: string): RREntry[] {
  if (cache.has(sym)) return cache.get(sym)!;
  const file = path.join(RR_DIR, `${sym}.json`);
  if (!fs.existsSync(file)) { cache.set(sym, []); return []; }
  const data: RREntry[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  data.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  cache.set(sym, data);
  return data;
}

function findOnOrBefore(entries: RREntry[], date: string): RREntry | null {
  let best: RREntry | null = null;
  for (const e of entries) {
    if (e.trade_date.slice(0, 10) > date) break;
    best = e;
  }
  return best;
}

function findNDaysBefore(entries: RREntry[], date: string, n: number): RREntry | null {
  const idx = entries.findIndex(e => e.trade_date.slice(0, 10) >= date);
  if (idx < n) return null;
  return entries[idx - n];
}

export interface RiskReversalContext {
  sym: string;
  date: string;
  rr: number | null;          // current RR value
  rr5dAgo: number | null;     // 5 days ago
  rr10dAgo: number | null;    // 10 days ago
  rrDelta5d: number | null;   // change over 5 days
  rrDelta10d: number | null;  // change over 10 days
  trend: "improving" | "deteriorating" | "stable";
  isExtremeBearish: boolean;  // RR < -0.4 (historically fearful)
  isExtremeBullish: boolean;  // RR > 0.1 (historically complacent)
  isBottomSignal: boolean;    // extreme bearish + improving = institutional bottom
  isTopSignal: boolean;       // extreme bullish + deteriorating = institutional top
  percentile: number;         // 0-100 where current RR sits in last 252 days
}

export function getRiskReversal(sym: string, date: string): RiskReversalContext | null {
  const entries = loadSym(sym);
  if (entries.length === 0) return null;

  const current = findOnOrBefore(entries, date);
  if (!current || current.rr === null) return null;

  const d5 = findNDaysBefore(entries, date, 5);
  const d10 = findNDaysBefore(entries, date, 10);

  const rr5dAgo = d5?.rr ?? null;
  const rr10dAgo = d10?.rr ?? null;
  const rrDelta5d = rr5dAgo !== null ? current.rr - rr5dAgo : null;
  const rrDelta10d = rr10dAgo !== null ? current.rr - rr10dAgo : null;

  // Trend: based on 5d change
  let trend: RiskReversalContext["trend"] = "stable";
  if (rrDelta5d !== null) {
    if (rrDelta5d > 0.02) trend = "improving";
    else if (rrDelta5d < -0.02) trend = "deteriorating";
  }

  // Extremes (calibrated from SPX historical range ~-0.6 to +0.2)
  const isExtremeBearish = current.rr < -0.4;
  const isExtremeBullish = current.rr > 0.05;

  // Bottom signal: extreme bearish + improving = institutions removing hedges
  const isBottomSignal = isExtremeBearish && trend === "improving";
  // Top signal: bullish + deteriorating = institutions adding hedges
  const isTopSignal = isExtremeBullish && trend === "deteriorating";

  // Percentile over last 252 trading days
  const idx = entries.findIndex(e => e.trade_date.slice(0, 10) >= date);
  const lookback = entries.slice(Math.max(0, idx - 252), idx + 1).filter(e => e.rr !== null).map(e => e.rr!);
  let percentile = 50;
  if (lookback.length > 10) {
    const sorted = [...lookback].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current.rr);
    percentile = Math.round((rank / sorted.length) * 100);
  }

  return {
    sym, date,
    rr: current.rr,
    rr5dAgo, rr10dAgo,
    rrDelta5d, rrDelta10d,
    trend,
    isExtremeBearish, isExtremeBullish,
    isBottomSignal, isTopSignal,
    percentile,
  };
}

/** Get RR for the primary ETF of each CFD */
export function getRiskReversalForCfd(cfd: "NAS100" | "US30" | "XAUUSD", date: string): RiskReversalContext | null {
  const sym = cfd === "NAS100" ? "SPX" : cfd === "US30" ? "DIA" : "GLD";
  return getRiskReversal(sym, date);
}
