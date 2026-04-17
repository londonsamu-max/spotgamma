/**
 * Event-Driven Backtest Engine — L60 Bounce/Break at gamma bars.
 *
 * Instead of time-driven (every 45min decide), this iterates
 * EVERY 1-min ETF candle and triggers ONLY when price approaches
 * a gamma bar. At that exact moment, scores HIRO + candle + VRP + gamma sign
 * to determine BOUNCE or BREAK direction.
 *
 * Architecture:
 *   for each 1-min ETF candle:
 *     for each fat gamma bar of this CFD:
 *       if ETF price is within proximity of bar strike:
 *         → score L60 (HIRO, candle, VRP, gamma sign, macro)
 *         → if score passes threshold → emit intent
 *         → mark bar as "touched" (cooldown to avoid re-triggering)
 */

import type { CFD, Direction, TradeMode, GammaBar, OHLCBar } from "../utils/types.js";
import { BUFFERS, BROKER_SPECS } from "../utils/types.js";
import { loadOhlc1Min, loadMt5Day, priceAt } from "../data-loaders/price-provider.js";
import { getTopGammaBars, CFD_SYMBOLS, computeConversionRatio, loadGammaBars } from "../data-loaders/gamma-provider.js";
import { getHiroFast as getHiro, getFlowContextFast as getFlowContext, type HiroValue, type FlowContext } from "../data-loaders/flow-analyzer-fast.js";
import { analyzeCandle, type CandleAnalysis } from "./candle-detector.js";
import { getRegime, type RegimeInfo } from "../data-loaders/synth-oi-loader.js";
import { getMacroContext, type MacroContext } from "../data-loaders/macro-loader.js";
import { classifyScenario, volumeMultiplier, type FilterResult } from "./scenario-filter.js";
import { getRiskReversalForCfd, type RiskReversalContext } from "../data-loaders/risk-reversal-loader.js";
import { getTraceContext, type TraceContext } from "../data-loaders/trace-loader.js";
import { shouldPyramid, type PositionMode } from "./pyramid-manager.js";
import type { EnrichedIntent, ScenarioTag } from "./decision-engine-v2.js";

const ALL_CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];

/** Which primary ETF to iterate for each CFD */
const PRIMARY_ETF: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

/** Which synth-OI symbol */
const OI_SYM: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

/** Proximity thresholds in ETF price units (how close ETF must be to strike) */
const PROXIMITY_ETF: Record<string, number> = {
  SPX: 8,   // ±8 pts SPX (~±29 pts NAS100)
  QQQ: 1.5, SPY: 1,
  DIA: 1.5, // ±1.5 pts DIA (~±150 pts US30)
  GLD: 1,   // ±1 pt GLD (~±10.8 pts XAUUSD)
};

/** Cooldown: once a bar is touched, wait N minutes before re-triggering */
const COOLDOWN_MIN = 30;

/** Minimum bar |netGamma| for triggering (ETF units) */
const MIN_GAMMA_TRIGGER: Record<CFD, number> = {
  NAS100: 200e6,
  US30: 3e6,
  XAUUSD: 2e6,
};

interface BarState {
  strike: number;
  sym: string;
  lastTouchedTs: number;
}

/** L60 Score — the core decision at the gamma bar */
interface L60Score {
  hiroScore: number;
  instFlowScore: number;
  strikeConcentrationScore: number;
  aggressiveFlowScore: number;
  expiryScore: number;
  candleScore: number;
  vrpScore: number;
  gammaScore: number;
  macroScore: number;
  total: number;
  direction: Direction;
  isBounce: boolean;
}

function scoreL60(
  bar: GammaBar,
  cfd: CFD,
  hiro: HiroValue | null,
  flow: FlowContext | null,
  candle: CandleAnalysis,
  prevCandle: CandleAnalysis | null,
  regime: RegimeInfo | null,
  macro: MacroContext,
  priceAboveBar: boolean,
): L60Score {
  let hiroScore = 0;
  let candleScore = 0;
  let vrpScore = 0;
  let gammaScore = 0;
  let macroScore = 0;

  // Additional flow scores (NEW — L52-L65)
  let instFlowScore = 0;
  let strikeConcentrationScore = 0;
  let aggressiveFlowScore = 0;
  let expiryScore = 0;

  // --- HIRO (L51, L103): net delta flow direction ---
  if (hiro) {
    if (hiro.percentile >= 80) hiroScore = 2;
    else if (hiro.percentile >= 60) hiroScore = 1;
    else if (hiro.percentile <= 20) hiroScore = -2;
    else if (hiro.percentile <= 40) hiroScore = -1;
  }

  // --- INDIVIDUAL FLOW SIGNALS (L52-L65) ---
  if (flow) {
    // L53: Institutional bias (>$50K trades) — HIGHEST weight
    if (flow.institutionalBias === "bullish") instFlowScore = 2;
    else if (flow.institutionalBias === "bearish") instFlowScore = -2;

    // L52, L57: Strike concentration at THIS bar — the killer signal
    if (flow.strikeNearBar) {
      const barPremium = flow.strikeNearBar.callPremium + flow.strikeNearBar.putPremium;
      if (barPremium > 500000) {
        // Massive premium at this strike = strong conviction
        if (flow.strikeNearBar.putPremium > flow.strikeNearBar.callPremium * 1.5) {
          strikeConcentrationScore = -2; // put-heavy at this strike = bearish
        } else if (flow.strikeNearBar.callPremium > flow.strikeNearBar.putPremium * 1.5) {
          strikeConcentrationScore = 2;  // call-heavy = bullish
        }
      } else if (barPremium > 100000) {
        // Moderate premium
        if (flow.strikeNearBar.netDelta > 0) strikeConcentrationScore = 1;
        else if (flow.strikeNearBar.netDelta < 0) strikeConcentrationScore = -1;
      }
    }

    // L64: Aggressive flow (BUY at ASK = urgent buying)
    if (flow.aggressiveFlow === "buying") aggressiveFlowScore = 1;
    else if (flow.aggressiveFlow === "selling") aggressiveFlowScore = -1;

    // L54: Expiry breakdown — 0DTE gives intraday direction
    if (flow.zeroDteNetDelta !== undefined) {
      if (flow.zeroDteNetDelta > 0) expiryScore = 1;
      else if (flow.zeroDteNetDelta < 0) expiryScore = -1;
    }
  }

  // --- Candle pattern at the bar ---
  if (candle.pattern === "hammer" || candle.pattern === "bullish_engulfing") candleScore = 1;
  else if (candle.pattern === "inverted_hammer" || candle.pattern === "bearish_engulfing") candleScore = -1;
  else if (candle.pattern === "wick_rejection_down") candleScore = 1;
  else if (candle.pattern === "wick_rejection_up") candleScore = -1;
  else if (candle.pattern === "body_through_up") candleScore = 1;
  else if (candle.pattern === "body_through_down") candleScore = -1;

  // --- VRP (L1, L16) ---
  const vrp = regime?.vrp ?? 0;
  if (vrp > 0.01) vrpScore = 1;
  else if (vrp < -0.01) vrpScore = -1;

  // --- Gamma sign of the bar ---
  if (bar.netGamma > 0) gammaScore = 1;
  else gammaScore = -1;

  // --- Macro alignment ---
  if (cfd === "XAUUSD") {
    if (macro.dxyTrend === "down") macroScore = 1;
    else if (macro.dxyTrend === "up") macroScore = -1;
  } else {
    if (macro.vixRegime === "low" || macro.vixRegime === "mid") macroScore = 1;
    else if (macro.vixRegime === "extreme") macroScore = -1;
  }

  // Risk Reversal score
  let rrScore = 0;

  // 0DTE maxGex score (NEW — magnetic target)
  let maxGexScore = 0;

  // TOTAL: all signals combined (max theoretical ±15)
  const total = hiroScore + instFlowScore + strikeConcentrationScore +
                aggressiveFlowScore + expiryScore +
                candleScore + vrpScore + gammaScore + macroScore + rrScore + maxGexScore;

  // Resolve direction based on bar position and score
  let direction: Direction;
  let isBounce: boolean;

  if (bar.netGamma > 0) {
    // Support bar — default expectation is BOUNCE (LONG)
    if (total >= 0) { direction = "LONG"; isBounce = true; }
    else { direction = "SHORT"; isBounce = false; } // break through support
  } else {
    // Resistance bar — default expectation is rejection (SHORT)
    if (total <= 0) { direction = "SHORT"; isBounce = true; }
    else { direction = "LONG"; isBounce = false; } // break through resistance
  }

  return { hiroScore, instFlowScore, strikeConcentrationScore, aggressiveFlowScore, expiryScore, candleScore, vrpScore, gammaScore, macroScore, total, direction, isBounce };
}

/** Run event-driven backtest for one day on one CFD */
export async function runEventDrivenDay(
  cfd: CFD,
  date: string,
): Promise<EnrichedIntent[]> {
  const primaryEtf = PRIMARY_ETF[cfd];
  const etfCandles = loadOhlc1Min(primaryEtf, date);
  if (etfCandles.length < 10) return [];

  // Get ETF spot prices for conversion
  const etfSpotPrices: Record<string, number> = {};
  for (const sym of CFD_SYMBOLS[cfd]) {
    const gb = loadGammaBars(date, sym);
    if (gb) etfSpotPrices[sym] = gb.spotPrice;
  }

  // Get CFD price at day open for initial ratio estimate
  const cfdCandles = loadMt5Day(cfd, date, "M15");
  if (cfdCandles.length === 0) return [];
  const cfdOpenPrice = cfdCandles[0].open;

  // Get fat gamma bars for this CFD
  const bars = getTopGammaBars(date, cfd, cfdOpenPrice, etfSpotPrices, 15, Infinity);
  const fatBars = bars.filter((b) => Math.abs(b.netGamma) >= MIN_GAMMA_TRIGGER[cfd]);
  if (fatBars.length === 0) return [];

  // Daily context (constant for the day)
  const regime = getRegime(OI_SYM[cfd], date);
  const macro = getMacroContext(date);
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Track bar touch cooldowns
  const barStates: Map<number, BarState> = new Map();
  for (const bar of fatBars) {
    barStates.set(bar.strike, { strike: bar.strike, sym: bar.symbol, lastTouchedTs: 0 });
  }

  const intents: EnrichedIntent[] = [];

  // Walk through every 1-min ETF candle
  for (let i = 1; i < etfCandles.length; i++) {
    const c = etfCandles[i];
    const prev = etfCandles[i - 1];
    const t = c.t;

    // For each fat bar, check proximity
    for (const bar of fatBars) {
      const prox = PROXIMITY_ETF[primaryEtf] ?? 2;
      const strike = bar.strike;

      // Is ETF price touching the bar?
      if (strike < c.l - prox || strike > c.h + prox) continue;

      // Cooldown check
      const state = barStates.get(strike)!;
      if (t - state.lastTouchedTs < COOLDOWN_MIN * 60 * 1000) continue;
      state.lastTouchedTs = t;

      // === TRIGGERED: price is at the gamma bar ===

      // Get HIRO at this exact moment
      const hiro = getHiro(primaryEtf, date, t);

      // Get FULL flow context at this exact moment (L52-L65)
      const flow = getFlowContext(primaryEtf, date, t, bar.strike);

      // Get candle analysis
      const candleAnalysis = analyzeCandle(
        { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v },
        { t: prev.t, o: prev.o, h: prev.h, l: prev.l, c: prev.c, v: prev.v },
      );

      // Risk Reversal context for this CFD + date
      const rr = getRiskReversalForCfd(cfd, date);
      const pyramidInfo = shouldPyramid(cfd, date);

      // 0DTE TRACE context (maxGexStrike = magnetic target)
      const trace = cfd === "NAS100" ? getTraceContext(date, t, strike, "mm") : null;

      // Score L60 with ALL signals including individual flow
      const priceAboveBar = c.c > strike;
      const score = scoreL60(bar, cfd, hiro, flow, candleAnalysis, null, regime, macro, priceAboveBar);

      // Add Risk Reversal to score AFTER base L60
      if (rr) {
        if (rr.isBottomSignal && score.direction === "LONG") score.total += 3; // strong bottom + going long = jackpot
        else if (rr.isTopSignal && score.direction === "SHORT") score.total += 3;
        else if (rr.trend === "improving" && score.direction === "LONG") score.total += 1;
        else if (rr.trend === "deteriorating" && score.direction === "SHORT") score.total += 1;
        // Against RR = penalty
        else if (rr.isBottomSignal && score.direction === "SHORT") score.total -= 2;
        else if (rr.isTopSignal && score.direction === "LONG") score.total -= 2;
      }

      // 0DTE maxGex score: magnetic target alignment
      if (trace) {
        const maxGex = trace.maxGexStrike;
        const distToMaxGex = strike - maxGex; // positive = bar above maxGex

        // If THIS bar IS the maxGex strike (±5pts) → extreme bounce signal
        if (Math.abs(distToMaxGex) <= 5) {
          // Price at maxGex = strong pinning. Expect BOUNCE at this level.
          if (score.direction === "LONG" && bar.netGamma > 0) score.total += 2;
          if (score.direction === "SHORT" && bar.netGamma < 0) score.total += 2;
        }
        // If bar is BETWEEN price and maxGex → price will travel toward maxGex
        else if (distToMaxGex > 0 && c.c < strike) {
          // maxGex is above current bar, bar is above price → price going UP toward maxGex
          if (score.direction === "LONG") score.total += 1;
        }
        else if (distToMaxGex < 0 && c.c > strike) {
          // maxGex is below current bar, bar is below price → price going DOWN toward maxGex
          if (score.direction === "SHORT") score.total += 1;
        }
        // Going AWAY from maxGex = fighting the magnet → penalty
        else if (score.direction === "LONG" && maxGex < strike - 20) score.total -= 1;
        else if (score.direction === "SHORT" && maxGex > strike + 20) score.total -= 1;
      }

      // Determine trade mode: pyramid (multi-day) or intraday
      const positionMode: PositionMode = pyramidInfo.mode === "pyramid" && pyramidInfo.direction === score.direction ? "pyramid" : "intraday";

      // Threshold: need |total| >= 3 to act (with flow signals, we can be pickier)
      if (Math.abs(score.total) < 3) continue;

      // Get CFD price at this moment
      const cfdPrice = priceAt(cfd, t, "M15");
      if (!cfdPrice) continue;

      // Compute ratio at this moment
      const ratio = cfdPrice / strike;

      // Find next bar in direction for TP (in ETF units)
      const barsInDir = fatBars.filter((b) =>
        score.direction === "LONG" ? b.strike > strike : b.strike < strike
      ).sort((a, b) =>
        score.direction === "LONG" ? a.strike - b.strike : b.strike - a.strike
      );
      const tpBar = barsInDir[0];
      if (!tpBar) continue;

      // Find prev bar for SL
      const slBars = fatBars.filter((b) =>
        score.direction === "LONG" ? b.strike < strike : b.strike > strike
      ).sort((a, b) =>
        score.direction === "LONG" ? b.strike - a.strike : a.strike - b.strike
      );
      const slBar = slBars[0];

      // Convert to CFD
      const tp1Cfd = tpBar.strike * ratio;
      const buffer = BUFFERS[cfd];
      let slCfd: number;
      if (slBar) {
        slCfd = score.direction === "LONG"
          ? slBar.strike * ratio - buffer.slBuffer
          : slBar.strike * ratio + buffer.slBuffer;
      } else {
        const fixedSl = { NAS100: 40, US30: 70, XAUUSD: 8 }[cfd];
        slCfd = score.direction === "LONG" ? cfdPrice - fixedSl : cfdPrice + fixedSl;
      }

      // R:R check
      const risk = Math.abs(cfdPrice - slCfd);
      const reward = Math.abs(tp1Cfd - cfdPrice);
      if (risk === 0) continue;
      const rrRatio = reward / risk;
      if (rrRatio < 1.5) continue;

      // Trade mode
      const barSepEtf = Math.abs(tpBar.strike - strike);
      const barSepCfd = barSepEtf * ratio;
      let tradeMode: TradeMode;
      if (cfd === "NAS100") tradeMode = barSepCfd > 100 ? "swing" : barSepCfd > 30 ? "intraday" : "scalp";
      else if (cfd === "US30") tradeMode = barSepCfd > 150 ? "swing" : barSepCfd > 50 ? "intraday" : "scalp";
      else tradeMode = barSepCfd > 10 ? "swing" : barSepCfd > 3 ? "intraday" : "scalp";

      if (tradeMode === "scalp") continue; // Skip scalp (V7 showed it loses)

      // Volume
      let volume = tradeMode === "swing"
        ? (cfd === "XAUUSD" ? 0.01 : 0.03)
        : BROKER_SPECS[cfd].minLot;

      // Scenario tag (includes RR and position mode)
      const absGamma = Math.abs(bar.netGamma);
      const scenario: ScenarioTag = {
        regime: regime?.regime ?? "unknown",
        vrpSign: score.vrpScore > 0 ? "positive" : score.vrpScore < 0 ? "negative" : "zero",
        vixRegime: macro.vixRegime,
        dxyTrend: macro.dxyTrend,
        structure: score.isBounce ? "bounce" : "break",
        mode: positionMode === "pyramid" ? "swing" : tradeMode,
        direction: score.direction,
        dayOfWeek: dayNames[dow],
        candlePattern: candleAnalysis.pattern,
        skewBias: regime?.skewBias ?? "neutral",
        ivRankBucket: (regime?.ivRank ?? 0.5) < 0.33 ? "low" : (regime?.ivRank ?? 0.5) < 0.66 ? "mid" : "high",
        barSizeBucket: absGamma > 1e9 ? "mega" : absGamma > 500e6 ? "large" : absGamma > 100e6 ? "medium" : "small",
      };

      // Whitelist/blacklist filter
      const scenarioClass = classifyScenario(cfd, scenario);
      const volMult = volumeMultiplier(scenarioClass, Math.abs(score.total));
      if (volMult === 0) continue;
      volume = Math.max(BROKER_SPECS[cfd].minLot, Math.round(volume * volMult * 100) / 100);

      // Adjust expiry based on position mode
      const expiry = positionMode === "pyramid"
        ? t + 5 * 24 * 60 * 60 * 1000  // 5 days for pyramid
        : t + 60 * 60 * 1000;           // 1 hour for intraday

      const intent: EnrichedIntent = {
        id: `${date}-${new Date(t).toISOString().slice(11, 16).replace(":", "")}-${cfd}-${score.direction}-${strike}`,
        cfd,
        direction: score.direction,
        tradeMode: positionMode === "pyramid" ? "swing" : tradeMode,
        exactLevel: cfdPrice,
        entryMode: "level",
        structuralSL: slCfd,
        tp1: tp1Cfd,
        volume,
        rationale: `[${positionMode.toUpperCase()}] ETF ${primaryEtf}$${strike}. L60=${score.total} (HIRO=${score.hiroScore} inst=${score.instFlowScore} strikeConc=${score.strikeConcentrationScore} agg=${score.aggressiveFlowScore} 0dte=${score.expiryScore} candle=${score.candleScore} vrp=${score.vrpScore} gamma=${score.gammaScore} macro=${score.macroScore}) RR=${rr?.rr?.toFixed(3) ?? "?"} maxGex=${trace?.maxGexStrike ?? "?"} → ${score.isBounce ? "BOUNCE" : "BREAK"} ${score.direction}. R:R=${rrRatio.toFixed(2)}`,
        conviction: Math.abs(score.total) >= 4 ? "HIGH" : Math.abs(score.total) >= 3 ? "MEDIUM" : "LOW",
        triggerSymbol: primaryEtf,
        triggerLevel: strike,
        createdAt: t,
        expiresAt: expiry,
        scenario,
        multiFactorScore: Math.abs(score.total),
        etfStrike: strike,
        etfSymbol: primaryEtf,
        tpEtfStrike: tpBar.strike,
        slEtfStrike: slBar?.strike,
      };

      intents.push(intent);
    }
  }

  return intents;
}
