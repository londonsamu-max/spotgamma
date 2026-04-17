import type { AgentViewSnapshot, CFD, GammaBar } from "../utils/types.js";
import { priceAt, loadMt5Day } from "../data-loaders/price-provider.js";
import { CFD_SYMBOLS, computeConversionRatio, getTopGammaBars, loadGammaBars } from "../data-loaders/gamma-provider.js";

const ALL_CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];

/** Reconstructs an AgentViewSnapshot for a given timestamp using historical data */
export function reconstructSnapshot(date: string, t: number): AgentViewSnapshot | null {
  // Get CFD prices at that moment from MT5 candles
  const cfdPrices: Record<CFD, number> = {} as any;
  for (const cfd of ALL_CFDS) {
    const p = priceAt(cfd, t, "M15");
    if (p === null) return null; // critical: no price data
    cfdPrices[cfd] = p;
  }

  // Get ETF spot prices from gamma bar files (they include spotPrice per symbol)
  const etfSpotPrices: Record<string, number> = {};
  for (const cfd of ALL_CFDS) {
    for (const sym of CFD_SYMBOLS[cfd]) {
      if (etfSpotPrices[sym]) continue;
      const gb = loadGammaBars(date, sym);
      if (gb) etfSpotPrices[sym] = gb.spotPrice;
    }
  }

  // Compute conversion ratios per CFD
  const conversionRatios = {
    NAS100: computeConversionRatio("NAS100", cfdPrices.NAS100, etfSpotPrices),
    US30: computeConversionRatio("US30", cfdPrices.US30, etfSpotPrices),
    XAUUSD: computeConversionRatio("XAUUSD", cfdPrices.XAUUSD, etfSpotPrices),
  };

  // Get top gamma bars per CFD near price. MASSIVELY widened because bars
  // are often concentrated far from spot (e.g. DIA strikes at +6-9% from price).
  const gammaBarsNear: Record<CFD, GammaBar[]> = {} as any;
  const MAX_DIST = { NAS100: 1000, US30: 3000, XAUUSD: 150 };
  for (const cfd of ALL_CFDS) {
    gammaBarsNear[cfd] = getTopGammaBars(date, cfd, cfdPrices[cfd], etfSpotPrices, 20, MAX_DIST[cfd]);
  }

  // Extract walls + zeroGamma for each ETF
  const callWall: Record<string, number> = {};
  const putWall: Record<string, number> = {};
  const zeroGamma: Record<string, number> = {};
  for (const sym of ["SPX", "QQQ", "SPY", "DIA", "GLD"]) {
    const gb = loadGammaBars(date, sym);
    if (gb) {
      callWall[sym] = gb.callWall;
      putWall[sym] = gb.putWall;
      zeroGamma[sym] = gb.zeroGamma;
    }
  }

  const timeStr = new Date(t).toISOString().slice(11, 16);

  return {
    t,
    date,
    timeStr,
    cfdPrices,
    gammaBarsNear,
    conversionRatios,
    spotGammaFlags: { callWall, putWall, zeroGamma },
  };
}

/** Enumerate timestamps where we want to run a decision cycle (every 5 minutes within market hours) */
export function cycleTimestamps(date: string): number[] {
  // Use NAS100 M15 candles as the clock source
  const candles = loadMt5Day("NAS100", date, "M15");
  if (candles.length === 0) return [];
  // Run at each candle close (15-min steps)
  const tss = candles.map((c) => c.t!);
  // De-dup and sort
  return Array.from(new Set(tss)).sort((a, b) => a - b);
}
