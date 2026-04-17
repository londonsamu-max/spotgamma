/**
 * MT5 Proxy Trigger — for DIA/GLD where we don't have ETF OHLC 1-min.
 *
 * Instead of triggering on ETF price directly, uses:
 *   1. Drift model to convert ETF strike → expected CFD price range
 *   2. MT5 M15 candles to detect when CFD price enters that range
 *   3. Adjusts for hour-of-day and VIX regime (drift varies)
 *
 * For NAS100: still uses SPX OHLC 1-min (direct ETF trigger, best precision)
 * For US30:   uses MT5 US30 M15 + drift model from DIA
 * For XAUUSD: uses MT5 XAUUSD M15 + drift model from GLD
 */

import { loadMt5Day, loadOhlc1Min } from "./price-provider.js";
import { predictCfdRange, loadDriftModel } from "../models/drift-model.js";
import { getMacroContext } from "./macro-loader.js";
import type { CFD, OHLCBar, MT5Candle } from "../utils/types.js";

const PRIMARY_ETF: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

/** Determines which trigger method to use for a CFD */
export function getTriggerMethod(cfd: CFD): "etf_1min" | "mt5_proxy" {
  if (cfd === "NAS100") return "etf_1min"; // SPX has real 1-min data
  return "mt5_proxy"; // DIA/GLD don't have historical 1-min
}

/**
 * For MT5 proxy: given an ETF strike, compute the CFD price range
 * where the trigger should fire, adjusted by drift model.
 */
export function getProxyTriggerRange(
  cfd: CFD,
  etfStrike: number,
  date: string,
  hour: number,
): { low: number; mid: number; high: number } | null {
  const macro = getMacroContext(date);
  const range = predictCfdRange(cfd, etfStrike, hour, macro.vixRegime);
  if (!range) {
    // Fallback: use simple fixed ratios
    const defaultRatio: Record<CFD, number> = { NAS100: 3.74, US30: 99.7, XAUUSD: 10.8 };
    const mid = etfStrike * defaultRatio[cfd];
    const spread = mid * 0.002; // ±0.2%
    return { low: mid - spread, mid, high: mid + spread };
  }
  return range;
}

/**
 * Find the first MT5 M15 candle where CFD price enters the trigger range.
 * Returns the candle timestamp if found, null otherwise.
 */
export function findMt5ProxyTrigger(
  cfd: CFD,
  etfStrike: number,
  date: string,
  afterTs: number,
  expiresAt: number,
): { triggerTs: number; cfdPriceAtTrigger: number } | null {
  const candles = loadMt5Day(cfd, date, "M15");
  if (candles.length === 0) return null;

  for (const c of candles) {
    if (c.t! < afterTs) continue;
    if (c.t! > expiresAt) return null;

    const hour = new Date(c.t!).getUTCHours();
    const range = getProxyTriggerRange(cfd, etfStrike, date, hour);
    if (!range) continue;

    // Check if candle high/low crosses the trigger range
    if (c.high >= range.low && c.low <= range.high) {
      // Triggered! Estimate entry price as midpoint of range within candle
      const entryEstimate = Math.max(c.low, Math.min(c.high, range.mid));
      return { triggerTs: c.t!, cfdPriceAtTrigger: entryEstimate };
    }
  }

  return null;
}

/**
 * Universal trigger finder — uses ETF 1-min for NAS100, MT5 proxy for US30/XAUUSD
 */
export function findTrigger(
  cfd: CFD,
  etfStrike: number,
  etfSymbol: string,
  date: string,
  afterTs: number,
  expiresAt: number,
): { triggerTs: number; cfdPriceAtTrigger: number; method: string } | null {
  const method = getTriggerMethod(cfd);

  if (method === "etf_1min") {
    // Direct ETF trigger (NAS100 via SPX)
    const etfBars = loadOhlc1Min(etfSymbol, date);
    const tol = { SPX: 1.5, QQQ: 0.15, SPY: 0.15 }[etfSymbol] ?? 1;

    for (const bar of etfBars) {
      if (bar.t < afterTs) continue;
      if (bar.t > expiresAt) return null;
      if (etfStrike >= bar.l - tol && etfStrike <= bar.h + tol) {
        // Get CFD price at this moment
        const cfdCandles = loadMt5Day(cfd, date, "M15");
        const cfdBar = cfdCandles.reduce((best: MT5Candle | null, c) => {
          if (!best || Math.abs(c.t! - bar.t) < Math.abs(best.t! - bar.t)) return c;
          return best;
        }, null);
        if (!cfdBar) return null;
        const entry = (cfdBar.low + cfdBar.close) / 2; // conservative estimate
        return { triggerTs: bar.t, cfdPriceAtTrigger: entry, method: "etf_1min" };
      }
    }
    return null;
  }

  // MT5 proxy (US30/XAUUSD)
  const result = findMt5ProxyTrigger(cfd, etfStrike, date, afterTs, expiresAt);
  if (!result) return null;
  return { ...result, method: "mt5_proxy" };
}
