/**
 * Executor Sim v2 — TRIGGERS ON ETF PRICE (not converted CFD).
 *
 * Design change from v1:
 *   - Entry detection: walk through ETF OHLC 1-min (SPX, QQQ, SPY, DIA, GLD)
 *     and find the first minute where ETF price touches the gamma bar STRIKE.
 *   - Entry execution: at that moment, read CFD price from MT5 candles.
 *   - SL/TP: still CFD-based (that's what we trade), using the converted
 *     levels computed AT ENTRY TIME (ratio = cfdEntry / etfStrike).
 *
 * This eliminates the conversion-ratio drift bug where the CFD trigger would
 * fire at a slightly different structural moment than the real gamma level.
 */

import type {
  TradeIntent, ClosedTrade, TradeMode, CFD, MT5Candle, OHLCBar,
} from "../utils/types.js";
import { BROKER_SPECS, BUFFERS } from "../utils/types.js";
import { loadOhlc1Min } from "../data-loaders/price-provider.js";

/** Trigger tolerance on ETF price (in ETF units) */
const ETF_TOL: Record<string, number> = {
  SPX: 1.5, SPY: 0.15, QQQ: 0.15, DIA: 0.1, GLD: 0.1,
};

/** Breakeven thresholds per trade mode (R multiples) */
const BE_R: Record<TradeMode, number> = { scalp: 0.5, intraday: 1.0, swing: 1.5 };

/** Tolerance for SL/TP hit detection on CFD candles */
const CFD_TOL: Record<CFD, number> = { NAS100: 3, US30: 5, XAUUSD: 1 };

export interface SimulationInput {
  intent: TradeIntent & { etfStrike: number; etfSymbol: string };
  etfCandles: OHLCBar[];  // 1-min bars for the ETF (SPX/QQQ/SPY/DIA/GLD)
  cfdCandles: MT5Candle[]; // 15-min bars for the CFD (NAS100/US30/XAUUSD)
  nextBarEtf?: { strike: number };   // next gamma bar in direction (ETF units) for TP
  prevBarEtf?: { strike: number };   // previous gamma bar (ETF units) for SL
}

/**
 * Simulates one trade with ETF-based trigger:
 *   1. Find first minute where etf.low <= strike <= etf.high
 *   2. Record entry: CFD price at that minute (from 15-min candle spanning it)
 *   3. Convert next/prev ETF bars to CFD prices using ratio at entry
 *   4. Walk forward CFD candles for SL/TP hit detection
 */
export function simulateWithEtfTrigger(input: SimulationInput): ClosedTrade | null {
  const { intent, etfCandles, cfdCandles, nextBarEtf, prevBarEtf } = input;
  if (etfCandles.length === 0 || cfdCandles.length === 0) return null;

  const etfStrike = intent.etfStrike;
  const tol = ETF_TOL[intent.etfSymbol] ?? 1;
  const dir = intent.direction;

  // Phase 1 — find ETF touch moment
  const etfAfterCreation = etfCandles.filter((c) => c.t >= intent.createdAt);
  let triggerTs = 0;
  for (const bar of etfAfterCreation) {
    if (etfStrike >= bar.l - tol && etfStrike <= bar.h + tol) {
      triggerTs = bar.t;
      break;
    }
    if (bar.t > intent.expiresAt) return null;
  }
  if (!triggerTs) return null;

  // Phase 2 — get CFD price at that moment (closest 15-min candle <= triggerTs)
  const cfdAtEntry = findCfdAtTs(cfdCandles, triggerTs);
  if (!cfdAtEntry) return null;

  // Use the midpoint of the 15-min candle around trigger as approximate fill
  const entryPrice = estimateEntryPrice(cfdAtEntry, dir);
  const ratio = entryPrice / etfStrike;

  // Phase 3 — convert SL/TP levels using the SAME ratio (structural bars in ETF units)
  const tp1Etf = nextBarEtf?.strike ?? null;
  const slEtf = prevBarEtf?.strike ?? null;
  const tp1Cfd = tp1Etf ? tp1Etf * ratio : intent.tp1;
  const buffer = BUFFERS[intent.cfd];
  let slCfd = slEtf
    ? (dir === "LONG" ? slEtf * ratio - buffer.slBuffer : slEtf * ratio + buffer.slBuffer)
    : intent.structuralSL;

  // Validate
  const risk = Math.abs(entryPrice - slCfd);
  const reward = Math.abs(tp1Cfd - entryPrice);
  if (risk === 0) return null;
  const rr = reward / risk;
  if (rr < 1.2) return null; // R:R got worse after re-conversion; skip

  // Phase 4 — walk CFD candles after trigger for SL/TP hit
  const cfdAfter = cfdCandles.filter((c) => c.t! > triggerTs);
  const beR = BE_R[intent.tradeMode];
  const beBuffer = buffer.beBuffer;
  const beTrigger = dir === "LONG" ? entryPrice + risk * beR : entryPrice - risk * beR;
  const beNewSl = dir === "LONG" ? entryPrice + beBuffer : entryPrice - beBuffer;
  const cfdTol = CFD_TOL[intent.cfd];
  let currentSl = slCfd;
  let movedToBE = false;
  let maxAdverse = 0;
  let maxFavorable = 0;

  for (const candle of cfdAfter) {
    const { high, low, close, t } = candle;
    if (dir === "LONG") {
      const adv = entryPrice - low;
      const fav = high - entryPrice;
      if (adv > maxAdverse) maxAdverse = adv;
      if (fav > maxFavorable) maxFavorable = fav;
    } else {
      const adv = high - entryPrice;
      const fav = entryPrice - low;
      if (adv > maxAdverse) maxAdverse = adv;
      if (fav > maxFavorable) maxFavorable = fav;
    }

    const slHit = dir === "LONG" ? low <= currentSl + cfdTol : high >= currentSl - cfdTol;
    const tpHit = dir === "LONG" ? high >= tp1Cfd - cfdTol : low <= tp1Cfd + cfdTol;

    if (slHit) return close_(intent, triggerTs, t!, entryPrice, currentSl, movedToBE ? "trail" : "sl", maxAdverse, maxFavorable);
    if (tpHit) return close_(intent, triggerTs, t!, entryPrice, tp1Cfd, "tp1", maxAdverse, maxFavorable);

    if (!movedToBE) {
      const reachedBE = dir === "LONG" ? high >= beTrigger : low <= beTrigger;
      if (reachedBE) {
        movedToBE = true;
        currentSl = beNewSl;
      }
    }
  }

  const last = cfdAfter[cfdAfter.length - 1];
  if (!last) return null;
  return close_(intent, triggerTs, last.t!, entryPrice, last.close, "eod", maxAdverse, maxFavorable);
}

function findCfdAtTs(cfdCandles: MT5Candle[], ts: number): MT5Candle | null {
  // Find the last candle that starts at or before ts
  let best: MT5Candle | null = null;
  for (const c of cfdCandles) {
    if (c.t! <= ts) best = c;
    else break;
  }
  return best;
}

function estimateEntryPrice(candle: MT5Candle, dir: "LONG" | "SHORT"): number {
  // Approximate: assume trigger happens inside the candle's range.
  // For LONG at support: assume entry near candle low-mid.
  // For SHORT at resistance: assume entry near candle high-mid.
  if (dir === "LONG") return (candle.low + candle.close) / 2;
  return (candle.high + candle.close) / 2;
}

function close_(
  intent: TradeIntent,
  entryTs: number,
  exitTs: number,
  entry: number,
  exit: number,
  reason: ClosedTrade["exitReason"],
  maxAdverse: number,
  maxFavorable: number,
): ClosedTrade {
  const spec = BROKER_SPECS[intent.cfd];
  const pnlPts = intent.direction === "LONG" ? exit - entry : entry - exit;
  const pnlDollars = pnlPts * spec.dollarsPerPoint * (intent.volume / spec.minLot);
  const durationMin = (exitTs - entryTs) / 60000;
  return {
    intentId: intent.id,
    cfd: intent.cfd,
    direction: intent.direction,
    tradeMode: intent.tradeMode,
    entry: Math.round(entry * 100) / 100,
    entryTs,
    exit: Math.round(exit * 100) / 100,
    exitTs,
    exitReason: reason,
    pnlPts: Math.round(pnlPts * 100) / 100,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    durationMin: Math.round(durationMin),
    maxAdverse: Math.round(maxAdverse * 100) / 100,
    maxFavorable: Math.round(maxFavorable * 100) / 100,
  };
}
