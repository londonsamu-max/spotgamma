/**
 * Decision Engine — codified subset of the 112 lessons for backtest.
 *
 * SIMPLIFIED MVP: focuses on the gamma-bars-first strategy (L43, L58, L60).
 * Without live flow + HIRO, we use:
 *  - gamma bar size as proxy for structural strength
 *  - price proximity as main trigger
 *  - simple market structure classification from recent candles
 *  - trade mode auto-classification by bar separation (L109)
 */

import type {
  AgentViewSnapshot, TradeIntent, CFD, Direction, TradeMode, GammaBar, MarketStructure,
} from "../utils/types.js";
import { BUFFERS, BROKER_SPECS } from "../utils/types.js";
import { loadMt5Day } from "../data-loaders/price-provider.js";

const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];

/** Classify market structure per CFD using recent M15 candles (L110 simplified) */
export function classifyStructure(cfd: CFD, date: string, t: number): MarketStructure {
  const candles = loadMt5Day(cfd, date, "M15").filter((c) => c.t! <= t);
  if (candles.length < 8) return "congestion";

  const last12 = candles.slice(-12);
  const highs = last12.map((c) => c.high);
  const lows = last12.map((c) => c.low);
  const closes = last12.map((c) => c.close);
  const rangeMax = Math.max(...highs) - Math.min(...lows);
  const avgRange = rangeMax / 12;

  // Detect trend: linear regression slope on closes
  const n = closes.length;
  const xMean = (n - 1) / 2;
  const yMean = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (closes[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;

  // Thresholds per CFD
  const trendThresh = { NAS100: 3, US30: 5, XAUUSD: 0.3 }[cfd];
  const congestionThresh = { NAS100: 30, US30: 50, XAUUSD: 3 }[cfd];

  if (rangeMax < congestionThresh) return "congestion";
  if (slope > trendThresh) return "markup";
  if (slope < -trendThresh) return "markdown";
  return "rotation_day";
}

/** Decide trade mode (L109) */
export function autoTradeMode(cfd: CFD, barSeparation: number, structure: MarketStructure): TradeMode {
  if (structure === "congestion") return "scalp";
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

/** Volume by trade mode */
export function volumeByMode(cfd: CFD, mode: TradeMode): number {
  const base = BROKER_SPECS[cfd].minLot;
  if (mode === "swing") {
    if (cfd === "NAS100") return 0.03;
    if (cfd === "US30") return 0.03;
    return 0.01;
  }
  return base;
}

/** For a given CFD, generate intents based on snapshot */
export function generateIntentsForCfd(
  snapshot: AgentViewSnapshot,
  cfd: CFD,
  date: string,
): TradeIntent[] {
  const intents: TradeIntent[] = [];
  const price = snapshot.cfdPrices[cfd];
  const bars = snapshot.gammaBarsNear[cfd];
  if (bars.length === 0) return intents;

  const structure = classifyStructure(cfd, date, snapshot.t);
  const buffer = BUFFERS[cfd];

  // Sort bars by distance to price
  const byDist = [...bars].sort((a, b) =>
    Math.abs((a.cfdPrice ?? 0) - price) - Math.abs((b.cfdPrice ?? 0) - price)
  );

  // Take the closest 4 fat bars to seed entries
  const candidates = byDist.slice(0, 4);
  const nearBar = candidates[0];
  if (!nearBar || nearBar.cfdPrice === undefined) return intents;

  // Proximity rule (L97/L102): only act if nearest bar within threshold
  const proximityThresh = { NAS100: 80, US30: 250, XAUUSD: 8 }[cfd];
  if (Math.abs(nearBar.cfdPrice - price) > proximityThresh) {
    // Too far — create 1 stretch order at the nearest fat bar anyway (L102 minimum coverage)
  }

  for (let i = 0; i < Math.min(2, candidates.length); i++) {
    const bar = candidates[i];
    if (!bar.cfdPrice) continue;

    const barPrice = bar.cfdPrice;
    const dist = barPrice - price;
    // Support bar (green/positive gamma) below current price → LONG bounce at bar
    // Resistance bar (red/negative gamma) above current price → SHORT rejection at bar
    let direction: Direction;
    if (bar.netGamma > 0 && dist <= 5) direction = "LONG"; // support at/below
    else if (bar.netGamma < 0 && dist >= -5) direction = "SHORT"; // resistance at/above
    else if (bar.netGamma > 0 && dist > 0) direction = "LONG"; // support above, breakout scenario (skipped usually)
    else direction = "SHORT";

    // Don't go against the trend structure in markup/markdown
    if (structure === "markup" && direction === "SHORT") continue;
    if (structure === "markdown" && direction === "LONG") continue;

    // Find next bar in direction for TP
    const nextBarsInDir = byDist.filter((b) => {
      if (!b.cfdPrice) return false;
      return direction === "LONG" ? b.cfdPrice > barPrice : b.cfdPrice < barPrice;
    });
    // Sort by distance from barPrice ascending
    nextBarsInDir.sort((a, b) => Math.abs(a.cfdPrice! - barPrice) - Math.abs(b.cfdPrice! - barPrice));
    const tpBar = nextBarsInDir[0];
    if (!tpBar?.cfdPrice) continue;

    // Find previous bar opposite direction for SL
    const slBarsInDir = byDist.filter((b) => {
      if (!b.cfdPrice) return false;
      return direction === "LONG" ? b.cfdPrice < barPrice : b.cfdPrice > barPrice;
    });
    slBarsInDir.sort((a, b) => Math.abs(a.cfdPrice! - barPrice) - Math.abs(b.cfdPrice! - barPrice));
    const slBar = slBarsInDir[0];

    // Structural SL: behind next opposite bar + buffer. If no opposite bar, default fixed width
    let sl: number;
    if (slBar?.cfdPrice !== undefined) {
      sl = direction === "LONG"
        ? slBar.cfdPrice - buffer.slBuffer
        : slBar.cfdPrice + buffer.slBuffer;
    } else {
      // Fallback fixed SL
      const fixedSl = { NAS100: 40, US30: 70, XAUUSD: 8 }[cfd];
      sl = direction === "LONG" ? barPrice - fixedSl : barPrice + fixedSl;
    }

    const tp1 = tpBar.cfdPrice;

    // Validate R:R >= 1.5 (L48)
    const risk = Math.abs(barPrice - sl);
    const reward = Math.abs(tp1 - barPrice);
    if (risk === 0) continue;
    const rr = reward / risk;
    if (rr < 1.5) continue;

    // Trade mode
    const barSeparation = Math.abs(tp1 - barPrice);
    const tradeMode = autoTradeMode(cfd, barSeparation, structure);
    const volume = volumeByMode(cfd, tradeMode);

    // Conviction by bar size + structure alignment
    let conviction: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
    const absGamma = Math.abs(bar.netGamma);
    if (cfd === "NAS100" && absGamma > 1e9) conviction = "HIGH";
    else if (cfd === "US30" && absGamma > 20e6) conviction = "HIGH";
    else if (cfd === "XAUUSD" && absGamma > 30e6) conviction = "HIGH";
    else if (absGamma < { NAS100: 500e6, US30: 8e6, XAUUSD: 5e6 }[cfd]) conviction = "LOW";

    // Create intent
    const intent: TradeIntent = {
      id: `${date}-${snapshot.timeStr.replace(":", "")}-${cfd}-${direction}-${Math.round(barPrice)}`,
      cfd,
      direction,
      tradeMode,
      exactLevel: barPrice,
      entryMode: "level",
      structuralSL: sl,
      tp1,
      volume,
      rationale: `${bar.symbol}$${bar.strike} ${(bar.netGamma / 1e6).toFixed(0)}M ${bar.type}, struct=${structure}, R:R ${rr.toFixed(2)}`,
      conviction,
      triggerSymbol: bar.symbol,
      triggerLevel: bar.strike,
      createdAt: snapshot.t,
      expiresAt: snapshot.t + 60 * 60 * 1000, // 1 hour default
    };

    intents.push(intent);
  }

  return intents;
}

/** Generate intents for all CFDs from a snapshot */
export function generateAllIntents(snapshot: AgentViewSnapshot, date: string): TradeIntent[] {
  const intents: TradeIntent[] = [];
  for (const cfd of CFDS) {
    intents.push(...generateIntentsForCfd(snapshot, cfd, date));
  }
  return intents;
}
