/**
 * Candle pattern detector — uses OHLC 1-min or any OHLC data.
 * Implements key patterns from CLAUDE.md L60 and statistical rules:
 *  - hammer (76% bounce at support)
 *  - doji (69% bounce)
 *  - wick_rejection (65% bounce)
 *  - body_through (58-61% break continuation)
 *  - engulfing (directional reversal)
 */

import type { OHLCBar } from "../utils/types.js";

export type CandlePattern =
  | "hammer"
  | "inverted_hammer"
  | "doji"
  | "wick_rejection_up"
  | "wick_rejection_down"
  | "body_through_up"
  | "body_through_down"
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "none";

export interface CandleAnalysis {
  pattern: CandlePattern;
  isBullish: boolean; // true = points up, false = points down
  isNeutral: boolean; // doji
  strength: number; // 0-1
}

/** Analyze a single candle relative to previous for engulfing */
export function analyzeCandle(current: OHLCBar, prev?: OHLCBar): CandleAnalysis {
  const body = Math.abs(current.c - current.o);
  const range = current.h - current.l;
  if (range === 0) return { pattern: "none", isBullish: false, isNeutral: true, strength: 0 };

  const upperWick = current.h - Math.max(current.o, current.c);
  const lowerWick = Math.min(current.o, current.c) - current.l;
  const bodyRatio = body / range;
  const isGreen = current.c > current.o;

  // Doji: body < 10% of range
  if (bodyRatio < 0.1) {
    return { pattern: "doji", isBullish: false, isNeutral: true, strength: 1 - bodyRatio * 10 };
  }

  // Hammer: body in upper third, long lower wick (>2x body)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && isGreen) {
    return { pattern: "hammer", isBullish: true, isNeutral: false, strength: Math.min(1, lowerWick / body / 3) };
  }
  // Inverted hammer: long upper wick, body bottom
  if (upperWick > body * 2 && lowerWick < body * 0.5 && !isGreen) {
    return { pattern: "inverted_hammer", isBullish: false, isNeutral: false, strength: Math.min(1, upperWick / body / 3) };
  }

  // Wick rejection: wick > 1.5x body on one side
  if (lowerWick > body * 1.5 && lowerWick > upperWick * 1.5) {
    return { pattern: "wick_rejection_down", isBullish: true, isNeutral: false, strength: 0.65 };
  }
  if (upperWick > body * 1.5 && upperWick > lowerWick * 1.5) {
    return { pattern: "wick_rejection_up", isBullish: false, isNeutral: false, strength: 0.65 };
  }

  // Body-through (strong trending candle): body > 70% of range
  if (bodyRatio > 0.7) {
    if (isGreen) return { pattern: "body_through_up", isBullish: true, isNeutral: false, strength: bodyRatio };
    return { pattern: "body_through_down", isBullish: false, isNeutral: false, strength: bodyRatio };
  }

  // Engulfing with previous
  if (prev) {
    const prevBody = Math.abs(prev.c - prev.o);
    if (body > prevBody * 1.2) {
      if (isGreen && prev.c < prev.o && current.c > prev.o && current.o < prev.c) {
        return { pattern: "bullish_engulfing", isBullish: true, isNeutral: false, strength: 0.7 };
      }
      if (!isGreen && prev.c > prev.o && current.c < prev.o && current.o > prev.c) {
        return { pattern: "bearish_engulfing", isBullish: false, isNeutral: false, strength: 0.7 };
      }
    }
  }

  return { pattern: "none", isBullish: isGreen, isNeutral: false, strength: bodyRatio };
}

/** Aggregate recent N candles to detect momentum */
export interface RecentCandlesAnalysis {
  lastPatterns: CandlePattern[];
  momentum: "strong_up" | "up" | "flat" | "down" | "strong_down";
  hammerOrWickRejectionAtLow: boolean; // support test
  hammerOrWickRejectionAtHigh: boolean; // resistance test
  bodyThroughDirection: "up" | "down" | null;
}

export function analyzeRecent(candles: OHLCBar[], count: number = 5): RecentCandlesAnalysis {
  const last = candles.slice(-count);
  if (last.length < 2) {
    return {
      lastPatterns: [],
      momentum: "flat",
      hammerOrWickRejectionAtLow: false,
      hammerOrWickRejectionAtHigh: false,
      bodyThroughDirection: null,
    };
  }
  const analyses: CandleAnalysis[] = [];
  for (let i = 0; i < last.length; i++) {
    analyses.push(analyzeCandle(last[i], i > 0 ? last[i - 1] : undefined));
  }

  const closes = last.map((c) => c.c);
  const change = closes[closes.length - 1] - closes[0];
  const first = closes[0];
  const pctChange = (change / first) * 100;

  let momentum: RecentCandlesAnalysis["momentum"] = "flat";
  if (pctChange > 0.4) momentum = "strong_up";
  else if (pctChange > 0.1) momentum = "up";
  else if (pctChange < -0.4) momentum = "strong_down";
  else if (pctChange < -0.1) momentum = "down";

  // Was there a body-through in the recent set?
  const btUp = analyses.some((a) => a.pattern === "body_through_up");
  const btDown = analyses.some((a) => a.pattern === "body_through_down");

  // Hammer/wick reject at low of range?
  const lowIdx = last.reduce((mi, c, i) => (c.l < last[mi].l ? i : mi), 0);
  const highIdx = last.reduce((mi, c, i) => (c.h > last[mi].h ? i : mi), 0);
  const hammerAtLow = ["hammer", "wick_rejection_down", "bullish_engulfing"].includes(analyses[lowIdx].pattern);
  const hammerAtHigh = ["inverted_hammer", "wick_rejection_up", "bearish_engulfing"].includes(analyses[highIdx].pattern);

  return {
    lastPatterns: analyses.map((a) => a.pattern),
    momentum,
    hammerOrWickRejectionAtLow: hammerAtLow,
    hammerOrWickRejectionAtHigh: hammerAtHigh,
    bodyThroughDirection: btUp ? "up" : btDown ? "down" : null,
  };
}
