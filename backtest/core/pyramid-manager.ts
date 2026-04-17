/**
 * Pyramid Manager — handles both intraday trades AND multi-day pyramid positions.
 *
 * TWO MODES determined by Risk Reversal:
 *
 * 1. INTRADAY MODE (default):
 *    - RR stable or not extreme → enter at bar, exit same day
 *    - SL tight (8-15pts), TP at next bar
 *    - Close at EOD regardless
 *
 * 2. PYRAMID MODE (when RR signals bottom/top):
 *    - RR extreme + improving → institutional reversal detected
 *    - Enter LONG #1 at fat support bar
 *    - If price confirms (crosses next bar + RR still improving) → add LONG #2
 *    - Trail all SLs to last confirmed bar
 *    - Hold overnight, hold multiple days
 *    - Exit when: RR deteriorates OR HIRO flips OR max 5 days OR SL hit
 *
 * Both modes use same L60 score for entry quality.
 * Both modes use tight SL behind gamma bar.
 */

import type { CFD, Direction, TradeMode } from "../utils/types.js";
import { BUFFERS, BROKER_SPECS } from "../utils/types.js";
import { getRiskReversalForCfd, type RiskReversalContext } from "../data-loaders/risk-reversal-loader.js";

export type PositionMode = "intraday" | "pyramid";

export interface ManagedPosition {
  id: string;
  cfd: CFD;
  direction: Direction;
  mode: PositionMode;
  entryPrice: number;
  entryTs: number;
  entryDate: string;
  currentSL: number;
  currentTP: number;
  volume: number;
  pyramidLevel: number;     // 0 = original, 1 = first add, etc.
  parentId?: string;        // if pyramid, links to original position
  maxFavorable: number;
  maxAdverse: number;
  daysHeld: number;
  rationale: string;
  l60Score: number;
  etfStrike: number;
  etfSymbol: string;
  trailedBars: number[];    // ETF strikes that have been used as trail points
  isBreakeven: boolean;
  closed: boolean;
  exitPrice?: number;
  exitTs?: number;
  exitReason?: string;
  pnlDollars?: number;
}

/** Determine if this day + CFD should use pyramid mode */
export function shouldPyramid(cfd: CFD, date: string): { mode: PositionMode; direction: Direction | null; rr: RiskReversalContext | null } {
  const rr = getRiskReversalForCfd(cfd, date);
  if (!rr) return { mode: "intraday", direction: null, rr: null };

  if (rr.isBottomSignal) {
    // Extreme bearish + improving → institutional bottom → LONG pyramid
    return { mode: "pyramid", direction: "LONG", rr };
  }
  if (rr.isTopSignal) {
    // Extreme bullish + deteriorating → institutional top → SHORT pyramid
    return { mode: "pyramid", direction: "SHORT", rr };
  }

  // Also check: strong improving trend even if not "extreme" yet
  if (rr.rrDelta5d !== null && rr.rrDelta5d > 0.04 && rr.rr !== null && rr.rr < -0.25) {
    return { mode: "pyramid", direction: "LONG", rr };
  }
  if (rr.rrDelta5d !== null && rr.rrDelta5d < -0.04 && rr.rr !== null && rr.rr > -0.1) {
    return { mode: "pyramid", direction: "SHORT", rr };
  }

  return { mode: "intraday", direction: null, rr };
}

/** Calculate SL for a position (tight, behind gamma bar) */
export function calculateSL(cfd: CFD, direction: Direction, barPrice: number, prevBarPrice?: number): number {
  const buffer = BUFFERS[cfd];
  if (prevBarPrice !== undefined) {
    return direction === "LONG"
      ? prevBarPrice - buffer.slBuffer
      : prevBarPrice + buffer.slBuffer;
  }
  // Fallback: fixed small SL
  const fixedSl = { NAS100: 15, US30: 25, XAUUSD: 5 }[cfd];
  return direction === "LONG" ? barPrice - fixedSl : barPrice + fixedSl;
}

/** Calculate volume based on mode */
export function calculateVolume(cfd: CFD, mode: PositionMode, pyramidLevel: number): number {
  const base = BROKER_SPECS[cfd].minLot;
  if (mode === "intraday") return base;
  // Pyramid: same volume each level (don't increase risk)
  if (cfd === "XAUUSD") return 0.01;
  return base; // 0.10 for NAS/US30
}

/** Check if a pyramid position should be closed (daily validation) */
export function shouldClosePyramid(
  pos: ManagedPosition,
  currentDate: string,
  currentCfdPrice: number,
): { close: boolean; reason: string } {
  const rr = getRiskReversalForCfd(pos.cfd, currentDate);

  // Max 5 days held
  if (pos.daysHeld >= 5) return { close: true, reason: "max_days_5" };

  // RR deteriorated (flipped against position)
  if (rr) {
    if (pos.direction === "LONG" && rr.trend === "deteriorating") {
      return { close: true, reason: "rr_deteriorating" };
    }
    if (pos.direction === "SHORT" && rr.trend === "improving") {
      return { close: true, reason: "rr_improving_against_short" };
    }
  }

  // Large adverse move (emergency)
  const adversePts = pos.direction === "LONG"
    ? pos.entryPrice - currentCfdPrice
    : currentCfdPrice - pos.entryPrice;
  const emergencySL = { NAS100: 100, US30: 200, XAUUSD: 20 }[pos.cfd];
  if (adversePts > emergencySL) return { close: true, reason: "emergency_sl" };

  return { close: false, reason: "" };
}

/** Check if we should add another pyramid level */
export function shouldAddPyramid(
  existingPositions: ManagedPosition[],
  cfd: CFD,
  direction: Direction,
  currentCfdPrice: number,
  nextBarPriceCfd: number,
  currentDate: string,
): boolean {
  // Max 4 pyramid levels per CFD per direction
  const sameDir = existingPositions.filter(p => p.cfd === cfd && p.direction === direction && !p.closed);
  if (sameDir.length >= 4) return false;

  // All existing must be in profit
  const allInProfit = sameDir.every(p => {
    const pnl = direction === "LONG" ? currentCfdPrice - p.entryPrice : p.entryPrice - currentCfdPrice;
    return pnl > 0;
  });
  if (!allInProfit) return false;

  // Price must have crossed the next bar (confirmation)
  const lastEntry = sameDir[sameDir.length - 1];
  if (!lastEntry) return true; // first entry

  const progressPts = direction === "LONG"
    ? currentCfdPrice - lastEntry.entryPrice
    : lastEntry.entryPrice - currentCfdPrice;

  // Must have moved at least 30pts NAS/US30, 5pts XAU since last entry
  const minProgress = { NAS100: 30, US30: 50, XAUUSD: 5 }[cfd];
  if (progressPts < minProgress) return false;

  // RR still supports
  const rr = getRiskReversalForCfd(cfd, currentDate);
  if (rr && direction === "LONG" && rr.trend === "deteriorating") return false;
  if (rr && direction === "SHORT" && rr.trend === "improving") return false;

  return true;
}

/** Trail all pyramid positions' SLs to a new confirmed bar */
export function trailPyramidSLs(
  positions: ManagedPosition[],
  cfd: CFD,
  direction: Direction,
  confirmedBarCfdPrice: number,
): void {
  const buffer = BUFFERS[cfd];
  const newSL = direction === "LONG"
    ? confirmedBarCfdPrice - buffer.slBuffer
    : confirmedBarCfdPrice + buffer.slBuffer;

  for (const pos of positions) {
    if (pos.cfd !== cfd || pos.direction !== direction || pos.closed) continue;
    // Only trail UP for longs, DOWN for shorts
    if (direction === "LONG" && newSL > pos.currentSL) {
      pos.currentSL = newSL;
      pos.isBreakeven = newSL >= pos.entryPrice;
      pos.trailedBars.push(confirmedBarCfdPrice);
    }
    if (direction === "SHORT" && newSL < pos.currentSL) {
      pos.currentSL = newSL;
      pos.isBreakeven = newSL <= pos.entryPrice;
      pos.trailedBars.push(confirmedBarCfdPrice);
    }
  }
}

/** Summary of open positions for logging */
export function positionsSummary(positions: ManagedPosition[]): string {
  const open = positions.filter(p => !p.closed);
  if (open.length === 0) return "no open positions";
  return open.map(p =>
    `${p.cfd} ${p.direction} ${p.mode}#${p.pyramidLevel} @${p.entryPrice.toFixed(1)} SL=${p.currentSL.toFixed(1)} (${p.daysHeld}d)`
  ).join(" | ");
}
