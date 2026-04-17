/**
 * Individual Flow Analyzer — reads raw trades from .jsonl.gz
 * and produces a rich FlowContext at any given timestamp.
 *
 * Implements L52-L65 from CLAUDE.md:
 *   - Institutional trades (>$50K premium) — L53
 *   - Strike concentration (where is the money?) — L52, L57
 *   - P/C ratio intraday — L61
 *   - Aggressive flow (BUY at ASK vs SELL at BID) — L64
 *   - Expiry breakdown (0DTE, weekly, monthly, LEAPS) — L54
 *   - Opening vs Closing — L62
 *   - Large delta trades (market movers) — L63
 *   - Top institutional trades — L53, L85
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as readline from "node:readline";

const HIST = path.resolve(process.cwd(), "data/historical/flow");
const WINDOW_MS = 30 * 60 * 1000; // 30 min lookback window

interface RawTrade {
  sym: string;
  ts: number;
  delta: number;
  gamma: number;
  strike: number;
  size: number;
  side: "BUY" | "SELL" | "UNK";
  price: number;
  bid: number;
  ask: number;
  iv: number;
  prevOI: number;
  premium: number;
  cp: "C" | "P";
  exp: number;
}

// Cache: date → array of ALL trades (sorted by ts)
const tradeCache = new Map<string, RawTrade[]>();

async function loadAllTrades(date: string): Promise<RawTrade[]> {
  if (tradeCache.has(date)) return tradeCache.get(date)!;

  const file = path.join(HIST, `${date}.jsonl.gz`);
  if (!fs.existsSync(file)) {
    tradeCache.set(date, []);
    return [];
  }

  const trades: RawTrade[] = [];
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim() || line.includes('"__meta":true')) continue;
    try {
      const t: RawTrade = JSON.parse(line);
      if (t.sym && t.ts && t.premium !== undefined) trades.push(t);
    } catch {}
  }

  trades.sort((a, b) => a.ts - b.ts);
  tradeCache.set(date, trades);
  return trades;
}

/** Pre-load flow for a date (call once per day before querying) */
export async function ensureFlowAnalyzerLoaded(date: string): Promise<void> {
  await loadAllTrades(date);
}

// ─── FlowContext output ────────────────────────────────────────────────

export interface InstitutionalTrade {
  sym: string;
  strike: number;
  cp: "C" | "P";
  side: "BUY" | "SELL" | "UNK";
  premium: number;
  delta: number;
  size: number;
  exp: number;
  daysToExp: number;
  isAggressive: boolean; // bought at ask or sold at bid
}

export interface StrikeFlow {
  strike: number;
  netPremium: number;
  netDelta: number;
  callPremium: number;
  putPremium: number;
  tradeCount: number;
}

export interface ExpiryBucket {
  netDelta: number;
  callPremium: number;
  putPremium: number;
  tradeCount: number;
}

export interface FlowContext {
  // HIRO-equivalent
  netDelta: number;
  hiroBias: "bullish" | "bearish" | "neutral";

  // Institutional (L53): trades >$50K
  institutionalBias: "bullish" | "bearish" | "neutral";
  instBullishPremium: number;
  instBearishPremium: number;
  instTradeCount: number;
  topInstitutionalTrades: InstitutionalTrade[];

  // Strike concentration (L52, L57)
  topStrikes: StrikeFlow[];
  strikeNearBar: StrikeFlow | null; // flow at the specific bar being evaluated

  // P/C ratio (L61)
  pcRatio: number;
  callVolume: number;
  putVolume: number;

  // Aggressive flow (L64)
  aggressiveFlow: "buying" | "selling" | "balanced";
  aggressiveBuyPremium: number;
  aggressiveSellPremium: number;

  // Expiry breakdown (L54)
  zeroDte: ExpiryBucket;
  weekly: ExpiryBucket;
  monthly: ExpiryBucket;
  leaps: ExpiryBucket;

  // Opening vs Closing (L62)
  openingVsClosing: "opening_dominant" | "closing_dominant" | "balanced";
  openingCount: number;
  closingCount: number;

  // Large delta (L63): trades that literally move the market
  largeDeltaNetFlow: number; // sum of delta for trades with |delta| > 1M

  // Meta
  tradeCount: number;
  windowMinutes: number;
}

/** Get full flow context for a symbol at a specific timestamp, looking back WINDOW_MS */
export function getFlowContext(
  sym: string,
  date: string,
  t: number,
  nearBarStrike?: number, // if provided, checks flow concentration at this strike
): FlowContext | null {
  const allTrades = tradeCache.get(date);
  if (!allTrades || allTrades.length === 0) return null;

  // Filter: this symbol, within time window
  const windowStart = t - WINDOW_MS;
  const trades = allTrades.filter(
    (tr) => tr.sym === sym && tr.ts >= windowStart && tr.ts <= t
  );
  if (trades.length < 5) return null;

  const now = new Date(t);

  // ─── Aggregates ───
  let netDelta = 0;
  let callVolume = 0;
  let putVolume = 0;
  let instBullPrem = 0;
  let instBearPrem = 0;
  let instCount = 0;
  let aggBuyPrem = 0;
  let aggSellPrem = 0;
  let openingCount = 0;
  let closingCount = 0;
  let largeDeltaNet = 0;

  const strikeMap = new Map<number, StrikeFlow>();
  const zeroDte: ExpiryBucket = { netDelta: 0, callPremium: 0, putPremium: 0, tradeCount: 0 };
  const weekly: ExpiryBucket = { netDelta: 0, callPremium: 0, putPremium: 0, tradeCount: 0 };
  const monthly: ExpiryBucket = { netDelta: 0, callPremium: 0, putPremium: 0, tradeCount: 0 };
  const leaps: ExpiryBucket = { netDelta: 0, callPremium: 0, putPremium: 0, tradeCount: 0 };

  const instTrades: InstitutionalTrade[] = [];

  for (const tr of trades) {
    const sign = tr.side === "BUY" ? 1 : tr.side === "SELL" ? -1 : 0;
    const signedDelta = sign * tr.delta * tr.size;
    const signedPremium = sign * tr.premium;
    const absPremium = Math.abs(tr.premium);

    netDelta += signedDelta;

    // Call/Put volume
    if (tr.cp === "C") callVolume += tr.size;
    else putVolume += tr.size;

    // Institutional (>$50K)
    if (absPremium >= 50000) {
      instCount++;
      if (signedDelta > 0) instBullPrem += absPremium;
      else instBearPrem += absPremium;

      // Classify expiry
      const daysToExp = Math.max(0, Math.round((tr.exp - t) / 86400000));
      const isAggressive = (tr.side === "BUY" && tr.price >= tr.ask * 0.99) ||
                           (tr.side === "SELL" && tr.price <= tr.bid * 1.01);

      instTrades.push({
        sym: tr.sym, strike: tr.strike, cp: tr.cp, side: tr.side,
        premium: tr.premium, delta: tr.delta, size: tr.size,
        exp: tr.exp, daysToExp, isAggressive,
      });
    }

    // Aggressive flow
    if (tr.side === "BUY" && tr.price >= tr.ask * 0.99) aggBuyPrem += absPremium;
    if (tr.side === "SELL" && tr.price <= tr.bid * 1.01) aggSellPrem += absPremium;

    // Opening vs Closing: if size > prevOI * 0.1 → likely opening new position
    if (tr.prevOI > 0 && tr.size > tr.prevOI * 0.1) openingCount++;
    else closingCount++;

    // Large delta trades
    if (Math.abs(tr.delta * tr.size) > 1000000) largeDeltaNet += signedDelta;

    // Strike aggregation
    let sf = strikeMap.get(tr.strike);
    if (!sf) {
      sf = { strike: tr.strike, netPremium: 0, netDelta: 0, callPremium: 0, putPremium: 0, tradeCount: 0 };
      strikeMap.set(tr.strike, sf);
    }
    sf.netPremium += signedPremium;
    sf.netDelta += signedDelta;
    if (tr.cp === "C") sf.callPremium += absPremium;
    else sf.putPremium += absPremium;
    sf.tradeCount++;

    // Expiry bucket
    const dte = Math.round((tr.exp - t) / 86400000);
    const bucket = dte <= 0 ? zeroDte : dte <= 5 ? weekly : dte <= 30 ? monthly : leaps;
    bucket.netDelta += signedDelta;
    if (tr.cp === "C") bucket.callPremium += absPremium;
    else bucket.putPremium += absPremium;
    bucket.tradeCount++;
  }

  // Top 10 strikes by total premium
  const topStrikes = Array.from(strikeMap.values())
    .sort((a, b) => (b.callPremium + b.putPremium) - (a.callPremium + a.putPremium))
    .slice(0, 10);

  // Strike near the bar
  let strikeNearBar: StrikeFlow | null = null;
  if (nearBarStrike !== undefined) {
    // Find the closest strike within ±5 of the bar
    for (const [strike, sf] of strikeMap) {
      if (Math.abs(strike - nearBarStrike) <= 5) {
        if (!strikeNearBar || (sf.callPremium + sf.putPremium) > (strikeNearBar.callPremium + strikeNearBar.putPremium)) {
          strikeNearBar = sf;
        }
      }
    }
  }

  // Top institutional trades sorted by premium desc
  instTrades.sort((a, b) => Math.abs(b.premium) - Math.abs(a.premium));
  const topInst = instTrades.slice(0, 10);

  // Derive biases
  const hiroBias: FlowContext["hiroBias"] = netDelta > 0 ? "bullish" : netDelta < 0 ? "bearish" : "neutral";
  const instBias: FlowContext["institutionalBias"] =
    instBullPrem > instBearPrem * 1.3 ? "bullish" :
    instBearPrem > instBullPrem * 1.3 ? "bearish" : "neutral";
  const aggFlow: FlowContext["aggressiveFlow"] =
    aggBuyPrem > aggSellPrem * 1.3 ? "buying" :
    aggSellPrem > aggBuyPrem * 1.3 ? "selling" : "balanced";
  const ovc: FlowContext["openingVsClosing"] =
    openingCount > closingCount * 1.5 ? "opening_dominant" :
    closingCount > openingCount * 1.5 ? "closing_dominant" : "balanced";
  const pcRatio = putVolume > 0 ? callVolume / putVolume : 999;

  return {
    netDelta,
    hiroBias,
    institutionalBias: instBias,
    instBullishPremium: instBullPrem,
    instBearishPremium: instBearPrem,
    instTradeCount: instCount,
    topInstitutionalTrades: topInst,
    topStrikes,
    strikeNearBar,
    pcRatio: Math.round(pcRatio * 100) / 100,
    callVolume,
    putVolume,
    aggressiveFlow: aggFlow,
    aggressiveBuyPremium: aggBuyPrem,
    aggressiveSellPremium: aggSellPrem,
    zeroDte,
    weekly,
    monthly,
    leaps,
    openingVsClosing: ovc,
    openingCount,
    closingCount,
    largeDeltaNetFlow: largeDeltaNet,
    tradeCount: trades.length,
    windowMinutes: WINDOW_MS / 60000,
  };
}
