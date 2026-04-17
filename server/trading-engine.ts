/**
 * Trading Engine v3 - Intraday CFD Trading System
 * Based on options structure, dealer positioning, institutional flow, and vanna mechanics.
 *
 * Key principles:
 * 1. Levels are "decision zones" (not support/resistance)
 * 2. Cross-asset analysis: SPX+SPY+QQQ → NAS100, SPX+SPY+DIA → US30, GLD → XAUUSD
 * 3. 6 confirmations: GEX 0DTE, HIRO, Nivel/Outlier, Tape, Vanna, Regimen SG
 * 4. Official SpotGamma levels (Call Wall, Put Wall, Key Gamma, Vol Trigger, Implied Move)
 * 5. Vanna trades: VIX→indices, GLD IV→gold, UVXY→refuge flow
 * 6. Dynamic SL/TP in CFD prices (NAS100, US30, XAUUSD)
 * 7. Risk management: $5-$10 max risk with user's lot sizes
 * 8. Trade types: Gamma, Vanna, Refuge
 */

import type {
  AssetData,
  GexData,
  HiroData,
  TapeData,
  TraceData,
  StrikeData,
  OfficialSGLevels,
  VannaContext,
  CFDPriceData,
  TradierGexData,
} from "./spotgamma-scraper";
import {
  updateSessionPrice,
  getSessionTrend,
  getImpliedMoveStatus,
  getGapContext,
  trackLevelTouch,
  getLevelFreshness,
  getMacroAlert,
  getCachedDXYTLT,
  refreshDXYTLT,
} from "./session-tracker";
// RL-Agent removed: PPO Multi-Head is now the only decision maker (Fase 2: PPO Puro)
import { fetchTwelveSeries, detectCandleSignal, candleRewardMultiplier, fetchGammaTilt, fetchDeltaTilt } from "./spotgamma-scraper";
import type { CandleSignal } from "./spotgamma-scraper";
import { fetchYahooPrices, CFD_TO_YAHOO, type DayPrice } from "./yahoo-price-fetcher";
import { getPPOAgent, ensurePPOLoaded, buildPPOState, normalizeState, PPO_ACTION_LABELS, parseAction } from "./ppo-agent";
import type { PPOState } from "./ppo-agent";
import { getMultiHeadAgent, ensureMultiHeadLoaded, buildPPOState as mhBuildPPOState, type MultiHeadDecision } from "./ppo-multihead";
import { isModelLoaded as isMHInferenceLoaded, predict as mhInferencePredict, normalizeForInference, type MHInferenceResult } from "./ppo-inference";
import { predictLSTM, isLSTMAvailable } from "./ppo-inference-lstm.js";
import { getRollingNormalizer } from "./rolling-normalizer";
import { getEpisodeBank, type DailyContext } from "./episode-bank.js";

// ── Candle signal cache (refreshed async, read sync) ─────────────────────────
const _candleCache: Record<string, { signal: CandleSignal; ts: number }> = {};

export function refreshCandleSignals(): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const [cfd, sym] of [["NAS100","SPX"],["US30","DIA"],["XAUUSD","GLD"]] as const) {
    fetchTwelveSeries(sym, today, "5min").then(bars => {
      if (bars.length >= 2) {
        _candleCache[cfd] = { signal: detectCandleSignal(bars, 4), ts: Date.now() };
        console.log(`[CANDLE] ${sym}: ${_candleCache[cfd].signal} (${bars.length} bars)`);
      }
    }).catch(() => {});
  }
}

interface RichCandleSignal {
  label: CandleSignal;
  bodyRatio: number;   // 0-1
  trend: number;       // -1, 0, 1
  volSpike: number;    // ratio vs avg
}

function getCachedCandleSignal(cfd: string): RichCandleSignal {
  const c = _candleCache[cfd];
  const neutral: RichCandleSignal = { label: "neutral", bodyRatio: 0.5, trend: 0, volSpike: 1 };
  if (!c) return neutral;
  if (Date.now() - c.ts > 600_000) return neutral;
  // Extract richer info from the string label
  const label = c.signal;
  return {
    label,
    bodyRatio: label === "bullish" ? 0.7 : label === "bearish" ? 0.3 : 0.5,
    trend: label === "bullish" ? 1 : label === "bearish" ? -1 : 0,
    volSpike: 1, // no intrabar volume available
  };
}

// ── Price history cache (for momentum, RSI, ATR) ────────────────────────────
// Uses local SpotGamma daily-ohlc files (already downloaded) instead of Yahoo (429 rate limited)
import fs from "fs";
import path from "path";

interface PriceHistoryEntry {
  prices: DayPrice[];
  fetchedAt: number;
}
const _priceHistoryCache: Record<string, PriceHistoryEntry> = {};

const CFD_TO_OHLC_SYM: Record<string, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

async function getPriceHistory(cfd: string): Promise<DayPrice[]> {
  const cached = _priceHistoryCache[cfd];
  if (cached && Date.now() - cached.fetchedAt < 12 * 3600_000) return cached.prices;
  const sym = CFD_TO_OHLC_SYM[cfd];
  if (!sym) return [];
  try {
    const ohlcPath = path.resolve(process.cwd(), `data/historical/daily-ohlc/${sym}.json`);
    if (!fs.existsSync(ohlcPath)) return [];
    const raw: { t: number; o: number; h: number; l: number; c: number; v: number }[] =
      JSON.parse(fs.readFileSync(ohlcPath, "utf-8"));
    // Convert to DayPrice format, take last 60 entries for efficiency
    const prices: DayPrice[] = raw.slice(-60).map(r => ({
      date: new Date(r.t * 1000).toISOString().slice(0, 10),
      open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, adjClose: r.c,
    }));
    _priceHistoryCache[cfd] = { prices, fetchedAt: Date.now() };
    console.log(`[PRICE-HIST] ${cfd}/${sym}: loaded ${prices.length} days (last: ${prices[prices.length-1]?.date})`);
    return prices;
  } catch (e: any) {
    console.warn(`[PRICE-HIST] Failed to load ${cfd}: ${e.message}`);
  }
  return cached?.prices ?? [];
}

function computeMomentum(prices: DayPrice[], days: number): number {
  if (prices.length < days + 1) return 0;
  const curr = prices[prices.length - 1].close;
  const prev = prices[prices.length - 1 - days].close;
  return prev > 0 ? (curr - prev) / prev * 100 : 0;
}

function computeRSI(prices: DayPrice[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i].close - prices[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function computeATRPct(prices: DayPrice[], period = 14): number {
  if (prices.length < period + 1) return 1.0;
  let total = 0;
  const start = Math.max(1, prices.length - period);
  for (let i = start; i < prices.length; i++) {
    const prev = prices[i - 1].close;
    if (prev > 0) total += Math.abs(prices[i].high - prices[i].low) / prev * 100;
  }
  return total / (prices.length - start) || 1.0;
}

function computeVolumeRatio(prices: DayPrice[], period = 20): number {
  if (prices.length < period + 1) return 1.0;
  const lastVol = prices[prices.length - 1].volume;
  let avgVol = 0;
  for (let i = prices.length - 1 - period; i < prices.length - 1; i++) {
    avgVol += prices[i].volume;
  }
  avgVol /= period;
  return avgVol > 0 ? lastVol / avgVol : 1.0;
}

// ── Tilt cache (gamma/delta tilt from SpotGamma) ────────────────────────────
const _tiltCache: Record<string, { gammaTilt: number; deltaTilt: number; ts: number }> = {};

async function refreshTiltData(): Promise<void> {
  for (const sym of ["SPX"]) {
    try {
      const [gammaRows, deltaRows] = await Promise.all([
        fetchGammaTilt(sym),
        fetchDeltaTilt(sym),
      ]);
      const gt = gammaRows.length > 0 ? gammaRows[gammaRows.length - 1].gammaTilt : 0;
      const dt = deltaRows.length > 0 ? deltaRows[deltaRows.length - 1].deltaTilt : 0;
      _tiltCache[sym] = { gammaTilt: gt, deltaTilt: dt, ts: Date.now() };
      console.log(`[TILT] ${sym}: gammaTilt=${gt.toFixed(4)}, deltaTilt=${dt.toFixed(4)}`);
    } catch (e: any) {
      console.warn(`[TILT] Failed to fetch ${sym}: ${e.message}`);
    }
  }
}

function getCachedTilt(sym: string): { gammaTilt: number; deltaTilt: number } {
  const c = _tiltCache[sym] ?? _tiltCache["SPX"];
  if (!c || Date.now() - c.ts > 3600_000) return { gammaTilt: 0, deltaTilt: 0 }; // 1h expiry
  return { gammaTilt: c.gammaTilt, deltaTilt: c.deltaTilt };
}

// ── HIRO acceleration tracking ──────────────────────────────────────────────
export const _hiroHistory: Record<string, { ts: number; value: number }[]> = {};

function trackHiroAccel(sym: string, currentValue: number): number {
  if (!_hiroHistory[sym]) _hiroHistory[sym] = [];
  const hist = _hiroHistory[sym];
  hist.push({ ts: Date.now(), value: currentValue });
  // Keep last 20 readings
  while (hist.length > 20) hist.shift();
  if (hist.length < 2) return 0;
  // Compute acceleration: change in value per minute
  const prev = hist[hist.length - 2];
  const curr = hist[hist.length - 1];
  const dtMin = Math.max(0.5, (curr.ts - prev.ts) / 60_000);
  const accel = (curr.value - prev.value) / dtMin;
  // Normalize to roughly [-1, 1] (typical HIRO changes per minute)
  return Math.tanh(accel / 1e6);
}

// ── Pre-warm caches at module load (5s delay for server startup) ────────────
let _cacheInitialized = false;
async function ensureLiveCachesLoaded(): Promise<void> {
  if (_cacheInitialized) return;
  _cacheInitialized = true;
  try {
    await Promise.all([
      getPriceHistory("NAS100"),
      getPriceHistory("US30"),
      getPriceHistory("XAUUSD"),
      refreshTiltData(),
    ]);
    console.log(`[LIVE-CACHE] Price history: NAS100=${_priceHistoryCache["NAS100"]?.prices?.length ?? 0}d, US30=${_priceHistoryCache["US30"]?.prices?.length ?? 0}d, XAUUSD=${_priceHistoryCache["XAUUSD"]?.prices?.length ?? 0}d`);
  } catch (e: any) {
    console.warn(`[LIVE-CACHE] Pre-warm partial failure: ${e.message}`);
  }
}
// Fire immediately at import (non-blocking)
setTimeout(() => ensureLiveCachesLoaded(), 3000);

// ============ CFD SPECIFICATIONS ============

export interface CFDSpec {
  cfd: string;
  label: string;
  lotSize: number;         // User's lot size
  valuePerPoint: number;   // $ per point at user's lot size
  maxRiskUSD: number;      // Max risk in dollars
  maxSLPoints: number;     // Max SL in CFD points for $10 risk
  minSLPoints: number;     // Min SL in CFD points for $5 risk
  // Conversion from analysis asset to CFD
  betaVsSPX: number;       // Beta multiplier vs SPX
}

export const CFD_SPECS: Record<string, CFDSpec> = {
  NAS100: {
    cfd: "NAS100", label: "NASDAQ 100 CFD",
    lotSize: 0.1, valuePerPoint: 0.10,
    maxRiskUSD: 10, maxSLPoints: 100, minSLPoints: 50,
    betaVsSPX: 1.5,
  },
  US30: {
    cfd: "US30", label: "US30 (Dow Jones) CFD",
    lotSize: 0.1, valuePerPoint: 0.10,   // 0.1 lot → $0.10/pt
    maxRiskUSD: 10, maxSLPoints: 100, minSLPoints: 30,
    betaVsSPX: 0.9,
  },
  XAUUSD: {
    cfd: "XAUUSD", label: "XAUUSD (Oro) CFD",
    lotSize: 0.01, valuePerPoint: 1.00, // $1 per $1 move
    maxRiskUSD: 10, maxSLPoints: 50, minSLPoints: 10,
    betaVsSPX: 0, // Independent
  },
};

// Map analysis assets to CFD instruments
export const ASSET_TO_CFD: Record<string, string> = {
  SPX: "NAS100", SPY: "NAS100", QQQ: "NAS100",
  DIA: "US30",
  GLD: "XAUUSD",
};

// Assets that use SPX TRACE 0DTE GEX for classifyDecisionLevels bias scoring
// DIA and GLD use their own SpotGamma chart GEX (via etfGex) — NOT SPX GEX
export const GEX_ELIGIBLE_ASSETS = ["SPX", "SPY", "QQQ"];

// ============ FIX 9: CACHED ET TIME ============

/** Cached ET time info for current cycle — avoids recalculating EDT/EST in every function */
interface ETTimeInfo {
  etH: number;
  etMins: number;
  dow: number;    // 0=Sun..6=Sat
  isEDT: boolean;
  utcH: number;
  utcM: number;
  day: number;
  month: number;
  year: number;
}

function getETTime(now?: Date): ETTimeInfo {
  const d = now || new Date();
  const utcH = d.getUTCHours();
  const utcM = d.getUTCMinutes();
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dow = d.getUTCDay();

  let isEDT = mo > 3 && mo < 11;
  if (mo === 3) {
    let cnt = 0, sun2 = 0;
    for (let i = 1; i <= 31; i++) {
      const dt = new Date(Date.UTC(y, 2, i));
      if (dt.getUTCMonth() !== 2) break;
      if (dt.getUTCDay() === 0 && ++cnt === 2) { sun2 = i; break; }
    }
    isEDT = day > sun2 || (day === sun2 && utcH >= 7);
  } else if (mo === 11) {
    let sun1 = 0;
    for (let i = 1; i <= 7; i++) { if (new Date(Date.UTC(y, 10, i)).getUTCDay() === 0) { sun1 = i; break; } }
    isEDT = day < sun1 || (day === sun1 && utcH < 6);
  }

  const etH = ((utcH + (isEDT ? -4 : -5)) % 24 + 24) % 24;
  const etMins = etH * 60 + utcM;

  return { etH, etMins, dow, isEDT, utcH, utcM, day, month: mo, year: y };
}

// Cross-asset groups for consensus analysis
const CROSS_ASSET_GROUPS: Record<string, { assets: string[]; cfd: string; requiredConsensus: number }> = {
  NAS100: { assets: ["SPX", "SPY", "QQQ"], cfd: "NAS100", requiredConsensus: 1 },
  US30: { assets: ["SPX", "SPY", "DIA"], cfd: "US30", requiredConsensus: 2 },
  XAUUSD: { assets: ["GLD"], cfd: "XAUUSD", requiredConsensus: 1 },
};

// ============ TYPES ============

export type LevelHierarchy = "minor" | "reaction" | "dominant";
export type TradeType = "gamma" | "breakout" | "bounce" | "vanna_index" | "vanna_gold" | "refuge" | "cross_asset" | "im_exhaustion" | "opex_pin" | "hiro_divergence" | "gamma_squeeze" | "charm_flow" | "news_reaction";

export interface DecisionLevel {
  strike: number;
  hierarchy: LevelHierarchy;
  bias: "buy" | "sell" | "neutral";
  biasScore: number;
  gammaNotional: number;
  callGammaNotional: number;
  putGammaNotional: number;
  outlierScore: number;
  distanceFromPrice: number;
  distancePct: number;
  isNearPrice: boolean;
  dealerExposure: "long_gamma" | "short_gamma" | "neutral";
  netPositioning: number;
  flowBias: "bullish" | "bearish" | "neutral";
  // Confluence with official SG levels
  confluenceWithSG: boolean;
  sgLevelType: string; // "Call Wall", "Put Wall", "Key Gamma", etc.
  // Top strike priority (highest absolute gamma near price)
  isTopStrike: boolean;
  topStrikeRank?: number;  // 1, 2 or 3
  // Cross-asset origin (SPY/QQQ strike converted to primary space)
  isCrossAsset?: boolean;
  companionAbsDist?: number;  // distancia absoluta en dólares del strike al precio del companion
}

export interface VannaSignal {
  detected: boolean;
  type: "bullish_vanna" | "bearish_vanna" | "none";
  description: string;
  strength: "strong" | "moderate" | "weak" | "none";
  volDropping: boolean;
  priceRising: boolean;
  dealersMustBuyFutures: boolean;
}

export interface VolatilityAnalysis {
  asset: string;
  volatilitySource: string;
  currentVol: number;
  volChange: number;
  volChangePct: number;
  volLevel: "extreme_fear" | "elevated" | "normal" | "low" | "complacent";
  isExpanding: boolean;
  vannaSignal: VannaSignal;
  description: string;
}

export interface CrossAssetConsensus {
  cfd: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  assetsAnalyzed: string[];
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  consensusStrength: "strong" | "moderate" | "weak" | "none";
  details: string[];
}

export interface TradeSetup {
  asset: string;           // Primary analysis asset
  cfd: string;             // CFD to trade (NAS100, US30, XAUUSD)
  cfdLabel: string;
  tradeType: TradeType;    // NEW: Type of trade
  direction: "LONG" | "SHORT" | "NO_TRADE";
  score: number;           // 0-100

  // Entry in CFD price
  entryPrice: number;      // Analysis asset price
  cfdEntryPrice: number;   // NEW: CFD price for execution
  entryZone: DecisionLevel | null;

  // Dynamic SL/TP in CFD prices
  stopLoss: number;        // In CFD price
  stopLossPoints: number;  // In CFD points
  stopLossRiskUSD: number; // Risk in dollars
  stopLossReason: string;
  takeProfit1: number;     // In CFD price
  takeProfit1Points: number;
  takeProfit2: number;     // In CFD price
  takeProfit2Points: number;
  takeProfit3: number;     // NEW: Third TP for runners
  takeProfit3Points: number;
  takeProfitReason: string;
  riskRewardRatio: number;

  // Trade management
  breakEvenTrigger: number;
  trailingStopTrigger: number;

  // Trailing stop configuration (Mejora A)
  trailingStopConfig?: {
    tp1LockSL: number;         // SL level cuando toca TP1 (= entry price, breakeven)
    midTP1TP2LockSL: number;   // SL cuando llega a 50% de TP1→TP2 (= TP1)
    tp2TrailPct: number;       // % de trailing cuando supera TP2 (ej: 0.3 = 30% del rango TP1-TP2)
  };

  // 6 Confirmations
  gexConfirmed: boolean;
  gexDetail: string;
  hiroConfirmed: boolean;
  hiroDetail: string;
  tapeConfirmed: boolean;
  tapeDetail: string;
  levelConfirmed: boolean;  // Outlier/level near price
  levelDetail: string;
  vannaConfirmed: boolean;  // NEW: Vanna flow confirms
  vannaDetail: string;
  regimeConfirmed: boolean; // NEW: Gamma regime confirms
  regimeDetail: string;

  // Cross-asset consensus
  crossAssetConsensus: CrossAssetConsensus | null;

  // Official SG Levels context
  sgLevels: {
    callWall: number;
    putWall: number;
    keyGamma: number;
    maxGamma: number;
    volTrigger: number;
    impliedMove: number;
    impliedMovePct: number;
    gammaRegime: string;
  } | null;

  // Vanna context
  vannaSignal: VannaSignal;

  // Dynamic TP adjustment (from GEX change tracker)
  dynamicTP: {
    shouldAdjust: boolean;
    reason: string;
    action: "hold" | "tighten_tp" | "extend_tp" | "close_now" | "move_to_breakeven";
    adjustedTP1: number;  // Adjusted TP1 in CFD price (0 = no change)
    adjustedTP2: number;  // Adjusted TP2 in CFD price (0 = no change)
    confidence: number;   // 0-100
    lastChecked: string;
  };

  // Setup invalidation triggers
  invalidation: {
    gammaFlipLevel: number;    // Analysis price: setup invalid if crossed
    gammaFlipCFD: number;      // CFD price equivalent of gamma flip
    hiroReversed: boolean;     // HIRO currently against direction
    vixDangerLevel: number;    // VIX above this = danger for LONG indices
    conditions: string[];      // Human-readable invalidation conditions
  };

  // GEX strength at nearest level
  gexStrengthScore: number;   // 0-100: how strong is the GEX at the nearest level

  // Volatility intelligence
  ivRegime: "high_iv" | "normal_iv" | "low_iv";
  ivRank: number;
  skewBias: "put_skew" | "call_skew" | "neutral";
  highVolPoint: number;
  lowVolPoint: number;
  atmIV30: number;
  rv30: number;
  vrp: number;

  // Entry mode & quality (session filter + candle/distance confirmation)
  entryMode: "ENTRADA" | "VIGILANCIA" | "NO_OPERAR";
  entryQuality: "optimal" | "valid" | "caution" | "watch";
  entryNote: string;      // Human-readable entry quality explanation
  sessionLabel: string;   // e.g. "Almuerzo NY 10:30-13:30 CO"

  // OPEX context (Mejora C)
  opexContext?: {
    isWeeklyOPEX: boolean;
    isMonthlyOPEX: boolean;
    is0DTEOPEX: boolean;
    opexType: string;
    thresholdBoost: number;
  };

  // RL Adaptive Policy (multi-table Q-learning)
  adaptivePolicy?: {
    riskProfile: string;
    slMultiplier: number;
    tp1Pct: number;
    tp2Pct: number;
    tp3Pct: number;
    entryMode: string;
    setupTypeFilter: string;
    volumeMultiplier: number;
    confidence: number;
    isExploring: boolean;
    rlDirectionAction?: number;   // 0=LONG, 1=SHORT, 2=SKIP
    rlMarketStateKey?: string;    // 6-dim key for direction table (tape+hiro)
    // PPO Multi-Head decision tracking (Fase 2 PPO Puro)
    ppoStateAtEntry?: Record<string, number>;  // 46-feature state for learning
    ppoHeadActions?: Record<string, number>;   // Head choices for learning
    ppoHeadLogProbs?: Record<string, number>;  // Log probs for REINFORCE
  };

  // Context
  reason: string;
  details: string[];
  nearestLevels: DecisionLevel[];
  timestamp: string;
}

// ============ LEVEL CLASSIFICATION ============

export function classifyDecisionLevels(
  asset: AssetData,
  gex: GexData | null,
  sgLevels: OfficialSGLevels | null,
): DecisionLevel[] {
  const levels: DecisionLevel[] = [];
  const price = asset.currentPrice;
  if (!price || price === 0) return levels;

  const hasGex = GEX_ELIGIBLE_ASSETS.includes(asset.symbol);
  const gammaFlip = asset.gammaFlipLevel || 0;

  const candidates = asset.strikes
    .filter((s) => s.isNearPrice && Math.abs(s.totalGamma) > 0)
    .sort((a, b) => Math.abs(b.totalGamma) - Math.abs(a.totalGamma));

  if (candidates.length === 0) return levels;

  const gammaValues = candidates.map((s) => Math.abs(s.totalGamma));
  const mean = gammaValues.reduce((a, b) => a + b, 0) / gammaValues.length;
  const stdDev = Math.sqrt(
    gammaValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / gammaValues.length,
  );

  // Build top strike set for priority detection
  const topStrikeSet = new Map<number, number>(); // strike → rank (1, 2, 3)
  for (let i = 0; i < asset.topStrikes.length; i++) {
    topStrikeSet.set(asset.topStrikes[i].strike, i + 1);
  }

  // Build set of official SG level strikes for confluence detection
  const sgStrikes: Map<number, string> = new Map();
  if (sgLevels) {
    if (sgLevels.callWall > 0) sgStrikes.set(sgLevels.callWall, "Call Wall");
    if (sgLevels.putWall > 0) sgStrikes.set(sgLevels.putWall, "Put Wall");
    if (sgLevels.keyGamma > 0) sgStrikes.set(sgLevels.keyGamma, "Key Gamma");
    if (sgLevels.maxGamma > 0) sgStrikes.set(sgLevels.maxGamma, "Max Gamma");
    if (sgLevels.keyDelta > 0) sgStrikes.set(sgLevels.keyDelta, "Key Delta");
    if (sgLevels.volTrigger > 0) sgStrikes.set(sgLevels.volTrigger, "Vol Trigger");
    if (sgLevels.zeroGamma > 0) sgStrikes.set(sgLevels.zeroGamma, "Zero Gamma");
  }

  for (const strike of candidates) {
    const absGamma = Math.abs(strike.totalGamma);
    const distPct = strike.distancePct;

    let hierarchy: LevelHierarchy = "minor";
    if (absGamma > mean + 2 * stdDev) {
      hierarchy = "dominant";
    } else if (absGamma > mean + stdDev) {
      hierarchy = "reaction";
    }

    let bias: "buy" | "sell" | "neutral" = "neutral";
    let biasScore = 50;

    // Apply gammaFlip bias if asset has a valid flip level (works for SPX, DIA, GLD — any asset)
    if (gammaFlip > 0) {
      if (price < gammaFlip) {
        if (strike.strike < price) biasScore -= 15;
        else biasScore -= 10;
      } else {
        if (strike.strike < price) biasScore += 15;
        else biasScore += 10;
      }
    }

    if (strike.netPosTotal > 0) {
      if (strike.netPosCalls > strike.netPosPuts) biasScore += 10;
      else biasScore -= 10;
    } else if (strike.netPosTotal < 0) {
      if (Math.abs(strike.netPosPuts) > Math.abs(strike.netPosCalls)) biasScore += 5;
      else biasScore -= 5;
    }

    const callDominance =
      Math.abs(strike.callGammaNotional) /
      (Math.abs(strike.callGammaNotional) + Math.abs(strike.putGammaNotional) || 1);
    if (callDominance > 0.6) biasScore += 8;
    else if (callDominance < 0.4) biasScore -= 8;

    biasScore = Math.max(0, Math.min(100, biasScore));
    if (biasScore >= 60) bias = "buy";
    else if (biasScore <= 40) bias = "sell";

    // Dealer exposure: any asset with a valid gammaFlip gets long/short gamma label
    let dealerExposure: DecisionLevel["dealerExposure"] = "neutral";
    if (gammaFlip > 0) {
      dealerExposure = price > gammaFlip ? "long_gamma" : "short_gamma";
    }

    let flowBias: "bullish" | "bearish" | "neutral" = "neutral";
    if (strike.netPosCalls > 0 && strike.netPosCalls > Math.abs(strike.netPosPuts)) flowBias = "bullish";
    else if (strike.netPosPuts > 0 && strike.netPosPuts > Math.abs(strike.netPosCalls)) flowBias = "bearish";

    // Check confluence with official SG levels (within 0.3% tolerance)
    let confluenceWithSG = false;
    let sgLevelType = "";
    for (const [sgStrike, sgType] of Array.from(sgStrikes.entries())) {
      const tolerance = price * 0.003; // 0.3%
      if (Math.abs(strike.strike - sgStrike) <= tolerance) {
        confluenceWithSG = true;
        sgLevelType = sgType;
        // Boost hierarchy if confluent with SG level
        if (hierarchy === "minor") hierarchy = "reaction";
        else if (hierarchy === "reaction") hierarchy = "dominant";

        // Extra boost when gamma_ratio confirms dominance at this specific level
        const gammaRatio = sgLevels?.gammaRatio || 1;
        if (sgType === "Call Wall" && gammaRatio > 1.5) {
          // Call gamma dominates → Call Wall is extra strong ceiling
          hierarchy = "dominant";
          sgLevelType = `Call Wall (gamma_ratio ${gammaRatio.toFixed(2)} - calls dominan)`;
        } else if (sgType === "Put Wall" && gammaRatio < 0.67) {
          // Put gamma dominates → Put Wall is extra strong floor
          hierarchy = "dominant";
          sgLevelType = `Put Wall (gamma_ratio ${gammaRatio.toFixed(2)} - puts dominan)`;
        }
        break;
      }
    }

    // Boost for top strikes (highest absolute gamma near price)
    const topRank = topStrikeSet.get(strike.strike);
    const isTop = topRank !== undefined;
    if (isTop) {
      if (topRank === 1) {
        // #1 top strike: force dominant
        hierarchy = "dominant";
      } else {
        // #2, #3: boost one tier
        if (hierarchy === "minor") hierarchy = "reaction";
        else if (hierarchy === "reaction") hierarchy = "dominant";
      }
    }

    levels.push({
      strike: strike.strike,
      hierarchy, bias, biasScore,
      gammaNotional: strike.totalGamma,
      callGammaNotional: strike.callGammaNotional,
      putGammaNotional: strike.putGammaNotional,
      outlierScore: strike.outlierScore,
      distanceFromPrice: strike.distanceFromPrice,
      distancePct: strike.distancePct,
      isNearPrice: strike.isNearPrice,
      dealerExposure, netPositioning: strike.netPosTotal, flowBias,
      confluenceWithSG, sgLevelType,
      isTopStrike: isTop,
      topStrikeRank: topRank,
    });
  }

  return levels.sort((a, b) => a.distanceFromPrice - b.distanceFromPrice);
}

// ============ VANNA TRADE DETECTION ============

export function detectVannaFlow(
  asset: AssetData,
  volAnalysis: VolatilityAnalysis,
): VannaSignal {
  const priceRising = asset.dailyChangePct > 0;
  const priceFalling = asset.dailyChangePct < 0;
  const volDropping = volAnalysis.volChangePct < -1;
  const volRising = volAnalysis.volChangePct > 1;

  if (volDropping && priceRising) {
    const strength = volAnalysis.volChangePct < -3 ? "strong" : volAnalysis.volChangePct < -2 ? "moderate" : "weak";
    return {
      detected: true, type: "bullish_vanna",
      description: `Vanna ALCISTA: Vol cae ${Math.abs(volAnalysis.volChangePct).toFixed(1)}% + precio sube ${asset.dailyChangePct.toFixed(2)}%. Dealers compran futuros.`,
      strength, volDropping: true, priceRising: true, dealersMustBuyFutures: true,
    };
  }

  if (volRising && priceFalling) {
    const strength = volAnalysis.volChangePct > 3 ? "strong" : volAnalysis.volChangePct > 2 ? "moderate" : "weak";
    return {
      detected: true, type: "bearish_vanna",
      description: `Vanna BAJISTA: Vol sube ${volAnalysis.volChangePct.toFixed(1)}% + precio cae ${Math.abs(asset.dailyChangePct).toFixed(2)}%. Dealers venden futuros.`,
      strength, volDropping: false, priceRising: false, dealersMustBuyFutures: false,
    };
  }

  return {
    detected: false, type: "none",
    description: "Sin flujo Vanna significativo.",
    strength: "none", volDropping, priceRising, dealersMustBuyFutures: false,
  };
}

// ============ VOLATILITY ANALYSIS ============

export function analyzeVolatility(
  asset: AssetData,
  vixAsset: AssetData | null,
  uvixAsset: AssetData | null,
): VolatilityAnalysis {
  const isGold = asset.symbol === "GLD";
  const isIndex = ["SPX", "SPY", "QQQ", "DIA"].includes(asset.symbol);

  let volSource = "VIX";
  let volPrice = vixAsset?.currentPrice || 0;
  let volChange = vixAsset?.dailyChange || 0;
  let volChangePct = vixAsset?.dailyChangePct || 0;

  if (isGold) {
    volSource = "GLD IV";
    // For gold, use its own IV change (from equities API)
    // Fallback to UVXY if no IV data
    if (uvixAsset) {
      volPrice = uvixAsset.currentPrice;
      volChange = uvixAsset.dailyChange;
      volChangePct = uvixAsset.dailyChangePct;
      volSource = "UVXY";
    }
  }

  let volLevel: VolatilityAnalysis["volLevel"] = "normal";
  if (volPrice > 35) volLevel = "extreme_fear";
  else if (volPrice > 25) volLevel = "elevated";
  else if (volPrice > 15) volLevel = "normal";
  else if (volPrice > 12) volLevel = "low";
  else volLevel = "complacent";

  const isExpanding = volChangePct > 0;

  const volAnalysisPartial: VolatilityAnalysis = {
    asset: asset.symbol, volatilitySource: volSource,
    currentVol: volPrice, volChange, volChangePct, volLevel, isExpanding,
    vannaSignal: { detected: false, type: "none", description: "", strength: "none", volDropping: false, priceRising: false, dealersMustBuyFutures: false },
    description: "",
  };

  const vannaSignal = detectVannaFlow(asset, volAnalysisPartial);

  const description =
    `${volSource}: ${volPrice.toFixed(2)} (${volChangePct > 0 ? "+" : ""}${volChangePct.toFixed(1)}%). ` +
    `Nivel: ${volLevel.replace("_", " ").toUpperCase()}. ` +
    (vannaSignal.detected ? vannaSignal.description : "Sin Vanna flow.");

  return { ...volAnalysisPartial, vannaSignal, description };
}

// ============ CROSS-ASSET STRIKE LEVELS (SPY/QQQ → SPX-equivalent) ============

/**
 * Adds gamma levels from companion assets (SPY, QQQ) to the NAS100/US30 level pool.
 *
 * Proximity is evaluated in each companion's OWN price scale — this is the only
 * accurate way to answer "is the market near this gamma level?":
 *   - Converting QQQ $585 → SPX $6,540 introduces ratio drift error (~50-100 pts on gap days).
 *   - Checking |$585 - QQQ_live| / QQQ_live directly has zero conversion error.
 *
 * QQQ levels are especially reliable for NAS100 because both track Nasdaq-100.
 * SPY levels are reliable for direction signal; their SPX-equivalent is stable (~10x).
 *
 * The strike stored in DecisionLevel is kept in primary (SPX/DIA) space so the rest
 * of the engine (biasScore, SL/TP conversion) stays consistent. distancePct is set
 * from the companion's own scale — the number that actually matters for entry quality.
 */
function getCrossAssetDecisionLevels(
  primaryAsset: AssetData,
  companionAssets: AssetData[],
): DecisionLevel[] {
  const extra: DecisionLevel[] = [];
  const primaryPrice = primaryAsset.currentPrice;
  if (!primaryPrice) return extra;

  for (const companion of companionAssets) {
    if (!companion.currentPrice || companion.symbol === primaryAsset.symbol) continue;

    const companionPrice = companion.currentPrice;
    const ratio          = primaryPrice / companionPrice; // e.g. SPX/SPY ≈ 10, SPX/QQQ ≈ 11.2

    const topStrikes = [...(companion.outlierStrikes || []), ...(companion.topStrikes || [])].slice(0, 5);

    for (const s of topStrikes) {
      // ── Proximity check in companion's OWN scale ──────────────────────────
      // This avoids ratio-drift errors that appear on gap days or tech-rotation days.
      const companionDist    = Math.abs(s.strike - companionPrice);
      const companionDistPct = (companionDist / companionPrice) * 100;
      if (companionDist > 2.0) continue; // pre-filtro generoso: solo excluye niveles a más de $2 del precio

      // ── Convert strike to primary space (SPX/DIA) for engine consistency ──
      const normalizedStrike = s.strike * ratio;
      const distFromPrimary  = Math.abs(normalizedStrike - primaryPrice);

      extra.push({
        strike: normalizedStrike,
        hierarchy: s.isOutlier ? "dominant" : "reaction",
        bias: "neutral",
        biasScore: 50,
        gammaNotional:      s.totalGamma,
        callGammaNotional:  s.callGammaNotional,
        putGammaNotional:   s.putGammaNotional,
        outlierScore:       s.outlierScore || 0,
        distanceFromPrice:  distFromPrimary,
        distancePct:        companionDistPct,
        isNearPrice:        companionDist <= 0.5,
        dealerExposure:     "neutral",
        netPositioning:     s.netPosTotal || 0,
        flowBias:           "neutral",
        confluenceWithSG:   false,
        isTopStrike:        false,
        isCrossAsset:       true,
        companionAbsDist:   companionDist,  // dólares exactos entre strike y precio del companion
        sgLevelType: `${companion.symbol} $${s.strike} (×${ratio.toFixed(1)} → SPX ~$${normalizedStrike.toFixed(0)})`,
      });
    }
  }

  return extra;
}

// ============ CROSS-ASSET CONSENSUS ============

function buildCrossAssetConsensus(
  cfdTarget: string,
  assets: AssetData[],
  gex: GexData | null,
  hiro: HiroData | null,
  sgLevels: Record<string, OfficialSGLevels>,
): CrossAssetConsensus | null {
  const group = CROSS_ASSET_GROUPS[cfdTarget];
  if (!group) return null;

  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  const details: string[] = [];
  const assetsAnalyzed: string[] = [];

  for (const sym of group.assets) {
    const asset = assets.find(a => a.symbol === sym);
    if (!asset || asset.currentPrice === 0) continue;
    assetsAnalyzed.push(sym);

    let assetBias: "bullish" | "bearish" | "neutral" = "neutral";
    const reasons: string[] = [];

    // Factor 1: HIRO direction
    const hiroData = hiro?.perAsset?.[sym];
    if (hiroData) {
      if (hiroData.hiroTrend === "bullish") { reasons.push("HIRO+"); assetBias = "bullish"; }
      else if (hiroData.hiroTrend === "bearish") { reasons.push("HIRO-"); assetBias = "bearish"; }
    }

    // Factor 2: Gamma regime
    const levels = sgLevels[sym];
    if (levels) {
      if (levels.gammaRegime === "positive") {
        reasons.push("Gamma+");
        if (assetBias === "neutral") assetBias = "bullish";
      } else if (levels.gammaRegime === "very_negative") {
        reasons.push("Gamma--");
        if (assetBias === "neutral") assetBias = "bearish";
      }
    }

    // Factor 3: Price vs key levels
    if (asset.dailyChangePct > 0.3) { reasons.push(`+${asset.dailyChangePct.toFixed(1)}%`); }
    else if (asset.dailyChangePct < -0.3) { reasons.push(`${asset.dailyChangePct.toFixed(1)}%`); }

    if (assetBias === "bullish") bullishCount++;
    else if (assetBias === "bearish") bearishCount++;
    else neutralCount++;

    details.push(`${sym}: ${assetBias.toUpperCase()} (${reasons.join(", ") || "neutral"})`);
  }

  const total = bullishCount + bearishCount + neutralCount;
  let direction: CrossAssetConsensus["direction"] = "NEUTRAL";
  let consensusStrength: CrossAssetConsensus["consensusStrength"] = "none";

  if (bullishCount >= group.requiredConsensus && bullishCount > bearishCount) {
    direction = "LONG";
    consensusStrength = bullishCount === total ? "strong" : bullishCount >= total - 1 ? "moderate" : "weak";
  } else if (bearishCount >= group.requiredConsensus && bearishCount > bullishCount) {
    direction = "SHORT";
    consensusStrength = bearishCount === total ? "strong" : bearishCount >= total - 1 ? "moderate" : "weak";
  }

  return { cfd: cfdTarget, direction, assetsAnalyzed, bullishCount, bearishCount, neutralCount, consensusStrength, details };
}

// ============ BREAKOUT DETECTION ============
//
// In negative/very_negative gamma regime, dealers are short gamma → they AMPLIFY moves
// (sell as price falls, buy as price rises). Key SG walls (Put Wall, Call Wall, Key Gamma)
// tend to BREAK rather than hold. This function detects when price is near a wall with
// overwhelming flow confirmation of the break, and returns a breakout trade signal.
//
// Breakout SHORT: price near Put Wall from above + bearish flow → ruptura bajista
// Breakout LONG:  price near Call Wall from below + bullish flow → ruptura alcista
//

interface BreakoutSignal {
  direction: "LONG" | "SHORT";
  wallName: string;
  wallPrice: number;       // in analysis asset price space
  wallCFDPrice: number;    // in CFD space
  wallLevel: DecisionLevel | null;
  flowScore: number;       // how many flow signals confirm (0-5)
  reason: string;
}

// ============ BOUNCE DETECTION ============
// Triggered when price is just above a key GEX support level after a bounce:
//   • Positive gamma regime (mean reversion) → Vol Trigger / Zero Gamma / Max Gamma
//   • Any regime: Gamma Flip crossed upward (structural bullish shift)
//   • Any regime: Put Wall respected (price bounced off strongest put support)

interface BounceSignal {
  direction: "LONG" | "SHORT";  // LONG = rebote desde soporte | SHORT = rechazo desde resistencia
  levelLabel: string;           // "Put Wall" | "Call Wall" | "Gamma Flip" | "Vol Trigger" | "Key Gamma" | "GEX $XXXX"
  levelPrice: number;           // Analysis asset price
  levelCFDPrice: number;        // CFD equivalent
  distancePct: number;          // % de distancia al nivel (precio ya alejado del nivel)
  regimeType: "positive" | "negative" | "very_negative" | "neutral";
  reason: string;
  // compat aliases
  supportLevel: string;
  supportPrice: number;
  supportCFDPrice: number;
}

function detectBounce(
  asset: AssetData,
  sgLevels: OfficialSGLevels | null,
  allLevels: DecisionLevel[],   // todos los niveles GEX individuales por strike
  cfdTarget: string,
  cfdPrice: number,
  etfGex: Record<string, TradierGexData>,
): BounceSignal[] {
  if (!sgLevels || cfdPrice <= 0) return [];
  const price = asset.currentPrice;
  if (price <= 0) return [];

  const toCFD = (lvl: number) => cfdPrice + (lvl - price) / price * cfdPrice;

  // FIX 10: gammaFlipLevel for XAUUSD comes from GLD ETF scale (~$300).
  // primaryAsset.currentPrice is also GLD (~$300). The toCFD() function
  // converts correctly to CFD scale (~$3000+). This is by design.
  const primarySym = cfdTarget === "XAUUSD" ? "GLD" : cfdTarget === "US30" ? "DIA" : null;
  const etfData = primarySym ? etfGex?.[primarySym] : null;
  const gammaFlip = (etfData?.gammaFlipLevel && etfData.gammaFlipLevel > 0)
    ? etfData.gammaFlipLevel : (asset.gammaFlipLevel || 0);

  const regime = sgLevels.gammaRegime;
  const isPositive = regime === "positive";

  // ─── CANDIDATOS: cada entrada tiene dir, nombre, nivel, prioridad, restricción de régimen ───
  type Cand = { dir: "LONG" | "SHORT"; name: string; level: number; priority: number; anyRegime: boolean };
  const candidates: Cand[] = [];

  // ── LONG desde soporte (precio ya POR ENCIMA del nivel) ──────────────
  const addLong = (name: string, level: number, priority: number, anyRegime: boolean) => {
    if (level <= 0 || price <= level) return;
    const d = (price - level) / price * 100;
    if (d >= 0.05 && d <= 2.5) candidates.push({ dir: "LONG", name, level, priority, anyRegime });
  };

  addLong("Put Wall",    sgLevels.putWall,    5, true);   // soporte más fuerte — cualquier régimen
  addLong("Gamma Flip",  gammaFlip,           4, true);   // cruce alcista del flip — cualquier régimen
  addLong("Zero Gamma",  sgLevels.zeroGamma,  4, true);   // igual que Gamma Flip
  addLong("Vol Trigger", sgLevels.volTrigger, 3, false);  // solo gamma positivo (mean-rev)
  addLong("Key Gamma",   sgLevels.keyGamma,   3, true);
  addLong("Max Gamma",   sgLevels.maxGamma,   2, false);  // solo gamma positivo

  // Todos los niveles GEX individuales debajo del precio (soporte)
  for (const lvl of allLevels) {
    if (lvl.strike >= price) continue;
    if (lvl.hierarchy === "minor") continue;          // solo dominant y reaction
    if ((lvl.biasScore ?? 50) < 55) continue;         // sesgo comprador
    const d = (price - lvl.strike) / price * 100;
    if (d < 0.05 || d > 2.5) continue;
    const prio = lvl.hierarchy === "dominant" ? 4 : 2;
    candidates.push({ dir: "LONG", name: `GEX $${lvl.strike.toLocaleString()} (${lvl.hierarchy})`, level: lvl.strike, priority: prio, anyRegime: true });
  }

  // ── SHORT desde resistencia (precio ya POR DEBAJO del nivel) ─────────
  const addShort = (name: string, level: number, priority: number, anyRegime: boolean) => {
    if (level <= 0 || price >= level) return;
    const d = (level - price) / price * 100;
    if (d >= 0.05 && d <= 2.5) candidates.push({ dir: "SHORT", name, level, priority, anyRegime });
  };

  addShort("Call Wall",   sgLevels.callWall,   5, true);   // resistencia más fuerte
  addShort("Gamma Flip",  gammaFlip,           4, true);   // cruce bajista del flip
  addShort("Zero Gamma",  sgLevels.zeroGamma,  4, true);
  addShort("Key Gamma",   sgLevels.keyGamma,   3, true);
  addShort("Vol Trigger", sgLevels.volTrigger, 3, false);  // solo gamma positivo
  addShort("Max Gamma",   sgLevels.maxGamma,   2, false);

  // Todos los niveles GEX individuales por encima del precio (resistencia)
  for (const lvl of allLevels) {
    if (lvl.strike <= price) continue;
    if (lvl.hierarchy === "minor") continue;
    if ((lvl.biasScore ?? 50) > 45) continue;         // sesgo vendedor
    const d = (lvl.strike - price) / price * 100;
    if (d < 0.05 || d > 2.5) continue;
    const prio = lvl.hierarchy === "dominant" ? 4 : 2;
    candidates.push({ dir: "SHORT", name: `GEX $${lvl.strike.toLocaleString()} (${lvl.hierarchy})`, level: lvl.strike, priority: prio, anyRegime: true });
  }

  if (candidates.length === 0) return [];

  // Filtrar por régimen y ordenar por prioridad
  const valid = candidates.filter(c => c.anyRegime || isPositive);
  if (valid.length === 0) return [];

  valid.sort((a, b) => b.priority - a.priority);

  return valid.slice(0, 4).map(best => {
    const distPct = best.dir === "LONG"
      ? (price - best.level) / price * 100
      : (best.level - price) / price * 100;
    const levelCFDPrice = toCFD(best.level);
    const verb = best.dir === "LONG" ? "REBOTE" : "RECHAZO";
    const prep = best.dir === "LONG" ? "sobre soporte" : "bajo resistencia";
    const reason = `${verb} ${best.name} $${best.level.toLocaleString()} — precio ${distPct.toFixed(2)}% ${prep} | Regime: ${regime}`;
    return {
      direction:      best.dir,
      levelLabel:     best.name,
      levelPrice:     best.level,
      levelCFDPrice,
      distancePct:    distPct,
      regimeType:     regime as BounceSignal["regimeType"],
      reason,
      // compat
      supportLevel:    best.name,
      supportPrice:    best.level,
      supportCFDPrice: levelCFDPrice,
    };
  });
}

function detectBreakout(
  primaryAsset: AssetData,
  sgLevels: OfficialSGLevels | null,
  cfdTarget: string,
  cfdPrice: number,
  levels: DecisionLevel[],
  hiro: HiroData | null,
  tape: TapeData | null,
  vannaContext: VannaContext | null,
  groupAssets: string[],
  traceData: TraceData | null | undefined,
  etfGex: Record<string, TradierGexData> | undefined,
  vixLevel: number = 20,
): BreakoutSignal | null {
  // ── Gate 1: gamma regime MUST be negative or very_negative ────────────
  if (!sgLevels) return null;
  const regime = sgLevels.gammaRegime;
  if (regime !== "negative" && regime !== "very_negative") return null;

  const price = primaryAsset.currentPrice;
  if (!price || price <= 0 || cfdPrice <= 0) return null;

  // ── Gate 2: find levels within proximity ────────────────────────────────
  // Includes BOTH official SG walls AND any reaction/dominant decision level.
  // 0.8% for normal, 1.2% for very_negative (price accelerates → wider window)
  const vixMultiplier = Math.min(2.5, Math.max(1.0, (vixLevel || 20) / 20));
  const baseProximityPct = regime === "very_negative" ? 0.015 : 0.010;
  const proximityPct = baseProximityPct * vixMultiplier;

  interface WallCandidate {
    name: string;
    wallPrice: number;
    breakDirection: "LONG" | "SHORT";
    distPct: number;   // absolute distance as % of price
    priority: number;  // lower = higher priority (SG walls > dominant > reaction)
  }

  const candidates: WallCandidate[] = [];
  const addedStrikes = new Set<number>(); // avoid duplicates

  // ── A) Official SG walls (highest priority) ─────────────────────────
  // Put Wall: price above or at it → SHORT breakout (breaking support)
  if (sgLevels.putWall > 0) {
    const dist = (price - sgLevels.putWall) / price;
    if (dist >= -0.003 && dist <= proximityPct) {
      candidates.push({ name: "Put Wall", wallPrice: sgLevels.putWall, breakDirection: "SHORT", distPct: dist * 100, priority: 0 });
      addedStrikes.add(sgLevels.putWall);
    }
  }

  // Call Wall: price below or at it → LONG breakout (breaking resistance)
  if (sgLevels.callWall > 0) {
    const dist = (sgLevels.callWall - price) / price;
    if (dist >= -0.003 && dist <= proximityPct) {
      candidates.push({ name: "Call Wall", wallPrice: sgLevels.callWall, breakDirection: "LONG", distPct: dist * 100, priority: 0 });
      addedStrikes.add(sgLevels.callWall);
    }
  }

  // Key Gamma: pivot — direction depends on approach side
  if (sgLevels.keyGamma > 0 && sgLevels.keyGamma !== sgLevels.putWall && sgLevels.keyGamma !== sgLevels.callWall) {
    const dist = Math.abs(price - sgLevels.keyGamma) / price;
    if (dist <= proximityPct) {
      const breakDir: "LONG" | "SHORT" = price >= sgLevels.keyGamma ? "SHORT" : "LONG";
      candidates.push({ name: "Key Gamma", wallPrice: sgLevels.keyGamma, breakDirection: breakDir, distPct: dist * 100, priority: 0 });
      addedStrikes.add(sgLevels.keyGamma);
    }
  }

  // Vol Trigger: important regime boundary
  if (sgLevels.volTrigger > 0 && !addedStrikes.has(sgLevels.volTrigger)) {
    const dist = Math.abs(price - sgLevels.volTrigger) / price;
    if (dist <= proximityPct) {
      const breakDir: "LONG" | "SHORT" = price >= sgLevels.volTrigger ? "SHORT" : "LONG";
      candidates.push({ name: "Vol Trigger", wallPrice: sgLevels.volTrigger, breakDirection: breakDir, distPct: dist * 100, priority: 1 });
      addedStrikes.add(sgLevels.volTrigger);
    }
  }

  // Max Gamma
  if (sgLevels.maxGamma > 0 && !addedStrikes.has(sgLevels.maxGamma)) {
    const dist = Math.abs(price - sgLevels.maxGamma) / price;
    if (dist <= proximityPct) {
      const breakDir: "LONG" | "SHORT" = price >= sgLevels.maxGamma ? "SHORT" : "LONG";
      candidates.push({ name: "Max Gamma", wallPrice: sgLevels.maxGamma, breakDirection: breakDir, distPct: dist * 100, priority: 1 });
      addedStrikes.add(sgLevels.maxGamma);
    }
  }

  // ── B) Decision levels: reaction and dominant strikes ──────────────
  // These are the gamma strikes already classified by classifyDecisionLevels.
  // In negative gamma, ANY significant level can break — not just SG walls.
  for (const level of levels) {
    if (level.hierarchy === "minor") continue; // only reaction/dominant
    if (addedStrikes.has(level.strike)) continue; // avoid duplicates with SG walls
    const dist = Math.abs(level.strike - price) / price;
    if (dist > proximityPct) continue;

    // Direction: if price is above the level → SHORT breakout through it
    //            if price is below the level → LONG breakout through it
    const breakDir: "LONG" | "SHORT" = price >= level.strike ? "SHORT" : "LONG";
    const label = level.confluenceWithSG
      ? `Gamma ${level.hierarchy} + ${level.sgLevelType}`
      : `Gamma ${level.hierarchy} $${level.strike.toLocaleString()}`;
    const priorityRank = level.hierarchy === "dominant" ? 2 : 3;

    candidates.push({ name: label, wallPrice: level.strike, breakDirection: breakDir, distPct: dist * 100, priority: priorityRank });
    addedStrikes.add(level.strike);
  }

  if (candidates.length === 0) return null;

  // Sort: SG walls first (priority 0), then dominant (2), then reaction (3), then by proximity
  candidates.sort((a, b) => a.priority - b.priority || a.distPct - b.distPct);

  // ── Gate 3: check institutional flow alignment for each candidate ──────
  for (const candidate of candidates) {
    const dir = candidate.breakDirection;
    let flowCount = 0;
    const flowDetails: string[] = [];

    // Flow 1: HIRO consensus across group assets
    if (hiro) {
      let hiroBull = 0, hiroBear = 0;
      for (const sym of groupAssets) {
        const t = hiro.perAsset?.[sym]?.hiroTrend;
        if (t === "bullish") hiroBull++;
        else if (t === "bearish") hiroBear++;
      }
      if (dir === "SHORT" && hiroBear > hiroBull) {
        flowCount++;
        flowDetails.push(`HIRO bajista (${hiroBear}/${groupAssets.length})`);
      } else if (dir === "LONG" && hiroBull > hiroBear) {
        flowCount++;
        flowDetails.push(`HIRO alcista (${hiroBull}/${groupAssets.length})`);
      }
    }

    // Flow 2: Tape (options flow sentiment)
    if (tape?.perAsset) {
      const assetFlow = tape.perAsset[primaryAsset.symbol];
      if (assetFlow && assetFlow.totalTrades > 0) {
        if (dir === "SHORT" && (assetFlow.sentiment === "bearish" || assetFlow.sentimentScore < 42)) {
          flowCount++;
          flowDetails.push(`Tape bajista (${assetFlow.sentimentScore})`);
        } else if (dir === "LONG" && (assetFlow.sentiment === "bullish" || assetFlow.sentimentScore > 58)) {
          flowCount++;
          flowDetails.push(`Tape alcista (${assetFlow.sentimentScore})`);
        }
      }
    }

    // Flow 3: Vanna (VIX/IV mechanics)
    if (vannaContext) {
      if (cfdTarget === "NAS100" || cfdTarget === "US30") {
        if (dir === "SHORT" && vannaContext.vixVannaSignal === "bearish") {
          flowCount++;
          flowDetails.push(`Vanna bajista (VIX +${Math.abs(vannaContext.vixChangePct).toFixed(1)}%)`);
        } else if (dir === "LONG" && vannaContext.vixVannaSignal === "bullish") {
          flowCount++;
          flowDetails.push(`Vanna alcista (VIX ${vannaContext.vixChangePct.toFixed(1)}%)`);
        }
      } else if (cfdTarget === "XAUUSD") {
        if (dir === "SHORT" && vannaContext.gldVannaSignal === "bearish") {
          flowCount++;
          flowDetails.push("Vanna GLD bajista");
        } else if (dir === "LONG" && (vannaContext.gldVannaSignal === "bullish" || vannaContext.refugeFlowActive)) {
          flowCount++;
          flowDetails.push("Vanna GLD alcista");
        }
      }
    }

    // Flow 4: GEX bias (0DTE TRACE for NAS100, own GEX for US30/XAUUSD)
    if (cfdTarget === "NAS100" && traceData && traceData.netGexBias) {
      if (dir === "SHORT" && traceData.netGexBias === "bearish") {
        flowCount++;
        flowDetails.push(`0DTE GEX bajista (ratio ${traceData.gexRatio?.toFixed(2) || "N/A"})`);
      } else if (dir === "LONG" && traceData.netGexBias === "bullish") {
        flowCount++;
        flowDetails.push(`0DTE GEX alcista (ratio ${traceData.gexRatio?.toFixed(2) || "N/A"})`);
      }
    } else if (cfdTarget === "US30" && etfGex?.["DIA"]) {
      if (dir === "SHORT" && etfGex["DIA"].netBias === "bearish") {
        flowCount++;
        flowDetails.push("GEX DIA bajista");
      } else if (dir === "LONG" && etfGex["DIA"].netBias === "bullish") {
        flowCount++;
        flowDetails.push("GEX DIA alcista");
      }
    } else if (cfdTarget === "XAUUSD" && etfGex?.["GLD"]) {
      if (dir === "SHORT" && etfGex["GLD"].netBias === "bearish") {
        flowCount++;
        flowDetails.push("GEX GLD bajista");
      } else if (dir === "LONG" && etfGex["GLD"].netBias === "bullish") {
        flowCount++;
        flowDetails.push("GEX GLD alcista");
      }
    }

    // Flow 5: Options skew (put_skew → bearish pressure, call_skew → complacency)
    const neSkew = sgLevels.neSkew || 0;
    if (dir === "SHORT" && neSkew < -0.05) {
      flowCount++;
      flowDetails.push(`Put skew (${neSkew.toFixed(3)})`);
    } else if (dir === "LONG" && neSkew > 0.05) {
      flowCount++;
      flowDetails.push(`Call skew (${neSkew.toFixed(3)})`);
    }

    // ── Minimum flow threshold ───────────────────────────────────────────
    // very_negative regime: 2/5 signals (regime itself is very strong)
    // negative regime: 3/5 signals (need more external confirmation)
    const minFlow = regime === "very_negative" ? 2 : 3;
    if (flowCount < minFlow) continue;

    // ── Find DecisionLevel nearest to the wall ───────────────────────────
    const wallLevel = levels
      .filter(l => Math.abs(l.strike - candidate.wallPrice) / price < 0.005)
      .sort((a, b) =>
        Math.abs(a.strike - candidate.wallPrice) - Math.abs(b.strike - candidate.wallPrice),
      )[0] || null;

    // Convert wall to CFD price
    const wallCFDPrice = cfdPrice + (candidate.wallPrice - price) / price * cfdPrice;

    const emoji = dir === "SHORT" ? "🔻" : "🔺";
    const reason =
      `${emoji} RUPTURA ${candidate.name} $${candidate.wallPrice.toLocaleString()} (${candidate.distPct.toFixed(2)}%) | ` +
      `Gamma ${regime === "very_negative" ? "MUY " : ""}NEGATIVO + ${flowCount}/5 flujos confirman: ${flowDetails.join(", ")}`;

    return { direction: dir, wallName: candidate.name, wallPrice: candidate.wallPrice, wallCFDPrice, wallLevel, flowScore: flowCount, reason };
  }

  return null;
}

// ============ CFD PRICE CONVERSION ============

function convertToCFDPrice(
  analysisAsset: string,
  analysisPrice: number,
  cfdTarget: string,
  cfdPrices: CFDPriceData | null,
): number {
  if (!cfdPrices) return 0;

  if (cfdTarget === "NAS100") return cfdPrices.nas100.price;
  if (cfdTarget === "US30") return cfdPrices.us30.price;
  if (cfdTarget === "XAUUSD") return cfdPrices.xauusd.price;
  return 0;
}

function convertPointsToCFD(
  analysisAsset: string,
  analysisPoints: number,
  cfdTarget: string,
  analysisPrice: number,
  cfdPrice: number,
): number {
  if (analysisPrice === 0 || cfdPrice === 0) return 0;
  // Convert using percentage: same % move in analysis = same % move in CFD
  const pctMove = analysisPoints / analysisPrice;
  return pctMove * cfdPrice;
}

// ============ SESSION FILTER & ENTRY QUALITY ============

interface SessionContext {
  session: "apertura" | "tendencia_am" | "almuerzo" | "retoma" | "power_hour" | "fuera";
  sessionLabel: string;
  isLunch: boolean;       // NY lunch = watch-only by default
  scoreThreshold: number; // Minimum score for ENTRADA
  watchThreshold: number; // Minimum score to show as VIGILANCIA
}

/** Detects current trading session in ET time, displays in Colombia time. */
// getSessionContext() removed: sessionType is now a PPO feature, not a rule (Fase 3 PPO Puro)

interface EntryQuality {
  quality: "optimal" | "valid" | "caution" | "watch";
  note: string;
}

/**
 * Assesses entry quality based on:
 * 1. Distance to nearest gamma level (tight = better)
 * 2. Rejection confirmation: for SHORT at resistance price should be BELOW level,
 *    for LONG at support price should be ABOVE level (proxy for candle rejection).
 */
function assessEntryQuality(
  direction: "LONG" | "SHORT" | "NO_TRADE",
  entryLevel: DecisionLevel | null,
  currentPrice: number,
  hiroConfirmed: boolean = false,
  tapeConfirmed: boolean = false,
  hiroAvailable: boolean = false,
  tapeAvailable: boolean = false,
): EntryQuality {
  if (direction === "NO_TRADE" || !entryLevel) {
    return { quality: "watch", note: "Sin nivel de entrada definido." };
  }

  const level = entryLevel.strike;
  const distAbs = Math.abs(currentPrice - level); // absolute points
  const distPct = distAbs / level * 100;

  // ── Multi-factor rejection confirmation ────────────────────────────────
  // Factor 1 (required): price is on the correct side of the level
  //   SHORT at resistance → price already below level (started rejecting)
  //   LONG  at support    → price already above level (started bouncing)
  const priceAtCorrectSide =
    (direction === "SHORT" && currentPrice < level) ||
    (direction === "LONG"  && currentPrice > level);

  // Factor 2 (flow): HIRO trend or tape flow agrees with direction.
  // HIRO is the primary flow signal (intraday options momentum).
  // Tape is secondary (actual premium flow).
  // If neither data source is available → fall back to price-position only.
  const hasFlowData   = hiroAvailable || tapeAvailable;
  const flowConfirms  = hiroConfirmed || tapeConfirmed;

  // Rejection requires price on correct side.
  // When flow data exists, it must also agree (prevents false rejections where
  // price dipped below resistance but HIRO is still bullish → no real rejection).
  const showingRejection = priceAtCorrectSide && (!hasFlowData || flowConfirms);

  // Build a label for the confirmation detail
  const rejectionDetail = showingRejection
    ? (() => {
        if (!hasFlowData) return "rechazo precio-proxy";
        const parts: string[] = [];
        if (hiroConfirmed)  parts.push("HIRO ✓");
        if (tapeConfirmed)  parts.push("Tape ✓");
        return parts.length ? parts.join(" + ") : "rechazo confirmado";
      })()
    : (() => {
        if (!priceAtCorrectSide) return "precio no ha tocado nivel";
        // price ok but flow disagrees
        const against: string[] = [];
        if (hiroAvailable && !hiroConfirmed) against.push("HIRO en contra");
        if (tapeAvailable && !tapeConfirmed) against.push("Tape en contra");
        return against.length ? against.join(", ") : "sin confirmación de flujo";
      })();

  // Asset-specific distance thresholds (all in %):
  //   SPX-scale (price > 1000):   optimal < 0.05% (~3 pts) | valid < 0.10% (~7 pts) | watch < 0.22% (~15 pts)
  //   ETF-scale (GLD/DIA ≤ 1000): optimal < 0.15% (~$0.64) | valid < 0.30% (~$1.28) | watch < 0.60% (~$2.56)
  //   GLD/DIA need wider % bands — strikes every $1, less granular gamma levels
  let zoneOptimal: boolean, zoneValid: boolean, zoneWatch: boolean;
  let distDisplay: string;

  if (currentPrice > 1000) {
    // SPX / index scale — very tight, every point matters
    zoneOptimal = distPct <= 0.05;
    zoneValid   = distPct <= 0.10;
    zoneWatch   = distPct <= 0.22;
    distDisplay = `${distAbs.toFixed(0)}pts (${distPct.toFixed(2)}%)`;
  } else {
    // ETF scale: GLD (~$426), DIA (~$463) — wider % because strikes at $1 intervals
    zoneOptimal = distPct <= 0.15;
    zoneValid   = distPct <= 0.30;
    zoneWatch   = distPct <= 0.60;
    distDisplay = `$${distAbs.toFixed(2)} (${distPct.toFixed(2)}%)`;
  }

  if (zoneOptimal && showingRejection)
    return { quality: "optimal", note: `$${level.toLocaleString()} (${distDisplay}) — ${rejectionDetail} — entrada óptima.` };

  if (zoneOptimal && !showingRejection)
    return { quality: "caution", note: `Precio en zona $${level.toLocaleString()} (${distDisplay}) pero ${rejectionDetail} — esperar confirmación.` };

  if (zoneValid && showingRejection)
    return { quality: "valid", note: `$${level.toLocaleString()} (${distDisplay}) — ${rejectionDetail} — entrada válida.` };

  if (zoneValid && !showingRejection)
    return { quality: "caution", note: `Acercándose a $${level.toLocaleString()} (${distDisplay}) — ${rejectionDetail} — sin confirmación aún.` };

  if (zoneWatch)
    return { quality: "watch", note: `$${level.toLocaleString()} lejos (${distDisplay}) — vigilar acercamiento.` };

  return { quality: "watch", note: `$${level.toLocaleString()} muy lejos (${distDisplay}) — no operar.` };
}

// ============ DYNAMIC SL/TP IN CFD PRICES ============

/**
 * Returns volatility-adaptive SL parameters based on VIX level and asset IV Rank.
 * VIX is the primary driver; IV Rank of the specific asset is secondary.
 *
 * VIX regimes:
 *   < 15  → calm     → tighter SL allowed
 *   15-20 → normal   → base SL
 *   20-25 → elevated → 1.4× wider SL, more risk budget
 *   25-30 → high     → 1.8× wider SL, more risk budget
 *   > 30  → extreme  → 2.5× wider SL, max risk budget
 *
 * IV Rank adds up to +35% on top.
 */
function getVolatilityAdjustedSLParams(
  vixPrice: number,
  ivRank: number,
  cfdTarget: string,
): { mult: number; dynamicMinSL: number; dynamicMaxRisk: number; volDesc: string } {
  // VIX-based base multiplier
  let vixMult: number;
  let regime: "calm" | "normal" | "elevated" | "high" | "extreme";
  if (vixPrice < 15)      { vixMult = 0.85; regime = "calm"; }
  else if (vixPrice < 20) { vixMult = 1.00; regime = "normal"; }
  else if (vixPrice < 25) { vixMult = 1.40; regime = "elevated"; }
  else if (vixPrice < 30) { vixMult = 1.80; regime = "high"; }
  else                    { vixMult = 2.50; regime = "extreme"; }

  // IV Rank secondary multiplier (asset-specific volatility)
  let ivMult = 1.0;
  if (ivRank > 70)      ivMult = 1.35;
  else if (ivRank > 50) ivMult = 1.20;
  else if (ivRank > 30) ivMult = 1.10;

  const mult = Math.min(vixMult * ivMult, 3.0); // cap at 3×

  // Dynamic minimum SL (pts) per asset per VIX regime
  // These are chosen so stops survive intraday noise at each vol level
  const MIN_SL_TABLE: Record<string, Record<string, number>> = {
    NAS100: { calm: 35,  normal: 55,  elevated: 90,  high: 130, extreme: 200 },
    US30:   { calm: 25,  normal: 40,  elevated: 60,  high: 80,  extreme: 100 }, // 0.1 lot → $0.10/pt
    XAUUSD: { calm: 10,  normal: 18,  elevated: 28,  high: 38,  extreme: 50  },
  };

  // Dynamic max risk ($) per asset per VIX regime
  // Higher vol → allow a bigger stop in $ to avoid getting chopped out
  const MAX_RISK_TABLE: Record<string, Record<string, number>> = {
    NAS100: { calm: 8,  normal: 10, elevated: 14, high: 18, extreme: 25 },
    US30:   { calm: 4,  normal: 6,  elevated: 8,  high: 10, extreme: 12 }, // $0.10/pt: 40pts=$4, 100pts=$10
    XAUUSD: { calm: 10, normal: 18, elevated: 25, high: 32, extreme: 45 }, // cap extremo en $45
  };

  const dynamicMinSL    = MIN_SL_TABLE[cfdTarget]?.[regime]    ?? CFD_SPECS[cfdTarget]?.minSLPoints ?? 10;
  const dynamicMaxRisk  = MAX_RISK_TABLE[cfdTarget]?.[regime]  ?? CFD_SPECS[cfdTarget]?.maxRiskUSD  ?? 10;

  const volDesc = `VIX ${vixPrice.toFixed(0)} (${regime}) ivRk ${ivRank}%`;
  return { mult, dynamicMinSL, dynamicMaxRisk, volDesc };
}

/**
 * Factor 2: GEX Regime multiplier.
 * In negative gamma, dealers amplify moves → wider SL needed.
 * In positive gamma, mean-reversion is likely → tighter SL is safer.
 */
function getGEXRegimeSLMult(gammaRegime: string): { mult: number; desc: string } {
  switch (gammaRegime) {
    case "very_negative": return { mult: 1.40, desc: "GEX muy neg" };
    case "negative":      return { mult: 1.20, desc: "GEX neg" };
    case "neutral":       return { mult: 1.00, desc: "GEX neutral" };
    case "positive":      return { mult: 0.88, desc: "GEX pos (mean-rev)" };
    case "very_positive": return { mult: 0.80, desc: "GEX muy pos" };
    default:              return { mult: 1.00, desc: "" };
  }
}

/**
 * Factor 3: Time-of-day multiplier, using ET (Eastern Time) sessions.
 * Colombia (UTC-5) during EDT season: CO = ET - 1hr (market opens 8:30 CO).
 * During EST season: CO = ET (market opens 9:30 CO).
 * Volatility pattern: wild at open, quiet at lunch, elevated at close.
 */
function getTimeOfDaySLMult(et?: ETTimeInfo): { mult: number; session: string } {
  const t = et || getETTime();
  const etMins = t.etMins;

  // Colombia display offset (CO = ET - 1 during EDT, CO = ET during EST)
  const coDiff = t.isEDT ? -1 : 0;
  const coOpen = `${9 + coDiff}:30-${10 + coDiff}:00`;

  // Market open = 9:30 ET, close = 16:00 ET
  if (etMins < 570 || etMins >= 960)   return { mult: 1.00, session: "pre/post mercado" };
  if (etMins < 600)                     return { mult: 1.35, session: `apertura ${coOpen} CO` };
  if (etMins < 690)                     return { mult: 1.00, session: "tendencia AM" };
  if (etMins < 870)                     return { mult: 0.80, session: "almuerzo NY (bajo vol)" };
  if (etMins < 900)                     return { mult: 1.10, session: "retoma tarde" };
  return                                       { mult: 1.30, session: "power hour" };
}

/**
 * Factor 4: Day-type multiplier.
 * OpEx days and Mondays have structurally higher volatility.
 */
function getDayTypeSLMult(sessionDate: string): { mult: number; desc: string } {
  const [y, mo, d] = sessionDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun, 5=Fri, 1=Mon

  if (dow === 5) {
    // Find 3rd Friday of the month
    let friCount = 0, thirdFri = 0;
    for (let i = 1; i <= 31; i++) {
      const test = new Date(Date.UTC(y, mo - 1, i));
      if (test.getUTCMonth() !== mo - 1) break;
      if (test.getUTCDay() === 5 && ++friCount === 3) { thirdFri = i; break; }
    }
    if (d === thirdFri) return { mult: 1.60, desc: "OpEx mensual (3er viernes)" };
    return { mult: 1.25, desc: "viernes (OpEx semanal)" };
  }
  if (dow === 1) return { mult: 1.10, desc: "lunes" };
  return { mult: 1.00, desc: "día normal" };
}

function calculateCFDStopLoss(
  direction: "LONG" | "SHORT",
  cfdPrice: number,
  cfdTarget: string,
  levels: DecisionLevel[],
  analysisPrice: number,
  sgLevels: OfficialSGLevels | null,
  vannaContext: VannaContext | null,
  assetIvRank: number = 30,
  gammaRegime: string = "neutral",
  sessionDate: string = "",
  newsMult: number = 1.0,       // Factor 5: macro-event volatility (default = no adjustment)
): { sl: number; slPoints: number; slRiskUSD: number; reason: string } {
  const spec = CFD_SPECS[cfdTarget];
  if (!spec) return { sl: 0, slPoints: 0, slRiskUSD: 0, reason: "Sin spec CFD" };

  // Strategy: Find the nearest gamma level that would invalidate the trade
  // Then convert to CFD price and check if it's within risk tolerance

  let slPoints = 0;
  let reason = "";

  if (direction === "LONG") {
    // SL below nearest support level
    const levelsBelow = levels
      .filter(l => l.strike < analysisPrice)
      .sort((a, b) => b.strike - a.strike);

    if (levelsBelow.length > 0) {
      const nearest = levelsBelow[0];
      const analysisSLDistance = analysisPrice - nearest.strike;
      const pctDistance = analysisSLDistance / analysisPrice;
      slPoints = pctDistance * cfdPrice;

      // If confluent with SG level, put SL just below it (tighter)
      if (nearest.confluenceWithSG) {
        slPoints = slPoints * 0.7; // Tighter SL at SG levels (they hold better)
        reason = `Bajo ${nearest.sgLevelType} $${nearest.strike} (confluencia SG)`;
      } else {
        reason = `Bajo nivel gamma $${nearest.strike} (${nearest.hierarchy})`;
      }
    } else if (sgLevels && sgLevels.putWall > 0 && sgLevels.putWall < analysisPrice) {
      const pctDistance = (analysisPrice - sgLevels.putWall) / analysisPrice;
      slPoints = pctDistance * cfdPrice;
      reason = `Bajo Put Wall oficial $${sgLevels.putWall}`;
    } else {
      // Default: use implied move as reference
      const imPct = sgLevels ? sgLevels.impliedMovePct / 100 : 0.005;
      slPoints = imPct * 0.3 * cfdPrice; // 30% of implied move
      reason = "Default: 30% del Implied Move";
    }
  } else {
    // SHORT: SL above nearest resistance
    const levelsAbove = levels
      .filter(l => l.strike > analysisPrice)
      .sort((a, b) => a.strike - b.strike);

    if (levelsAbove.length > 0) {
      const nearest = levelsAbove[0];
      const analysisSLDistance = nearest.strike - analysisPrice;
      const pctDistance = analysisSLDistance / analysisPrice;
      slPoints = pctDistance * cfdPrice;

      if (nearest.confluenceWithSG) {
        slPoints = slPoints * 0.7;
        reason = `Sobre ${nearest.sgLevelType} $${nearest.strike} (confluencia SG)`;
      } else {
        reason = `Sobre nivel gamma $${nearest.strike} (${nearest.hierarchy})`;
      }
    } else if (sgLevels && sgLevels.callWall > 0 && sgLevels.callWall > analysisPrice) {
      const pctDistance = (sgLevels.callWall - analysisPrice) / analysisPrice;
      slPoints = pctDistance * cfdPrice;
      reason = `Sobre Call Wall oficial $${sgLevels.callWall}`;
    } else {
      const imPct = sgLevels ? sgLevels.impliedMovePct / 100 : 0.005;
      slPoints = imPct * 0.3 * cfdPrice;
      reason = "Default: 30% del Implied Move";
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DYNAMIC SL ADJUSTMENT — 4 factors applied in sequence
  // ══════════════════════════════════════════════════════════════════════════

  // Factor 1 — VIX + IV Rank (primary sizing driver)
  const vixPrice = vannaContext?.vixPrice ?? 18;
  const { mult: volMult, dynamicMinSL, dynamicMaxRisk, volDesc } =
    getVolatilityAdjustedSLParams(vixPrice, assetIvRank, cfdTarget);
  slPoints *= volMult;

  // Factor 2 — GEX Regime (negative gamma = dealers amplify = wider SL)
  const { mult: gexMult, desc: gexDesc } = getGEXRegimeSLMult(gammaRegime);

  // Factor 3 — Time of day (apertura/almuerzo/power hour)
  const { mult: timeMult, session: timeSession } = getTimeOfDaySLMult();

  // Factor 4 — Day type (OpEx, lunes, normal)
  const dateStr = sessionDate || new Date().toISOString().slice(0, 10);
  const { mult: dayMult, desc: dayDesc } = getDayTypeSLMult(dateStr);

  // Combine factors 2-4 with a cap so they don't explode (±50% max swing)
  const secondaryMult = Math.min(Math.max(gexMult * timeMult * dayMult, 0.65), 1.65);
  slPoints *= secondaryMult;

  // Factor 5 — Macro event (FOMC / CPI / NFP)
  // Wider SL to survive the initial spike/whipsaw around the release.
  // Applied AFTER the other factors so it stacks on top of the context-aware base.
  if (newsMult > 1.0) {
    slPoints *= newsMult;
    reason += ` [Noticia×${newsMult.toFixed(2)}]`;
  }

  // VRP fine-tune (tertiary, small adjustment)
  let vrpNote = "";
  if (sgLevels) {
    const vrp = sgLevels.vrp;
    if (vrp > 0.1)       { slPoints *= 0.93; vrpNote = " VRP↑"; }
    else if (vrp < -0.02) { slPoints *= 1.08; vrpNote = " VRP↓"; }
  }

  // Build reason string
  reason += ` [×${volMult.toFixed(2)} ${volDesc}]`;
  reason += ` [GEX×${gexMult.toFixed(2)} ${gexDesc}]`;
  reason += ` [${timeSession}×${timeMult.toFixed(2)}]`;
  reason += ` [${dayDesc}×${dayMult.toFixed(2)}${vrpNote}]`;

  // ── Implied Move sanity bounds ─────────────────────────────────────────
  // SL should live between 20% and 65% of the expected daily range.
  // Prevents stops in pure noise (too tight) or stops with bad R:R (too wide).
  if (sgLevels && sgLevels.impliedMovePct > 0 && spec.betaVsSPX > 0) {
    const imPoints = (sgLevels.impliedMovePct / 100) * spec.betaVsSPX * cfdPrice;
    const imFloor  = imPoints * 0.20;
    const imCap    = imPoints * 0.65;
    if (slPoints < imFloor) {
      slPoints = imFloor;
      reason += ` [IM floor ${imFloor.toFixed(0)}pts]`;
    } else if (slPoints > imCap) {
      slPoints = imCap;
      reason += ` [IM cap ${imCap.toFixed(0)}pts]`;
    }
  }

  // ── Enforce dynamic risk limits (VIX-scaled min/max) ─────────────────────
  const riskUSD = slPoints * spec.valuePerPoint;
  if (riskUSD > dynamicMaxRisk) {
    slPoints = dynamicMaxRisk / spec.valuePerPoint;
    reason += ` [Max $${dynamicMaxRisk.toFixed(0)}]`;
  }
  if (slPoints < dynamicMinSL) {
    slPoints = dynamicMinSL;
    reason += ` [Min ${dynamicMinSL}pts]`;
  }

  slPoints = Math.round(slPoints * 100) / 100;
  const sl = direction === "LONG" ? cfdPrice - slPoints : cfdPrice + slPoints;
  const slRiskUSD = Math.round(slPoints * spec.valuePerPoint * 100) / 100;

  return { sl, slPoints, slRiskUSD, reason };
}

function calculateCFDTakeProfits(
  direction: "LONG" | "SHORT",
  cfdPrice: number,
  slPoints: number,
  cfdTarget: string,
  levels: DecisionLevel[],
  analysisPrice: number,
  sgLevels: OfficialSGLevels | null,
): { tp1: number; tp1Pts: number; tp2: number; tp2Pts: number; tp3: number; tp3Pts: number; reason: string; rr: number } {
  const spec = CFD_SPECS[cfdTarget];
  if (!spec || slPoints === 0) return { tp1: 0, tp1Pts: 0, tp2: 0, tp2Pts: 0, tp3: 0, tp3Pts: 0, reason: "", rr: 0 };

  // Minimum R:R thresholds
  const minTP1Pts = slPoints * 1.2;
  const minTP2Pts = slPoints * 2.0;
  const minTP3Pts = slPoints * 3.5;

  // Maximum TP caps — prevents unrealistic targets from far SG levels (e.g. GLD callWall at $475 ETF)
  // Based on max realistic intraday moves: NAS100 ~3%, US30 ~2.5%, XAUUSD ~4%
  const maxDailyPct: Record<string, number> = { NAS100: 0.04, US30: 0.035, XAUUSD: 0.055 };
  const maxPct = maxDailyPct[cfdTarget] ?? 0.04;
  const MAX_TP1_PTS = Math.max(cfdPrice * maxPct * 0.45, minTP1Pts * 2);
  const MAX_TP2_PTS = Math.max(cfdPrice * maxPct * 0.75, minTP2Pts * 2);
  const MAX_TP3_PTS = Math.max(cfdPrice * maxPct, minTP3Pts * 2);

  // Convert analysis price level → CFD points distance from current price
  const analysisToCfdPts = (level: number) =>
    Math.abs(level - analysisPrice) / analysisPrice * cfdPrice;

  // ─── Build cascade of gamma wall targets ───
  const tpWalls: { pts: number; label: string }[] = [];

  if (direction === "LONG") {
    // Gamma levels above price (reaction/dominant only)
    levels
      .filter(l => l.strike > analysisPrice && (l.hierarchy === "reaction" || l.hierarchy === "dominant"))
      .sort((a, b) => a.strike - b.strike)
      .forEach(l => tpWalls.push({ pts: analysisToCfdPts(l.strike), label: `Gamma $${l.strike.toLocaleString()} (${l.hierarchy})` }));
    // Official SG walls
    if (sgLevels?.keyGamma > analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.keyGamma), label: `Key Gamma $${sgLevels.keyGamma.toLocaleString()}` });
    if (sgLevels?.callWall > analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.callWall), label: `Call Wall $${sgLevels.callWall.toLocaleString()}` });
    if (sgLevels?.maxGamma > analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.maxGamma), label: `Max Gamma $${sgLevels.maxGamma.toLocaleString()}` });
  } else {
    // SHORT: levels below price
    levels
      .filter(l => l.strike < analysisPrice && (l.hierarchy === "reaction" || l.hierarchy === "dominant"))
      .sort((a, b) => b.strike - a.strike)
      .forEach(l => tpWalls.push({ pts: analysisToCfdPts(l.strike), label: `Gamma $${l.strike.toLocaleString()} (${l.hierarchy})` }));
    if (sgLevels?.keyGamma > 0 && sgLevels.keyGamma < analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.keyGamma), label: `Key Gamma $${sgLevels.keyGamma.toLocaleString()}` });
    if (sgLevels?.putWall > 0 && sgLevels.putWall < analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.putWall), label: `Put Wall $${sgLevels.putWall.toLocaleString()}` });
    if (sgLevels?.maxGamma > 0 && sgLevels.maxGamma < analysisPrice)
      tpWalls.push({ pts: analysisToCfdPts(sgLevels.maxGamma), label: `Max Gamma $${sgLevels.maxGamma.toLocaleString()}` });
  }

  // Implied move as fallback baseline
  let imPts = 0;
  if (sgLevels && sgLevels.impliedMove > 0) {
    const imPctCapped = Math.min(sgLevels.impliedMovePct, 5);
    imPts = (imPctCapped / 100) * cfdPrice;
  }

  // Filter out walls too close to SL, sort ascending by distance
  const validWalls = tpWalls
    .filter(w => w.pts >= minTP1Pts)
    .sort((a, b) => a.pts - b.pts);

  const usedLabels: string[] = [];

  // TP1: nearest valid gamma wall, or 40% of implied move
  let tp1Pts = minTP1Pts;
  if (validWalls[0]) {
    tp1Pts = validWalls[0].pts;
    usedLabels.push(`TP1 → ${validWalls[0].label}`);
  } else if (imPts > 0) {
    tp1Pts = Math.max(imPts * 0.4, minTP1Pts);
    usedLabels.push(`TP1 40% IM (${sgLevels?.impliedMove.toFixed(1)}pts)`);
  }

  // TP2: next wall at least 10% beyond TP1, or 70% of implied move
  let tp2Pts = minTP2Pts;
  const tp2Wall = validWalls.find(w => w.pts > tp1Pts * 1.10);
  if (tp2Wall) {
    tp2Pts = Math.max(tp2Wall.pts, minTP2Pts);
    usedLabels.push(`TP2 → ${tp2Wall.label}`);
  } else if (imPts > 0) {
    tp2Pts = Math.max(imPts * 0.7, tp1Pts * 1.3, minTP2Pts);
    usedLabels.push(`TP2 70% IM`);
  } else {
    tp2Pts = Math.max(tp1Pts * 1.5, minTP2Pts);
  }

  // TP3: furthest wall beyond TP2, or 100% of implied move (runner)
  let tp3Pts = minTP3Pts;
  const tp3Walls = validWalls.filter(w => w.pts > tp2Pts * 1.10);
  const tp3Wall = tp3Walls[tp3Walls.length - 1]; // Furthest available
  if (tp3Wall) {
    tp3Pts = Math.max(tp3Wall.pts, minTP3Pts);
    usedLabels.push(`TP3 → ${tp3Wall.label}`);
  } else if (imPts > 0) {
    tp3Pts = Math.max(imPts, tp2Pts * 1.4, minTP3Pts);
    usedLabels.push(`TP3 100% IM`);
  } else {
    tp3Pts = Math.max(tp2Pts * 1.6, minTP3Pts);
  }

  // VRP adjustment (IV vs RV spread)
  if (sgLevels && sgLevels.vrp !== 0) {
    const vrp = sgLevels.vrp;
    if (vrp > 0.05) {
      tp1Pts *= 0.85; tp2Pts *= 0.85; tp3Pts *= 0.85;
      usedLabels.push(`VRP +${(vrp * 100).toFixed(1)}% → TPs -15%`);
    } else if (vrp < -0.02) {
      tp1Pts *= 1.15; tp2Pts *= 1.15; tp3Pts *= 1.15;
      usedLabels.push(`VRP ${(vrp * 100).toFixed(1)}% → TPs +15%`);
    }
  }

  // Apply max caps (prevents GLD callWall 15% away from corrupting targets)
  tp1Pts = Math.min(tp1Pts, MAX_TP1_PTS);
  tp2Pts = Math.min(tp2Pts, MAX_TP2_PTS);
  tp3Pts = Math.min(tp3Pts, MAX_TP3_PTS);

  tp1Pts = Math.round(tp1Pts * 100) / 100;
  tp2Pts = Math.round(tp2Pts * 100) / 100;
  tp3Pts = Math.round(tp3Pts * 100) / 100;

  const tp1 = direction === "LONG" ? cfdPrice + tp1Pts : cfdPrice - tp1Pts;
  const tp2 = direction === "LONG" ? cfdPrice + tp2Pts : cfdPrice - tp2Pts;
  const tp3 = direction === "LONG" ? cfdPrice + tp3Pts : cfdPrice - tp3Pts;
  const rr = slPoints > 0 ? Math.round((tp2Pts / slPoints) * 10) / 10 : 0;

  return { tp1, tp1Pts, tp2, tp2Pts, tp3, tp3Pts, reason: usedLabels.join(" | "), rr };
}

// ============ TRADE SCORING (6 confirmations) ============

function calculateTradeScore(setup: {
  gexConfirmed: boolean;
  hiroConfirmed: boolean;
  hiroContradicts: boolean;  // HIRO disponible pero en dirección opuesta al setup
  tapeConfirmed: boolean;
  levelConfirmed: boolean;
  vannaConfirmed: boolean;
  regimeConfirmed: boolean;
  levelHierarchy: LevelHierarchy;
  confluenceWithSG: boolean;
  isTopStrike: boolean;
  topStrikeRank?: number;
  riskReward: number;
  crossAssetStrength: string;
  gexStrengthPct: number;
}): number {
  let score = 0;

  // 6 confirmaciones principales
  if (setup.gexConfirmed) {
    const gexPts = setup.gexStrengthPct >= 75 ? 16 : setup.gexStrengthPct >= 50 ? 13 : setup.gexStrengthPct >= 25 ? 10 : 8;
    score += gexPts;
  }
  if (setup.hiroConfirmed) score += 16;
  // Penalización: HIRO claramente en contra → resta 10 puntos
  // (distinto de HIRO neutro/mixto que simplemente no suma)
  if (setup.hiroContradicts) score -= 10;
  if (setup.tapeConfirmed) score += 16;
  if (setup.levelConfirmed) score += 16;
  if (setup.vannaConfirmed) score += 16;
  if (setup.regimeConfirmed) score += 16;

  // Bonus
  if (setup.confluenceWithSG) score += 5;
  if (setup.isTopStrike) score += setup.topStrikeRank === 1 ? 4 : 2;
  if (setup.levelHierarchy === "dominant") score += 3;
  if (setup.riskReward >= 2.5) score += 3;
  if (setup.crossAssetStrength === "strong") score += 5;
  else if (setup.crossAssetStrength === "moderate") score += 3;

  return Math.min(100, Math.max(0, score));
}

// ============ OPEX CONTEXT (Mejora C) ============

interface OPEXContext {
  isWeeklyOPEX: boolean;
  isMonthlyOPEX: boolean;
  is0DTEOPEX: boolean;
  opexType: string;
  thresholdBoost: number;
}

/**
 * Returns OPEX context for today.
 * - OPEX semanal: viernes
 * - OPEX SPX 0DTE: lunes, miércoles, viernes
 * - OPEX mensual: tercer viernes del mes
 */
function getOPEXContext(date?: Date): OPEXContext {
  const now = date || new Date();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth() + 1; // 1-indexed
  const d = now.getUTCDate();
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

  // SPX 0DTE: lunes (1), miércoles (3), viernes (5)
  const is0DTEOPEX = dow === 1 || dow === 3 || dow === 5;

  // OPEX semanal: viernes
  const isWeeklyOPEX = dow === 5;

  // OPEX mensual: tercer viernes del mes
  let isMonthlyOPEX = false;
  let thirdFriday = 0;
  if (isWeeklyOPEX) {
    let friCount = 0;
    for (let i = 1; i <= 31; i++) {
      const dt = new Date(Date.UTC(y, mo - 1, i));
      if (dt.getUTCMonth() !== mo - 1) break;
      if (dt.getUTCDay() === 5 && ++friCount === 3) { thirdFriday = i; break; }
    }
    isMonthlyOPEX = d === thirdFriday;
  }

  let opexType = "normal";
  let thresholdBoost = 0;

  if (isMonthlyOPEX) {
    opexType = "OPEX mensual (3er viernes)";
    thresholdBoost = 8;
  } else if (isWeeklyOPEX) {
    opexType = "OPEX semanal (viernes)";
    thresholdBoost = 3;
  } else if (is0DTEOPEX) {
    opexType = "SPX 0DTE (L/X/V)";
    thresholdBoost = 5;
  }

  return { isWeeklyOPEX, isMonthlyOPEX, is0DTEOPEX, opexType, thresholdBoost };
}

// ============ NEW SETUP DETECTORS ============

// ── Setup 1: Implied Move Exhaustion ─────────────────────────────────────────

interface IMExhaustionSignal {
  direction: "LONG" | "SHORT";
  levelLabel: string;
  levelPrice: number;
  levelCFDPrice: number;
  distancePct: number;
  consumed: number;
}

/**
 * detectIMExhaustion: cuando el precio consumió >75% del implied move del día
 * y llega a un nivel GEX → reversión de alta probabilidad.
 * Dirección CONTRARIA al movimiento del día.
 */
function detectIMExhaustion(
  asset: AssetData,
  sgLevels: OfficialSGLevels | null,
  levels: DecisionLevel[],
  cfdTarget: string,
  cfdPrice: number,
  imStatus: { consumed: number; impliedMovePct: number; isOverExtended: boolean; isExhausted: boolean },
): IMExhaustionSignal | null {
  if (!sgLevels || cfdPrice <= 0) return null;
  if (imStatus.consumed < 0.75) return null;

  const price = asset.currentPrice;
  if (price <= 0) return null;

  // Dirección contraria al movimiento del día
  const dailyChangePct = asset.dailyChangePct || 0;
  if (Math.abs(dailyChangePct) < 0.3) return null; // sin movimiento claro

  const direction: "LONG" | "SHORT" = dailyChangePct > 0 ? "SHORT" : "LONG";

  // Buscar nivel GEX cercano (dominant o reaction dentro de 0.3%)
  const toCFD = (lvl: number) => cfdPrice + (lvl - price) / price * cfdPrice;
  const threshold = 0.008; // 0.8% — cuando IM está agotado, precio suele estar lejos de niveles

  // Buscar en niveles GEX clasificados
  const nearLevel = levels.find(l =>
    (l.hierarchy === "dominant" || l.hierarchy === "reaction") &&
    l.distancePct < threshold * 100,
  );

  // También verificar niveles oficiales SG
  const sgCandidates: { label: string; price: number }[] = [];
  if (sgLevels.callWall > 0) sgCandidates.push({ label: "Call Wall", price: sgLevels.callWall });
  if (sgLevels.putWall > 0) sgCandidates.push({ label: "Put Wall", price: sgLevels.putWall });
  if (sgLevels.keyGamma > 0) sgCandidates.push({ label: "Key Gamma", price: sgLevels.keyGamma });
  if (sgLevels.maxGamma > 0) sgCandidates.push({ label: "Max Gamma", price: sgLevels.maxGamma });
  if (sgLevels.volTrigger > 0) sgCandidates.push({ label: "Vol Trigger", price: sgLevels.volTrigger });

  const nearSG = sgCandidates.find(c => Math.abs(c.price - price) / price < threshold);

  let levelLabel = "";
  let levelPrice = 0;

  if (nearLevel) {
    levelLabel = nearLevel.confluenceWithSG ? `${nearLevel.sgLevelType} $${nearLevel.strike.toLocaleString()}` : `GEX $${nearLevel.strike.toLocaleString()} (${nearLevel.hierarchy})`;
    levelPrice = nearLevel.strike;
  } else if (nearSG) {
    levelLabel = `${nearSG.label} $${nearSG.price.toLocaleString()}`;
    levelPrice = nearSG.price;
  } else {
    return null; // Sin nivel GEX cercano
  }

  const distancePct = Math.abs(price - levelPrice) / price * 100;
  const levelCFDPrice = toCFD(levelPrice);
  const consumed = imStatus.consumed;

  return { direction, levelLabel, levelPrice, levelCFDPrice, distancePct, consumed };
}

// ── Setup 2: OPEX Pin Strike ──────────────────────────────────────────────────

interface OPEXPinSignal {
  direction: "LONG" | "SHORT";
  pinStrike: number;
  pinCFDPrice: number;
  distancePct: number;
}

/**
 * detectOPEXPin: en días de vencimiento de opciones, el precio se "pega"
 * al strike de Max Gamma. Fadea los movimientos que se alejan del pin.
 * Solo NAS100 y US30. No aplica en última hora (3pm-4pm ET).
 */
function detectOPEXPin(
  asset: AssetData,
  sgLevels: OfficialSGLevels | null,
  cfdTarget: string,
  cfdPrice: number,
  opexCtx: OPEXContext,
  et?: ETTimeInfo,
): OPEXPinSignal | null {
  // Solo NAS100 y US30
  if (cfdTarget === "XAUUSD") return null;
  if (!sgLevels || cfdPrice <= 0) return null;

  // Solo en días de OPEX
  if (!opexCtx.isWeeklyOPEX && !opexCtx.is0DTEOPEX) return null;

  // Verificar que no sea la última hora (3pm-4pm ET)
  const t = et || getETTime();
  // Bloquear 3pm-4pm ET (900-960 mins)
  if (t.etMins >= 900) return null;

  const price = asset.currentPrice;
  if (price <= 0) return null;

  // Pin strike = maxGamma o keyGamma
  const pinStrike = sgLevels.maxGamma > 0 ? sgLevels.maxGamma : (sgLevels.keyGamma > 0 ? sgLevels.keyGamma : 0);
  if (pinStrike <= 0) return null;

  const distancePct = Math.abs(price - pinStrike) / price * 100;

  // Threshold: entre 0.2% y 1.5% del pin
  if (distancePct < 0.2 || distancePct > 1.5) return null;

  const direction: "LONG" | "SHORT" = price > pinStrike ? "SHORT" : "LONG";
  const pinCFDPrice = cfdPrice + (pinStrike - price) / price * cfdPrice;

  return { direction, pinStrike, pinCFDPrice, distancePct };
}

// ── Setup 3: HIRO Divergence ──────────────────────────────────────────────────

interface HIRODivergenceSignal {
  direction: "LONG" | "SHORT";
  hiroSignal: "bullish" | "bearish";
  pricePct: number;
  strength: "strong" | "moderate" | "weak";
}

/**
 * detectHIRODivergence: HIRO muestra flujo de opciones fuertemente direccional
 * OPUESTO al movimiento reciente del precio → señal de reversión.
 * Solo activa si la divergencia es "strong".
 */
function detectHIRODivergence(
  asset: AssetData,
  hiro: HiroData | null,
  cfdTarget: string,
  group: { assets: string[] },
): HIRODivergenceSignal | null {
  if (!hiro) return null;

  const dailyChangePct = asset.dailyChangePct || 0;

  // Necesitamos un movimiento de precio significativo (±0.5%)
  if (Math.abs(dailyChangePct) < 0.5) return null;

  // Revisar el HIRO del asset primario y del grupo
  const primaryHiro = hiro.perAsset?.[asset.symbol];
  if (!primaryHiro) return null;

  const hiroTrend = primaryHiro.hiroTrend;

  // Contar consenso del grupo para determinar fortaleza
  let hiroBullishCount = 0;
  let hiroBearishCount = 0;
  let groupTotal = 0;
  for (const sym of group.assets) {
    const h = hiro.perAsset?.[sym];
    if (h) {
      groupTotal++;
      if (h.hiroTrend === "bullish") hiroBullishCount++;
      else if (h.hiroTrend === "bearish") hiroBearishCount++;
    }
  }

  // Solo activar si hay consenso fuerte del grupo también
  const hiroMajority = hiroBullishCount > hiroBearishCount ? "bullish" : hiroBearishCount > hiroBullishCount ? "bearish" : "neutral";
  if (hiroMajority === "neutral") return null;

  // Divergencia LONG: precio cayendo + HIRO bullish
  if (dailyChangePct < -0.5 && hiroMajority === "bullish") {
    // Determinar fortaleza: grupo unánime = strong, mayoría = moderate
    const strength: "strong" | "moderate" | "weak" = (hiroBullishCount === groupTotal && groupTotal > 0) ? "strong"
      : hiroBullishCount > hiroBearishCount ? "moderate" : "weak";
    if (strength === "weak") return null; // Allow both strong and moderate
    return { direction: "LONG", hiroSignal: "bullish", pricePct: dailyChangePct, strength };
  }

  // Divergencia SHORT: precio subiendo + HIRO bearish
  if (dailyChangePct > 0.5 && hiroMajority === "bearish") {
    const strength: "strong" | "moderate" | "weak" = (hiroBearishCount === groupTotal && groupTotal > 0) ? "strong"
      : hiroBearishCount > hiroBullishCount ? "moderate" : "weak";
    if (strength === "weak") return null; // Allow both strong and moderate
    return { direction: "SHORT", hiroSignal: "bearish", pricePct: dailyChangePct, strength };
  }

  return null;
}

// ── Setup 4: Gamma Squeeze ────────────────────────────────────────────────────

interface GammaSqueezeSignal {
  direction: "LONG" | "SHORT";
  flipLevel: number;
  flipCFDPrice: number;
  momentum: number; // dailyChangePct
}

/**
 * detectGammaSqueeze: precio cruzó el Gamma Flip con momentum fuerte →
 * dealers deben cubrir agresivamente, amplificando el movimiento.
 * Solo en régimen negative o very_negative.
 * NO aplica si ya hay breakout del mismo lado.
 */
function detectGammaSqueeze(
  asset: AssetData,
  sgLevels: OfficialSGLevels | null,
  cfdTarget: string,
  cfdPrice: number,
  gammaRegime: string,
  gammaFlipLevel: number,
  hasBreakout: boolean,
): GammaSqueezeSignal | null {
  if (!sgLevels || cfdPrice <= 0) return null;
  if (gammaFlipLevel <= 0) return null;

  // Solo en régimen negativo
  if (gammaRegime !== "negative" && gammaRegime !== "very_negative") return null;

  // FIX 10: gammaFlipLevel for XAUUSD is in GLD ETF scale (~$300).
  // price (asset.currentPrice) is also GLD. toCFD conversion handles the scale correctly.
  const price = asset.currentPrice;
  if (price <= 0) return null;

  const dailyChangePct = asset.dailyChangePct || 0;

  // Determinar dirección del squeeze por momentum
  let direction: "LONG" | "SHORT";
  if (dailyChangePct >= 0.8) {
    direction = "LONG"; // Squeeze alcista
  } else if (dailyChangePct <= -0.8) {
    direction = "SHORT"; // Squeeze bajista
  } else {
    return null; // Sin momentum suficiente
  }

  // No aplicar si ya hay breakout del mismo lado
  if (hasBreakout) return null;

  // El precio debe estar del lado del cruce (a menos de 0.5% del flip)
  const distPct = Math.abs(price - gammaFlipLevel) / price * 100;
  if (distPct > 0.5) return null;

  // Verificar que cruzó en la dirección correcta
  // LONG squeeze: precio debe estar por ENCIMA del flip (acaba de cruzar hacia arriba)
  // SHORT squeeze: precio debe estar por DEBAJO del flip (acaba de cruzar hacia abajo)
  if (direction === "LONG" && price < gammaFlipLevel) return null;
  if (direction === "SHORT" && price > gammaFlipLevel) return null;

  const flipCFDPrice = cfdPrice + (gammaFlipLevel - price) / price * cfdPrice;

  return { direction, flipLevel: gammaFlipLevel, flipCFDPrice, momentum: dailyChangePct };
}

// ── Setup 5: Charm Flow ───────────────────────────────────────────────────────

interface CharmFlowSignal {
  direction: "LONG" | "SHORT";
  session: "lunes_apertura" | "viernes_cierre";
  reason: string;
}

/**
 * detectCharmFlow: charm decay de opciones genera flujo direccional predecible.
 * - Lunes apertura (9:30-11:00 ET): flujo alcista (si mercado no cayó >-0.5%)
 * - Viernes cierre (2:00-3:30 ET): flujo bajista en índices al cierre
 * Solo NAS100 y US30.
 */
function detectCharmFlow(
  cfdTarget: string,
  dailyChangePct: number,
  et?: ETTimeInfo,
): CharmFlowSignal | null {
  // Solo NAS100 y US30
  if (cfdTarget === "XAUUSD") return null;

  // Use cached ET time or calculate
  const t = et || getETTime();
  const dow = t.dow;
  const etMins = t.etMins;

  // Lunes apertura: 9:30-11:00 ET (570-660 mins)
  if (dow === 1 && etMins >= 570 && etMins < 660) {
    // Flujo alcista si mercado no cayó más de -0.5%
    if (dailyChangePct > -0.5) {
      return {
        direction: "LONG",
        session: "lunes_apertura",
        reason: `Charm decay lunes: opciones vendidas el viernes decaen → flujo alcista (mercado ${dailyChangePct >= 0 ? "+" : ""}${dailyChangePct.toFixed(2)}%)`,
      };
    }
  }

  // Viernes cierre: 2:00-3:30 ET (840-930 mins)
  if (dow === 5 && etMins >= 840 && etMins < 930) {
    return {
      direction: "SHORT",
      session: "viernes_cierre",
      reason: `Charm decay viernes: dealers venden opciones al vencimiento → presión bajista cierre (${dailyChangePct >= 0 ? "+" : ""}${dailyChangePct.toFixed(2)}%)`,
    };
  }

  return null;
}

// ── NEW SETUP: News Reaction ──────────────────────────────────────────────────

interface NewsReactionSignal {
  direction: "LONG" | "SHORT";
  event: string;
  minutesSinceRelease: number;
  priceReaction: number;  // % move since release
}

/**
 * detectNewsReaction: después de una noticia macro (FOMC, CPI, NFP),
 * si el precio reacciona fuertemente Y confirma dirección con HIRO → trade de momentum.
 * Solo activa 5-60 minutos después del release.
 */
function detectNewsReaction(
  asset: AssetData,
  macroAlert: { isActive: boolean; hasEvent: boolean; hoursUntil: number; event: string; time: string },
  hiro: HiroData | null,
  cfdTarget: string,
  group: { assets: string[] },
): NewsReactionSignal | null {
  if (!macroAlert.hasEvent) return null;

  // Only after the event (hoursUntil < 0 means it already happened)
  const minutesSince = -macroAlert.hoursUntil * 60;
  if (minutesSince < 5 || minutesSince > 60) return null;  // 5-60 minutes after

  const dailyChangePct = asset.dailyChangePct || 0;

  // Need strong price reaction (> 0.5%)
  if (Math.abs(dailyChangePct) < 0.5) return null;

  // HIRO must confirm the reaction direction (institutional follow-through)
  if (!hiro) return null;
  let hiroBull = 0, hiroBear = 0;
  for (const sym of group.assets) {
    const h = hiro.perAsset?.[sym];
    if (h?.hiroTrend === "bullish") hiroBull++;
    else if (h?.hiroTrend === "bearish") hiroBear++;
  }

  let direction: "LONG" | "SHORT";
  if (dailyChangePct > 0.5 && hiroBull > hiroBear) {
    direction = "LONG";  // Price up + HIRO confirms = momentum buy
  } else if (dailyChangePct < -0.5 && hiroBear > hiroBull) {
    direction = "SHORT";  // Price down + HIRO confirms = momentum sell
  } else {
    return null;  // No confirmation
  }

  return {
    direction,
    event: macroAlert.event,
    minutesSinceRelease: Math.round(minutesSince),
    priceReaction: dailyChangePct,
  };
}

// ── Mejora B: Level Confluence Counter ───────────────────────────────────────

/**
 * countLevelConfluence: cuenta cuántos niveles GEX están dentro de ±0.3%
 * del entryStrike para determinar confluencia de zona.
 * Returns: número de niveles adicionales confluentes (0 si solo hay 1).
 */
function countLevelConfluence(
  entryStrike: number,
  levels: DecisionLevel[],
  sgLevels: OfficialSGLevels | null,
  price: number,
): { count: number; bonus: number; label: string } {
  if (entryStrike <= 0 || price <= 0) return { count: 0, bonus: 0, label: "" };

  const zonePct = 0.003; // ±0.3%
  const zoneAbs = price * zonePct;

  // Contar niveles GEX dentro de la zona
  const gexInZone = levels.filter(l =>
    Math.abs(l.strike - entryStrike) <= zoneAbs &&
    (l.hierarchy === "reaction" || l.hierarchy === "dominant"),
  );

  // Contar niveles oficiales SG dentro de la zona
  const sgInZone: string[] = [];
  if (sgLevels) {
    const sgMap: [number, string][] = [
      [sgLevels.callWall, "Call Wall"],
      [sgLevels.putWall, "Put Wall"],
      [sgLevels.keyGamma, "Key Gamma"],
      [sgLevels.maxGamma, "Max Gamma"],
      [sgLevels.volTrigger, "Vol Trigger"],
    ];
    for (const [sgPrice, sgName] of sgMap) {
      if (sgPrice > 0 && Math.abs(sgPrice - entryStrike) <= zoneAbs) {
        sgInZone.push(sgName);
      }
    }
  }

  const totalCount = gexInZone.length + sgInZone.length;

  let bonus = 0;
  let label = "";
  if (totalCount >= 3) {
    bonus = 10;
    label = `[CONFLUENCIA] ${totalCount} niveles en zona $${entryStrike.toLocaleString()} ± 0.3%${sgInZone.length > 0 ? ` (incl. ${sgInZone.slice(0, 2).join(", ")})` : ""}`;
  } else if (totalCount === 2) {
    bonus = 5;
    label = `[CONFLUENCIA] 2 niveles en zona $${entryStrike.toLocaleString()} ± 0.3%${sgInZone.length > 0 ? ` (incl. ${sgInZone[0]})` : ""}`;
  }

  return { count: totalCount, bonus, label };
}

// ── Broken Level Memory ──────────────────────────────────────────────────────
interface BrokenLevelEntry {
  cfdTarget: string;
  wallName: string;
  wallPrice: number;
  direction: "LONG" | "SHORT";
  detectedAt: number;
  flowScore: number;
  confirmations: number;
}
const brokenLevelMemory = new Map<string, BrokenLevelEntry>();
const BROKEN_LEVEL_TTL_MS = 15 * 60 * 1000;

function cleanBrokenLevelMemory(): void {
  const now = Date.now();
  for (const [key, entry] of brokenLevelMemory.entries()) {
    if (now - entry.detectedAt > BROKEN_LEVEL_TTL_MS) {
      brokenLevelMemory.delete(key);
    }
  }
}

export function getRetestMemory(): BrokenLevelEntry[] {
  cleanBrokenLevelMemory();
  return Array.from(brokenLevelMemory.values());
}

// ============ MAIN TRADE SETUP GENERATOR ============

export function generateTradeSetups(
  assets: AssetData[],
  gex: GexData | null,
  hiro: HiroData | null,
  tape: TapeData | null,
  vixAsset: AssetData | null,
  uvixAsset: AssetData | null,
  traceData?: TraceData | null,
  officialLevels?: Record<string, OfficialSGLevels>,
  vannaContext?: VannaContext | null,
  cfdPrices?: CFDPriceData | null,
  etfGex?: Record<string, TradierGexData>,
  volContext?: import("./spotgamma-scraper.js").VolContext | null,
  gexChangeTracker?: import("./spotgamma-scraper.js").GexChangeTracker | null,
): TradeSetup[] {
  // ════════════════════════════════════════════════════════════════════════════
  // PPO PURO TOTAL — El agente decide TODO desde 46 features
  // Sin reglas, sin detección de señales, sin confirmaciones.
  // Solo: datos → features → PPO predict → ejecutar
  // ════════════════════════════════════════════════════════════════════════════

  const setups: TradeSetup[] = [];
  const etTime = getETTime();

  // Ensure price history + tilt caches are loaded (async, non-blocking)
  ensureLiveCachesLoaded();

  // Priority order for SpotGamma data per CFD
  const SG_PRIORITY: Record<string, string[]> = {
    NAS100: ["SPX", "QQQ", "SPY"],
    US30: ["DIA", "SPX"],
    XAUUSD: ["GLD"],
  };

  for (const cfdTarget of ["NAS100", "US30", "XAUUSD"] as const) {
    const spec = CFD_SPECS[cfdTarget];
    if (!spec) continue;

    // 1. Get CFD price
    const cfdPrice = convertToCFDPrice("", 0, cfdTarget, cfdPrices || null);
    if (!cfdPrice || cfdPrice <= 0) continue;

    // 2. Find best SpotGamma data for this CFD
    let sgData: OfficialSGLevels | null = null;
    let primarySym = "";
    for (const sym of (SG_PRIORITY[cfdTarget] ?? [])) {
      if (officialLevels?.[sym] && (officialLevels[sym].callWall > 0 || officialLevels[sym].zeroGamma > 0)) {
        sgData = officialLevels[sym];
        primarySym = sym;
        break;
      }
    }
    if (!sgData) continue;

    // 3. Gather live data for feature construction
    const gammaRatioRaw = (sgData as any).gammaRatio ?? 0.5;
    const ivRankRaw = sgData.ivRank ?? 50;
    const ivRankNorm = ivRankRaw > 1 ? ivRankRaw / 100 : ivRankRaw;
    const livePrice = (sgData as any).price || cfdPrice;

    // Live HIRO
    const liveHiro = hiro?.perAsset?.[primarySym] || hiro?.perAsset?.["SPX"] || null;

    // Live Tape
    const liveTape = tape?.perAsset?.[primarySym] || null;

    // Candle signal
    const candleSignal = getCachedCandleSignal(cfdTarget);

    // Implied Move
    const liveImPct = sgData.impliedMovePct ?? 1;

    // Day of week normalized
    const dayOfWeekNorm = (new Date().getDay() - 1) / 2 - 1; // Mon=-1, Fri=1

    // Session type from ET time
    const sessionType = etTime.etMins < 570 || etTime.etMins >= 960 ? 5
      : etTime.etMins < 600 ? 0  // open
      : etTime.etMins < 690 ? 1  // am_trend
      : etTime.etMins < 870 ? 2  // lunch
      : etTime.etMins < 900 ? 3  // retoma
      : 4;                        // power_hour

    // Implied move exhaustion
    const imStatus = getImpliedMoveStatus(cfdTarget, cfdPrice, sgData);
    const imExhaustionLevel = Math.min(1, (imStatus?.consumed ?? 0));

    // Macro context
    const macroAlert = getMacroAlert();

    // Time normalized
    const timeNorm = (etTime.etH + etTime.utcM / 60) / 24;

    // ── Top strikes & strike-derived features ────────────────────────────────
    // primaryAsset tiene los datos reales por strike (gamma, OI, distancia).
    // Antes estaban hardcodeados a 0 — ahora los calculamos del dato vivo.
    const primaryAsset = assets.find(a => a.symbol === primarySym) ?? null;

    let _absGammaPeakDist = 0;
    let _absGammaSkew     = 0;
    let _gammaWallDist    = 0;
    let _gammaConc        = 0.5;
    let _impliedMoveUsage = imExhaustionLevel > 0 ? imExhaustionLevel : 1.0;
    let _topStrikeProx    = 0;   // 0=lejos, 1=exactamente en top strike — reemplaza volumeProfilePOC

    if (primaryAsset && primaryAsset.strikes.length > 0) {
      const allSt = primaryAsset.strikes;
      const totalAbsGamma = allSt.reduce((s, st) => s + Math.abs(st.totalGamma), 0);

      if (totalAbsGamma > 0) {
        // Strike con mayor gamma absoluto (peak)
        const sorted = [...allSt].sort((a, b) => Math.abs(b.totalGamma) - Math.abs(a.totalGamma));
        const peak = sorted[0];
        _absGammaPeakDist = (livePrice - peak.strike) / livePrice * 100;
        const ca = Math.abs(peak.callGamma), pa = Math.abs(peak.putGamma);
        _absGammaSkew     = (ca + pa) > 0 ? (ca - pa) / (ca + pa) : 0;
        _gammaWallDist    = (peak.strike - livePrice) / livePrice * 100;

        // Herfindahl: qué tan concentrado está el gamma en pocos strikes (0=disperso, 1=muy concentrado)
        _gammaConc = Math.min(1, allSt.reduce((s, st) =>
          s + Math.pow(Math.abs(st.totalGamma) / totalAbsGamma, 2), 0) * 10);
      }

      // Top 3 strikes por gamma — proximidad al precio actual
      const tops = primaryAsset.topStrikes.slice(0, 3);
      if (tops.length > 0) {
        const dists = tops.map(t => Math.abs((livePrice - t.strike) / livePrice * 100));
        const minDist = Math.min(...dists);
        // Score: 1.0 si precio exactamente en el strike, ~0 si está > 1% lejos
        // Decay exponencial: score = exp(-dist / 0.3)
        _topStrikeProx = Math.exp(-minDist / 0.30);
        if (_topStrikeProx > 0.01) {
          const closestTop = tops[dists.indexOf(minDist)];
          console.log(`[TopStrike] ${cfdTarget}: nearest top strike ${closestTop.strike} (${minDist.toFixed(2)}% away, prox=${_topStrikeProx.toFixed(2)}, gamma=${closestTop.totalGamma.toFixed(0)})`);
        }
      }

      // outlierStrikes también contribuyen a la proximidad (strikes estadísticamente significativos)
      if (primaryAsset.outlierStrikes?.length > 0) {
        const outlierDists = primaryAsset.outlierStrikes.map(t =>
          Math.abs((livePrice - t.strike) / livePrice * 100));
        const minOutlierDist = Math.min(...outlierDists);
        const outlierProx = Math.exp(-minOutlierDist / 0.30);
        _topStrikeProx = Math.max(_topStrikeProx, outlierProx * 0.8);  // outliers pesan 80%
      }
    }

    // ── Compute extended SpotGamma features (features 49-93) ──────────────────
    // [A] Skew / Fear (from OfficialSGLevels)
    const atmIV30 = sgData.atmIV30 ?? 0;
    const _skewNorm        = sgData.skew ?? 0;
    const _callSkewNorm    = sgData.callSkew ?? 0;
    const _putSkewNorm     = sgData.putSkew ?? 0;
    const _d95Norm         = atmIV30 > 0 ? (sgData.d95 ?? 0) - atmIV30 : 0;
    const _d25neNorm       = sgData.d25ne ?? 0.2;
    const _fwdGarchSpread  = atmIV30 > 0 ? (sgData.fwdGarch ?? 0) - atmIV30 : 0;

    // [B] Positioning (from OfficialSGLevels)
    const _totalDeltaNorm   = Math.tanh((sgData.totalDelta ?? 0) / 1e9); // billions
    const _activityFactor   = Math.min(1, Math.max(0, sgData.activityFactor ?? 0.5));
    const _gammaRegimeNum   = sgData.gammaRegime === "positive" ? 1
                            : sgData.gammaRegime === "very_negative" ? -1
                            : sgData.gammaRegime === "negative" ? -0.5 : 0;
    const _levelsChangedFlag = sgData.levelsChanged ? 1 : 0;
    const _priceVsKeyDelta  = sgData.keyDelta > 0 ? (livePrice - sgData.keyDelta) / livePrice * 100 : 0;
    const _priceVsPutControl= sgData.putControl > 0 ? (livePrice - sgData.putControl) / livePrice * 100 : 0;
    const _priceVsMaxGamma  = sgData.maxGamma > 0 ? (livePrice - sgData.maxGamma) / livePrice * 100 : 0;

    // [C] Vol Term Structure (from VolContext per primary asset)
    const volAsset = volContext?.perAsset?.[primarySym] ?? volContext?.perAsset?.["SPX"] ?? null;
    const _volTermSpread    = volAsset?.termSpread ?? 0;
    const _volPutCallSkew   = volAsset?.putCallSkew ?? 0;
    const _volTermStruct    = volAsset?.termStructure === "contango" ? 1 : -1;
    const _volIVLevel       = volAsset?.ivLevel === "very_low" ? 0
                            : volAsset?.ivLevel === "low" ? 0.25
                            : volAsset?.ivLevel === "high" ? 0.75
                            : volAsset?.ivLevel === "very_high" ? 1 : 0.5;
    // Fallback: if no volContext, use IV rank as proxy for market regime
    const _volMarketRegime  = volContext?.overallRegime === "low_vol" ? 0
                            : volContext?.overallRegime === "high_vol" ? 0.67
                            : volContext?.overallRegime === "extreme_vol" ? 1
                            : volContext ? 0.33
                            : Math.min(1, ivRankNorm); // fallback: ivRank as regime proxy

    // [D] Vanna Flows (from VannaContext, with fallback to VIX asset data)
    const vixAssetData = vixAsset ?? assets.find(a => a.symbol === "VIX") ?? null;
    const vix = vannaContext?.vixPrice ?? vixAssetData?.currentPrice ?? 18;
    const _vixLevelNorm     = (vix - 20) / 20;
    const _vixChangePct     = vannaContext?.vixChangePct ?? (vixAssetData?.dailyChangePct ?? 0);
    const uvixAssetData = uvixAsset ?? assets.find(a => a.symbol === "UVIX" || a.symbol === "UVXY") ?? null;
    const _uvixChangePct    = vannaContext?.uvixChangePct ?? (uvixAssetData?.dailyChangePct ?? 0);
    const divStrMap: Record<string, number> = { none: 0, weak: 0.33, moderate: 0.67, strong: 1 };
    const divStr = vannaContext?.uvixGldDivergence?.strength ?? "none";
    const divSign = vannaContext?.uvixGldDivergence?.signal === "buy_gold" ? 1
                  : vannaContext?.uvixGldDivergence?.signal === "sell_gold" ? -1 : 0;
    const _uvixGldDiv       = (divStrMap[divStr] ?? 0) * divSign;
    const _indexVanna       = vannaContext?.indexVannaActive ? 1 : 0;
    const _refugeFlow       = vannaContext?.refugeFlowActive ? 1 : 0;

    // [E] 0DTE GEX from TraceData (use SPX trace or first available)
    const traceAsset = traceData ?? null;
    const topSup = traceAsset?.topSupport?.[0];
    const topRes = traceAsset?.topResistance?.[0];
    const traceSym = traceAsset?.currentPrice ?? livePrice;
    const _traceGexRatio    = traceAsset ? Math.min(5, Math.max(0, traceAsset.totalPositiveGex / Math.max(Math.abs(traceAsset.totalNegativeGex), 1))) : 1;
    const _traceNetBias     = traceAsset?.netGexBias === "bullish" ? 1 : traceAsset?.netGexBias === "bearish" ? -1 : 0;
    const _traceSupportDist = topSup ? (livePrice - topSup.strike) / livePrice * 100 : 0;
    const _traceResistDist  = topRes ? (topRes.strike - livePrice) / livePrice * 100 : 0;
    const _traceMaxGexDist  = traceAsset?.maxGexStrike ? (livePrice - traceAsset.maxGexStrike) / livePrice * 100 : 0;

    // [F] GEX Change Tracking
    const gct = gexChangeTracker ?? null;
    const _gexBiasChanged   = gct?.changes?.biasChanged ? 1 : 0;
    const _gexRatioDelta    = gct ? Math.max(-1, Math.min(1, (gct.changes?.ratioChange ?? 0) / 0.5)) : 0;
    const _gexSupShifted    = gct?.changes?.supportShifted ? 1 : 0;
    const _gexResShifted    = gct?.changes?.resistanceShifted ? 1 : 0;

    // [G] Tape Enriched (from TapeAssetSummary)
    const _tapeNetDelta     = liveTape ? Math.tanh(liveTape.netDelta / 1e6) : 0;
    const _tapeSentiment    = liveTape ? liveTape.sentimentScore / 100 : 0;
    const _tapePCR          = liveTape?.putCallRatio ?? 1;
    const largestTrade      = liveTape?.largestTrades?.[0]?.premium ?? 0;
    const _tapeMaxPremRatio = liveTape && liveTape.totalPremium > 0 ? Math.min(1, largestTrade / liveTape.totalPremium) : 0;

    // [H] Asset Microstructure (from AssetData)
    const _assetDailyChg   = primaryAsset?.dailyChangePct ?? 0;
    const totalGammaAbs    = Math.abs(primaryAsset?.totalGamma ?? 0);
    const _zeroDteRatio    = (primaryAsset && totalGammaAbs > 0)
                            ? Math.min(1, Math.abs(primaryAsset.zeroDteGamma) / totalGammaAbs) : 0;
    // OI call/put skew near ATM (top 5 closest strikes)
    let _oiCallPutSkew = 0;
    if (primaryAsset && primaryAsset.strikes.length > 0) {
      const near5 = [...primaryAsset.strikes].sort((a, b) => a.distanceFromPrice - b.distanceFromPrice).slice(0, 5);
      const coi = near5.reduce((s, st) => s + st.callOI, 0);
      const poi = near5.reduce((s, st) => s + st.putOI, 0);
      _oiCallPutSkew = (coi + poi) > 0 ? (coi - poi) / (coi + poi) : 0;
    }
    const _skewRankNorm  = Math.min(1, Math.max(0, (primaryAsset?.skewRank ?? 50) / 100));
    const _garchRankNorm = Math.min(1, Math.max(0, (primaryAsset?.garchRank ?? 50) / 100));

    // [I] CFD + Market Context
    const cfdKey = cfdTarget === "NAS100" ? "nas100" : cfdTarget === "US30" ? "us30" : "xauusd";
    const _cfdDailyChg  = (cfdPrices as any)?.[cfdKey]?.changePct ?? 0;
    const spxData       = cfdPrices?.spx ?? null;
    const _spxDailyChg  = spxData?.changePct ?? primaryAsset?.dailyChangePct ?? 0;
    const _flowStrength = Math.min(1, Math.max(0, (primaryAsset?.flowData?.flowStrength ?? 50) / 100));

    try {
      // ── Compute price-history-based features (momentum, RSI, ATR) ──────
      const priceHist = _priceHistoryCache[cfdTarget]?.prices ?? [];
      const _momentum5d  = computeMomentum(priceHist, 5);
      const _momentum20d = computeMomentum(priceHist, 20);
      const _rsi14       = computeRSI(priceHist, 14);
      const _atrPct      = priceHist.length > 15 ? computeATRPct(priceHist) : ((sgData as any).atrPct ?? 1.0);
      const _volumeRatio = computeVolumeRatio(priceHist, 20);

      // ── Tilt data (from SpotGamma API cache) ──────────────────────────
      const tilt = getCachedTilt(primarySym);

      // ── HIRO acceleration ─────────────────────────────────────────────
      const hiroValue = liveHiro?.hiroValue ?? 0;
      const _hiroAccel = hiroValue !== 0 ? trackHiroAccel(primarySym, hiroValue) : 0;

      // 4. Build 94-feature PPOState from raw market data
      const livePPOState = mhBuildPPOState({
        gammaTilt: tilt.gammaTilt || (sgData as any).gammaTilt || 0,
        deltaTilt: tilt.deltaTilt || (sgData as any).deltaTilt || 0,
        gammaRatioNorm: typeof gammaRatioRaw === "number" ? gammaRatioRaw / (gammaRatioRaw + 1) : 0.5,
        deltaRatioNorm: (sgData as any).deltaRatio ?? 0.5,
        ivRank: ivRankNorm,
        neSkew: sgData.neSkew ?? 0,
        vrp: (sgData.atmIV30 ?? 0) - (sgData.rv30 ?? sgData.atmIV30 ?? 0),
        momentum5d: _momentum5d,
        momentum20d: _momentum20d,
        rsi14: _rsi14,
        squeezeSig: (sgData as any).squeezeSig ?? 0,
        positionFactor: (sgData as any).positionFactor ?? 0,
        putCallRatio: (sgData as any).putCallRatio ?? 1.0,
        volumeRatio: _volumeRatio,
        atrPct: _atrPct,
        callWall: sgData.callWall ?? 0,
        putWall: sgData.putWall ?? 0,
        price: livePrice,
        isOPEXWeek: false,
        cfd: cfdTarget,
        gammaWallDist:    _gammaWallDist,      // % dist al strike de mayor gamma
        gammaConcentration: _gammaConc,         // Herfindahl — qué tan concentrado
        callGammaRatio: primaryAsset
          ? (primaryAsset.callGamma / Math.max(Math.abs(primaryAsset.totalGamma), 1e-9)) * 0.5 + 0.5
          : 0.5,
        nextExpGamma: (sgData as any).next_exp_g ?? 0,
        nextExpDelta: (sgData as any).next_exp_d ?? 0,
        tapeBullishPct: liveTape ? liveTape.callCount / Math.max(liveTape.totalTrades, 1) : 0.5,
        tapePremiumRatio: liveTape ? liveTape.callPremium / Math.max(liveTape.totalPremium, 1) : 0.5,
        tapeGammaSkew: liveTape ? (liveTape.netGamma > 0 ? 1 : liveTape.netGamma < 0 ? -1 : 0) * Math.min(1, Math.abs(liveTape.netGamma) / 1e6) : 0,
        candleBodyRatio: candleSignal.bodyRatio,
        candleTrend: candleSignal.trend,
        candleVolSpike: candleSignal.volSpike,
        impliedMovePct:   liveImPct,
        impliedMoveUsage: _impliedMoveUsage,    // ratio movimiento real / implícito (antes siempre 1)
        comboLevelDist: (() => {
          // Distancia al nivel más cercano de SpotGamma (callWall, putWall, keyGamma, volTrigger)
          const levels = [sgData.callWall, sgData.putWall, sgData.keyGamma, sgData.volTrigger]
            .filter(l => l > 0)
            .map(l => (livePrice - l) / livePrice * 100);
          if (levels.length === 0) return 0;
          return levels.reduce((min, d) => Math.abs(d) < Math.abs(min) ? d : min, levels[0]);
        })(),
        comboLevelSide: (() => {
          const levels = [sgData.callWall, sgData.putWall, sgData.keyGamma, sgData.volTrigger]
            .filter(l => l > 0);
          if (levels.length === 0) return 0;
          const closest = levels.reduce((best, l) =>
            Math.abs(l - livePrice) < Math.abs(best - livePrice) ? l : best, levels[0]);
          return livePrice > closest ? 1 : -1;
        })(),
        absGammaPeakDist: _absGammaPeakDist,   // % dist al strike de mayor gamma absoluto
        absGammaSkew:     _absGammaSkew,        // (call-put) / total en el peak
        hiroNorm: liveHiro ? (liveHiro.hiroRange30dMax !== liveHiro.hiroRange30dMin
          ? (liveHiro.hiroValue - liveHiro.hiroRange30dMin) / (liveHiro.hiroRange30dMax - liveHiro.hiroRange30dMin) * 2 - 1
          : 0) : 0,
        hiroAccel: _hiroAccel,
        volumeProfilePOC: 0,  // needs tick-level data, not available
        volumeImbalance: primaryAsset
          ? Math.min(1, primaryAsset.callVolume / Math.max(primaryAsset.callVolume + primaryAsset.putVolume, 1))
          : 0.5,
        dayOfWeek: dayOfWeekNorm,
        // Context features
        sessionType,
        macroAlertActive: !!(macroAlert?.isActive),
        counterTrendDetected: false,
        imExhaustionLevel,
        // Top-3 strike distances (features 46-48)
        topStrikeDist1: primaryAsset?.topStrikes?.[0]
          ? (livePrice - primaryAsset.topStrikes[0].strike) / livePrice * 100 : 0,
        topStrikeDist2: primaryAsset?.topStrikes?.[1]
          ? (livePrice - primaryAsset.topStrikes[1].strike) / livePrice * 100 : 0,
        topStrikeDist3: primaryAsset?.topStrikes?.[2]
          ? (livePrice - primaryAsset.topStrikes[2].strike) / livePrice * 100 : 0,
        // ── SpotGamma Extended features (49-93) ──────────────────────────
        skewNorm: _skewNorm,
        callSkewNorm: _callSkewNorm,
        putSkewNorm: _putSkewNorm,
        d95Norm: _d95Norm,
        d25neNorm: _d25neNorm,
        fwdGarchSpread: _fwdGarchSpread,
        totalDeltaNorm: _totalDeltaNorm,
        activityFactorNorm: _activityFactor,
        gammaRegimeNum: _gammaRegimeNum,
        levelsChangedFlag: _levelsChangedFlag,
        priceVsKeyDelta: _priceVsKeyDelta,
        priceVsPutControl: _priceVsPutControl,
        priceVsMaxGamma: _priceVsMaxGamma,
        volTermSpread: _volTermSpread,
        volPutCallSkew: _volPutCallSkew,
        volTermStructureNum: _volTermStruct,
        volIVLevelNum: _volIVLevel,
        volMarketRegimeNum: _volMarketRegime,
        vixLevelNorm: _vixLevelNorm,
        vixChangePctFeat: _vixChangePct,
        uvixChangePctFeat: _uvixChangePct,
        uvixGldDivStrength: _uvixGldDiv,
        indexVannaActiveFlag: _indexVanna,
        refugeFlowActiveFlag: _refugeFlow,
        traceGexRatio: _traceGexRatio,
        traceNetBiasNum: _traceNetBias,
        traceSupportDist: _traceSupportDist,
        traceResistDist: _traceResistDist,
        traceMaxGexDist: _traceMaxGexDist,
        gexBiasChangedFlag: _gexBiasChanged,
        gexRatioChangeDelta: _gexRatioDelta,
        gexSupportShiftedFlag: _gexSupShifted,
        gexResistShiftedFlag: _gexResShifted,
        tapeNetDeltaNorm: _tapeNetDelta,
        tapeSentimentNorm: _tapeSentiment,
        tapePutCallRatioNorm: _tapePCR,
        tapeLargestPremiumRatio: _tapeMaxPremRatio,
        assetDailyChangePct: _assetDailyChg,
        zeroDteRatio: _zeroDteRatio,
        oiCallPutSkew: _oiCallPutSkew,
        skewRankNorm: _skewRankNorm,
        garchRankNorm: _garchRankNorm,
        cfdDailyChangePct: _cfdDailyChg,
        spxDailyChangePct: _spxDailyChg,
        flowStrengthNorm: _flowStrength,
        // ── Model-Based Features (Markets in Profile) ─────────────────────
        // Market Structure
        isPositiveGamma: sgData.gammaRegime === "positive" ? 1 : 0,
        isNegativeGamma: (sgData.gammaRegime === "negative" || sgData.gammaRegime === "very_negative") ? 1 : 0,
        isBracketing: (() => {
          const cw = sgData.callWall ?? 0, pw = sgData.putWall ?? 0;
          if (cw <= 0 || pw <= 0 || livePrice <= 0) return 0;
          const distCW = Math.abs(livePrice - cw) / livePrice * 100;
          const distPW = Math.abs(livePrice - pw) / livePrice * 100;
          return (distCW < 3 && distPW < 3) ? 1 : 0; // within 3% of both walls
        })(),
        // Auction/Profile — POC proxy = max gamma strike
        priceVsPOC: (() => {
          const maxG = sgData.maxGamma ?? 0;
          if (maxG <= 0 || livePrice <= 0) return 0;
          return Math.max(-1, Math.min(1, (livePrice - maxG) / maxG * 10));
        })(),
        ibRangeRatio: 1, // needs intraday data, default 1 (average)
        valueAreaPosition: (() => {
          const cw = sgData.callWall ?? 0, pw = sgData.putWall ?? 0;
          const maxG = sgData.maxGamma ?? 0;
          if (cw <= 0 || pw <= 0 || livePrice <= 0) return 0;
          const range = cw - pw;
          if (range <= 0) return 0;
          return Math.max(-1, Math.min(1, (livePrice - (pw + range / 2)) / (range / 2)));
        })(),
        excessFlag: (() => {
          // 0DTE GEX extremes as excess proxy
          const traceAssetLocal = traceData ?? null;
          const topSup = traceAssetLocal?.topSupport?.[0];
          const topRes = traceAssetLocal?.topResistance?.[0];
          const supDist = topSup ? Math.abs(livePrice - topSup.strike) / livePrice * 100 : 99;
          const resDist = topRes ? Math.abs(livePrice - topRes.strike) / livePrice * 100 : 99;
          if (supDist < 0.3) return -1; // at excess low (bounce likely)
          if (resDist < 0.3) return 1;  // at excess high (reject likely)
          return 0;
        })(),
        // Model Signals
        trendDaySignal: (() => {
          // Trend day = negative gamma + strong directional move + tape alignment
          const isNegG = sgData.gammaRegime === "negative" || sgData.gammaRegime === "very_negative";
          if (!isNegG) return 0;
          const dailyChg = primaryAsset?.dailyChangePct ?? 0;
          const tapeBull = liveTape ? liveTape.callCount / Math.max(liveTape.totalTrades, 1) : 0.5;
          if (dailyChg > 0.5 && tapeBull > 0.55) return 1;  // up trend day
          if (dailyChg < -0.5 && tapeBull < 0.45) return -1; // down trend day
          return 0;
        })(),
        breakoutSignal: (() => {
          const cw = sgData.callWall ?? 0, pw = sgData.putWall ?? 0;
          if (cw <= 0 || pw <= 0) return 0;
          if (livePrice > cw) return 1;  // broke above call wall
          if (livePrice < pw) return -1; // broke below put wall
          return 0;
        })(),
        vannaFlowSignal: (() => {
          const vixChg = vannaContext?.vixChangePct ?? 0;
          const idxVanna = vannaContext?.indexVannaActive ?? false;
          const refuge = vannaContext?.refugeFlowActive ?? false;
          if (vixChg > 3 && idxVanna) return -1;  // VIX spiking → bearish indices
          if (vixChg < -3) return 1;               // VIX dropping → bullish indices
          if (refuge) return -1;                    // refuge flow → bearish indices (bullish gold)
          return 0;
        })(),
        inventoryCorrectionSignal: (() => {
          // Short covering = price near lows + HIRO starting to rise
          const hiroP = liveHiro ? (() => {
            const rm = liveHiro.hiroRange30dMin ?? 0, rx = liveHiro.hiroRange30dMax ?? 0;
            return rx !== rm ? (liveHiro.hiroValue - rm) / (rx - rm) * 100 : 50;
          })() : 50;
          const nearPW = sgData.putWall > 0 ? Math.abs(livePrice - sgData.putWall) / livePrice * 100 < 1 : false;
          const nearCW = sgData.callWall > 0 ? Math.abs(livePrice - sgData.callWall) / livePrice * 100 < 1 : false;
          if (nearPW && hiroP > 40 && hiroP < 60) return 1;  // at support, HIRO neutral→rising = short covering
          if (nearCW && hiroP > 40 && hiroP < 60) return -1; // at resistance, HIRO neutral→falling = long liquidation
          return 0;
        })(),
        gapSignal: (() => {
          const prevClose = primaryAsset?.previousClose ?? 0;
          const curPrice = primaryAsset?.currentPrice ?? 0;
          if (prevClose <= 0 || curPrice <= 0) return 0;
          const gapPct = (curPrice - prevClose) / prevClose * 100;
          if (gapPct > 0.3) return 1;   // gap up
          if (gapPct < -0.3) return -1; // gap down
          return 0;
        })(),
        // Risk Context
        vrpSign: (() => {
          const iv = sgData.atmIV30 ?? 0;
          const rv = sgData.rv30 ?? iv;
          const vrp = iv - rv;
          if (vrp > 0.01) return 1;   // positive VRP → mean reversion
          if (vrp < -0.01) return -1; // negative VRP → breakout
          return 0;
        })(),
        sessionPhase: timeNorm, // already 0-1
      }, timeNorm);

      // 5. PPO Multi-Head predict — 8 heads decide EVERYTHING
      const usePureJSInference = isMHInferenceLoaded();
      let mhDecision: MultiHeadDecision | MHInferenceResult;
      // Normalized state (needed by both JS inference and LSTM ensemble)
      const normalized = normalizeForInference(livePPOState);

      // ── Save rich daily context BEFORE PPO decision (so it saves even on SKIP) ──
      {
        const bank = getEpisodeBank();
        const todayStr = new Date().toISOString().slice(0, 10);
        if (!bank.hasDailyContext(todayStr)) {
          bank.saveDailyContext({
            date:  todayStr,
            state: Array.from(normalized),
            gex:   (sgData as any).gexLevel ?? 0,
            flip:  sgData.zeroGamma ?? 0,
            hiro:  liveHiro?.hiroValue ?? 0,
          });
          console.log(`[EpisodeBank] Rich daily context saved for ${todayStr} from ${cfdTarget} (${normalized.length}f, ${normalized.filter(v => Math.abs(v) > 0.001).length} non-zero)`);
        }
      }

      if (usePureJSInference) {

        // Actualizar rolling normalizer con las features de esta señal
        // (se llama ANTES de predict() para que el normalizador vea datos frescos)
        const _signalDate = new Date().toISOString().slice(0, 10);
        const rollingNorm = getRollingNormalizer();
        rollingNorm.update(_signalDate, normalized);
        rollingNorm.save();
        console.log(`[RollingNorm] ${cfdTarget}: ${rollingNorm.daysInBuffer}d buffer (warmed: ${rollingNorm.isWarmedUp})`);

        const result = mhInferencePredict(normalized);
        if (!result) { console.warn(`[PPO] ${cfdTarget}: inference failed`); continue; }
        mhDecision = result;
      } else {
        const mhAgent = getMultiHeadAgent();
        if (!mhAgent) { console.warn(`[PPO] ${cfdTarget}: no model loaded`); continue; }
        mhDecision = mhAgent.selectBest(livePPOState);
      }

      // Guard against NaN confidence (e.g. fresh un-trained model)
      if (!isFinite(mhDecision.confidence) || isNaN(mhDecision.confidence)) {
        console.warn(`[PPO] ${cfdTarget}: confidence NaN — model not yet trained, skipping`);
        continue;
      }

      // ── Top-strike priority boost ──────────────────────────────────────────
      const topStrikeBoost = _topStrikeProx >= 0.70 ? 1.25
                           : _topStrikeProx >= 0.40 ? 1.10
                           : _topStrikeProx >= 0.15 ? 1.00
                           : 0.90;
      const boostedConf = Math.min(100, mhDecision.confidence * topStrikeBoost);
      if (topStrikeBoost !== 1.00) {
        console.log(`[TopStrike] ${cfdTarget}: prox=${_topStrikeProx.toFixed(2)} boost=${topStrikeBoost}× conf ${mhDecision.confidence.toFixed(1)}% → ${boostedConf.toFixed(1)}%`);
      }
      (mhDecision as any).confidence = boostedConf;

      // ── 5b. LSTM Ensemble (if weights available) ───────────────────────────
      let lstmNote = "";
      if (isLSTMAvailable()) {
        try {
          const todayStr = new Date().toISOString().slice(0, 10);
          const lstmResult = predictLSTM(normalized, todayStr);
          if (lstmResult) {
            // Ensemble: average direction probabilities
            const mlpDirProbs  = mhDecision.headProbs?.direction ?? [0.33, 0.33, 0.33];
            const lstmDirProbs = lstmResult.headProbs.direction;
            const DIR_LABELS   = ["SKIP", "LONG", "SHORT"];
            const ensembleProbs = mlpDirProbs.map((p: number, i: number) =>
              0.5 * p + 0.5 * (lstmDirProbs[i] ?? 0)
            );
            const ensembleIdx = ensembleProbs.indexOf(Math.max(...ensembleProbs));
            const ensembleDir = DIR_LABELS[ensembleIdx] as "SKIP" | "LONG" | "SHORT";
            // Average confidence
            const ensembleConf = Math.round(
              0.5 * (mhDecision as any).confidence +
              0.5 * lstmResult.confidence * 100
            );

            // If models agree on direction → boost confidence
            // If they disagree → lower confidence (model uncertainty)
            if (ensembleDir === mhDecision.direction) {
              (mhDecision as any).confidence = Math.min(100, ensembleConf * 1.1);
              lstmNote = `LSTM agrees: dir=${lstmResult.direction} ensemble_conf=${ensembleConf}%`;
            } else if (ensembleDir === "SKIP" || mhDecision.direction === "SKIP") {
              lstmNote = `LSTM disagrees: MLP=${mhDecision.direction} LSTM=${lstmResult.direction} → use MLP`;
            } else {
              // Opposite direction — significant uncertainty, lower confidence
              (mhDecision as any).confidence = Math.max(0, (mhDecision as any).confidence * 0.7);
              lstmNote = `LSTM conflict: MLP=${mhDecision.direction} LSTM=${lstmResult.direction} → conf penalized`;
            }
            console.log(`[LSTM] ${cfdTarget}: ${lstmNote}`);
          }
        } catch (lstmErr: any) {
          console.warn(`[LSTM] ${cfdTarget}: inference error — ${lstmErr.message}`);
        }
      }

      console.log(`[PPO] ${cfdTarget}: dir=${mhDecision.direction} risk=${mhDecision.risk} entry=${mhDecision.entry} sizing=${mhDecision.sizing} session=${mhDecision.session} conf=${mhDecision.confidence.toFixed(1)}%${lstmNote ? " | "+lstmNote : ""}`);

      // 6. PPO filters — skip if agent says so
      if (mhDecision.direction === "SKIP") continue;
      if (mhDecision.session === "wait" && (mhDecision.headProbs?.session?.[1] ?? 0) > 0.60) continue;
      if ((mhDecision as any).overExtension === "SKIP") continue;

      // 7. Calculate SL/TP from ATR × PPO's risk multipliers
      const atrPct = (sgData as any).atrPct ?? 1.0;
      const atr = cfdPrice * Math.max(atrPct, 0.3) / 100;
      const isLong = mhDecision.direction === "LONG";
      const slPoints = atr * mhDecision.slMultiplier;
      const tp1Points = atr * mhDecision.tp1Multiplier;
      const tp2Points = atr * mhDecision.tp2Multiplier;
      const tp3Points = atr * mhDecision.tp3Multiplier;

      const stopLoss = isLong ? cfdPrice - slPoints : cfdPrice + slPoints;
      const tp1 = isLong ? cfdPrice + tp1Points : cfdPrice - tp1Points;
      const tp2 = isLong ? cfdPrice + tp2Points : cfdPrice - tp2Points;
      const tp3 = isLong ? cfdPrice + tp3Points : cfdPrice - tp3Points;

      // 8. Store PPO state for online learning
      let ppoStateAtEntry: number[] | undefined;
      let ppoHeadActions: Record<string, number> | undefined;
      let ppoHeadLogProbs: Record<string, number> | undefined;
      if ('headProbs' in mhDecision && mhDecision.headProbs) {
        const headNames = ["direction", "risk", "entry", "sizing", "session", "overExtension", "entryQuality", "scoreThreshold"] as const;
        const actions: Record<string, number> = {};
        const logProbs: Record<string, number> = {};
        for (const name of headNames) {
          const probs = mhDecision.headProbs[name as keyof typeof mhDecision.headProbs];
          if (!probs) continue;
          let best = 0;
          for (let j = 1; j < probs.length; j++) { if (probs[j] > probs[best]) best = j; }
          actions[name] = best;
          logProbs[name] = Math.log(Math.max(probs[best], 1e-8));
        }
        ppoStateAtEntry = normalizeForInference(livePPOState);
        ppoHeadActions = actions;
        ppoHeadLogProbs = logProbs;
      }

      // (Rich daily context already saved above, before PPO decision)

      // 9. Build TradeSetup — pure PPO, no rules
      const riskReward = tp2Points / Math.max(slPoints, 0.01);

      setups.push({
        asset: primarySym,
        cfd: cfdTarget,
        cfdLabel: spec.label,
        tradeType: "gamma" as any,
        direction: mhDecision.direction as "LONG" | "SHORT",
        score: Math.round(mhDecision.confidence),
        entryPrice: livePrice,
        cfdEntryPrice: cfdPrice,
        entryZone: null,
        stopLoss,
        stopLossPoints: Math.round(slPoints),
        stopLossRiskUSD: slPoints * spec.valuePerPoint * spec.lotSize,
        stopLossReason: `PPO risk=${mhDecision.risk} (ATR×${mhDecision.slMultiplier})`,
        takeProfit1: tp1,
        takeProfit1Points: Math.round(tp1Points),
        takeProfit2: tp2,
        takeProfit2Points: Math.round(tp2Points),
        takeProfit3: tp3,
        takeProfit3Points: Math.round(tp3Points),
        takeProfitReason: `PPO risk=${mhDecision.risk}`,
        riskRewardRatio: riskReward,
        breakEvenTrigger: tp1,
        trailingStopTrigger: tp2,
        trailingStopConfig: {
          tp1LockSL: cfdPrice,
          midTP1TP2LockSL: tp1,
          tp2TrailPct: 0.3,
        },
        // Confirmations — PPO learns these internally, we just log what data was available
        gexConfirmed: sgData.callWall > 0,
        gexDetail: `PPO uses GEX features directly (${primarySym})`,
        hiroConfirmed: liveHiro !== null,
        hiroDetail: liveHiro ? `HIRO=${liveHiro.hiroTrend}` : "No HIRO data",
        tapeConfirmed: liveTape !== null,
        tapeDetail: liveTape ? `Tape flow available` : "No tape data",
        levelConfirmed: true,
        levelDetail: `PPO decides entry from features (CW=$${sgData.callWall} PW=$${sgData.putWall})`,
        vannaConfirmed: vannaContext !== null,
        vannaDetail: vannaContext ? "Vanna context available" : "No vanna data",
        regimeConfirmed: true,
        regimeDetail: `Regime: ${sgData.gammaRegime ?? "unknown"}`,
        crossAssetConsensus: null,
        sgLevels: {
          callWall: sgData.callWall ?? 0,
          putWall: sgData.putWall ?? 0,
          keyGamma: sgData.keyGamma ?? 0,
          maxGamma: sgData.maxGamma ?? 0,
          volTrigger: sgData.volTrigger ?? 0,
          impliedMove: sgData.impliedMove ?? 0,
          impliedMovePct: sgData.impliedMovePct ?? 0,
          gammaRegime: sgData.gammaRegime ?? "unknown",
        },
        vannaSignal: { direction: mhDecision.direction === "LONG" ? "bullish" : "bearish" } as any,
        dynamicTP: {
          shouldAdjust: false, reason: "PPO manages risk", action: "hold" as const,
          adjustedTP1: 0, adjustedTP2: 0, confidence: mhDecision.confidence, lastChecked: new Date().toISOString(),
        },
        invalidation: {
          gammaFlipLevel: sgData.zeroGamma ?? 0,
          gammaFlipCFD: 0,
          hiroReversed: false,
          vixDangerLevel: 30,
          conditions: ["PPO monitors all conditions via features"],
        },
        gexStrengthScore: 50,
        ivRegime: ivRankNorm > 0.7 ? "high_iv" : ivRankNorm < 0.3 ? "low_iv" : "normal_iv",
        ivRank: ivRankNorm * 100,
        skewBias: (sgData.neSkew ?? 0) < -0.05 ? "put_skew" : (sgData.neSkew ?? 0) > 0.05 ? "call_skew" : "neutral",
        highVolPoint: 0,
        lowVolPoint: 0,
        atmIV30: sgData.atmIV30 ?? 0,
        rv30: sgData.rv30 ?? 0,
        vrp: (sgData.atmIV30 ?? 0) - (sgData.rv30 ?? 0),
        entryMode: "ENTRADA",
        entryQuality: "optimal",
        entryNote: `PPO Puro: dir=${mhDecision.direction} risk=${mhDecision.risk} sizing=${mhDecision.sizing} conf=${mhDecision.confidence.toFixed(1)}%`,
        sessionLabel: "PPO Puro",
        opexContext: undefined,
        adaptivePolicy: {
          riskProfile: mhDecision.risk,
          slMultiplier: mhDecision.slMultiplier,
          tp1Pct: mhDecision.tp1Multiplier,
          tp2Pct: mhDecision.tp2Multiplier,
          tp3Pct: mhDecision.tp3Multiplier,
          entryMode: "ppo_pure",
          setupTypeFilter: "all",
          volumeMultiplier: 1.0,
          confidence: mhDecision.confidence,
          isExploring: false,
          ppoStateAtEntry,
          ppoHeadActions,
          ppoHeadLogProbs,
          ppoRisk: mhDecision.risk,
          bankTradeId: `${cfdTarget}-${Date.now()}`,
        },
        reason: `[PPO] ${cfdTarget} ${mhDecision.direction} — PPO Puro (conf=${mhDecision.confidence.toFixed(0)}%, risk=${mhDecision.risk}, sizing=${mhDecision.sizing})`,
        details: [
          `[PPO-PURO] 8 heads: dir=${mhDecision.direction} risk=${mhDecision.risk} entry=${mhDecision.entry} sizing=${mhDecision.sizing} session=${mhDecision.session}`,
          `[DATA] ${primarySym}: CW=$${sgData.callWall} PW=$${sgData.putWall} ZG=$${sgData.zeroGamma} Regime=${sgData.gammaRegime}`,
          `[SL/TP] SL=${Math.round(slPoints)}pts TP1=${Math.round(tp1Points)} TP2=${Math.round(tp2Points)} TP3=${Math.round(tp3Points)} RR=${riskReward.toFixed(1)}`,
        ],
        nearestLevels: [],
        timestamp: new Date().toISOString(),
      } as TradeSetup);

      // ── Episode Bank: registrar apertura del trade ────────────────────────────
      if (ppoStateAtEntry && ppoHeadActions) {
        const bankId = `${cfdTarget}-${Date.now()}`;
        // Actualizar el bankTradeId con el mismo valor que ya pusheamos
        const lastSetup = setups[setups.length - 1];
        if (lastSetup?.adaptivePolicy) {
          (lastSetup.adaptivePolicy as any).bankTradeId = bankId;
        }
        getEpisodeBank().openEpisode(bankId, {
          date:      new Date().toISOString().slice(0, 10),
          ts:        Date.now(),
          state:     Array.from(ppoStateAtEntry),
          rawState:  Array.from(normalized),  // pre-z-score normalized (94 features)
          action: {
            direction:      ppoHeadActions["direction"]      ?? 0,
            risk:           ppoHeadActions["risk"]           ?? 1,
            entry:          ppoHeadActions["entry"]          ?? 0,
            sizing:         ppoHeadActions["sizing"]         ?? 1,
            session:        ppoHeadActions["session"]        ?? 0,
            overExtension:  ppoHeadActions["overExtension"]  ?? 0,
            entryQuality:   ppoHeadActions["entryQuality"]   ?? 0,
            scoreThreshold: ppoHeadActions["scoreThreshold"] ?? 1,
          },
          symbol:    primarySym,
          cfd:       cfdTarget,
          price:     cfdPrice,
          gexLevel:  (sgData as any).gexLevel ?? 0,
          gammaFlip: sgData.zeroGamma ?? 0,
          hiroValue: liveHiro?.hiroValue ?? 0,
          confidence: mhDecision.confidence / 100,
        });
      }

    } catch (e: any) {
      console.warn(`[PPO] ${cfdTarget} error: ${e.message}`);
    }
  }

  // ── Episode Bank: guardar contexto diario (SIEMPRE, fuera del CFD loop) ──────
  // Esto garantiza que se guarde al menos una vez por día incluso si
  // ningún CFD pasa los filtros de trading. Usa el primer PPO state disponible.
  try {
    const bank = getEpisodeBank();
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!bank.hasDailyContext(todayStr)) {
      // Build a PPO state from SPX (most reliable data source)
      const spxLevels = officialLevels?.["SPX"];
      if (spxLevels && (spxLevels.callWall > 0 || spxLevels.zeroGamma > 0)) {
        const spxAsset = assets.find(a => a.symbol === "SPX");
        const spxPrice = spxAsset?.currentPrice || spxLevels.price || 0;
        const liveHiro = hiro?.perAsset?.["SPX"] || null;
        const liveTape = tape?.perAsset?.["SPX"] || null;
        const gammaRatioRaw = (spxLevels as any).gammaRatio ?? 0.5;
        const ivRankRaw = spxLevels.ivRank ?? 50;
        const ivRankNorm = ivRankRaw > 1 ? ivRankRaw / 100 : ivRankRaw;
        const candleSignal = getCachedCandleSignal("NAS100");
        const spxCfdPrice = convertToCFDPrice("", 0, "NAS100", cfdPrices || null);

        const fbPH = _priceHistoryCache["NAS100"]?.prices ?? [];
        const fbTilt = getCachedTilt("SPX");
        const dailyPPOState = mhBuildPPOState({
          gammaTilt: fbTilt.gammaTilt || (gammaRatioRaw > 0.55 ? 0.1 : gammaRatioRaw < 0.45 ? -0.1 : 0),
          deltaTilt: fbTilt.deltaTilt || 0,
          gammaRatioNorm: gammaRatioRaw,
          deltaRatioNorm: 0.5,
          ivRank: ivRankNorm,
          neSkew: spxLevels.neSkew ?? 0,
          vrp: (spxLevels.atmIV30 ?? 0) - (spxLevels.rv30 ?? spxLevels.atmIV30 ?? 0),
          momentum5d: computeMomentum(fbPH, 5),
          momentum20d: computeMomentum(fbPH, 20),
          rsi14: computeRSI(fbPH, 14),
          squeezeSig: (spxLevels as any).squeezeSig ?? 50,
          positionFactor: (spxLevels as any).positionFactor ?? 0,
          putCallRatio: (spxLevels as any).putCallRatio ?? 1,
          volumeRatio: computeVolumeRatio(fbPH, 20),
          atrPct: fbPH.length > 15 ? computeATRPct(fbPH) : 1,
          priceVsCallWall: spxPrice > 0 ? (spxPrice - spxLevels.callWall) / spxPrice * 100 : 0,
          priceVsPutWall: spxPrice > 0 ? (spxPrice - spxLevels.putWall) / spxPrice * 100 : 0,
          isOPEX: 0,
          cfdIdx: 0,
          gammaWallDist: 0,
          gammaConcentration: 0.5,
          callGammaRatio: gammaRatioRaw,
          nextExpGamma: 0,
          nextExpDelta: 0,
          tapeBullishPct: liveTape?.bullishPct ?? 0.5,
          tapePremiumRatio: 0.5,
          tapeGammaSkew: 0,
          candleBodyRatio: candleSignal?.bodyRatio ?? 0.5,
          candleTrend: candleSignal?.trend ?? 0,
          candleVolSpike: 1,
          impliedMovePct: spxLevels.impliedMovePct ?? 1,
          impliedMoveUsage: 1,
          comboLevelDist: 0,
          comboLevelSide: 0,
          absGammaPeakDist: 0,
          absGammaSkew: 0,
          hiroNorm: liveHiro ? Math.tanh(liveHiro.hiroValue / 500) : 0,
          hiroAccel: 0,
          volumeProfilePOC: 0,
          volumeImbalance: 0.5,
          dayOfWeek: [0, -1, -0.5, 0, 0.5, 1, 0][new Date().getDay()] ?? 0,
        }, etTime.hours / 24);

        const dailyNorm = normalizeForInference(dailyPPOState);
        bank.saveDailyContext({
          date:  todayStr,
          state: Array.from(dailyNorm),
          gex:   (spxLevels as any).gexLevel ?? 0,
          flip:  spxLevels.zeroGamma ?? 0,
          hiro:  liveHiro?.hiroValue ?? 0,
        });
        console.log(`[EpisodeBank] Daily context saved for ${todayStr} (${dailyNorm.length} features)`);
      }
    }
  } catch (e: any) {
    console.warn(`[EpisodeBank] Daily context save error: ${e.message}`);
  }

  return setups.sort((a, b) => b.score - a.score);
}
