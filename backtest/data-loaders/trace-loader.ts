/**
 * 0DTE TRACE loader — reads decoded JSON from data/historical/trace-0dte/
 * Provides maxGexStrike (magnetic target), gamma flip, walls at any timestamp.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TRACE_DIR = path.resolve(process.cwd(), "data/historical/trace-0dte");

interface TraceSnapshot {
  ts: string;
  spotPrice: number | null;
  maxGexStrike: number;
  maxGexValue: number;
  totalGamma: number;
  callWallStrike: number | null;
  putWallStrike: number | null;
  gammaFlip: number | null;
  topStrikes: { strike: number; gamma: number }[];
}

interface TraceDay {
  date: string;
  lens: string;
  timestamps: number;
  snapshots: TraceSnapshot[];
}

const cache = new Map<string, TraceDay>();

function loadDay(date: string, lens: string = "mm"): TraceDay | null {
  const key = `${date}_${lens}`;
  if (cache.has(key)) return cache.get(key)!;
  const file = path.join(TRACE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data: TraceDay = JSON.parse(fs.readFileSync(file, "utf-8"));
    cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

export interface TraceContext {
  maxGexStrike: number;      // THE magnetic target price
  maxGexValue: number;       // gamma at that strike (notional $)
  totalGamma: number;        // sum of all gamma
  gammaFlip: number | null;  // where gamma crosses zero
  callWall: number | null;   // ceiling
  putWall: number | null;    // floor
  spotEstimate: number | null;
  distFromMaxGex: number;    // how far current ETF price is from maxGex
  priceAboveMaxGex: boolean; // is price above the magnetic target?
  topStrikes: { strike: number; gamma: number }[];
}

/**
 * Get 0DTE trace context for a specific timestamp.
 * Finds the nearest snapshot at or before the given timestamp.
 */
export function getTraceContext(
  date: string,
  t: number,
  currentEtfPrice?: number,
  lens: string = "mm",
): TraceContext | null {
  const day = loadDay(date, lens);
  if (!day || day.snapshots.length === 0) return null;

  // Find nearest snapshot <= t
  // Timestamps in snapshots are like "Tue Mar 10 2026 04:..." or ISO strings
  // We need to compare with our unix ms timestamp
  let bestSnap: TraceSnapshot | null = null;
  let bestDist = Infinity;

  for (const snap of day.snapshots) {
    if (!snap.ts) continue;
    let snapTs: number;
    try {
      snapTs = new Date(snap.ts).getTime();
    } catch {
      continue;
    }
    if (isNaN(snapTs)) continue;

    const dist = t - snapTs;
    if (dist >= 0 && dist < bestDist) {
      bestDist = dist;
      bestSnap = snap;
    }
  }

  // If no snapshot before t, use first available
  if (!bestSnap) bestSnap = day.snapshots[0];
  if (!bestSnap) return null;

  const maxGex = bestSnap.maxGexStrike;
  const dist = currentEtfPrice ? currentEtfPrice - maxGex : 0;

  return {
    maxGexStrike: maxGex,
    maxGexValue: bestSnap.maxGexValue,
    totalGamma: bestSnap.totalGamma,
    gammaFlip: bestSnap.gammaFlip,
    callWall: bestSnap.callWallStrike,
    putWall: bestSnap.putWallStrike,
    spotEstimate: bestSnap.spotPrice,
    distFromMaxGex: dist,
    priceAboveMaxGex: dist > 0,
    topStrikes: bestSnap.topStrikes,
  };
}

/**
 * Check if maxGexStrike shifted significantly between two timestamps.
 * A shift in maxGex = the magnetic target moved = price will follow.
 */
export function maxGexShift(
  date: string,
  t1: number,
  t2: number,
  lens: string = "mm",
): { shifted: boolean; from: number; to: number; delta: number } | null {
  const ctx1 = getTraceContext(date, t1, undefined, lens);
  const ctx2 = getTraceContext(date, t2, undefined, lens);
  if (!ctx1 || !ctx2) return null;

  const delta = ctx2.maxGexStrike - ctx1.maxGexStrike;
  return {
    shifted: Math.abs(delta) >= 5, // 5 SPX points = significant
    from: ctx1.maxGexStrike,
    to: ctx2.maxGexStrike,
    delta,
  };
}

/** List dates with trace data available */
export function listTraceDates(lens: string = "mm"): string[] {
  if (!fs.existsSync(TRACE_DIR)) return [];
  return fs.readdirSync(TRACE_DIR)
    .filter(f => f.endsWith(`_${lens}.json`))
    .map(f => f.replace(`_${lens}.json`, ""))
    .sort();
}
