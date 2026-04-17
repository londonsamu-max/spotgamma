/**
 * Decision Engine v2 — USES ALL available data EXCEPT flow (still downloading).
 *
 * New signals vs v1:
 *  - Gamma regime from synth-oi-daily (L16: VRP override)
 *  - VRP (atm_iv30 - rv30)
 *  - IV rank, skew, put/call ratio
 *  - Macro context (VIX regime, DXY trend, TLT trend)
 *  - Candle patterns from MT5 M15 (hammer, engulfing, body-through)
 *  - Day-of-week filter (Mon risk reduction)
 *  - Circuit breaker (track session state)
 *  - Scenario tagging (so we can identify winning setups)
 */

import type {
  AgentViewSnapshot, TradeIntent, CFD, Direction, TradeMode, MarketStructure, GammaBar,
} from "../utils/types.js";
import { BUFFERS, BROKER_SPECS } from "../utils/types.js";
import { loadMt5Day } from "../data-loaders/price-provider.js";
import { getRegime, type RegimeInfo } from "../data-loaders/synth-oi-loader.js";
import { getMacroContext, expectedDailyRange, type MacroContext } from "../data-loaders/macro-loader.js";
import { analyzeRecent, type RecentCandlesAnalysis } from "./candle-detector.js";
import { classifyScenario, volumeMultiplier } from "./scenario-filter.js";
import { getAllHiro, type HiroValue } from "../data-loaders/hiro-reconstructor.js";

const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];

/** Which synth-OI symbol represents each CFD */
const CFD_OI_SYMBOL: Record<CFD, string> = {
  NAS100: "SPX",   // primary
  US30: "DIA",
  XAUUSD: "GLD",
};

/** Day of week (0=Sun, 1=Mon, ...) */
function dayOfWeek(date: string): number {
  return new Date(date + "T12:00:00Z").getUTCDay();
}

/** Classify market structure per CFD using recent M15 candles */
export function classifyStructure(cfd: CFD, date: string, t: number): MarketStructure {
  const candles = loadMt5Day(cfd, date, "M15").filter((c) => c.t! <= t);
  if (candles.length < 8) return "congestion";
  const last12 = candles.slice(-12);
  const highs = last12.map((c) => c.high);
  const lows = last12.map((c) => c.low);
  const closes = last12.map((c) => c.close);
  const rangeMax = Math.max(...highs) - Math.min(...lows);
  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (closes[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const trendThresh = { NAS100: 3, US30: 5, XAUUSD: 0.3 }[cfd];
  const congestionThresh = { NAS100: 30, US30: 50, XAUUSD: 3 }[cfd];
  if (rangeMax < congestionThresh) return "congestion";
  if (slope > trendThresh) return "markup";
  if (slope < -trendThresh) return "markdown";
  return "rotation_day";
}

export function autoTradeMode(cfd: CFD, barSeparation: number, structure: MarketStructure, regime?: RegimeInfo): TradeMode {
  if (structure === "congestion") return "scalp";
  // Regime-aware: very_negative favors swing shorts (more trend days)
  if (regime?.regime === "very_negative" || regime?.regime === "very_positive") {
    if (cfd === "NAS100" && barSeparation > 70) return "swing";
    if (cfd === "US30" && barSeparation > 100) return "swing";
    if (cfd === "XAUUSD" && barSeparation > 7) return "swing";
  }
  if (cfd === "NAS100") {
    if (barSeparation < 30) return "scalp";
    if (barSeparation > 100) return "swing";
    return "intraday";
  } else if (cfd === "US30") {
    if (barSeparation < 50) return "scalp";
    if (barSeparation > 150) return "swing";
    return "intraday";
  } else {
    if (barSeparation < 3) return "scalp";
    if (barSeparation > 10) return "swing";
    return "intraday";
  }
}

export function volumeByMode(cfd: CFD, mode: TradeMode, mondayReduction: boolean): number {
  let base = BROKER_SPECS[cfd].minLot;
  if (mode === "swing") {
    if (cfd === "NAS100") base = 0.03;
    else if (cfd === "US30") base = 0.03;
    else base = 0.01;
  }
  if (mondayReduction) base *= 0.5;
  // Min lot safety
  const minLot = BROKER_SPECS[cfd].minLot;
  return Math.max(minLot, Math.round(base * 100) / 100);
}

/** Scenario tag: compact profile of the conditions that triggered this trade */
export interface ScenarioTag {
  regime: string;
  vrpSign: "positive" | "negative" | "zero";
  vixRegime: string;
  dxyTrend: string;
  structure: string;
  mode: TradeMode;
  direction: Direction;
  dayOfWeek: string;
  candlePattern: string;
  skewBias: string;
  ivRankBucket: "low" | "mid" | "high";
  barSizeBucket: "small" | "medium" | "large" | "mega";
}

function ivRankBucket(r: number): ScenarioTag["ivRankBucket"] {
  if (r < 0.33) return "low";
  if (r < 0.66) return "mid";
  return "high";
}

function barSizeBucket(cfd: CFD, absGamma: number): ScenarioTag["barSizeBucket"] {
  if (cfd === "NAS100") {
    if (absGamma > 2e9) return "mega";
    if (absGamma > 1e9) return "large";
    if (absGamma > 500e6) return "medium";
    return "small";
  }
  if (cfd === "US30") {
    if (absGamma > 40e6) return "mega";
    if (absGamma > 20e6) return "large";
    if (absGamma > 10e6) return "medium";
    return "small";
  }
  if (absGamma > 60e6) return "mega";
  if (absGamma > 30e6) return "large";
  if (absGamma > 10e6) return "medium";
  return "small";
}

/** Main entry — enriched intents with scenario tags + ETF info for v2 executor */
export interface EnrichedIntent extends TradeIntent {
  scenario: ScenarioTag;
  multiFactorScore: number;
  // For ETF-based trigger (v10+)
  etfStrike: number;   // the actual gamma bar strike in ETF units
  etfSymbol: string;   // SPX, QQQ, SPY, DIA, GLD
  tpEtfStrike?: number; // next bar in direction (ETF units)
  slEtfStrike?: number; // prev bar opposite (ETF units)
}

export function generateIntentsForCfd(
  snapshot: AgentViewSnapshot,
  cfd: CFD,
  date: string,
  macro: MacroContext,
  candleAnalysis: RecentCandlesAnalysis,
): EnrichedIntent[] {
  const intents: EnrichedIntent[] = [];
  const price = snapshot.cfdPrices[cfd];
  const bars = snapshot.gammaBarsNear[cfd];
  if (bars.length === 0) return intents;

  const structure = classifyStructure(cfd, date, snapshot.t);
  const regime = getRegime(CFD_OI_SYMBOL[cfd], date);
  const buffer = BUFFERS[cfd];
  const dow = dayOfWeek(date);
  const isMonday = dow === 1;
  const isFriday = dow === 5;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // VRP override (L1, L16): never fade negative VRP / always trust positive
  const vrp = regime?.vrp ?? 0;
  const vrpSign: ScenarioTag["vrpSign"] = vrp > 0.005 ? "positive" : vrp < -0.005 ? "negative" : "zero";

  // Sort bars by distance to price
  const byDist = [...bars].sort((a, b) =>
    Math.abs((a.cfdPrice ?? 0) - price) - Math.abs((b.cfdPrice ?? 0) - price)
  );
  const candidates = byDist.slice(0, 8);
  if (!candidates[0]?.cfdPrice) return intents;

  // Evaluate more candidates (up to 4 per cycle) to maximize coverage
  for (let i = 0; i < Math.min(4, candidates.length); i++) {
    const bar = candidates[i];
    if (!bar.cfdPrice) continue;
    const barPrice = bar.cfdPrice;
    const dist = barPrice - price;

    // Direction rule
    let direction: Direction;
    if (bar.netGamma > 0 && dist <= 5) direction = "LONG";
    else if (bar.netGamma < 0 && dist >= -5) direction = "SHORT";
    else if (bar.netGamma > 0 && dist > 0) direction = "LONG";
    else direction = "SHORT";

    // === SOFT FILTERS (only structural alignment is enforced) ===
    let multiFactor = 0;

    // ONLY hard filter: don't trade against clear structure
    if (structure === "markup" && direction === "SHORT") continue;
    if (structure === "markdown" && direction === "LONG") continue;
    multiFactor++;

    // Everything else = scoring signal (don't block, just count)
    if (vrpSign === "positive") multiFactor++;
    if (regime?.regime === "very_positive" && direction === "LONG") multiFactor++;
    if (regime?.regime === "very_negative" && direction === "SHORT") multiFactor++;
    if (regime?.regime === "positive" && direction === "LONG") multiFactor++;
    if (regime?.regime === "negative" && direction === "SHORT") multiFactor++;

    // Macro signals as score
    if (cfd === "XAUUSD" && macro.dxyTrend === "down" && direction === "LONG") multiFactor++;
    if (cfd === "XAUUSD" && macro.dxyTrend === "up" && direction === "SHORT") multiFactor++;
    if (cfd !== "XAUUSD" && macro.tltTrend === "up" && direction === "LONG") multiFactor++;

    if (direction === "LONG" && candleAnalysis.hammerOrWickRejectionAtLow) multiFactor++;
    if (direction === "SHORT" && candleAnalysis.hammerOrWickRejectionAtHigh) multiFactor++;

    if (isFriday) multiFactor++;
    if (isMonday) multiFactor--;

    // HIRO alignment (L51, L103) — positive score bonus, soft penalty
    const hiroMap = getAllHiro(date, snapshot.t);
    const primaryHiro = cfd === "NAS100" ? (hiroMap.SPX ?? hiroMap.QQQ) : cfd === "US30" ? hiroMap.DIA : hiroMap.GLD;
    if (primaryHiro) {
      // HIRO extreme alignment (L103): strong bonus
      if (direction === "LONG" && primaryHiro.percentile >= 80) multiFactor += 3;
      else if (direction === "SHORT" && primaryHiro.percentile <= 20) multiFactor += 3;
      // Mild alignment
      else if (direction === "LONG" && primaryHiro.percentile >= 55) multiFactor++;
      else if (direction === "SHORT" && primaryHiro.percentile <= 45) multiFactor++;
      // Only penalize extreme counter-HIRO (was too aggressive before)
      if (direction === "LONG" && primaryHiro.percentile < 10) multiFactor--;
      if (direction === "SHORT" && primaryHiro.percentile > 90) multiFactor--;
    }

    // === BUILD INTENT ===
    const nextBarsInDir = byDist.filter((b) => b.cfdPrice && (direction === "LONG" ? b.cfdPrice > barPrice : b.cfdPrice < barPrice));
    nextBarsInDir.sort((a, b) => Math.abs(a.cfdPrice! - barPrice) - Math.abs(b.cfdPrice! - barPrice));
    const tpBar = nextBarsInDir[0];
    if (!tpBar?.cfdPrice) continue;

    const slBarsInDir = byDist.filter((b) => b.cfdPrice && (direction === "LONG" ? b.cfdPrice < barPrice : b.cfdPrice > barPrice));
    slBarsInDir.sort((a, b) => Math.abs(a.cfdPrice! - barPrice) - Math.abs(b.cfdPrice! - barPrice));
    const slBar = slBarsInDir[0];

    let sl: number;
    if (slBar?.cfdPrice !== undefined) {
      sl = direction === "LONG" ? slBar.cfdPrice - buffer.slBuffer : slBar.cfdPrice + buffer.slBuffer;
    } else {
      const fixedSl = { NAS100: 40, US30: 70, XAUUSD: 8 }[cfd];
      sl = direction === "LONG" ? barPrice - fixedSl : barPrice + fixedSl;
    }

    const tp1 = tpBar.cfdPrice;
    const risk = Math.abs(barPrice - sl);
    const reward = Math.abs(tp1 - barPrice);
    if (risk === 0) continue;
    const rr = reward / risk;
    // R:R >= 1.5 (L48 minimum)
    if (rr < 1.5) continue;

    const barSeparation = Math.abs(tp1 - barPrice);
    const tradeMode = autoTradeMode(cfd, barSeparation, structure, regime ?? undefined);
    // Skip SCALP mode entirely — v6 data showed it loses consistently (-$176 in March)
    if (tradeMode === "scalp") continue;
    const volume = volumeByMode(cfd, tradeMode, isMonday);

    let conviction: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
    const absGamma = Math.abs(bar.netGamma);
    if (multiFactor >= 5) conviction = "HIGH";
    else if (multiFactor <= 2) conviction = "LOW";

    // Let all trades through (scoring captures quality, analysis tells us winners)

    const scenario: ScenarioTag = {
      regime: regime?.regime ?? "unknown",
      vrpSign,
      vixRegime: macro.vixRegime,
      dxyTrend: macro.dxyTrend,
      structure,
      mode: tradeMode,
      direction,
      dayOfWeek: dayNames[dow],
      candlePattern: candleAnalysis.lastPatterns.slice(-1)[0] ?? "none",
      skewBias: regime?.skewBias ?? "neutral",
      ivRankBucket: ivRankBucket(regime?.ivRank ?? 0.5),
      barSizeBucket: barSizeBucket(cfd, absGamma),
    };

    // Apply scenario filter for volume adjustment (v3 hyperfocus)
    const scenarioClass = classifyScenario(cfd, scenario);
    const volMult = volumeMultiplier(scenarioClass, multiFactor);
    if (volMult === 0) continue; // blacklisted or too low score
    const adjustedVolume = Math.round(volume * volMult * 100) / 100;
    // Enforce min lot
    const finalVolume = Math.max(BROKER_SPECS[cfd].minLot, adjustedVolume);

    const intent: EnrichedIntent = {
      id: `${date}-${snapshot.timeStr.replace(":", "")}-${cfd}-${direction}-${Math.round(barPrice)}`,
      cfd, direction, tradeMode,
      exactLevel: barPrice,
      entryMode: "level",
      structuralSL: sl,
      tp1,
      volume: finalVolume,
      rationale: `${bar.symbol}$${bar.strike} ${(bar.netGamma / 1e6).toFixed(0)}M ${bar.type}, struct=${structure}, regime=${regime?.regime ?? "?"}, vrp=${vrpSign}, vix=${macro.vixRegime}, score=${multiFactor}, class=${scenarioClass} volx${volMult}, R:R ${rr.toFixed(2)}`,
      conviction,
      triggerSymbol: bar.symbol,
      triggerLevel: bar.strike,
      createdAt: snapshot.t,
      expiresAt: snapshot.t + 60 * 60 * 1000,
      scenario,
      multiFactorScore: multiFactor,
      // ETF-based trigger info
      etfStrike: bar.strike,
      etfSymbol: bar.symbol,
      tpEtfStrike: tpBar.strike,
      slEtfStrike: slBar?.strike,
    };

    intents.push(intent);
  }

  return intents;
}

export function generateAllIntents(
  snapshot: AgentViewSnapshot,
  date: string,
): EnrichedIntent[] {
  const macro = getMacroContext(date);
  const intents: EnrichedIntent[] = [];
  for (const cfd of CFDS) {
    // Get candle analysis for this CFD near the current time
    const candles = loadMt5Day(cfd, date, "M15").filter((c) => c.t! <= snapshot.t);
    const candleAnalysis = analyzeRecent(
      candles.map((c) => ({ t: c.t!, o: c.open, h: c.high, l: c.low, c: c.close, v: c.tick_volume })),
      5,
    );
    intents.push(...generateIntentsForCfd(snapshot, cfd, date, macro, candleAnalysis));
  }
  return intents;
}
