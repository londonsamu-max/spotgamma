/**
 * Executor Sim — walks forward through M15 candles, simulates order fills, SL, TP, trailing.
 *
 * Design:
 *  - For each pending intent, watch candles after createdAt.
 *  - Fill when candle.low <= exactLevel <= candle.high (tolerance ±5pts NAS/US30, ±3pts XAU for level mode).
 *  - After fill, track:
 *    - SL hit: candle extremes reach SL
 *    - TP hit: candle extremes reach TP1
 *    - Breakeven: after 0.5R (scalp), 1R (intraday), 1.5R (swing) → move SL to entry + buffer
 *  - Close trade at first SL/TP hit.
 *  - If day ends without hit, close at last candle (eod).
 */

import type {
  TradeIntent, ClosedTrade, TradeMode, CFD, MT5Candle,
} from "../utils/types.js";
import { BROKER_SPECS, BUFFERS } from "../utils/types.js";

const LEVEL_TOL: Record<CFD, number> = { NAS100: 8, US30: 12, XAUUSD: 3 };

/** Breakeven thresholds per trade mode (in R multiples) */
const BE_R: Record<TradeMode, number> = {
  scalp: 0.5,
  intraday: 1.0,
  swing: 1.5,
};

export function simulateIntent(
  intent: TradeIntent,
  candles: MT5Candle[], // all candles of the day, sorted ascending
): ClosedTrade | null {
  // Find candles after createdAt
  const later = candles.filter((c) => c.t! >= intent.createdAt);
  if (later.length === 0) return null;

  const tol = LEVEL_TOL[intent.cfd];
  const dir = intent.direction;
  const entry = intent.exactLevel;
  const initialSl = intent.structuralSL;
  const initialRisk = Math.abs(entry - initialSl);
  const tp1 = intent.tp1;
  const beR = BE_R[intent.tradeMode];
  const beBuffer = BUFFERS[intent.cfd].beBuffer;
  const beTrigger = dir === "LONG" ? entry + initialRisk * beR : entry - initialRisk * beR;
  const beNewSl = dir === "LONG" ? entry + beBuffer : entry - beBuffer;

  let filled = false;
  let filledAt = 0;
  let currentSl = initialSl;
  let movedToBE = false;
  let maxAdverse = 0;
  let maxFavorable = 0;

  for (const candle of later) {
    const { open, high, low, close, t } = candle;

    // Phase 1: try to fill if not filled yet
    if (!filled) {
      // Level mode: fill if entry price is within candle range ± tolerance
      const lowBound = Math.min(low, entry - tol);
      const highBound = Math.max(high, entry + tol);
      if (entry >= low - tol && entry <= high + tol) {
        filled = true;
        filledAt = t!;
        continue; // start checking SL/TP from next candle
      }
      // Expired?
      if (t! > intent.expiresAt) return null;
      continue;
    }

    // Phase 2: trade is live — track max adverse/favorable
    if (dir === "LONG") {
      const adverse = entry - low;
      if (adverse > maxAdverse) maxAdverse = adverse;
      const favorable = high - entry;
      if (favorable > maxFavorable) maxFavorable = favorable;
    } else {
      const adverse = high - entry;
      if (adverse > maxAdverse) maxAdverse = adverse;
      const favorable = entry - low;
      if (favorable > maxFavorable) maxFavorable = favorable;
    }

    // Check SL hit first (conservative)
    const slHit = dir === "LONG" ? low <= currentSl : high >= currentSl;
    // Check TP hit
    const tpHit = dir === "LONG" ? high >= tp1 : low <= tp1;

    // If both hit in same candle, assume SL fills first (conservative)
    if (slHit) {
      const exit = currentSl;
      return closeTrade(intent, filledAt, t!, exit, movedToBE ? "trail" : "sl", maxAdverse, maxFavorable);
    }
    if (tpHit) {
      return closeTrade(intent, filledAt, t!, tp1, "tp1", maxAdverse, maxFavorable);
    }

    // Breakeven management
    if (!movedToBE) {
      const reachedBE = dir === "LONG" ? high >= beTrigger : low <= beTrigger;
      if (reachedBE) {
        movedToBE = true;
        currentSl = beNewSl;
      }
    }
  }

  // Market end — close at last candle close
  const last = later[later.length - 1];
  if (!filled) return null;
  return closeTrade(intent, filledAt, last.t!, last.close, "eod", maxAdverse, maxFavorable);
}

function closeTrade(
  intent: TradeIntent,
  entryTs: number,
  exitTs: number,
  exit: number,
  reason: ClosedTrade["exitReason"],
  maxAdverse: number,
  maxFavorable: number,
): ClosedTrade {
  const spec = BROKER_SPECS[intent.cfd];
  const pnlPts = intent.direction === "LONG" ? exit - intent.exactLevel : intent.exactLevel - exit;
  // Convert lots to $/pt: 0.10 lots on NAS = $0.10/pt baseline
  const pnlDollars = pnlPts * spec.dollarsPerPoint * (intent.volume / spec.minLot);
  const durationMin = (exitTs - entryTs) / 60000;

  return {
    intentId: intent.id,
    cfd: intent.cfd,
    direction: intent.direction,
    tradeMode: intent.tradeMode,
    entry: intent.exactLevel,
    entryTs,
    exit,
    exitTs,
    exitReason: reason,
    pnlPts: Math.round(pnlPts * 100) / 100,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    durationMin: Math.round(durationMin),
    maxAdverse: Math.round(maxAdverse * 100) / 100,
    maxFavorable: Math.round(maxFavorable * 100) / 100,
  };
}
