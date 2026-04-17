import * as fs from "node:fs";
import * as path from "node:path";
import type { GammaBarsDaily, GammaBar, CFD } from "../utils/types.js";

const HIST = path.resolve(process.cwd(), "data/historical");

/** Loads gamma bars for a given symbol on a given date */
export function loadGammaBars(date: string, symbol: string): GammaBarsDaily | null {
  const file = path.join(HIST, "gamma-bars", date, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed as GammaBarsDaily;
  } catch {
    return null;
  }
}

/** Which ETF symbols power each CFD for gamma bar analysis */
export const CFD_SYMBOLS: Record<CFD, string[]> = {
  NAS100: ["SPX", "QQQ", "SPY"],
  US30: ["DIA"],
  XAUUSD: ["GLD"],
};

/** Minimum gamma thresholds — lowered for broader coverage */
export const MIN_GAMMA: Record<CFD, number> = {
  NAS100: 150e6,   // >150M (was 300M)
  US30: 2e6,       // >2M (was 5M)
  XAUUSD: 1.5e6,   // >1.5M (was 3M)
};

/**
 * Compute conversion ratio CFD price / ETF price.
 * For NAS100: uses SPX (NAS is ~3.66x SPX).
 * For US30: uses DIA (~99.7x).
 * For XAUUSD: uses GLD (~10.8x).
 */
export function computeConversionRatio(cfd: CFD, cfdPrice: number, etfSpotPrices: Record<string, number>): number {
  if (cfd === "NAS100") {
    const spx = etfSpotPrices.SPX;
    if (spx && spx > 0) return cfdPrice / spx;
  } else if (cfd === "US30") {
    const dia = etfSpotPrices.DIA;
    if (dia && dia > 0) return cfdPrice / dia;
  } else if (cfd === "XAUUSD") {
    const gld = etfSpotPrices.GLD;
    if (gld && gld > 0) return cfdPrice / gld;
  }
  // Defaults if missing
  return { NAS100: 3.66, US30: 99.7, XAUUSD: 10.8 }[cfd];
}

/** Get top N fattest gamma bars for a CFD on a given date, combined across its source symbols */
export function getTopGammaBars(
  date: string,
  cfd: CFD,
  cfdPrice: number,
  etfSpotPrices: Record<string, number>,
  topN: number = 20,
  maxDistanceCfd: number = Infinity,
): GammaBar[] {
  const symbols = CFD_SYMBOLS[cfd];
  const all: GammaBar[] = [];

  for (const sym of symbols) {
    const daily = loadGammaBars(date, sym);
    if (!daily) continue;
    const ratio = computeConversionRatio(cfd, cfdPrice, etfSpotPrices);
    for (const bar of daily.allBars) {
      const cfdBarPrice = bar.strike * ratio;
      if (Math.abs(cfdBarPrice - cfdPrice) > maxDistanceCfd) continue;
      all.push({
        ...bar,
        symbol: sym,
        cfdPrice: cfdBarPrice,
      });
    }
  }

  // Filter by minimum gamma
  const minGamma = MIN_GAMMA[cfd];
  const filtered = all.filter((b) => Math.abs(b.netGamma) >= minGamma);

  // Sort by absolute netGamma descending
  filtered.sort((a, b) => Math.abs(b.netGamma) - Math.abs(a.netGamma));
  return filtered.slice(0, topN);
}
