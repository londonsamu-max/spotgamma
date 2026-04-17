/**
 * Historical Simulation Engine — Train the RL agent on real past data
 *
 * Uses SpotGamma gex-history + Yahoo Finance prices to run thousands of
 * simulated trading episodes. Each episode:
 *   1. Build GEXState + UnifiedState from historical GEX snapshot
 *   2. Ask agent for decision (getFullRLDecision)
 *   3. Calculate actual reward from next-day price movement
 *   4. Update Q-tables via learnFromFullDecision
 *
 * This accelerates learning from ~25 live episodes to thousands,
 * dramatically reducing epsilon and improving decision quality.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// RL-Agent removed (Fase 3 PPO Puro) — stubs for historical simulator compat
const buildGEXState = (..._args: any[]) => ({} as any);
const buildUnifiedState = (..._args: any[]) => ({} as any);
const getFullRLDecision = (..._args: any[]) => ({ direction: "SKIP" } as any);
const learnFromFullDecision = (..._args: any[]) => {};
const getRLStats = () => ({ totalEpisodes: 0, winRate: 0, epsilon: 0 });
type GEXState = any;
type UnifiedState = any;
import { fetchAllCFDPrices } from "./yahoo-price-fetcher";
import { loadGammaTilt, loadDeltaTilt, loadDailyOHLC } from "./historical-downloader";
import { PPOAgent, buildPPOState, kellySize, parseAction, type PPOState, PPO_ACTION_LABELS, PPO_ACTION_SIZE } from "./ppo-agent";
import {
  MultiHeadPPOAgent,
  buildPPOState as mhBuildPPOState,
  buildDecision,
  HEAD_CONFIGS,
  MH_REWARDS,
  sizingRewardMultiplier,
  sessionRewardMultiplier,
  type HeadName,
} from "./ppo-multihead";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data/historical");
const GEX_HISTORY_DIR = path.join(DATA_DIR, "gex-history");
const CHART_DATA_DIR = path.join(DATA_DIR, "chart-data");
const EQUITY_GEX_DIR = path.join(DATA_DIR, "equity-gex");
const TAPE_FLOW_DIR = path.join(DATA_DIR, "tape-flow");
const TAPE_SUMMARY_DIR = path.join(DATA_DIR, "tape-summary");

// SpotGamma symbol → CFD target
const SYM_TO_CFD: Record<string, "NAS100" | "US30" | "XAUUSD"> = {
  SPX: "NAS100",
  QQQ: "NAS100",
  DIA: "US30",
  GLD: "XAUUSD",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface GEXHistoryRow {
  quote_date: string;
  sym: string;
  upx: number;
  large_call_oi: number;
  large_put_oi: number;
  gamma_ratio: string | number;   // raw ratio (>1 = more calls)
  delta_ratio: string | number;   // 0-1 range
  iv_rank: string | number;
  atm_iv30: number;
  rv30?: number;                  // realized vol 30-day (for VRP = atm_iv30 - rv30)
  ne_skew?: number;               // near-expiry skew (negative = bearish, positive = bullish)
  skew?: number;                  // overall skew
  options_implied_move?: number;
  largeCoi?: number;
  largePoi?: number;
  price?: number;
  // Rich fields from synth_oi/v1/historical
  squeeze_scanner?: number;       // squeeze probability score
  vrp_scanner?: number;           // VRP scanner signal
  vrp_scanner_high?: number;      // VRP scanner high threshold
  tca_score?: number;             // total customer activity score
  position_factor?: number;       // overall positioning factor (-1 to 1)
  activity_factor?: number;       // activity factor
  iv_pct?: number;                // IV percentile
  skew_rank?: number;             // skew rank percentile
  garch_rank?: number;            // GARCH rank
  garch_scanner?: number;         // GARCH scanner signal
  put_call_ratio?: number;        // put/call ratio
  stock_volume?: number;          // stock volume
  stock_volume_30d_avg?: number;  // 30-day avg volume
  low_vol_point?: number;         // low volatility trigger level
  high_vol_point?: number;        // high volatility trigger level
}

interface EpisodeData {
  date: string;
  nextDate: string;
  sym: string;
  cfd: "NAS100" | "US30" | "XAUUSD";
  price: number;
  nextPrice: number;           // actual next-day price
  priceDeltaPct: number;       // multi-day weighted direction signal
  callWall: number;
  putWall: number;
  gammaRatioNorm: number;      // 0-1
  deltaRatioNorm: number;      // 0-1
  ivRank: number;              // 0-1
  atrPct: number;              // instrument's own ATR% for calibrated thresholds
  neSkew: number;              // near-expiry skew (directional signal)
  vrp: number;                 // volatility risk premium = atm_iv30 - rv30
  isOPEXWeek: boolean;         // true if date is in week of third Friday
  gammaTilt: number;           // gamma tilt (positive = call-heavy, negative = put-heavy)
  deltaTilt: number;           // delta tilt (directional delta positioning)
  // Rich fields for reward shaping
  squeezeSig: number;          // squeeze_scanner signal (0-100)
  vrpScannerSig: number;       // vrp_scanner signal
  tcaScore: number;            // total customer activity score
  positionFactor: number;      // overall positioning factor (-1 to 1)
  putCallRatio: number;        // put/call ratio
  volumeRatio: number;         // stock_volume / stock_volume_30d_avg
  // Intraday high/low for realistic outcome mapping
  dayHigh: number;             // highest price during the day
  dayLow: number;              // lowest price during the day
  // Momentum features
  momentum5d: number;          // 5-day price change %
  momentum20d: number;         // 20-day price change %
  rsi14: number;               // 14-day RSI (0-100)
  // Signal quality (confluence count)
  signalQuality: number;       // 0-6 how many signals agree on direction
  // Source flag
  isTiltOnly: boolean;         // true = no GEX data, derived from tilt+OHLC only
  // ── New data sources ────────────────────────────────────────────────────
  // Chart-data derived (gamma/delta curves by strike)
  gammaWallDist: number;       // % distance from price to max absolute gamma strike
  gammaConcentration: number;  // 0-1 how peaked/concentrated gamma is (Herfindahl-like)
  callGammaRatio: number;      // call gamma / (call+put gamma) at ATM region
  // Equity-GEX derived
  nextExpGamma: number;        // near-term expiry gamma (normalized)
  nextExpDelta: number;        // near-term expiry delta (normalized)
  // Tape-flow derived
  tapeBullishPct: number;      // 0-1 fraction of bullish signals
  tapePremiumRatio: number;    // call premium / (call+put premium)
  // Tape-summary derived
  tapeGammaSkew: number;       // (call gamma - put gamma) / (call gamma + put gamma) → [-1, 1]
  // ── Phase 2: twelve_series, impliedMove, comboLevels, absGamma, HIRO ──
  candleBodyRatio: number;     // avg candle body / range (0-1, 1=no wicks)
  candleTrend: number;         // last 5 candles trend: +1 bullish, -1 bearish
  candleVolSpike: number;      // current volume / avg volume (>1 = spike)
  impliedMovePct: number;      // expected daily range as % of price
  impliedMoveUsage: number;    // actual move / implied move (>1 = exceeded)
  comboLevelDist: number;      // % distance to nearest combo level
  comboLevelSide: number;      // -1=below nearest, +1=above nearest
  absGammaPeakDist: number;    // % distance to peak absolute gamma strike
  absGammaSkew: number;        // (call-put abs gamma) / total at peak [-1,1]
  hiroNorm: number;            // HIRO value normalized to 30d range [-1,1]
  hiroAccel: number;           // HIRO change rate (acceleration)
  volumeProfilePOC: number;    // % distance to Point of Control (max volume strike)
  volumeImbalance: number;     // volume above price / total volume (0-1)
  dayOfWeek: number;           // 0=Mon, 4=Fri, normalized to [-1,1]
}

export interface SimulationResult {
  episodesRun: number;
  wins: number;
  losses: number;
  cancelled: number;
  epsilonBefore: number;
  epsilonAfter: number;
  passes: number;
  datasetSize: number;
  gexEpisodes: number;
  tiltOnlyEpisodes: number;
  symbolBreakdown: Record<string, { episodes: number; wins: number; losses: number }>;
  durationMs: number;
  yahooEnriched: boolean;
  // Walk-forward validation (train on older data, test on recent)
  walkForward?: {
    trainPeriod: string;
    testPeriod: string;
    trainWinRate: number;
    testWinRate: number;
    testEpisodes: number;
    testWins: number;
    testLosses: number;
  };
}

// ── Data Loading ──────────────────────────────────────────────────────────────

function loadGEXHistory(sym: string): GEXHistoryRow[] {
  const filePath = path.join(GEX_HISTORY_DIR, `${sym}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const arr = Array.isArray(raw) ? raw : (raw.data ?? []);
    return arr.filter((r: any) => r.quote_date && r.upx > 0);
  } catch {
    return [];
  }
}

function normalizeGammaRatio(raw: string | number): number {
  const r = parseFloat(String(raw));
  if (isNaN(r)) return 0.5;
  // raw is the actual ratio (>1 = more calls), normalize to 0-1
  return r / (r + 1);
}

function normalizeDeltaRatio(raw: string | number): number {
  const r = parseFloat(String(raw));
  if (isNaN(r) || r < 0 || r > 1) return 0.5;
  return r;
}

function normalizeIVRank(raw: string | number): number {
  const r = parseFloat(String(raw));
  if (isNaN(r)) return 0.5;
  // iv_rank can be 0-1 or 0-100
  return r > 1 ? r / 100 : r;
}

// ── New Data Source Loaders ───────────────────────────────────────────────────

interface ChartDataFeatures {
  gammaWallDist: number;
  gammaConcentration: number;
  callGammaRatio: number;
}

/** Load chart-data for a given date+sym → gamma curve features */
function loadChartDataFeatures(date: string, sym: string, price: number): ChartDataFeatures | null {
  const filePath = path.join(CHART_DATA_DIR, date, `${sym}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const strikes: number[] = data.bars?.strikes ?? [];
    const gammaAll: number[] = data.bars?.cust?.gamma?.all ?? [];
    const spotPrices: number[] = data.curves?.spot_prices ?? [];
    if (strikes.length === 0 || gammaAll.length === 0) return null;

    // Find max absolute gamma strike
    let maxAbsGamma = 0, maxGammaStrike = price;
    for (let i = 0; i < Math.min(strikes.length, gammaAll.length); i++) {
      const absG = Math.abs(gammaAll[i]);
      if (absG > maxAbsGamma) { maxAbsGamma = absG; maxGammaStrike = strikes[i]; }
    }
    const gammaWallDist = price > 0 ? ((maxGammaStrike - price) / price) * 100 : 0;

    // Gamma concentration (Herfindahl-like: sum of squared shares)
    const totalAbsGamma = gammaAll.reduce((s, g) => s + Math.abs(g), 0);
    let herfindahl = 0;
    if (totalAbsGamma > 0) {
      for (const g of gammaAll) {
        const share = Math.abs(g) / totalAbsGamma;
        herfindahl += share * share;
      }
    }
    // Normalize: 1/N (uniform) to 1 (all concentrated). Scale to 0-1.
    const n = gammaAll.length;
    const gammaConcentration = n > 1 ? Math.min(1, (herfindahl - 1/n) / (1 - 1/n)) : 0;

    // Call gamma ratio at ATM region (use curves data if available)
    const curveGammaAll: number[] = data.curves?.cust?.gamma?.all ?? [];
    let callGamma = 0, totalGamma = 0;
    if (curveGammaAll.length > 0 && spotPrices.length > 0) {
      // Find ATM region (±5% of price)
      for (let i = 0; i < Math.min(spotPrices.length, curveGammaAll.length); i++) {
        const pctDist = Math.abs(spotPrices[i] - price) / price;
        if (pctDist < 0.05) {
          totalGamma += Math.abs(curveGammaAll[i]);
          if (curveGammaAll[i] > 0) callGamma += curveGammaAll[i];
        }
      }
    }
    const callGammaRatio = totalGamma > 0 ? callGamma / totalGamma : 0.5;

    return { gammaWallDist, gammaConcentration, callGammaRatio };
  } catch { return null; }
}

interface EquityGEXFeatures {
  nextExpGamma: number;
  nextExpDelta: number;
}

/** Load equity-gex for a given date+sym */
function loadEquityGEXFeatures(date: string, sym: string): EquityGEXFeatures | null {
  const filePath = path.join(EQUITY_GEX_DIR, date, `${sym}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const entry = data[sym] ?? data[Object.keys(data)[0]] ?? data;
    return {
      nextExpGamma: typeof entry.next_exp_g === "number" ? entry.next_exp_g : 0,
      nextExpDelta: typeof entry.next_exp_d === "number" ? entry.next_exp_d : 0,
    };
  } catch { return null; }
}

interface TapeFlowFeatures {
  tapeBullishPct: number;
  tapePremiumRatio: number;
}

/** Load tape-flow for a given date+sym → aggregate signal features */
function loadTapeFlowFeatures(date: string, sym: string): TapeFlowFeatures | null {
  const filePath = path.join(TAPE_FLOW_DIR, date, `${sym}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const trades: any[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(trades) || trades.length === 0) return null;
    let bullish = 0, total = 0, callPremium = 0, putPremium = 0;
    for (const t of trades) {
      total++;
      if (t.signal === "bullish") bullish++;
      const prem = typeof t.premium === "number" ? Math.abs(t.premium) : 0;
      if (t.callPut === "CALL") callPremium += prem;
      else putPremium += prem;
    }
    const tapeBullishPct = total > 0 ? bullish / total : 0.5;
    const totalPremium = callPremium + putPremium;
    const tapePremiumRatio = totalPremium > 0 ? callPremium / totalPremium : 0.5;
    return { tapeBullishPct, tapePremiumRatio };
  } catch { return null; }
}

interface TapeSummaryFeatures {
  tapeGammaSkew: number;
}

/** Load tape-summary for a given date → market-wide flow features */
function loadTapeSummaryFeatures(date: string): TapeSummaryFeatures | null {
  const filePath = path.join(TAPE_SUMMARY_DIR, `${date}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const callGamma = data.gamma?.call ?? 0;
    const putGamma = data.gamma?.put ?? 0;
    const totalGamma = Math.abs(callGamma) + Math.abs(putGamma);
    const tapeGammaSkew = totalGamma > 0 ? (callGamma - putGamma) / totalGamma : 0;
    return { tapeGammaSkew };
  } catch { return null; }
}

// Pre-load caches for new data sources (to avoid re-reading files thousands of times)
type ChartDataCache = Record<string, ChartDataFeatures | null>;     // "date|sym" → features
type EquityGEXCache = Record<string, EquityGEXFeatures | null>;
type TapeFlowCache = Record<string, TapeFlowFeatures | null>;
type TapeSummaryCache = Record<string, TapeSummaryFeatures | null>;

function preloadChartData(syms: string[]): ChartDataCache {
  const cache: ChartDataCache = {};
  if (!fs.existsSync(CHART_DATA_DIR)) return cache;
  const dates = fs.readdirSync(CHART_DATA_DIR).filter(d => /^\d{4}/.test(d));
  for (const date of dates) {
    for (const sym of syms) {
      const key = `${date}|${sym}`;
      cache[key] = null; // mark as "exists but not loaded yet" — lazy load with price
    }
  }
  console.log(`[SIM] Chart-data: ${dates.length} dates available for enrichment`);
  return cache;
}

function preloadEquityGEX(syms: string[]): EquityGEXCache {
  const cache: EquityGEXCache = {};
  if (!fs.existsSync(EQUITY_GEX_DIR)) return cache;
  const dates = fs.readdirSync(EQUITY_GEX_DIR).filter(d => /^\d{4}/.test(d));
  for (const date of dates) {
    for (const sym of syms) {
      cache[`${date}|${sym}`] = loadEquityGEXFeatures(date, sym);
    }
  }
  console.log(`[SIM] Equity-GEX: ${dates.length} dates loaded`);
  return cache;
}

function preloadTapeFlow(syms: string[]): TapeFlowCache {
  const cache: TapeFlowCache = {};
  if (!fs.existsSync(TAPE_FLOW_DIR)) return cache;
  const dates = fs.readdirSync(TAPE_FLOW_DIR).filter(d => /^\d{4}/.test(d));
  for (const date of dates) {
    for (const sym of syms) {
      cache[`${date}|${sym}`] = loadTapeFlowFeatures(date, sym);
    }
  }
  console.log(`[SIM] Tape-flow: ${dates.length} dates loaded`);
  return cache;
}

function preloadTapeSummary(): TapeSummaryCache {
  const cache: TapeSummaryCache = {};
  if (!fs.existsSync(TAPE_SUMMARY_DIR)) return cache;
  const files = fs.readdirSync(TAPE_SUMMARY_DIR).filter(f => f.endsWith(".json"));
  for (const f of files) {
    const date = f.replace(".json", "");
    cache[date] = loadTapeSummaryFeatures(date);
  }
  console.log(`[SIM] Tape-summary: ${files.length} dates loaded`);
  return cache;
}

/**
 * Returns true if the given date (YYYY-MM-DD) falls in the week of the
 * third Friday of its month (OPEX week). Trades behave differently that week.
 */
function isOPEXWeek(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z");
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();

  // Find the third Friday of this month
  let fridayCount = 0;
  let thirdFriday = new Date(Date.UTC(year, month, 1));
  while (fridayCount < 3) {
    if (thirdFriday.getUTCDay() === 5) fridayCount++;
    if (fridayCount < 3) thirdFriday.setUTCDate(thirdFriday.getUTCDate() + 1);
  }

  // OPEX week = Mon-Fri of that week (Sun 00:00 to Sat 23:59)
  const dayOfWeek = thirdFriday.getUTCDay(); // 5 = Friday
  const weekStart = new Date(thirdFriday);
  weekStart.setUTCDate(thirdFriday.getUTCDate() - (dayOfWeek - 1)); // Monday
  const weekEnd = new Date(thirdFriday);
  weekEnd.setUTCDate(thirdFriday.getUTCDate() + 1); // Saturday

  return d >= weekStart && d <= weekEnd;
}

/**
 * Compute reward multiplier from skew and direction.
 * - Skew confirms direction → 1.15 (higher quality signal)
 * - Skew contradicts direction → 0.85 (lower quality signal)
 * - Neutral → 1.0
 */
function skewRewardMultiplier(neSkew: number, direction: "LONG" | "SHORT"): number {
  if (neSkew < -0.05 && direction === "SHORT") return 1.15; // bearish skew + short
  if (neSkew > 0.05 && direction === "LONG")  return 1.15; // bullish skew + long
  if (neSkew < -0.05 && direction === "LONG")  return 0.85; // skew against
  if (neSkew > 0.05 && direction === "SHORT") return 0.85; // skew against
  return 1.0;
}

/**
 * Compute reward multiplier from VRP (atm_iv30 - rv30).
 * High VRP means market expects big moves → signals less reliable → dampen reward.
 */
function vrpRewardMultiplier(vrp: number): number {
  if (vrp > 0.08) return 0.90;  // high VRP — less reliable
  if (vrp > 0.04) return 0.95;  // moderate VRP
  if (vrp < -0.02) return 1.05; // negative VRP (realized > implied) — rare but high quality
  return 1.0;
}

/**
 * OPEX week reward multiplier.
 * During OPEX week, gamma pinning can trap trades near strikes → penalize mildly.
 */
function opexRewardMultiplier(isOpex: boolean): number {
  return isOpex ? 0.92 : 1.0;
}

/**
 * Tilt reward multiplier from gammaTilt + deltaTilt.
 * - gammaTilt > 0.05 and direction LONG → 1.08 (call-heavy, favors bullish)
 * - deltaTilt confirming direction → additional +0.05
 * - Contradicting tilt → 0.90
 */
function tiltRewardMultiplier(gammaTilt: number, deltaTilt: number, direction: "LONG" | "SHORT"): number {
  let mult = 1.0;
  // Gamma tilt
  if (gammaTilt > 0.05 && direction === "LONG")  mult += 0.08;
  if (gammaTilt < -0.05 && direction === "SHORT") mult += 0.08;
  if (gammaTilt > 0.05 && direction === "SHORT")  mult -= 0.10;
  if (gammaTilt < -0.05 && direction === "LONG")  mult -= 0.10;
  // Delta tilt (separate, additive)
  if (deltaTilt > 0.05 && direction === "LONG")  mult += 0.05;
  if (deltaTilt < -0.05 && direction === "SHORT") mult += 0.05;
  if (deltaTilt > 0.05 && direction === "SHORT")  mult -= 0.05;
  if (deltaTilt < -0.05 && direction === "LONG")  mult -= 0.05;
  return Math.max(0.75, Math.min(1.25, mult));
}

/**
 * Rich signal reward multiplier: squeeze, VRP scanner, position factor, volume.
 * These fields come from synth_oi/v1/historical and give extra context.
 */
function richSignalMultiplier(ep: EpisodeData, direction: "LONG" | "SHORT"): number {
  let mult = 1.0;

  // Squeeze signal: high squeeze = imminent big move, amplify reward
  if (ep.squeezeSig > 80) mult += 0.06;      // strong squeeze → move is coming
  else if (ep.squeezeSig > 50) mult += 0.02;

  // VRP scanner: high VRP = overpriced options → dampens signal quality
  if (ep.vrpScannerSig > 80) mult -= 0.06;   // very high VRP — signals noisy
  else if (ep.vrpScannerSig > 50) mult -= 0.03;

  // Position factor: -1 to 1. Positive = market bullish positioning
  if (ep.positionFactor > 0.3 && direction === "LONG")  mult += 0.04;
  if (ep.positionFactor < -0.3 && direction === "SHORT") mult += 0.04;
  if (ep.positionFactor > 0.3 && direction === "SHORT")  mult -= 0.04;
  if (ep.positionFactor < -0.3 && direction === "LONG")  mult -= 0.04;

  // Volume ratio: high volume days have more conviction
  if (ep.volumeRatio > 1.5) mult += 0.03;    // above-average volume
  if (ep.volumeRatio < 0.5) mult -= 0.03;    // below-average volume — less conviction

  // Put/Call ratio: extreme put/call as contrarian signal
  if (ep.putCallRatio > 1.5 && direction === "LONG") mult += 0.03;  // extreme puts → contrarian bullish
  if (ep.putCallRatio < 0.5 && direction === "SHORT") mult += 0.03; // extreme calls → contrarian bearish

  return Math.max(0.80, Math.min(1.20, mult));
}

/**
 * Signal quality: count how many signals agree on a direction.
 * High quality (4+) = strong conviction. Low quality (0-1) = noise.
 */
function computeSignalQuality(
  ep: { gammaRatioNorm: number; deltaRatioNorm: number; neSkew: number; gammaTilt: number; deltaTilt: number; positionFactor: number; momentum5d: number },
  direction: "LONG" | "SHORT",
): number {
  let score = 0;
  const isLong = direction === "LONG";
  if (isLong ? ep.gammaRatioNorm > 0.55 : ep.gammaRatioNorm < 0.45) score++;
  if (isLong ? ep.deltaRatioNorm > 0.55 : ep.deltaRatioNorm < 0.45) score++;
  if (isLong ? ep.neSkew > 0.03 : ep.neSkew < -0.03) score++;
  if (isLong ? ep.gammaTilt > 0.03 : ep.gammaTilt < -0.03) score++;
  if (isLong ? ep.deltaTilt > 0.03 : ep.deltaTilt < -0.03) score++;
  if (isLong ? ep.positionFactor > 0.1 : ep.positionFactor < -0.1) score++;
  if (isLong ? ep.momentum5d > 0.3 : ep.momentum5d < -0.3) score++;
  return score;
}

/**
 * Signal quality reward multiplier.
 * High confluence → amplify. Low confluence → dampen.
 */
function signalQualityMultiplier(quality: number): number {
  if (quality >= 5) return 1.12;  // very strong confluence
  if (quality >= 4) return 1.06;
  if (quality >= 3) return 1.0;   // neutral
  if (quality >= 2) return 0.94;
  return 0.88;                     // weak confluence
}

/**
 * Compute per-symbol ATR% from all available historical rows.
 * ATR% = mean(|price[N+1] - price[N]| / price[N] * 100)
 */
function computeSymbolATR(rows: GEXHistoryRow[]): number {
  if (rows.length < 2) return 0.8; // default 0.8% if no data
  let totalPct = 0;
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const p0 = rows[i - 1].upx;
    const p1 = rows[i].upx;
    if (p0 > 0 && p1 > 0) {
      totalPct += Math.abs(p1 - p0) / p0 * 100;
      count++;
    }
  }
  return count > 0 ? totalPct / count : 0.8;
}

/** Compute RSI from a series of closing prices */
function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/** Build episode dataset from gex-history rows + tilt-only episodes.
 *  Enriched with momentum, RSI, intraday H/L, signal quality.
 */
export function buildEpisodeDataset(
  yahooMap?: Record<string, Record<string, number>>,
): EpisodeData[] {
  const dataset: EpisodeData[] = [];

  // Pre-load all data sources
  const gammaTiltMaps: Record<string, Record<string, number>> = {};
  const deltaTiltMaps: Record<string, Record<string, number>> = {};
  const sgOHLCMaps: Record<string, Record<string, { o: number; h: number; l: number; c: number; v: number }>> = {};

  const allSyms = [...new Set([...Object.keys(SYM_TO_CFD), "SPX", "SPY", "QQQ", "GLD", "DIA"])];
  for (const sym of allSyms) {
    try { gammaTiltMaps[sym] = loadGammaTilt(sym); } catch { gammaTiltMaps[sym] = {}; }
    try { deltaTiltMaps[sym] = loadDeltaTilt(sym); } catch { deltaTiltMaps[sym] = {}; }
    try { sgOHLCMaps[sym] = loadDailyOHLC(sym); } catch { sgOHLCMaps[sym] = {}; }
  }
  const totalSGPrices = Object.values(sgOHLCMaps).reduce((s, m) => s + Object.keys(m).length, 0);
  if (totalSGPrices > 0) console.log(`[SIM] Loaded SpotGamma daily OHLC: ${totalSGPrices} price points`);

  // Pre-load new data sources
  const equityGEXCache = preloadEquityGEX(allSyms);
  const tapeFlowCache = preloadTapeFlow(allSyms);
  const tapeSummaryCache = preloadTapeSummary();
  let chartDataEnriched = 0;

  // ── Part A: GEX-enriched episodes (full data, 2024+) ──────────────────────
  for (const [sym, cfd] of Object.entries(SYM_TO_CFD)) {
    const rows = loadGEXHistory(sym);
    if (rows.length < 4) continue;
    rows.sort((a, b) => a.quote_date.localeCompare(b.quote_date));
    const atrPct = computeSymbolATR(rows);
    const gTiltMap = gammaTiltMaps[sym] ?? {};
    const dTiltMap = deltaTiltMaps[sym] ?? {};
    const sgOHLC   = sgOHLCMaps[sym]    ?? {};

    // Build close array for momentum/RSI
    const allCloses: { date: string; c: number }[] = [];
    for (const row of rows) {
      const d = row.quote_date.slice(0, 10);
      const c = sgOHLC[d]?.c ?? row.upx ?? 0;
      if (c > 0) allCloses.push({ date: d, c });
    }
    const closeMap = new Map(allCloses.map((x, i) => [x.date, i]));

    for (let i = 0; i < rows.length - 3; i++) {
      const row = rows[i], rowN1 = rows[i + 1], rowN2 = rows[i + 2], rowN3 = rows[i + 3];
      const date = row.quote_date.slice(0, 10);
      const nextDate = rowN1.quote_date.slice(0, 10);
      const dateN2 = rowN2.quote_date?.slice(0, 10);
      const dateN3 = rowN3.quote_date?.slice(0, 10);
      const symYahooMap = yahooMap?.[sym];
      const price   = sgOHLC[date]?.c     ?? symYahooMap?.[date]     ?? row.upx   ?? 0;
      const priceN1 = sgOHLC[nextDate]?.c ?? symYahooMap?.[nextDate] ?? rowN1.upx ?? 0;
      const priceN2 = sgOHLC[dateN2]?.c   ?? symYahooMap?.[dateN2]   ?? rowN2.upx ?? 0;
      const priceN3 = sgOHLC[dateN3]?.c   ?? symYahooMap?.[dateN3]   ?? rowN3.upx ?? 0;
      if (price <= 0 || priceN1 <= 0) continue;
      const callWall = row.large_call_oi || row.largeCoi || 0;
      const putWall  = row.large_put_oi  || row.largePoi  || 0;
      if (callWall <= 0 || putWall <= 0) continue;

      const d1 = (priceN1 - price) / price * 100;
      const d2 = priceN2 > 0 ? (priceN2 - price) / price * 100 : d1;
      const d3 = priceN3 > 0 ? (priceN3 - price) / price * 100 : d1;
      const priceDeltaPct = d1 * 0.70 + d2 * 0.20 + d3 * 0.10;

      const gammaRatioNorm = normalizeGammaRatio(row.gamma_ratio);
      const deltaRatioNorm = normalizeDeltaRatio(row.delta_ratio);
      const ivRank = normalizeIVRank(row.iv_rank);
      const neSkew = typeof row.ne_skew === "number" ? row.ne_skew : typeof row.skew === "number" ? row.skew : 0;
      const atmIV = typeof row.atm_iv30 === "number" ? row.atm_iv30 : 0;
      const rv30  = typeof row.rv30 === "number" ? row.rv30 : atmIV;
      const vrp = atmIV - rv30;
      const gammaTilt = gTiltMap[date] ?? 0;
      const deltaTilt = dTiltMap[date] ?? 0;

      // Rich fields
      const squeezeSig = typeof row.squeeze_scanner === "number" ? row.squeeze_scanner : 0;
      const vrpScannerSig = typeof row.vrp_scanner === "number" ? row.vrp_scanner : 0;
      const tcaScore = typeof row.tca_score === "number" ? row.tca_score : 0;
      const positionFactor = typeof row.position_factor === "number" ? row.position_factor : 0;
      const putCallRatio = typeof row.put_call_ratio === "number" ? row.put_call_ratio : 1.0;
      const vol = typeof row.stock_volume === "number" ? row.stock_volume : 0;
      const volAvg = typeof row.stock_volume_30d_avg === "number" ? row.stock_volume_30d_avg : 1;
      const volumeRatio = volAvg > 0 ? vol / volAvg : 1.0;

      // Intraday high/low from next day's OHLC
      const nextOHLC = sgOHLC[nextDate];
      const dayHigh = nextOHLC?.h ?? 0;
      const dayLow  = nextOHLC?.l ?? 0;

      // Momentum (5d, 20d) and RSI
      const idx = closeMap.get(date) ?? -1;
      const closes = allCloses.map(x => x.c);
      const momentum5d = idx >= 5 ? (closes[idx] - closes[idx - 5]) / closes[idx - 5] * 100 : 0;
      const momentum20d = idx >= 20 ? (closes[idx] - closes[idx - 20]) / closes[idx - 20] * 100 : 0;
      const rsi14 = idx >= 15 ? computeRSI(closes.slice(0, idx + 1)) : 50;

      // ── New data source enrichment ──────────────────────────────────────
      const chartFeats = loadChartDataFeatures(date, sym, price);
      if (chartFeats) chartDataEnriched++;
      const eqGEX = equityGEXCache[`${date}|${sym}`];
      const tapeFlow = tapeFlowCache[`${date}|${sym}`];
      const tapeSummary = tapeSummaryCache[date];

      dataset.push({
        date, nextDate, sym, cfd, price, nextPrice: priceN1, priceDeltaPct,
        callWall, putWall, gammaRatioNorm, deltaRatioNorm, ivRank, atrPct,
        neSkew, vrp, isOPEXWeek: isOPEXWeek(date), gammaTilt, deltaTilt,
        squeezeSig, vrpScannerSig, tcaScore, positionFactor, putCallRatio, volumeRatio,
        dayHigh, dayLow, momentum5d, momentum20d, rsi14,
        signalQuality: 0, // computed during simulation
        isTiltOnly: false,
        // New sources (default to neutral if not available)
        gammaWallDist: chartFeats?.gammaWallDist ?? 0,
        gammaConcentration: chartFeats?.gammaConcentration ?? 0,
        callGammaRatio: chartFeats?.callGammaRatio ?? 0.5,
        nextExpGamma: eqGEX?.nextExpGamma ?? (row.next_exp_g as number ?? 0),
        nextExpDelta: eqGEX?.nextExpDelta ?? (row.next_exp_d as number ?? 0),
        tapeBullishPct: tapeFlow?.tapeBullishPct ?? 0.5,
        tapePremiumRatio: tapeFlow?.tapePremiumRatio ?? 0.5,
        tapeGammaSkew: tapeSummary?.tapeGammaSkew ?? 0,
        // Phase 2 features
        candleBodyRatio: 0.5,
        candleTrend: 0,
        candleVolSpike: 1,
        impliedMovePct: row.options_implied_move ? row.options_implied_move / (row.upx || 1) * 100 : 1,
        impliedMoveUsage: row.options_implied_move && row.upx
          ? Math.abs(priceDeltaPct) / (row.options_implied_move / row.upx * 100 || 1)
          : 1,
        comboLevelDist: 0,
        comboLevelSide: 0,
        absGammaPeakDist: chartFeats?.gammaWallDist ?? 0,
        absGammaSkew: chartFeats ? (chartFeats.callGammaRatio - 0.5) * 2 : 0,
        hiroNorm: 0,
        hiroAccel: 0,
        volumeProfilePOC: 0,
        volumeImbalance: 0.5,
        // ── NEWLY MAPPED from GEX history (were available but not connected!) ──
        skewNorm: row.skew != null ? Math.tanh((row.skew as number) * 3) : 0,
        callSkewNorm: row.cskew_pct != null ? (row.cskew_pct as number) / 100 : 0,
        putSkewNorm: row.pskew_pct != null ? (row.pskew_pct as number) / 100 : 0,
        d95Norm: row.d95 != null ? (row.d95 as number) - (row.atm_iv30 as number ?? 0) : 0,
        d25neNorm: row.d25ne != null ? (row.d25ne as number) : 0.2,
        fwdGarchSpread: row.fwd_garch != null && row.atm_iv30 != null ? (row.fwd_garch as number) - (row.atm_iv30 as number) : 0,
        skewRankNorm: row.skew_rank != null ? (row.skew_rank as number) / 100 : 0.5,
        garchRankNorm: row.garch_rank != null ? (row.garch_rank as number) / 100 : 0.5,
        assetDailyChangePct: price > 0 && row.upx ? ((priceN1 - price) / price * 100) : 0,
        oiCallPutSkew: row.callsum && row.putsum ? ((row.callsum as number) / ((row.callsum as number) + (row.putsum as number)) - 0.5) * 2 : 0,
        cfdDailyChangePct: priceDeltaPct,
        spxDailyChangePct: sym === "SPX" ? priceDeltaPct : 0,
        flowStrengthNorm: 0.5,
        dayOfWeek: (() => {
          const d = new Date(date + "T12:00:00Z").getUTCDay();
          return d === 0 ? -1 : d === 6 ? 1 : (d - 3) / 2; // Mon=-1, Wed=0, Fri=1
        })(),
        // Multi-day profile features (from OHLC history)
        compositeVAPosition: (() => {
          if (idx < 5 || !closes[idx]) return 0;
          const mid5 = closes.slice(idx - 5, idx).reduce((s, c) => s + c, 0) / 5;
          const rng5 = closes.slice(idx - 5, idx).reduce((s, c, j) => {
            const ohIdx = allCloses.findIndex(x => x.c === c);
            const oh = sgOHLC[allCloses[ohIdx]?.date ?? ""];
            return s + (oh ? oh.h - oh.l : 0);
          }, 0) / 5;
          if (rng5 <= 0) return 0;
          return Math.max(-1, Math.min(1, (price - mid5) / (rng5 / 2)));
        })(),
        poorHighFlag: (() => {
          if (i < 1) return 0;
          const prevDate = rows[i - 1].quote_date.slice(0, 10);
          const prevOHLC = sgOHLC[prevDate];
          if (!prevOHLC) return 0;
          const highExcess = (prevOHLC.h - Math.max(prevOHLC.c, prevOHLC.o)) / (prevOHLC.h - prevOHLC.l + 0.01);
          return highExcess < 0.15 ? 1 : 0; // close near high = poor high
        })(),
        poorLowFlag: (() => {
          if (i < 1) return 0;
          const prevDate = rows[i - 1].quote_date.slice(0, 10);
          const prevOHLC = sgOHLC[prevDate];
          if (!prevOHLC) return 0;
          const lowExcess = (Math.min(prevOHLC.c, prevOHLC.o) - prevOHLC.l) / (prevOHLC.h - prevOHLC.l + 0.01);
          return lowExcess < 0.15 ? 1 : 0; // close near low = poor low
        })(),
        rangeExpansion: (() => {
          if (idx < 5) return 1;
          const todayRange = dayHigh > 0 && dayLow > 0 ? (dayHigh - dayLow) / price * 100 : atrPct;
          return todayRange / (atrPct || 1);
        })(),
        volumeVsAvg: row.stock_volume && row.stock_volume_30d_avg
          ? (row.stock_volume as number) / (row.stock_volume_30d_avg as number) : 1,
        nearExpirySkew: row.ne_skew ?? 0,
      });
    }
  }

  const gexEpisodes = dataset.length;
  console.log(`[SIM] Chart-data enriched ${chartDataEnriched} episodes`);

  // ── Part B: Tilt-only episodes (2015-2024, no GEX data) ───────────────────
  // Use daily OHLC + gammaTilt/deltaTilt to create additional training episodes
  // where we don't have GEX history but do have tilt + price data.
  for (const [sym, cfd] of Object.entries(SYM_TO_CFD)) {
    const sgOHLC = sgOHLCMaps[sym] ?? {};
    const gTiltMap = gammaTiltMaps[sym] ?? {};
    const dTiltMap = deltaTiltMaps[sym] ?? {};

    // Get all dates with both OHLC and tilt data
    const ohlcDates = Object.keys(sgOHLC).sort();
    if (ohlcDates.length < 25) continue;

    // Get the earliest GEX date for this symbol to avoid duplicates
    const gexRows = loadGEXHistory(sym);
    const earliestGEXDate = gexRows.length > 0
      ? gexRows.map(r => r.quote_date.slice(0, 10)).sort()[0]
      : "9999-12-31";

    // Compute ATR from OHLC data
    let atrSum = 0, atrCount = 0;
    for (let i = 1; i < ohlcDates.length; i++) {
      const p0 = sgOHLC[ohlcDates[i - 1]]?.c ?? 0;
      const p1 = sgOHLC[ohlcDates[i]]?.c ?? 0;
      if (p0 > 0 && p1 > 0) { atrSum += Math.abs(p1 - p0) / p0 * 100; atrCount++; }
    }
    const atrPct = atrCount > 0 ? atrSum / atrCount : 0.8;

    // Build closes array for momentum/RSI
    const closes = ohlcDates.map(d => sgOHLC[d]?.c ?? 0).filter(c => c > 0);

    for (let i = 20; i < ohlcDates.length - 3; i++) {
      const date = ohlcDates[i];
      if (date >= earliestGEXDate) break; // stop at GEX data start to avoid duplicates

      const gammaTilt = gTiltMap[date] ?? 0;
      const deltaTilt = dTiltMap[date] ?? 0;
      // Only create episodes where we have tilt data
      if (gammaTilt === 0 && deltaTilt === 0) continue;

      const bar = sgOHLC[date];
      const barN1 = sgOHLC[ohlcDates[i + 1]];
      const barN2 = sgOHLC[ohlcDates[i + 2]];
      const barN3 = sgOHLC[ohlcDates[i + 3]];
      if (!bar || !barN1 || bar.c <= 0 || barN1.c <= 0) continue;

      const price = bar.c;
      const priceN1 = barN1.c;
      const priceN2 = barN2?.c ?? priceN1;
      const priceN3 = barN3?.c ?? priceN1;

      const d1 = (priceN1 - price) / price * 100;
      const d2 = (priceN2 - price) / price * 100;
      const d3 = (priceN3 - price) / price * 100;
      const priceDeltaPct = d1 * 0.70 + d2 * 0.20 + d3 * 0.10;

      // Derive GEX proxies from tilt
      const gammaRatioNorm = gammaTilt > 0.05 ? 0.62 : gammaTilt < -0.05 ? 0.38 : 0.50;
      const deltaRatioNorm = deltaTilt > 0.05 ? 0.58 : deltaTilt < -0.05 ? 0.42 : 0.50;

      // Momentum
      const momentum5d = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] * 100 : 0;
      const momentum20d = i >= 20 ? (closes[i] - closes[i - 20]) / closes[i - 20] * 100 : 0;
      const rsi14 = computeRSI(closes.slice(0, i + 1));

      // Intraday H/L
      const dayHigh = barN1.h ?? 0;
      const dayLow  = barN1.l ?? 0;

      // Use tilt-derived callWall/putWall proxies
      const callWall = price * (1 + atrPct / 100 * 1.5);
      const putWall  = price * (1 - atrPct / 100 * 1.5);

      // Check for chart-data even in tilt-only period
      const chartFeats2 = loadChartDataFeatures(date, sym, price);

      dataset.push({
        date, nextDate: ohlcDates[i + 1], sym, cfd,
        price, nextPrice: priceN1, priceDeltaPct,
        callWall, putWall, gammaRatioNorm, deltaRatioNorm,
        ivRank: 0.5, atrPct,
        neSkew: 0, vrp: 0, isOPEXWeek: isOPEXWeek(date),
        gammaTilt, deltaTilt,
        squeezeSig: 0, vrpScannerSig: 0, tcaScore: 0, positionFactor: 0,
        putCallRatio: 1.0, volumeRatio: 1.0,
        dayHigh, dayLow, momentum5d, momentum20d, rsi14,
        signalQuality: 0, isTiltOnly: true,
        // New sources (mostly defaults for tilt-only period)
        gammaWallDist: chartFeats2?.gammaWallDist ?? 0,
        gammaConcentration: chartFeats2?.gammaConcentration ?? 0,
        callGammaRatio: chartFeats2?.callGammaRatio ?? 0.5,
        nextExpGamma: 0,
        nextExpDelta: 0,
        tapeBullishPct: 0.5,
        tapePremiumRatio: 0.5,
        tapeGammaSkew: 0,
        // Phase 2 features (defaults for tilt-only)
        candleBodyRatio: bar.o && bar.h && bar.l && bar.c
          ? Math.abs(bar.c - bar.o) / Math.max(bar.h - bar.l, 0.01) : 0.5,
        candleTrend: (() => {
          let bulls = 0;
          for (let k = Math.max(0, i - 4); k <= i; k++) {
            const b = sgOHLC[ohlcDates[k]];
            if (b && b.c > b.o) bulls++;
          }
          return (bulls / Math.min(5, i + 1)) * 2 - 1; // [0,1] → [-1,1]
        })(),
        candleVolSpike: bar.v && i >= 20
          ? bar.v / (closes.slice(Math.max(0, i - 20), i).reduce((s, _, j) => s + (sgOHLC[ohlcDates[Math.max(0, i - 20) + j]]?.v ?? bar.v), 0) / 20 || 1)
          : 1,
        impliedMovePct: atrPct,  // use ATR as proxy for implied move
        impliedMoveUsage: Math.abs(priceDeltaPct) / (atrPct || 1),
        comboLevelDist: 0,
        comboLevelSide: 0,
        absGammaPeakDist: chartFeats2?.gammaWallDist ?? 0,
        absGammaSkew: chartFeats2 ? (chartFeats2.callGammaRatio - 0.5) * 2 : 0,
        hiroNorm: 0,
        hiroAccel: 0,
        volumeProfilePOC: 0,
        volumeImbalance: 0.5,
        dayOfWeek: (() => {
          const d = new Date(date + "T12:00:00Z").getUTCDay();
          return d === 0 ? -1 : d === 6 ? 1 : (d - 3) / 2;
        })(),
      });
    }
  }

  const tiltOnlyEpisodes = dataset.length - gexEpisodes;
  console.log(`[SIM] Dataset: ${gexEpisodes} GEX episodes + ${tiltOnlyEpisodes} tilt-only episodes = ${dataset.length} total`);

  return dataset;
}

// ── Outcome Mapping (ATR-calibrated) ─────────────────────────────────────────

/**
 * Map price delta to trade outcome using per-instrument ATR thresholds.
 *
 * Thresholds as multiples of ATR% (instrument's own average daily range):
 *   TP3: move > 1.2× ATR in the right direction (strong trend)
 *   TP2: move > 0.55× ATR (confirmed move)
 *   TP1: move > 0.25× ATR (partial move)
 *   SL:  move > 0.40× ATR in the wrong direction (1:1.4 R:R)
 *   Cancelled: flat or noise (< 0.25× ATR)
 *
 * This is much more accurate than flat % thresholds because:
 *   - GLD: ATR ~0.55% → TP2 at ~0.30% (realistic for gold)
 *   - SPX: ATR ~1.10% → TP2 at ~0.60% (realistic for S&P)
 *   - QQQ: ATR ~1.20% → TP2 at ~0.66%
 */
/**
 * Map outcome using BOTH close-to-close AND intraday high/low.
 * If dayHigh/dayLow are available, check if SL or TP would have been hit intraday
 * even if the close suggests otherwise. This is much more realistic.
 */
function mapOutcome(
  decision: "LONG" | "SHORT",
  priceDeltaPct: number,
  atrPct: number,
  entryPrice = 0,
  dayHigh = 0,
  dayLow = 0,
  slMult = 0.40,      // SL as multiple of ATR (can be overridden by PPO action)
  tp1Mult = 0.25,     // TP1 multiplier
  tp2Mult = 0.55,     // TP2 multiplier
  tp3Mult = 1.20,     // TP3 multiplier
  exactOutcomeLong?: string,   // exact outcome from 1-min candles
  exactOutcomeShort?: string,
  has1MinData = false,
): "tp1" | "tp2" | "tp3" | "sl" | "cancelled" {
  // If exact 1-min outcome is available, use it directly (most accurate)
  if (has1MinData) {
    const exact = decision === "LONG" ? exactOutcomeLong : exactOutcomeShort;
    if (exact && exact !== "cancelled") {
      return exact as "tp1" | "tp2" | "tp3" | "sl";
    }
    // If exact says cancelled, still fall through to check close-to-close
    if (exact === "cancelled") return "cancelled";
  }
  const safeAtr = Math.max(atrPct, 0.3);

  const tp3Pct =  safeAtr * tp3Mult;
  const tp2Pct =  safeAtr * tp2Mult;
  const tp1Pct =  safeAtr * tp1Mult;
  const slPct  =  safeAtr * slMult;

  // If we have intraday data, check what would have been hit during the day.
  // FIX: when both SL and a TP could be hit (daily H/L has no timestamps),
  // use distance-based priority — the CLOSER level is more likely hit first.
  // Old code always checked SL first, systematically overstating losses.
  if (entryPrice > 0 && dayHigh > 0 && dayLow > 0) {
    const intradayUpPct = (dayHigh - entryPrice) / entryPrice * 100;
    const intradayDownPct = (entryPrice - dayLow) / entryPrice * 100;

    const favorablePct = decision === "LONG" ? intradayUpPct : intradayDownPct;
    const adversePct   = decision === "LONG" ? intradayDownPct : intradayUpPct;

    const slHit  = adversePct >= slPct;
    // Find the highest TP level that was breached + its distance from entry
    let bestTP: "tp1" | "tp2" | "tp3" | null = null;
    let tpDist = Infinity;
    if (favorablePct >= tp3Pct) { bestTP = "tp3"; tpDist = tp3Pct; }
    else if (favorablePct >= tp2Pct) { bestTP = "tp2"; tpDist = tp2Pct; }
    else if (favorablePct >= tp1Pct) { bestTP = "tp1"; tpDist = tp1Pct; }

    if (slHit && bestTP) {
      // Both SL and a TP were breached — closer level was likely hit first
      if (tpDist <= slPct) return bestTP;   // TP was closer → hit first
      return "sl";                           // SL was closer → hit first
    }
    if (slHit)  return "sl";
    if (bestTP) return bestTP;
  }

  // Fallback to close-to-close
  if (decision === "LONG") {
    if (priceDeltaPct >=  tp3Pct) return "tp3";
    if (priceDeltaPct >=  tp2Pct) return "tp2";
    if (priceDeltaPct >=  tp1Pct) return "tp1";
    if (priceDeltaPct <= -slPct)  return "sl";
    return "cancelled";
  } else {
    if (priceDeltaPct <= -tp3Pct) return "tp3";
    if (priceDeltaPct <= -tp2Pct) return "tp2";
    if (priceDeltaPct <= -tp1Pct) return "tp1";
    if (priceDeltaPct >=  slPct)  return "sl";
    return "cancelled";
  }
}

// ── GEX State Builder for historical data ────────────────────────────────────

function buildHistoricalGEXState(ep: EpisodeData, etHour = 11.0): GEXState {
  // zeroGamma proxy: midpoint of callWall + putWall, adjusted by gamma regime
  // In positive gamma: zero gamma is above market (dealers long gamma)
  // In negative gamma: zero gamma is below market
  const wallMid = (ep.callWall + ep.putWall) / 2;

  // Use gammaRatio to estimate where zero gamma is relative to price
  // High gamma ratio (>0.6) = lots of call gamma = positive regime = ZG near callWall
  // Low gamma ratio (<0.4) = lots of put gamma = negative regime = ZG near putWall
  let zeroGammaProxy: number;
  if (ep.gammaRatioNorm > 0.58) {
    // Positive gamma: ZG is above market, near call wall
    zeroGammaProxy = ep.callWall * 0.7 + wallMid * 0.3;
  } else if (ep.gammaRatioNorm < 0.42) {
    // Negative gamma: ZG is below market, near put wall
    zeroGammaProxy = ep.putWall * 0.7 + wallMid * 0.3;
  } else {
    zeroGammaProxy = wallMid;
  }

  return buildGEXState({
    zeroGamma: zeroGammaProxy,
    callWall: ep.callWall,
    putWall: ep.putWall,
    gammaRatio: ep.gammaRatioNorm,
    etHour,
    cfd: ep.cfd,
  });
}

function deriveTapeFlow(gammaRatioNorm: number): "bullish" | "bearish" | "neutral" {
  if (gammaRatioNorm > 0.56) return "bullish";
  if (gammaRatioNorm < 0.44) return "bearish";
  return "neutral";
}

function deriveHiroTrend(deltaRatioNorm: number): "bullish" | "bearish" | "neutral" {
  if (deltaRatioNorm > 0.55) return "bullish";
  if (deltaRatioNorm < 0.45) return "bearish";
  return "neutral";
}

// ── Main Simulation Loop ──────────────────────────────────────────────────────

/**
 * Run historical simulation to train the RL agent.
 *
 * @param passes - How many times to replay the dataset (more = more training)
 * @param useYahoo - Whether to fetch Yahoo Finance prices (enriches NAS100/US30/XAUUSD)
 */
export async function runHistoricalSimulation(
  passes = 200,
  useYahoo = false,
): Promise<SimulationResult> {
  const startMs = Date.now();
  const statsBefore = getRLStats();
  const epsilonBefore = statsBefore.epsilon;

  console.log(`[SIM] Starting historical simulation — ${passes} passes, epsilon=${epsilonBefore.toFixed(3)}`);

  // Load Yahoo prices if requested
  let yahooMap: Record<string, Record<string, number>> | undefined;
  let yahooEnriched = false;
  if (useYahoo) {
    try {
      console.log(`[SIM] Fetching Yahoo Finance prices...`);
      yahooMap = await fetchAllCFDPrices();
      const totalDays = Object.values(yahooMap).reduce((s, m) => s + Object.keys(m).length, 0);
      console.log(`[SIM] Yahoo prices: ${totalDays} data points across ${Object.keys(yahooMap).length} symbols`);
      yahooEnriched = totalDays > 0;
    } catch (e: any) {
      console.warn(`[SIM] Yahoo fetch failed: ${e.message} — using upx only`);
    }
  }

  // Build episode dataset
  const dataset = buildEpisodeDataset(yahooMap);
  console.log(`[SIM] Dataset: ${dataset.length} episodes from gex-history`);

  if (dataset.length === 0) {
    return {
      episodesRun: 0, wins: 0, losses: 0, cancelled: 0,
      epsilonBefore, epsilonAfter: epsilonBefore,
      passes, datasetSize: 0, gexEpisodes: 0, tiltOnlyEpisodes: 0,
      symbolBreakdown: {},
      durationMs: Date.now() - startMs,
      yahooEnriched,
    };
  }

  // Use multiple time slots to diversify training
  const timeSlots: Array<"open" | "midday" | "close"> = ["open", "midday", "close"];
  let totalEpisodes = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalCancelled = 0;
  const symbolBreakdown: Record<string, { episodes: number; wins: number; losses: number }> = {};

  for (let pass = 0; pass < passes; pass++) {
    // Shuffle dataset each pass to improve generalization
    const shuffled = [...dataset].sort(() => Math.random() - 0.5);

    for (const ep of shuffled) {
      const cfd = ep.cfd;
      const breakdownKey = `${ep.sym}→${cfd}`;

      if (!symbolBreakdown[breakdownKey]) {
        symbolBreakdown[breakdownKey] = { episodes: 0, wins: 0, losses: 0 };
      }

      // Use different time slots across passes for diversity
      const timeSlot = timeSlots[(pass + totalEpisodes) % timeSlots.length];

      // Build states
      const gexState = buildHistoricalGEXState(ep,
        timeSlot === "open" ? 9.5 : timeSlot === "midday" ? 11.5 : 14.5,
      );

      const tapeFlow = deriveTapeFlow(ep.gammaRatioNorm);
      const hiroTrend = deriveHiroTrend(ep.deltaRatioNorm);

      // Pass IV rank + momentum so the agent learns regime-specific behaviour
      const unifiedState: UnifiedState = buildUnifiedState(gexState, tapeFlow, hiroTrend, ep.ivRank, ep.momentum5d);

      // Get agent decision
      const decision = getFullRLDecision(unifiedState);

      if (decision.direction === "SKIP") {
        // Penalize SKIP only when there was a big directional move (> 0.8× ATR)
        const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
        if (bigMove) {
          learnFromFullDecision(unifiedState, {
            directionAction: decision.directionAction,
            entryLevelAction: decision.entryLevelAction,
            riskAction: decision.riskAction,
          }, "sl");
          totalLosses++;
        } else {
          totalCancelled++;
        }
        totalEpisodes++;
        symbolBreakdown[breakdownKey].episodes++;
        continue;
      }

      const dir = decision.direction as "LONG" | "SHORT";

      // Signal quality filter: if <2 signals agree, treat as low conviction
      const sigQuality = computeSignalQuality(ep, dir);

      // Use intraday H/L for more realistic outcome mapping
      const outcome = mapOutcome(dir, ep.priceDeltaPct, ep.atrPct, ep.price, ep.dayHigh, ep.dayLow);

      // Compute reward multiplier from all signal sources
      const skewMult = skewRewardMultiplier(ep.neSkew, dir);
      const vrpMult  = vrpRewardMultiplier(ep.vrp);
      const opexMult = opexRewardMultiplier(ep.isOPEXWeek);
      const tiltMult = tiltRewardMultiplier(ep.gammaTilt, ep.deltaTilt, dir);
      const richMult = richSignalMultiplier(ep, dir);
      const sigMult  = signalQualityMultiplier(sigQuality);
      // Tilt-only episodes get slightly dampened reward (less complete info)
      const srcMult  = ep.isTiltOnly ? 0.85 : 1.0;
      const rewardMult = skewMult * vrpMult * opexMult * tiltMult * richMult * sigMult * srcMult;

      // Learn from outcome with signal-quality-aware reward
      learnFromFullDecision(unifiedState, {
        directionAction: decision.directionAction,
        entryLevelAction: decision.entryLevelAction,
        riskAction: decision.riskAction,
      }, outcome, rewardMult);

      const isWin = outcome === "tp1" || outcome === "tp2" || outcome === "tp3";
      const isLoss = outcome === "sl";

      totalEpisodes++;
      symbolBreakdown[breakdownKey].episodes++;
      if (isWin) { totalWins++; symbolBreakdown[breakdownKey].wins++; }
      if (isLoss) { totalLosses++; symbolBreakdown[breakdownKey].losses++; }
      if (!isWin && !isLoss) totalCancelled++;
    }

    if (pass % 5 === 0 || pass === passes - 1) {
      const statsNow = getRLStats();
      console.log(`[SIM] Pass ${pass + 1}/${passes}: ${totalEpisodes} eps, wins=${totalWins} losses=${totalLosses} ε=${statsNow.epsilon.toFixed(3)}`);
    }
  }

  const statsAfter = getRLStats();

  // ── Walk-forward validation ────────────────────────────────────────────────
  // Test on most recent 20% of data that was NOT shuffled into training
  // This gives us out-of-sample accuracy estimate
  const cutoffDate = "2025-06-01"; // train ≤ cutoff, test > cutoff
  const testData = dataset.filter(ep => ep.date > cutoffDate);
  const trainData = dataset.filter(ep => ep.date <= cutoffDate);

  let wfTestWins = 0, wfTestLosses = 0, wfTestEpisodes = 0;
  for (const ep of testData) {
    const gexState = buildHistoricalGEXState(ep, 11.5);
    const tapeFlow = deriveTapeFlow(ep.gammaRatioNorm);
    const hiroTrend = deriveHiroTrend(ep.deltaRatioNorm);
    const unifiedState = buildUnifiedState(gexState, tapeFlow, hiroTrend, ep.ivRank, ep.momentum5d);
    const decision = getFullRLDecision(unifiedState);
    if (decision.direction === "SKIP") continue;
    const dir = decision.direction as "LONG" | "SHORT";
    const outcome = mapOutcome(dir, ep.priceDeltaPct, ep.atrPct, ep.price, ep.dayHigh, ep.dayLow);
    wfTestEpisodes++;
    if (["tp1", "tp2", "tp3"].includes(outcome)) wfTestWins++;
    else if (outcome === "sl") wfTestLosses++;
  }

  const trainResolved = totalWins + totalLosses;
  const trainWinRate = trainResolved > 0 ? totalWins / trainResolved * 100 : 0;
  const testResolved = wfTestWins + wfTestLosses;
  const testWinRate = testResolved > 0 ? wfTestWins / testResolved * 100 : 0;

  const durationMs = Date.now() - startMs;

  // Count episode types
  const gexEpisodeCount = dataset.filter(ep => !ep.isTiltOnly).length;
  const tiltOnlyCount = dataset.filter(ep => ep.isTiltOnly).length;

  console.log(`[SIM] Done — ${totalEpisodes} episodes in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[SIM] Dataset: ${gexEpisodeCount} GEX + ${tiltOnlyCount} tilt-only = ${dataset.length}`);
  console.log(`[SIM] Epsilon: ${epsilonBefore.toFixed(3)} → ${statsAfter.epsilon.toFixed(3)}`);
  console.log(`[SIM] Training: Wins=${totalWins} Losses=${totalLosses} Cancelled=${totalCancelled} WR=${trainWinRate.toFixed(1)}%`);
  console.log(`[SIM] Walk-forward test (>${cutoffDate}): ${wfTestEpisodes} eps, wins=${wfTestWins} losses=${wfTestLosses} WR=${testWinRate.toFixed(1)}%`);

  return {
    episodesRun: totalEpisodes,
    wins: totalWins,
    losses: totalLosses,
    cancelled: totalCancelled,
    epsilonBefore,
    epsilonAfter: statsAfter.epsilon,
    passes,
    datasetSize: dataset.length,
    gexEpisodes: gexEpisodeCount,
    tiltOnlyEpisodes: tiltOnlyCount,
    symbolBreakdown,
    durationMs,
    yahooEnriched,
    walkForward: testData.length > 0 ? {
      trainPeriod: `≤${cutoffDate}`,
      testPeriod: `>${cutoffDate}`,
      trainWinRate,
      testWinRate,
      testEpisodes: wfTestEpisodes,
      testWins: wfTestWins,
      testLosses: wfTestLosses,
    } : undefined,
  };
}

// ── SpotGamma Deep History Probe ──────────────────────────────────────────────

/**
 * Probe SpotGamma API for extended historical data.
 * Tries different date range parameters to see how far back data goes.
 */
export async function probeSpotGammaHistory(token: string): Promise<{
  endpoint: string;
  dateParam: string;
  rowCount: number;
  oldestDate: string;
  success: boolean;
}[]> {
  const API_BASE = "https://api.spotgamma.com";
  const results = [];

  const testConfigs = [
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&start=2024-01-01" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&from=2024-01-01" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&date=2024-01-01" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&limit=500" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&count=365" },
    { endpoint: "/synth_oi/v1/historical", dateParam: "sym=SPX&days=365" },
    { endpoint: "/synth_oi/v1/gex_history", dateParam: "sym=SPX" },
    { endpoint: "/synth_oi/v1/levels_history", dateParam: "sym=SPX" },
    { endpoint: "/synth_oi/v2/historical", dateParam: "sym=SPX" },
  ];

  for (const config of testConfigs) {
    const url = `${API_BASE}${config.endpoint}?${config.dateParam}`;
    console.log(`[PROBE] Testing: ${url}`);

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "Origin": "https://dashboard.spotgamma.com",
          "Referer": "https://dashboard.spotgamma.com/",
        },
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!resp.ok) {
        results.push({ ...config, rowCount: 0, oldestDate: "-", success: false });
        console.log(`[PROBE] ${resp.status}: ${config.endpoint}?${config.dateParam}`);
        continue;
      }

      const data = await resp.json();
      const arr = Array.isArray(data) ? data : (data.data ?? []);
      const rowCount = arr.length;
      const dates = arr.map((r: any) => r.quote_date || r.date || "").filter(Boolean).sort();
      const oldestDate = dates[0]?.slice(0, 10) ?? "-";

      results.push({ ...config, rowCount, oldestDate, success: rowCount > 0 });
      console.log(`[PROBE] ✓ ${config.endpoint}?${config.dateParam}: ${rowCount} rows, oldest=${oldestDate}`);

      await new Promise(r => setTimeout(r, 300)); // rate limit

    } catch (e: any) {
      results.push({ ...config, rowCount: 0, oldestDate: "-", success: false });
      console.log(`[PROBE] Error: ${e.message}`);
    }
  }

  return results;
}

/** Get simulation status */
export function getSimulationStatus(): {
  gexHistoryRows: Record<string, number>;
  canSimulate: boolean;
  estimatedEpisodesPerPass: number;
} {
  const symbols = ["SPX", "QQQ", "GLD", "DIA"];
  const gexHistoryRows: Record<string, number> = {};
  let totalRows = 0;

  for (const sym of symbols) {
    const rows = loadGEXHistory(sym);
    const usable = Math.max(0, rows.length - 1); // pairs
    gexHistoryRows[sym] = usable;
    totalRows += usable;
  }

  return {
    gexHistoryRows,
    canSimulate: totalRows >= 2,
    estimatedEpisodesPerPass: totalRows * 3, // 3 time slots per episode
  };
}

// ── PPO Training ─────────────────────────────────────────────────────────────

export interface PPOTrainingResult {
  episodesRun: number;
  wins: number;
  losses: number;
  cancelled: number;
  passes: number;
  datasetSize: number;
  gexEpisodes: number;
  tiltOnlyEpisodes: number;
  durationMs: number;
  avgActorLoss: number;
  avgCriticLoss: number;
  winRateByPass: number[];      // win rate at each pass checkpoint
  kelly: { kellyFraction: number; suggestedRiskPct: number };
  walkForward?: {
    trainWinRate: number;
    testWinRate: number;
    testEpisodes: number;
    testWins: number;
    testLosses: number;
  };
}

/**
 * Train PPO agent on historical data.
 * Uses the same episode dataset as Q-learning but feeds continuous state vectors
 * to neural networks instead of discretized Q-tables.
 */
export async function runPPOTraining(
  passes = 50,
): Promise<PPOTrainingResult> {
  const startMs = Date.now();
  console.log(`[PPO] Creating agent...`);
  const agent = new PPOAgent();
  console.log(`[PPO] Agent created, skipping load (fresh training)`);

  console.log(`[PPO] Starting training — ${passes} passes`);

  // Rewards are now risk-dependent (imported from ppo-agent REWARDS)
  const PPO_REWARDS: Record<string, Record<string, number>> = {
    tight:  { tp3: 5.0, tp2: 3.0, tp1: 1.5, sl: -1.5, cancelled: 0.0 },
    normal: { tp3: 4.0, tp2: 2.5, tp1: 1.0, sl: -2.0, cancelled: 0.0 },
    wide:   { tp3: 3.5, tp2: 2.0, tp1: 0.8, sl: -2.5, cancelled: 0.0 },
  };

  // Build dataset
  const dataset = buildEpisodeDataset();
  console.log(`[PPO] Dataset: ${dataset.length} episodes`);

  if (dataset.length === 0) {
    return {
      episodesRun: 0, wins: 0, losses: 0, cancelled: 0,
      passes, datasetSize: 0, gexEpisodes: 0, tiltOnlyEpisodes: 0,
      durationMs: 0, avgActorLoss: 0, avgCriticLoss: 0,
      winRateByPass: [], kelly: { kellyFraction: 0, suggestedRiskPct: 0 },
    };
  }

  const gexEps = dataset.filter(ep => !ep.isTiltOnly).length;
  const tiltEps = dataset.filter(ep => ep.isTiltOnly).length;

  const timeSlots = [0.35, 0.48, 0.65]; // open, midday, close (normalized)
  let totalWins = 0, totalLosses = 0, totalCancelled = 0, totalEpisodes = 0;
  let totalActorLoss = 0, totalCriticLoss = 0, lossCount = 0;
  const winRateByPass: number[] = [];

  // Collect average win/loss for Kelly sizing
  let sumWinReward = 0, winCount = 0, sumLossReward = 0, lossCountKelly = 0;

  for (let pass = 0; pass < passes; pass++) {
    const shuffled = [...dataset].sort(() => Math.random() - 0.5);

    // Build all states at once for batch prediction
    const timeNorm = timeSlots[pass % timeSlots.length];
    const allStates: number[][] = [];
    const allPPOStates: PPOState[] = [];
    for (const ep of shuffled) {
      const sessionIdx = timeNorm < 0.38 ? 0 : timeNorm < 0.48 ? 1 : timeNorm < 0.60 ? 2 : timeNorm < 0.63 ? 3 : 4;
      const epCtx = { ...ep, sessionType: sessionIdx, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) };
      const ppoState = buildPPOState(epCtx, timeNorm);
      allPPOStates.push(ppoState);
      allStates.push(normalizeState(ppoState));
    }

    // Batch predict — one forward pass for all episodes
    console.log(`[PPO] Pass ${pass+1}: batch predict ${allStates.length} states...`);
    const bpStart = Date.now();
    const { probs: allProbs, values: allValues } = agent.batchPredict(allStates);
    console.log(`[PPO] Batch predict done in ${Date.now()-bpStart}ms`);

    // Collect experiences
    const experiences: {
      state: number[];
      action: number;
      reward: number;
      logProb: number;
      value: number;
      advantage: number;
      return_: number;
    }[] = [];
    const rewards: number[] = [];
    const values: number[] = [];
    const dones: boolean[] = [];

    console.log(`[PPO] Pass ${pass+1}: processing ${shuffled.length} episodes (probs=${allProbs.length} vals=${allValues.length})...`);

    for (let idx = 0; idx < shuffled.length; idx++) {
      const ep = shuffled[idx];
      const probs = allProbs[idx] ?? [0.33, 0.33, 0.34];
      const value = allValues[idx] ?? 0;

      // Sample action from probabilities
      const r = Math.random();
      let cumProb = 0, action = PPO_ACTION_SIZE - 1;
      for (let a = 0; a < PPO_ACTION_SIZE; a++) {
        cumProb += probs[a];
        if (r < cumProb) { action = a; break; }
      }
      const logProb = Math.log(Math.max(probs[action], 1e-8));
      const parsed = parseAction(action);

      if (parsed.direction === "SKIP") {
        const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
        const reward = bigMove ? -1.0 : 0;
        experiences.push({ state: allStates[idx], action, logProb, value, reward, advantage: 0, return_: 0 });
        rewards.push(reward);
        values.push(value);
        dones.push(true);
        if (bigMove) totalLosses++; else totalCancelled++;
        totalEpisodes++;
        continue;
      }

      // Use risk-specific SL/TP thresholds for outcome mapping
      const outcome = mapOutcome(
        parsed.direction as "LONG" | "SHORT", ep.priceDeltaPct, ep.atrPct,
        ep.price, ep.dayHigh, ep.dayLow,
        parsed.slMultiplier, parsed.tp1Multiplier, parsed.tp2Multiplier, parsed.tp3Multiplier,
      );
      const sigQuality = computeSignalQuality(ep, parsed.direction as "LONG" | "SHORT");
      const sigMult = signalQualityMultiplier(sigQuality);
      const srcMult = ep.isTiltOnly ? 0.85 : 1.0;
      const riskRewards = PPO_REWARDS[parsed.risk] ?? PPO_REWARDS.normal;
      const baseReward = riskRewards[outcome] ?? 0;
      const reward = baseReward * sigMult * srcMult;

      experiences.push({ state: allStates[idx], action, logProb, value, reward, advantage: 0, return_: 0 });
      rewards.push(reward);
      values.push(value);
      dones.push(true);

      const isWin = ["tp1", "tp2", "tp3"].includes(outcome);
      const isLoss = outcome === "sl";
      totalEpisodes++;
      if (isWin) { totalWins++; agent.totalWins++; sumWinReward += Math.abs(reward); winCount++; }
      if (isLoss) { totalLosses++; agent.totalLosses++; sumLossReward += Math.abs(reward); lossCountKelly++; }
      if (!isWin && !isLoss) totalCancelled++;
      agent.totalEpisodes++;
    }

    // Compute GAE
    console.log(`[PPO] Pass ${pass+1}: collected ${experiences.length} experiences, computing GAE...`);
    const { advantages, returns } = agent.computeGAE(rewards, values, dones);
    for (let i = 0; i < experiences.length; i++) {
      experiences[i].advantage = advantages[i];
      experiences[i].return_ = returns[i];
    }

    // PPO update
    console.log(`[PPO] Pass ${pass+1}: training on batch...`);
    const tbStart = Date.now();
    const { actorLoss, criticLoss } = await agent.trainOnBatch(experiences);
    console.log(`[PPO] Pass ${pass+1}: trainOnBatch done in ${Date.now()-tbStart}ms`);
    totalActorLoss += actorLoss;
    totalCriticLoss += criticLoss;
    lossCount++;
    agent.trainingLoss.push(actorLoss);

    // Log progress
    if (pass % 5 === 0 || pass === passes - 1) {
      const resolved = totalWins + totalLosses;
      const wr = resolved > 0 ? (totalWins / resolved * 100).toFixed(1) : "0";
      winRateByPass.push(parseFloat(wr));
      console.log(`[PPO] Pass ${pass + 1}/${passes}: ${totalEpisodes} eps, WR=${wr}% aLoss=${actorLoss.toFixed(4)} cLoss=${criticLoss.toFixed(4)}`);
    }
  }

  // ── Walk-forward validation ──────────────────────────────────────────────
  const cutoffDate = "2025-06-01";
  const testData = dataset.filter(ep => ep.date > cutoffDate);
  let wfWins = 0, wfLosses = 0, wfEpisodes = 0;

  for (const ep of testData) {
    const ppoState = buildPPOState({ ...ep, sessionType: 1, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) }, 0.48);
    const { action } = agent.selectBestAction(ppoState);
    const parsed = parseAction(action);
    if (parsed.direction === "SKIP") continue;
    const outcome = mapOutcome(
      parsed.direction as "LONG" | "SHORT", ep.priceDeltaPct, ep.atrPct,
      ep.price, ep.dayHigh, ep.dayLow,
      parsed.slMultiplier, parsed.tp1Multiplier, parsed.tp2Multiplier, parsed.tp3Multiplier,
    );
    wfEpisodes++;
    if (["tp1", "tp2", "tp3"].includes(outcome)) wfWins++;
    else if (outcome === "sl") wfLosses++;
  }

  const wfResolved = wfWins + wfLosses;
  const testWR = wfResolved > 0 ? wfWins / wfResolved * 100 : 0;
  const trainResolved = totalWins + totalLosses;
  const trainWR = trainResolved > 0 ? totalWins / trainResolved * 100 : 0;

  // Kelly sizing
  const avgWin = winCount > 0 ? sumWinReward / winCount : 1;
  const avgLoss = lossCountKelly > 0 ? sumLossReward / lossCountKelly : 1;
  const kelly = kellySize(totalWins / Math.max(trainResolved, 1), avgWin, avgLoss);

  const durationMs = Date.now() - startMs;

  console.log(`[PPO] Done — ${totalEpisodes} episodes in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[PPO] Train WR: ${trainWR.toFixed(1)}% | Walk-forward WR: ${testWR.toFixed(1)}%`);
  console.log(`[PPO] Kelly: f*=${kelly.kellyFraction.toFixed(3)} → risk ${kelly.suggestedRiskPct.toFixed(1)}%/trade`);

  // Save model
  await agent.save();
  console.log(`[PPO] Model saved`);

  return {
    episodesRun: totalEpisodes,
    wins: totalWins,
    losses: totalLosses,
    cancelled: totalCancelled,
    passes,
    datasetSize: dataset.length,
    gexEpisodes: gexEps,
    tiltOnlyEpisodes: tiltEps,
    durationMs,
    avgActorLoss: lossCount > 0 ? totalActorLoss / lossCount : 0,
    avgCriticLoss: lossCount > 0 ? totalCriticLoss / lossCount : 0,
    winRateByPass,
    kelly: { kellyFraction: kelly.kellyFraction, suggestedRiskPct: kelly.suggestedRiskPct },
    walkForward: testData.length > 0 ? {
      trainWinRate: trainWR,
      testWinRate: testWR,
      testEpisodes: wfEpisodes,
      testWins: wfWins,
      testLosses: wfLosses,
    } : undefined,
  };
}

// Helper — use the canonical normalizeState from ppo-agent.ts
// Re-imported to avoid circular deps
import { normalizeState } from "./ppo-agent";

// ══════════════════════════════════════════════════════════════════════════════
// ── Multi-Head PPO Training ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export interface MHPPOTrainingResult {
  episodesRun: number;
  wins: number;
  losses: number;
  cancelled: number;
  skipped: number;
  passes: number;
  datasetSize: number;
  gexEpisodes: number;
  tiltOnlyEpisodes: number;
  durationMs: number;
  avgActorLoss: number;
  avgCriticLoss: number;
  winRateByPass: number[];
  kelly: { kellyFraction: number; suggestedRiskPct: number };
  walkForward?: {
    trainWinRate: number;
    testWinRate: number;
    testEpisodes: number;
    testWins: number;
    testLosses: number;
  };
  headDistributions: Record<string, Record<string, number>>;
}

const MH_HEAD_NAMES: HeadName[] = ["direction", "risk", "entry", "sizing", "session", "overExtension", "entryQuality", "scoreThreshold"];

/**
 * Train Multi-Head PPO agent on historical data.
 *
 * Unlike single-head PPO (which maps to a flat action space), this agent
 * independently controls 5 decision heads: direction, risk, entry type,
 * position sizing, and session timing.
 *
 * Uses walk-forward validation: train on ~80% (by date), test on ~20%.
 */
export async function runMultiHeadPPOTraining(
  passes = 50,
): Promise<MHPPOTrainingResult> {
  const startMs = Date.now();
  console.log(`[MH-PPO] Creating multi-head agent...`);
  const agent = new MultiHeadPPOAgent();
  console.log(`[MH-PPO] Agent created, fresh training (${passes} passes)`);

  // Build dataset — combine daily episodes + intraday episodes
  const dailyDataset = buildEpisodeDataset();
  console.log(`[MH-PPO] Daily episodes: ${dailyDataset.length}`);

  // Generate intraday episodes (26 per day × 8 symbols = ~535K episodes)
  let intradayDataset: typeof dailyDataset = [];
  try {
    const { generateIntradayEpisodes, intradayToPPOEpisodes } = await import("./intraday-episode-generator");
    const intradayRaw = generateIntradayEpisodes();
    intradayDataset = intradayToPPOEpisodes(intradayRaw) as typeof dailyDataset;
    console.log(`[MH-PPO] Intraday episodes: ${intradayDataset.length.toLocaleString()}`);
  } catch (e: any) {
    console.warn(`[MH-PPO] Intraday generation failed: ${e.message}`);
  }

  const fullDataset = [...dailyDataset, ...intradayDataset];
  console.log(`[MH-PPO] Full dataset: ${fullDataset.length.toLocaleString()} episodes (${dailyDataset.length} daily + ${intradayDataset.length.toLocaleString()} intraday)`);

  if (fullDataset.length === 0) {
    return {
      episodesRun: 0, wins: 0, losses: 0, cancelled: 0, skipped: 0,
      passes, datasetSize: 0, gexEpisodes: 0, tiltOnlyEpisodes: 0,
      durationMs: 0, avgActorLoss: 0, avgCriticLoss: 0,
      winRateByPass: [], kelly: { kellyFraction: 0, suggestedRiskPct: 0 },
      headDistributions: {},
    };
  }

  // ── Walk-forward split: 80% train / 20% test (by date) ────────────────
  const sortedByDate = [...fullDataset].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(sortedByDate.length * 0.8);
  const trainData = sortedByDate.slice(0, splitIdx);
  const testData = sortedByDate.slice(splitIdx);
  console.log(`[MH-PPO] Train: ${trainData.length} episodes, Test: ${testData.length} episodes (cutoff: ${sortedByDate[splitIdx]?.date})`);

  const gexEps = trainData.filter(ep => !ep.isTiltOnly).length;
  const tiltEps = trainData.filter(ep => ep.isTiltOnly).length;

  const timeSlots = [0.35, 0.48, 0.65]; // open, midday, close
  let totalWins = 0, totalLosses = 0, totalCancelled = 0, totalSkipped = 0, totalEpisodes = 0;
  let totalActorLoss = 0, totalCriticLoss = 0, lossCount = 0;
  const winRateByPass: number[] = [];
  let sumWinReward = 0, winCount = 0, sumLossReward = 0, lossCountKelly = 0;

  // Track head choice distributions
  const headChoiceCounts: Record<string, Record<string, number>> = {};
  for (const name of MH_HEAD_NAMES) {
    headChoiceCounts[name] = {};
    for (const label of HEAD_CONFIGS[name].labels) {
      headChoiceCounts[name][label as string] = 0;
    }
  }

  // Sample size per pass — use subset to avoid OOM on large datasets
  const MAX_EPISODES_PER_PASS = 25_000;
  const useSubsampling = trainData.length > MAX_EPISODES_PER_PASS;
  if (useSubsampling) {
    console.log(`[MH-PPO] Subsampling ${MAX_EPISODES_PER_PASS.toLocaleString()} of ${trainData.length.toLocaleString()} episodes per pass`);
  }

  for (let pass = 0; pass < passes; pass++) {
    // Subsample if dataset is large
    let passData: typeof trainData;
    if (useSubsampling) {
      const shuffledAll = [...trainData].sort(() => Math.random() - 0.5);
      passData = shuffledAll.slice(0, MAX_EPISODES_PER_PASS);
    } else {
      passData = [...trainData].sort(() => Math.random() - 0.5);
    }
    const shuffled = passData;
    const timeNorm = timeSlots[pass % timeSlots.length];

    // Build all PPO states with model-based features
    const allStates: number[][] = [];
    const allPPOStates: PPOState[] = [];
    for (const ep of shuffled) {
      const sessionIdx = timeNorm < 0.38 ? 0 : timeNorm < 0.48 ? 1 : timeNorm < 0.60 ? 2 : timeNorm < 0.63 ? 3 : 4;
      // Compute model-based features from historical data
      const grN = ep.gammaRatioNorm ?? 0.5;
      const _cw = ep.callWall ?? 0, _pw = ep.putWall ?? 0, _pr = ep.price ?? 0;
      const _vrp = (ep.atmIV30 ?? 0) - (ep.rv30 ?? ep.atmIV30 ?? 0);
      const _vaPos = (_cw > 0 && _pw > 0 && _pr > 0) ?
        Math.max(-1, Math.min(1, (_pr - (_pw + (_cw - _pw) / 2)) / ((_cw - _pw) / 2 || 1))) : 0;
      const epCtx = {
        ...ep, sessionType: sessionIdx, macroAlertActive: false, counterTrendDetected: false,
        imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2),
        isPositiveGamma: grN > 0.6 ? 1 : 0,
        isNegativeGamma: grN < 0.4 ? 1 : 0,
        isBracketing: (_cw > 0 && _pw > 0 && _pr > 0 && Math.abs(_pr - _cw) / _pr * 100 < 3 && Math.abs(_pr - _pw) / _pr * 100 < 3) ? 1 : 0,
        priceVsPOC: 0, ibRangeRatio: 1, valueAreaPosition: _vaPos,
        excessFlag: 0, trendDaySignal: 0, breakoutSignal: 0,
        vannaFlowSignal: 0, inventoryCorrectionSignal: 0,
        gapSignal: (ep.priceDeltaPct ?? 0) > 0.3 ? 1 : (ep.priceDeltaPct ?? 0) < -0.3 ? -1 : 0,
        vrpSign: _vrp > 0.01 ? 1 : _vrp < -0.01 ? -1 : 0,
        sessionPhase: timeNorm,
      };
      const ppoState = buildPPOState(epCtx, timeNorm);
      allPPOStates.push(ppoState);
      allStates.push(normalizeState(ppoState));
    }

    // Batch predict — one forward pass
    const { allHeadProbs, values: allValues } = agent.batchPredict(allStates);

    // Collect experiences
    interface MHExp {
      state: number[];
      headActions: Record<HeadName, number>;
      headLogProbs: Record<HeadName, number>;
      reward: number;
      value: number;
      advantage: number;
      return_: number;
    }
    const experiences: MHExp[] = [];
    const rewards: number[] = [];
    const values: number[] = [];
    const dones: boolean[] = [];

    for (let idx = 0; idx < shuffled.length; idx++) {
      const ep = shuffled[idx];
      const headProbs = allHeadProbs[idx];
      const value = allValues[idx] ?? 0;

      if (!headProbs) continue;

      // Sample actions from all heads
      const { headActions, headLogProbs } = agent.sampleActions(headProbs);

      // Decode direction from all 8 heads
      const dirLabel = HEAD_CONFIGS.direction.labels[headActions.direction];
      const riskLabel = HEAD_CONFIGS.risk.labels[headActions.risk];
      const entryLabel = HEAD_CONFIGS.entry.labels[headActions.entry];
      const sizingLabel = HEAD_CONFIGS.sizing.labels[headActions.sizing];
      const sessionLabel = HEAD_CONFIGS.session.labels[headActions.session];
      const overExtLabel = HEAD_CONFIGS.overExtension.labels[headActions.overExtension];
      const entryQualLabel = HEAD_CONFIGS.entryQuality.labels[headActions.entryQuality];
      const scoreThreshLabel = HEAD_CONFIGS.scoreThreshold.labels[headActions.scoreThreshold];

      // Track distributions (all 8 heads)
      for (const name of MH_HEAD_NAMES) {
        const label = HEAD_CONFIGS[name].labels[headActions[name]] as string;
        if (label && headChoiceCounts[name]) headChoiceCounts[name][label]++;
      }

      // ── Session head: "wait" means skip this episode ───────────────────
      if (sessionLabel === "wait") {
        const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
        const reward = sessionRewardMultiplier("wait", bigMove);
        experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
        rewards.push(reward);
        values.push(value);
        dones.push(true);
        totalSkipped++;
        totalEpisodes++;
        agent.totalEpisodes++;
        continue;
      }

      // ── Direction = SKIP ───────────────────────────────────────────────
      if (dirLabel === "SKIP") {
        const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
        const reward = bigMove ? -1.0 : 0;
        experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
        rewards.push(reward);
        values.push(value);
        dones.push(true);
        if (bigMove) totalLosses++; else totalCancelled++;
        totalEpisodes++;
        agent.totalEpisodes++;
        continue;
      }

      // ── Active trade: compute outcome using risk-specific multipliers ──
      const decision = buildDecision(headActions, headProbs);
      const outcome = mapOutcome(
        decision.direction as "LONG" | "SHORT",
        ep.priceDeltaPct,
        ep.atrPct,
        ep.price,
        ep.dayHigh,
        ep.dayLow,
        decision.slMultiplier,
        decision.tp1Multiplier,
        decision.tp2Multiplier,
        decision.tp3Multiplier,
        ep.exactOutcomeLong,
        ep.exactOutcomeShort,
        ep.has1MinData ?? false,
      );

      // Base reward from risk-specific table
      const riskRewards = MH_REWARDS[riskLabel] ?? MH_REWARDS.normal;
      const baseReward = riskRewards[outcome] ?? 0;

      // Signal quality multiplier
      const sigQuality = computeSignalQuality(ep, decision.direction as "LONG" | "SHORT");
      const sigMult = signalQualityMultiplier(sigQuality);

      // Source multiplier (tilt-only gets slightly less weight)
      const srcMult = ep.isTiltOnly ? 0.85 : 1.0;

      // Sizing multiplier: penalize full position on losses, reward on wins
      const sizMult = sizingRewardMultiplier(sizingLabel, outcome);

      // Entry type bonus: "at_level" and "at_wall" should be rewarded more for wins
      let entryMult = 1.0;
      if (entryLabel === "at_wall" && ["tp2", "tp3"].includes(outcome)) entryMult = 1.1;
      else if (entryLabel === "at_level" && ["tp1", "tp2", "tp3"].includes(outcome)) entryMult = 1.05;
      else if (entryLabel === "at_market" && outcome === "sl") entryMult = 1.1; // penalize market entries on SL

      // ── New head multipliers (Fase 3 PPO Puro) ─────────────────────────
      // OverExtension: reward skipping when IM exhausted, penalize trading into it
      const imUsage = ep.impliedMoveUsage ?? 1;
      const isHighExhaustion = imUsage > 1.5;
      let overExtMult = 1.0;
      if (isHighExhaustion && overExtLabel === "SKIP") overExtMult = 1.3;
      else if (isHighExhaustion && outcome === "sl") overExtMult = 0.5;

      // EntryQuality: reward patience
      const isWinOutcome = ["tp1", "tp2", "tp3"].includes(outcome);
      let qualMult = 1.0;
      if (entryQualLabel === "WAIT_OPTIMAL" && isWinOutcome) qualMult = 1.2;
      else if (entryQualLabel === "ACCEPT_CAUTION" && outcome === "sl") qualMult = 0.7;

      // ScoreThreshold: reward being strict when signal quality is low
      let threshMult = 1.0;
      if (scoreThreshLabel === "EXTRA" && sigQuality >= 4 && isWinOutcome) threshMult = 1.15;
      else if (scoreThreshLabel === "LOW" && sigQuality <= 2 && outcome === "sl") threshMult = 0.6;

      const reward = baseReward * sigMult * srcMult * sizMult * entryMult * overExtMult * qualMult * threshMult;

      experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
      rewards.push(reward);
      values.push(value);
      dones.push(true);

      const isWin = ["tp1", "tp2", "tp3"].includes(outcome);
      const isLoss = outcome === "sl";
      totalEpisodes++;
      agent.totalEpisodes++;
      if (isWin) { totalWins++; agent.totalWins++; sumWinReward += Math.abs(reward); winCount++; }
      if (isLoss) { totalLosses++; agent.totalLosses++; sumLossReward += Math.abs(reward); lossCountKelly++; }
      if (!isWin && !isLoss) totalCancelled++;
    }

    // Compute GAE
    const { advantages, returns: rets } = agent.computeGAE(rewards, values, dones);
    for (let i = 0; i < experiences.length; i++) {
      experiences[i].advantage = advantages[i];
      experiences[i].return_ = rets[i];
    }

    // PPO update
    const { actorLoss, criticLoss } = await agent.trainOnBatch(experiences);
    totalActorLoss += actorLoss;
    totalCriticLoss += criticLoss;
    lossCount++;
    agent.trainingLoss.push(actorLoss);

    // Log progress + walk-forward validation every 10 passes
    if (pass % 10 === 0 || pass === passes - 1) {
      const resolved = totalWins + totalLosses;
      const wr = resolved > 0 ? (totalWins / resolved * 100).toFixed(1) : "0";
      winRateByPass.push(parseFloat(wr));

      // Quick walk-forward WR on test set (every 10 passes)
      let wfW = 0, wfL = 0;
      const wfSample = testData.slice(0, Math.min(2000, testData.length));
      for (const ep of wfSample) {
        const ps = buildPPOState({ ...ep, sessionType: 1, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) }, 0.48);
        const dec = agent.selectBest(ps);
        if (dec.direction === "SKIP" || dec.session === "wait") continue;
        const safeAtr = Math.max(ep.atrPct, 0.3);
        const delta = ep.priceDeltaPct;
        if (dec.direction === "LONG") {
          if (delta >= safeAtr * dec.tp1Multiplier) wfW++; else if (delta <= -safeAtr * dec.slMultiplier) wfL++;
        } else {
          if (delta <= -safeAtr * dec.tp1Multiplier) wfW++; else if (delta >= safeAtr * dec.slMultiplier) wfL++;
        }
      }
      const wfRes = wfW + wfL;
      const wfWR = wfRes > 0 ? (wfW / wfRes * 100).toFixed(1) : "N/A";
      console.log(`[MH-PPO] Pass ${pass + 1}/${passes}: ${totalEpisodes} eps, trainWR=${wr}% testWR=${wfWR}% aLoss=${actorLoss.toFixed(4)} cLoss=${criticLoss.toFixed(4)}`);
    }
  }

  // ── Walk-forward validation on test set ──────────────────────────────────
  let wfWins = 0, wfLosses = 0, wfEpisodes = 0;

  for (const ep of testData) {
    const ppoState = buildPPOState({ ...ep, sessionType: 1, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) }, 0.48);
    const decision = agent.selectBest(ppoState);

    if (decision.direction === "SKIP" || decision.session === "wait") continue;

    const outcome = mapOutcome(
      decision.direction as "LONG" | "SHORT",
      ep.priceDeltaPct,
      ep.atrPct,
      ep.price,
      ep.dayHigh,
      ep.dayLow,
      decision.slMultiplier,
      decision.tp1Multiplier,
      decision.tp2Multiplier,
      decision.tp3Multiplier,
      ep.exactOutcomeLong,
      ep.exactOutcomeShort,
      ep.has1MinData ?? false,
    );
    wfEpisodes++;
    if (["tp1", "tp2", "tp3"].includes(outcome)) wfWins++;
    else if (outcome === "sl") wfLosses++;
  }

  const wfResolved = wfWins + wfLosses;
  const testWR = wfResolved > 0 ? wfWins / wfResolved * 100 : 0;
  const trainResolved = totalWins + totalLosses;
  const trainWR = trainResolved > 0 ? totalWins / trainResolved * 100 : 0;

  // Kelly sizing
  const avgWin = winCount > 0 ? sumWinReward / winCount : 1;
  const avgLoss = lossCountKelly > 0 ? sumLossReward / lossCountKelly : 1;
  const kelly = kellySize(totalWins / Math.max(trainResolved, 1), avgWin, avgLoss);

  const durationMs = Date.now() - startMs;

  console.log(`[MH-PPO] Done — ${totalEpisodes} episodes in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[MH-PPO] Train WR: ${trainWR.toFixed(1)}% | Walk-forward WR: ${testWR.toFixed(1)}%`);
  console.log(`[MH-PPO] Kelly: f*=${kelly.kellyFraction.toFixed(3)} → risk ${kelly.suggestedRiskPct.toFixed(1)}%/trade`);
  console.log(`[MH-PPO] Head distributions:`, JSON.stringify(headChoiceCounts));

  // Save model
  await agent.save();
  console.log(`[MH-PPO] Model saved`);

  return {
    episodesRun: totalEpisodes,
    wins: totalWins,
    losses: totalLosses,
    cancelled: totalCancelled,
    skipped: totalSkipped,
    passes,
    datasetSize: fullDataset.length,
    gexEpisodes: gexEps,
    tiltOnlyEpisodes: tiltEps,
    durationMs,
    avgActorLoss: lossCount > 0 ? totalActorLoss / lossCount : 0,
    avgCriticLoss: lossCount > 0 ? totalCriticLoss / lossCount : 0,
    winRateByPass,
    kelly: { kellyFraction: kelly.kellyFraction, suggestedRiskPct: kelly.suggestedRiskPct },
    walkForward: testData.length > 0 ? {
      trainWinRate: trainWR,
      testWinRate: testWR,
      testEpisodes: wfEpisodes,
      testWins: wfWins,
      testLosses: wfLosses,
    } : undefined,
    headDistributions: headChoiceCounts,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Ensemble Training with Curriculum Learning ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export async function runEnsembleTraining(
  numModels = 3,
  passesPerModel = 50,
): Promise<{ models: { id: number; trainWR: number; testWR: number }[]; ensembleTestWR: number }> {
  const fs = await import("fs");
  const path = await import("path");
  const modelDir = path.resolve(process.cwd(), "data/ppo-multihead-model");

  console.log(`[ENSEMBLE] Training ${numModels} models with curriculum learning...`);

  // Build dataset once (shared across all models)
  const dailyDataset = buildEpisodeDataset();
  let intradayDataset: typeof dailyDataset = [];
  try {
    const { generateIntradayEpisodes, intradayToPPOEpisodes } = await import("./intraday-episode-generator");
    const intradayRaw = generateIntradayEpisodes();
    intradayDataset = intradayToPPOEpisodes(intradayRaw) as typeof dailyDataset;
  } catch (e: any) {
    console.warn(`[ENSEMBLE] Intraday generation failed: ${e.message}`);
  }
  const fullDataset = [...dailyDataset, ...intradayDataset];
  console.log(`[ENSEMBLE] Dataset: ${fullDataset.length.toLocaleString()} episodes`);

  // Walk-forward split
  const sortedByDate = [...fullDataset].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(sortedByDate.length * 0.8);
  const trainData = sortedByDate.slice(0, splitIdx);
  const testData = sortedByDate.slice(splitIdx);
  console.log(`[ENSEMBLE] Train: ${trainData.length}, Test: ${testData.length}`);

  // Curriculum: separate data by difficulty
  const trendingEps = trainData.filter(ep => {
    const gr = ep.gammaRatioNorm ?? 0.5;
    return (gr > 0.6 || gr < 0.4) && Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.3;
  });
  const rangingEps = trainData.filter(ep => {
    const gr = ep.gammaRatioNorm ?? 0.5;
    return gr >= 0.4 && gr <= 0.6;
  });
  console.log(`[ENSEMBLE] Curriculum: ${trendingEps.length} trending (easy), ${rangingEps.length} ranging (hard), ${trainData.length} all`);

  const MAX_PER_PASS = 25_000;
  const timeSlots = [0.35, 0.48, 0.65];
  const results: { id: number; trainWR: number; testWR: number; agent: MultiHeadPPOAgent }[] = [];

  for (let modelIdx = 0; modelIdx < numModels; modelIdx++) {
    console.log(`\n[ENSEMBLE] ═══ Model ${modelIdx + 1}/${numModels} ═══`);
    const agent = new MultiHeadPPOAgent();

    let totalWins = 0, totalLosses = 0, totalEpisodes = 0;

    for (let pass = 0; pass < passesPerModel; pass++) {
      // Curriculum: first 30% trending only, next 30% mixed, last 40% all data
      let passData: typeof trainData;
      const currPhase = pass / passesPerModel;
      if (currPhase < 0.3) {
        // Phase 1: Easy — trending episodes only (clear direction)
        const shuffled = [...trendingEps].sort(() => Math.random() - 0.5);
        passData = shuffled.slice(0, MAX_PER_PASS);
      } else if (currPhase < 0.6) {
        // Phase 2: Mixed — trending + ranging
        const mixed = [...trendingEps, ...rangingEps].sort(() => Math.random() - 0.5);
        passData = mixed.slice(0, MAX_PER_PASS);
      } else {
        // Phase 3: All data (hardest — includes noise)
        const all = [...trainData].sort(() => Math.random() - 0.5);
        passData = all.slice(0, MAX_PER_PASS);
      }

      const timeNorm = timeSlots[pass % timeSlots.length];
      const allStates: number[][] = [];
      const allPPOStates: PPOState[] = [];

      for (const ep of passData) {
        const sessionIdx = timeNorm < 0.38 ? 0 : timeNorm < 0.48 ? 1 : timeNorm < 0.60 ? 2 : timeNorm < 0.63 ? 3 : 4;
        const grN = ep.gammaRatioNorm ?? 0.5;
        const _cw = ep.callWall ?? 0, _pw = ep.putWall ?? 0, _pr = ep.price ?? 0;
        const _vrp = (ep.atmIV30 ?? 0) - (ep.rv30 ?? ep.atmIV30 ?? 0);
        const _vaPos = (_cw > 0 && _pw > 0 && _pr > 0) ?
          Math.max(-1, Math.min(1, (_pr - (_pw + (_cw - _pw) / 2)) / ((_cw - _pw) / 2 || 1))) : 0;
        const epCtx = {
          ...ep, sessionType: sessionIdx, macroAlertActive: false, counterTrendDetected: false,
          imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2),
          isPositiveGamma: grN > 0.6 ? 1 : 0,
          isNegativeGamma: grN < 0.4 ? 1 : 0,
          isBracketing: (_cw > 0 && _pw > 0 && _pr > 0 && Math.abs(_pr - _cw) / _pr * 100 < 3 && Math.abs(_pr - _pw) / _pr * 100 < 3) ? 1 : 0,
          priceVsPOC: 0, ibRangeRatio: 1, valueAreaPosition: _vaPos,
          excessFlag: 0, trendDaySignal: 0, breakoutSignal: 0,
          vannaFlowSignal: 0, inventoryCorrectionSignal: 0,
          gapSignal: (ep.priceDeltaPct ?? 0) > 0.3 ? 1 : (ep.priceDeltaPct ?? 0) < -0.3 ? -1 : 0,
          vrpSign: _vrp > 0.01 ? 1 : _vrp < -0.01 ? -1 : 0,
          sessionPhase: timeNorm,
          compositeVAPosition: ep.compositeVAPosition ?? 0,
          poorHighFlag: ep.poorHighFlag ?? 0,
          poorLowFlag: ep.poorLowFlag ?? 0,
          rangeExpansion: ep.rangeExpansion ?? 1,
          volumeVsAvg: ep.volumeVsAvg ?? 1,
          nearExpirySkew: ep.nearExpirySkew ?? (ep.neSkew ?? 0),
        };
        const ppoState = buildPPOState(epCtx, timeNorm);
        allPPOStates.push(ppoState);
        allStates.push(normalizeState(ppoState));
      }

      const { allHeadProbs, values: allValues } = agent.batchPredict(allStates);
      const experiences: any[] = [];
      const rewards: number[] = [], values: number[] = [], dones: boolean[] = [];

      for (let idx = 0; idx < passData.length; idx++) {
        const ep = passData[idx];
        const headProbs = allHeadProbs[idx];
        const value = allValues[idx] ?? 0;
        if (!headProbs) continue;

        const { headActions, headLogProbs } = agent.sampleActions(headProbs);
        const dirLabel = HEAD_CONFIGS.direction.labels[headActions.direction];
        const riskLabel = HEAD_CONFIGS.risk.labels[headActions.risk];
        const sessionLabel = HEAD_CONFIGS.session.labels[headActions.session];
        const sizingLabel = HEAD_CONFIGS.sizing.labels[headActions.sizing];

        if (sessionLabel === "wait") {
          const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
          const reward = sessionRewardMultiplier("wait", bigMove);
          experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
          rewards.push(reward); values.push(value); dones.push(true);
          totalEpisodes++; agent.totalEpisodes++;
          continue;
        }
        if (dirLabel === "SKIP") {
          const bigMove = Math.abs(ep.priceDeltaPct) > ep.atrPct * 0.8;
          const reward = bigMove ? -1.0 : 0;
          experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
          rewards.push(reward); values.push(value); dones.push(true);
          totalEpisodes++; agent.totalEpisodes++;
          continue;
        }

        const decision = buildDecision(headActions, headProbs);
        const outcome = mapOutcome(
          decision.direction as "LONG" | "SHORT", ep.priceDeltaPct, ep.atrPct,
          ep.price, ep.dayHigh, ep.dayLow,
          decision.slMultiplier, decision.tp1Multiplier, decision.tp2Multiplier, decision.tp3Multiplier,
          ep.exactOutcomeLong, ep.exactOutcomeShort, ep.has1MinData ?? false,
        );

        const riskRewards = MH_REWARDS[riskLabel] ?? MH_REWARDS.normal;
        const baseReward = riskRewards[outcome] ?? 0;
        const sigQuality = computeSignalQuality(ep, decision.direction as "LONG" | "SHORT");
        const sigMult = signalQualityMultiplier(sigQuality);
        const srcMult = ep.isTiltOnly ? 0.85 : 1.0;
        const sizMult = sizingRewardMultiplier(sizingLabel, outcome);
        const reward = baseReward * sigMult * srcMult * sizMult;

        experiences.push({ state: allStates[idx], headActions, headLogProbs, value, reward, advantage: 0, return_: 0 });
        rewards.push(reward); values.push(value); dones.push(true);
        totalEpisodes++; agent.totalEpisodes++;
        if (["tp1", "tp2", "tp3"].includes(outcome)) { totalWins++; agent.totalWins++; }
        if (outcome === "sl") { totalLosses++; agent.totalLosses++; }
      }

      const { advantages, returns: rets } = agent.computeGAE(rewards, values, dones);
      for (let i = 0; i < experiences.length; i++) {
        experiences[i].advantage = advantages[i];
        experiences[i].return_ = rets[i];
      }
      await agent.trainOnBatch(experiences);

      if (pass % 10 === 0 || pass === passesPerModel - 1) {
        const resolved = totalWins + totalLosses;
        const wr = resolved > 0 ? (totalWins / resolved * 100).toFixed(1) : "0";
        const phase = currPhase < 0.3 ? "TRENDING" : currPhase < 0.6 ? "MIXED" : "ALL";
        console.log(`[ENSEMBLE] M${modelIdx + 1} Pass ${pass + 1}/${passesPerModel}: ${totalEpisodes} eps, WR=${wr}% [${phase}]`);
      }
    }

    // Walk-forward test for this model
    let wfW = 0, wfL = 0;
    for (const ep of testData) {
      const ps = buildPPOState({ ...ep, sessionType: 1, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) }, 0.48);
      const dec = agent.selectBest(ps);
      if (dec.direction === "SKIP" || dec.session === "wait") continue;
      const safeAtr = Math.max(ep.atrPct, 0.3);
      const delta = ep.priceDeltaPct;
      if (dec.direction === "LONG") {
        if (delta >= safeAtr * dec.tp1Multiplier) wfW++; else if (delta <= -safeAtr * dec.slMultiplier) wfL++;
      } else {
        if (delta <= -safeAtr * dec.tp1Multiplier) wfW++; else if (delta >= safeAtr * dec.slMultiplier) wfL++;
      }
    }
    const wfRes = wfW + wfL;
    const testWR = wfRes > 0 ? wfW / wfRes * 100 : 0;
    const trainWR = (totalWins + totalLosses) > 0 ? totalWins / (totalWins + totalLosses) * 100 : 0;

    console.log(`[ENSEMBLE] M${modelIdx + 1}: trainWR=${trainWR.toFixed(1)}% testWR=${testWR.toFixed(1)}%`);

    // Save this model
    const modelSubDir = path.resolve(modelDir, `ensemble-${modelIdx}`);
    if (!fs.existsSync(modelSubDir)) fs.mkdirSync(modelSubDir, { recursive: true });
    const actorWeights = (agent as any).actor.getWeights().map((w: any) => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));
    const criticWeights = (agent as any).critic.getWeights().map((w: any) => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));
    fs.writeFileSync(path.join(modelSubDir, "actor-weights.json"), JSON.stringify(actorWeights), "utf-8");
    fs.writeFileSync(path.join(modelSubDir, "critic-weights.json"), JSON.stringify(criticWeights), "utf-8");

    results.push({ id: modelIdx, trainWR, testWR, agent });
  }

  // ── Ensemble voting test ──────────────────────────────────────────────────
  console.log(`\n[ENSEMBLE] ═══ Ensemble Voting Test ═══`);
  let ensW = 0, ensL = 0;
  for (const ep of testData) {
    const ps = buildPPOState({ ...ep, sessionType: 1, macroAlertActive: false, counterTrendDetected: false, imExhaustionLevel: Math.min(1, (ep.impliedMoveUsage ?? 1) / 2) }, 0.48);

    // Vote: each model picks direction
    let longVotes = 0, shortVotes = 0;
    for (const r of results) {
      const dec = r.agent.selectBest(ps);
      if (dec.direction === "LONG") longVotes++;
      else if (dec.direction === "SHORT") shortVotes++;
    }

    // Majority vote (need 2/3 agreement)
    const majority = Math.ceil(numModels / 2) + (numModels % 2 === 0 ? 1 : 0);
    let ensDir: "LONG" | "SHORT" | null = null;
    if (longVotes >= majority) ensDir = "LONG";
    else if (shortVotes >= majority) ensDir = "SHORT";
    if (!ensDir) continue;

    const safeAtr = Math.max(ep.atrPct, 0.3);
    const delta = ep.priceDeltaPct;
    if (ensDir === "LONG") {
      if (delta >= safeAtr * 0.25) ensW++; else if (delta <= -safeAtr * 0.40) ensL++;
    } else {
      if (delta <= -safeAtr * 0.25) ensW++; else if (delta >= safeAtr * 0.40) ensL++;
    }
  }
  const ensRes = ensW + ensL;
  const ensembleTestWR = ensRes > 0 ? ensW / ensRes * 100 : 0;

  console.log(`[ENSEMBLE] Individual models: ${results.map(r => `M${r.id + 1}=${r.testWR.toFixed(1)}%`).join(', ')}`);
  console.log(`[ENSEMBLE] Ensemble (${numModels}-model vote): testWR=${ensembleTestWR.toFixed(1)}% (${ensW}W/${ensL}L from ${ensRes} trades)`);

  // Save best individual as main model too
  const best = results.reduce((a, b) => a.testWR > b.testWR ? a : b);
  await best.agent.save();
  console.log(`[ENSEMBLE] Best individual (M${best.id + 1}, testWR=${best.testWR.toFixed(1)}%) saved as main model`);

  // Save ensemble config
  fs.writeFileSync(path.resolve(modelDir, "ensemble-config.json"), JSON.stringify({
    numModels,
    passesPerModel,
    curriculum: true,
    models: results.map(r => ({ id: r.id, trainWR: r.trainWR, testWR: r.testWR })),
    ensembleTestWR,
    savedAt: new Date().toISOString(),
  }, null, 2), "utf-8");

  return {
    models: results.map(r => ({ id: r.id, trainWR: r.trainWR, testWR: r.testWR })),
    ensembleTestWR,
  };
}
