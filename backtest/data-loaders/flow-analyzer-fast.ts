/**
 * Flow Analyzer FAST — reads from pre-processed flow-processed/{date}.json
 * instead of raw .jsonl.gz. Zero memory issues, instant loading.
 *
 * Same FlowContext output as flow-analyzer.ts but from lightweight files.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PROCESSED_DIR = path.resolve(process.cwd(), "data/historical/flow-processed");
const WINDOW_BUCKETS = 6; // 6 × 5min = 30min lookback

interface BucketAgg {
  t: number;
  sym: string;
  netDelta: number;
  netPremium: number;
  tradeCount: number;
  callCount: number;
  putCount: number;
  buyCount: number;
  sellCount: number;
  aggBuyPrem: number;
  aggSellPrem: number;
  instBullPrem: number;
  instBearPrem: number;
  instCount: number;
  largeDeltaNet: number;
  openingCount: number;
  closingCount: number;
  zeroDteNetDelta: number;
  weeklyNetDelta: number;
  monthlyNetDelta: number;
  leapsNetDelta: number;
  topStrikes: { strike: number; netPrem: number; netDelta: number; callPrem: number; putPrem: number; count: number }[];
  instTrades: { strike: number; cp: string; side: string; premium: number; delta: number; size: number; exp: number; aggressive: boolean }[];
}

// Cache: date → buckets array
const cache = new Map<string, BucketAgg[]>();

function loadDay(date: string): BucketAgg[] {
  if (cache.has(date)) return cache.get(date)!;
  const file = path.join(PROCESSED_DIR, `${date}.json`);
  if (!fs.existsSync(file)) {
    cache.set(date, []);
    return [];
  }
  const data: BucketAgg[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  cache.set(date, data);
  return data;
}

export function ensureFlowProcessedLoaded(date: string): void {
  loadDay(date);
}

// ─── HIRO from pre-processed ───

export interface HiroValue {
  sym: string;
  value: number;
  percentile: number;
  trend: "bullish" | "bearish" | "neutral";
}

export function getHiroFast(sym: string, date: string, t: number): HiroValue | null {
  const buckets = loadDay(date).filter((b) => b.sym === sym && b.t + 300000 <= t);
  if (buckets.length < 3) return null;

  const recent = buckets.slice(-WINDOW_BUCKETS);
  const rollingSum = recent.reduce((s, b) => s + b.netDelta, 0);

  const windowSums: number[] = [];
  for (let i = WINDOW_BUCKETS; i <= buckets.length; i++) {
    const w = buckets.slice(i - WINDOW_BUCKETS, i);
    windowSums.push(w.reduce((s, b) => s + b.netDelta, 0));
  }
  if (windowSums.length < 3) return { sym, value: rollingSum, percentile: 50, trend: "neutral" };

  const sorted = [...windowSums].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= rollingSum);
  const percentile = Math.round((rank / sorted.length) * 100);

  let trend: "bullish" | "bearish" | "neutral" = "neutral";
  if (percentile >= 70) trend = "bullish";
  else if (percentile <= 30) trend = "bearish";

  return { sym, value: rollingSum, percentile, trend };
}

// ─── Full FlowContext from pre-processed ───

export interface FlowContext {
  netDelta: number;
  hiroBias: "bullish" | "bearish" | "neutral";
  institutionalBias: "bullish" | "bearish" | "neutral";
  instBullishPremium: number;
  instBearishPremium: number;
  instTradeCount: number;
  topInstitutionalTrades: BucketAgg["instTrades"];
  topStrikes: BucketAgg["topStrikes"];
  strikeNearBar: { strike: number; netPrem: number; netDelta: number; callPrem: number; putPrem: number; count: number } | null;
  pcRatio: number;
  aggressiveFlow: "buying" | "selling" | "balanced";
  aggressiveBuyPremium: number;
  aggressiveSellPremium: number;
  zeroDteNetDelta: number;
  weeklyNetDelta: number;
  monthlyNetDelta: number;
  leapsNetDelta: number;
  openingVsClosing: "opening_dominant" | "closing_dominant" | "balanced";
  largeDeltaNetFlow: number;
  tradeCount: number;
}

export function getFlowContextFast(
  sym: string,
  date: string,
  t: number,
  nearBarStrike?: number,
): FlowContext | null {
  const buckets = loadDay(date).filter((b) => b.sym === sym && b.t + 300000 <= t);
  const recent = buckets.slice(-WINDOW_BUCKETS);
  if (recent.length < 2) return null;

  // Aggregate last N buckets
  let netDelta = 0, callCount = 0, putCount = 0;
  let instBull = 0, instBear = 0, instCount = 0;
  let aggBuy = 0, aggSell = 0;
  let openCount = 0, closeCount = 0;
  let largeDelta = 0, tradeCount = 0;
  let zeroDte = 0, weekly = 0, monthly = 0, leaps = 0;
  const allInstTrades: BucketAgg["instTrades"] = [];
  const strikeMap = new Map<number, { netPrem: number; netDelta: number; callPrem: number; putPrem: number; count: number }>();

  for (const b of recent) {
    netDelta += b.netDelta;
    callCount += b.callCount;
    putCount += b.putCount;
    instBull += b.instBullPrem;
    instBear += b.instBearPrem;
    instCount += b.instCount;
    aggBuy += b.aggBuyPrem;
    aggSell += b.aggSellPrem;
    openCount += b.openingCount;
    closeCount += b.closingCount;
    largeDelta += b.largeDeltaNet;
    tradeCount += b.tradeCount;
    zeroDte += b.zeroDteNetDelta;
    weekly += b.weeklyNetDelta;
    monthly += b.monthlyNetDelta;
    leaps += b.leapsNetDelta;
    allInstTrades.push(...b.instTrades);
    for (const s of b.topStrikes) {
      const existing = strikeMap.get(s.strike);
      if (existing) {
        existing.netPrem += s.netPrem;
        existing.netDelta += s.netDelta;
        existing.callPrem += s.callPrem;
        existing.putPrem += s.putPrem;
        existing.count += s.count;
      } else {
        strikeMap.set(s.strike, { ...s });
      }
    }
  }

  const topStrikes = Array.from(strikeMap.values())
    .sort((a, b) => (b.callPrem + b.putPrem) - (a.callPrem + a.putPrem))
    .slice(0, 10);

  let strikeNearBar: FlowContext["strikeNearBar"] = null;
  if (nearBarStrike !== undefined) {
    for (const [strike, v] of strikeMap) {
      if (Math.abs(strike - nearBarStrike) <= 5) {
        if (!strikeNearBar || (v.callPrem + v.putPrem) > ((strikeNearBar?.callPrem ?? 0) + (strikeNearBar?.putPrem ?? 0))) {
          strikeNearBar = { strike, ...v };
        }
      }
    }
  }

  allInstTrades.sort((a, b) => Math.abs(b.premium) - Math.abs(a.premium));

  const hiroBias: FlowContext["hiroBias"] = netDelta > 0 ? "bullish" : netDelta < 0 ? "bearish" : "neutral";
  const instBias: FlowContext["institutionalBias"] =
    instBull > instBear * 1.3 ? "bullish" : instBear > instBull * 1.3 ? "bearish" : "neutral";
  const aggFlow: FlowContext["aggressiveFlow"] =
    aggBuy > aggSell * 1.3 ? "buying" : aggSell > aggBuy * 1.3 ? "selling" : "balanced";
  const ovc: FlowContext["openingVsClosing"] =
    openCount > closeCount * 1.5 ? "opening_dominant" : closeCount > openCount * 1.5 ? "closing_dominant" : "balanced";
  const pcRatio = putCount > 0 ? Math.round((callCount / putCount) * 100) / 100 : 999;

  return {
    netDelta, hiroBias,
    institutionalBias: instBias,
    instBullishPremium: instBull,
    instBearishPremium: instBear,
    instTradeCount: instCount,
    topInstitutionalTrades: allInstTrades.slice(0, 10),
    topStrikes,
    strikeNearBar,
    pcRatio,
    aggressiveFlow: aggFlow,
    aggressiveBuyPremium: aggBuy,
    aggressiveSellPremium: aggSell,
    zeroDteNetDelta: zeroDte,
    weeklyNetDelta: weekly,
    monthlyNetDelta: monthly,
    leapsNetDelta: leaps,
    openingVsClosing: ovc,
    largeDeltaNetFlow: largeDelta,
    tradeCount,
  };
}
