/**
 * Flow reader — streams .jsonl.gz files from data/historical/flow/
 * Exposes aggregated metrics per 5-min bucket per symbol:
 *   - netDelta (sum of side*delta): proxy for HIRO
 *   - netPremium: total premium flow
 *   - largeInstTrades: count of trades >$50K
 *   - buySellRatio
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as readline from "node:readline";

const HIST = path.resolve(process.cwd(), "data/historical/flow");
const BUCKET_MS = 5 * 60 * 1000; // 5-min buckets

export interface FlowTrade {
  sym: string;
  ts: number;
  delta: number;
  gamma: number;
  strike: number;
  size: number;
  side: "BUY" | "SELL" | "UNK";
  price: number;
  premium: number;
  cp: "C" | "P";
  exp: number;
}

export interface FlowBucket {
  bucketStart: number; // ms
  sym: string;
  netDelta: number; // sum of side-signed delta × size
  netPremium: number; // sum of signed premium
  tradeCount: number;
  largeInstTradeCount: number; // $>50K
  largePremiumSum: number;
  buyCount: number;
  sellCount: number;
}

const bucketCache = new Map<string, Map<string, FlowBucket[]>>();
// key: date, value: Map<symbol, buckets>

function bucketKey(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function flowFile(date: string): string {
  return path.join(HIST, `${date}.jsonl.gz`);
}

/** Load flow data for a day and bucket it. Returns Map<symbol, FlowBucket[]> */
export async function loadFlowDay(date: string): Promise<Map<string, FlowBucket[]>> {
  if (bucketCache.has(date)) return bucketCache.get(date)!;

  const file = flowFile(date);
  if (!fs.existsSync(file)) {
    bucketCache.set(date, new Map());
    return bucketCache.get(date)!;
  }

  const perSymbol = new Map<string, Map<number, FlowBucket>>();
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim() || line.includes('"__meta":true')) continue;
    let t: FlowTrade;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !t.ts) continue;

    const bucket = bucketKey(t.ts);
    let symMap = perSymbol.get(t.sym);
    if (!symMap) { symMap = new Map(); perSymbol.set(t.sym, symMap); }

    let b = symMap.get(bucket);
    if (!b) {
      b = {
        bucketStart: bucket, sym: t.sym,
        netDelta: 0, netPremium: 0,
        tradeCount: 0, largeInstTradeCount: 0, largePremiumSum: 0,
        buyCount: 0, sellCount: 0,
      };
      symMap.set(bucket, b);
    }
    const sign = t.side === "BUY" ? 1 : t.side === "SELL" ? -1 : 0;
    // delta × sign × size = net delta flow impact
    b.netDelta += sign * t.delta * t.size;
    b.netPremium += sign * t.premium;
    b.tradeCount++;
    if (sign > 0) b.buyCount++;
    if (sign < 0) b.sellCount++;
    if (Math.abs(t.premium) >= 50000) {
      b.largeInstTradeCount++;
      b.largePremiumSum += sign * t.premium;
    }
  }

  // Convert to sorted arrays
  const result = new Map<string, FlowBucket[]>();
  for (const [sym, map] of perSymbol) {
    const arr = Array.from(map.values()).sort((a, b) => a.bucketStart - b.bucketStart);
    result.set(sym, arr);
  }
  bucketCache.set(date, result);
  return result;
}

/** Get flow buckets for a symbol on a date, up to timestamp T */
export async function flowBucketsUpTo(sym: string, date: string, t: number): Promise<FlowBucket[]> {
  const daily = await loadFlowDay(date);
  const arr = daily.get(sym) ?? [];
  return arr.filter((b) => b.bucketStart + BUCKET_MS <= t);
}

/** Sync version: assumes already loaded */
export function flowBucketsUpToSync(sym: string, date: string, t: number): FlowBucket[] {
  const daily = bucketCache.get(date);
  if (!daily) return [];
  const arr = daily.get(sym) ?? [];
  return arr.filter((b) => b.bucketStart + BUCKET_MS <= t);
}

/** Pre-load a list of dates (to warm cache) */
export async function preloadDates(dates: string[]): Promise<void> {
  for (const d of dates) {
    if (!bucketCache.has(d)) await loadFlowDay(d);
  }
}
