/**
 * Historical Gamma Bars Downloader
 *
 * Downloads FULL gamma bar data from SpotGamma's chart_data endpoint
 * for backtesting. Saves complete bar data per day per symbol.
 *
 * Usage: Call downloadGammaBarsRange("2024-01-02", "2026-04-10")
 * or expose via tRPC route.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getToken } from "./spotgamma-scraper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BARS_DIR = path.resolve(__dirname, "../data/historical/gamma-bars");
const API_BASE = "https://api.spotgamma.com";

const SYMBOLS = ["SPX", "QQQ", "SPY", "DIA", "GLD"] as const;

// CFD conversion ratios (approximate, for reference — actual ratios change daily)
const CFD_MAP: Record<string, { cfd: string; approxRatio: number }> = {
  SPX: { cfd: "NAS100", approxRatio: 3.68 },
  QQQ: { cfd: "NAS100", approxRatio: 37.0 },
  SPY: { cfd: "NAS100", approxRatio: 37.0 },
  DIA: { cfd: "US30", approxRatio: 100.0 },
  GLD: { cfd: "XAUUSD", approxRatio: 10.9 },
};

export interface GammaBar {
  strike: number;
  callGamma: number;     // raw call gamma notional
  putGamma: number;      // raw put gamma notional
  netGamma: number;      // call - put (positive = support, negative = resistance)
  totalGamma: number;    // |call| + |put|
  type: "support" | "resistance";
  netPositioning?: number;
  // Extended data
  callDelta?: number;
  putDelta?: number;
  callOI?: number;
  putOI?: number;
  oiChange?: number;
}

export interface DayGammaBars {
  date: string;
  symbol: string;
  fetchedAt: string;

  // Price context
  spotPrice: number;         // approximate spot from curve
  zeroGamma: number;         // gamma flip level
  callWall: number;
  putWall: number;

  // All bars (every strike with gamma)
  allBars: GammaBar[];

  // Top 20 fattest bars by |totalGamma|
  topBars: GammaBar[];

  // Regime
  totalCallGamma: number;
  totalPutGamma: number;
  gammaRatio: number;        // >0.5 = positive gamma regime
  regime: "positive" | "negative" | "very_negative" | "neutral";

  // 0DTE vs monthly gamma
  zeroDteGamma?: { calls: number; puts: number };
  monthlyGamma?: { calls: number; puts: number };

  // Extended data (delta, OI)
  totalCallDelta?: number;
  totalPutDelta?: number;
  totalCallOI?: number;
  totalPutOI?: number;
  totalOIChange?: number;

  // Delta curves (smooth, for delta landscape)
  deltaCurve?: { all: number[]; monthly: number[]; nextExp: number[] };
  gammaCurve?: { all: number[]; monthly: number[]; nextExp: number[] };
  spotPrices?: number[];  // price axis for curves
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function sgFetch(urlPath: string, token: string): Promise<any> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(`${API_BASE}${urlPath}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Origin": "https://dashboard.spotgamma.com",
        "Referer": "https://dashboard.spotgamma.com/",
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!resp.ok) {
      console.log(`[HIST] ${urlPath} → ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e: any) {
    clearTimeout(tid);
    console.log(`[HIST] ${urlPath} → ERROR: ${e.message}`);
    return null;
  }
}

function getTradingDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const cur = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(cur.toISOString().split("T")[0]);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function extractGammaBars(date: string, symbol: string, chartData: any): DayGammaBars | null {
  if (!chartData?.bars || !chartData?.curves) return null;

  const strikes: number[] = chartData.bars.strikes || [];
  const callGammaAll: number[] = chartData.bars.cust?.gamma?.all?.calls || [];
  const putGammaAll: number[] = chartData.bars.cust?.gamma?.all?.puts || [];
  const netPosCalls: number[] = chartData.bars.cust?.net_positioning?.calls || [];
  const netPosPuts: number[] = chartData.bars.cust?.net_positioning?.puts || [];

  // Delta per strike
  const callDeltaAll: number[] = chartData.bars.cust?.delta?.all?.calls || [];
  const putDeltaAll: number[] = chartData.bars.cust?.delta?.all?.puts || [];

  // OI per strike
  const oiCalls: number[] = chartData.bars.oi?.calls || [];
  const oiPuts: number[] = chartData.bars.oi?.puts || [];

  // OI change per strike
  const oiChangeArr: number[] = chartData.bars.oi_change || [];

  // 0DTE and monthly gamma
  const callGamma0DTE: number[] = chartData.bars.cust?.gamma?.next_exp?.calls || [];
  const putGamma0DTE: number[] = chartData.bars.cust?.gamma?.next_exp?.puts || [];
  const callGammaMonthly: number[] = chartData.bars.cust?.gamma?.monthly?.calls || [];
  const putGammaMonthly: number[] = chartData.bars.cust?.gamma?.monthly?.puts || [];

  if (strikes.length === 0) return null;

  // Spot price from curve
  const spObj: Record<string, number> = chartData.curves.spot_prices || {};
  const spVals = Object.values(spObj) as number[];
  spVals.sort((a, b) => a - b);
  const spotPrice = spVals.length > 0 ? spVals[Math.floor(spVals.length / 2)] : 0;

  // Zero gamma from curve
  const curveGamma: number[] = chartData.curves.cust?.gamma?.all || [];
  let zeroGamma = 0;
  for (let i = 1; i < spVals.length && i < curveGamma.length; i++) {
    if (curveGamma[i - 1] < 0 && curveGamma[i] >= 0) {
      zeroGamma = spVals[i];
      break;
    }
    if (curveGamma[i - 1] >= 0 && curveGamma[i] < 0 && zeroGamma === 0) {
      zeroGamma = spVals[i];
    }
  }

  // Build all bars
  let totalCallGamma = 0;
  let totalPutGamma = 0;
  const allBars: GammaBar[] = [];

  for (let i = 0; i < strikes.length; i++) {
    const cg = callGammaAll[i] ?? 0;
    const pg = putGammaAll[i] ?? 0;
    const net = cg - Math.abs(pg);
    const total = Math.abs(cg) + Math.abs(pg);

    if (total < 1000) continue; // Skip negligible bars

    const netPos = (netPosCalls[i] ?? 0) + (netPosPuts[i] ?? 0);

    allBars.push({
      strike: strikes[i],
      callGamma: cg,
      putGamma: pg,
      netGamma: net,
      totalGamma: total,
      type: net >= 0 ? "support" : "resistance",
      netPositioning: netPos,
      callDelta: callDeltaAll[i] ?? 0,
      putDelta: putDeltaAll[i] ?? 0,
      callOI: oiCalls[i] ?? 0,
      putOI: oiPuts[i] ?? 0,
      oiChange: oiChangeArr[i] ?? 0,
    });

    totalCallGamma += Math.abs(cg);
    totalPutGamma += Math.abs(pg);
  }

  // Sort by fattest (total gamma)
  allBars.sort((a, b) => b.totalGamma - a.totalGamma);
  const topBars = allBars.slice(0, 20);

  // Key levels
  const callWall = allBars.reduce((best, b) => Math.abs(b.callGamma) > Math.abs(best.callGamma) ? b : best, allBars[0])?.strike ?? 0;
  const putWall = allBars.reduce((best, b) => Math.abs(b.putGamma) > Math.abs(best.putGamma) ? b : best, allBars[0])?.strike ?? 0;

  // Regime
  const gammaRatio = (totalCallGamma + totalPutGamma) > 0
    ? totalCallGamma / (totalCallGamma + totalPutGamma)
    : 0.5;

  let regime: "positive" | "negative" | "very_negative" | "neutral" = "neutral";
  if (gammaRatio > 0.55) regime = "positive";
  else if (gammaRatio < 0.35) regime = "very_negative";
  else if (gammaRatio < 0.45) regime = "negative";

  // 0DTE totals
  let zeroDteCallTotal = 0, zeroDtePutTotal = 0;
  let monthlyCallTotal = 0, monthlyPutTotal = 0;
  for (let i = 0; i < strikes.length; i++) {
    zeroDteCallTotal += Math.abs(callGamma0DTE[i] ?? 0);
    zeroDtePutTotal += Math.abs(putGamma0DTE[i] ?? 0);
    monthlyCallTotal += Math.abs(callGammaMonthly[i] ?? 0);
    monthlyPutTotal += Math.abs(putGammaMonthly[i] ?? 0);
  }

  // Delta/OI totals
  let totalCallDelta = 0, totalPutDelta = 0, totalCallOI = 0, totalPutOI = 0, totalOIChange = 0;
  for (let i = 0; i < strikes.length; i++) {
    totalCallDelta += Math.abs(callDeltaAll[i] ?? 0);
    totalPutDelta += Math.abs(putDeltaAll[i] ?? 0);
    totalCallOI += oiCalls[i] ?? 0;
    totalPutOI += oiPuts[i] ?? 0;
    totalOIChange += oiChangeArr[i] ?? 0;
  }

  // Curves
  const spotPricesArr = spVals;
  const gammaCurveAll: number[] = chartData.curves.cust?.gamma?.all || [];
  const gammaCurveMonthly: number[] = chartData.curves.cust?.gamma?.monthly || [];
  const gammaCurveNextExp: number[] = chartData.curves.cust?.gamma?.next_exp || [];
  const deltaCurveAll: number[] = chartData.curves.cust?.delta?.all || [];
  const deltaCurveMonthly: number[] = chartData.curves.cust?.delta?.monthly || [];
  const deltaCurveNextExp: number[] = chartData.curves.cust?.delta?.next_exp || [];

  return {
    date,
    symbol,
    fetchedAt: new Date().toISOString(),
    spotPrice,
    zeroGamma,
    callWall,
    putWall,
    allBars,
    topBars,
    totalCallGamma,
    totalPutGamma,
    gammaRatio,
    regime,
    totalCallDelta, totalPutDelta, totalCallOI, totalPutOI, totalOIChange,
    deltaCurve: { all: deltaCurveAll, monthly: deltaCurveMonthly, nextExp: deltaCurveNextExp },
    gammaCurve: { all: gammaCurveAll, monthly: gammaCurveMonthly, nextExp: gammaCurveNextExp },
    spotPrices: spotPricesArr,
    zeroDteGamma: { calls: zeroDteCallTotal, puts: zeroDtePutTotal },
    monthlyGamma: { calls: monthlyCallTotal, puts: monthlyPutTotal },
  };
}

/** Download gamma bars for a date range */
export async function downloadGammaBarsRange(
  startDate: string,
  endDate: string,
  symbols: readonly string[] = SYMBOLS,
  onProgress?: (msg: string) => void
): Promise<{ downloaded: number; skipped: number; failed: number }> {
  const token = await getToken();
  if (!token) {
    onProgress?.("ERROR: No SpotGamma token available");
    return { downloaded: 0, skipped: 0, failed: 0 };
  }

  const days = getTradingDays(startDate, endDate);
  let downloaded = 0, skipped = 0, failed = 0;

  onProgress?.(`Starting download: ${days.length} trading days × ${symbols.length} symbols = ${days.length * symbols.length} requests`);

  for (const date of days) {
    const dayDir = path.join(BARS_DIR, date);
    ensureDir(dayDir);

    for (const sym of symbols) {
      const filePath = path.join(dayDir, `${sym}.json`);

      // Skip if already downloaded
      if (fs.existsSync(filePath)) {
        skipped++;
        continue;
      }

      const raw = await sgFetch(`/synth_oi/v1/chart_data?sym=${sym}&date=${date}`, token);

      if (!raw) {
        failed++;
        onProgress?.(`FAILED: ${date} ${sym}`);
        await sleep(500);
        continue;
      }

      const bars = extractGammaBars(date, sym, raw);
      if (bars) {
        fs.writeFileSync(filePath, JSON.stringify(bars, null, 2));
        downloaded++;
        onProgress?.(`OK: ${date} ${sym} — ${bars.allBars.length} bars, top=${bars.topBars[0]?.strike} (${bars.regime})`);
      } else {
        failed++;
        onProgress?.(`PARSE_FAIL: ${date} ${sym}`);
      }

      await sleep(400); // Rate limiting
    }
  }

  onProgress?.(`Done: ${downloaded} downloaded, ${skipped} skipped (already had), ${failed} failed`);
  return { downloaded, skipped, failed };
}

/** Quick download of last N trading days */
export async function downloadRecentGammaBars(days: number = 30): Promise<void> {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  await downloadGammaBarsRange(startDate, endDate, SYMBOLS, console.log);
}

/** Load saved gamma bars for a specific date and symbol */
export function loadGammaBars(date: string, symbol: string): DayGammaBars | null {
  const filePath = path.join(BARS_DIR, date, `${symbol}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DayGammaBars;
  } catch {
    return null;
  }
}

/** Load all symbols for a date */
export function loadDayBars(date: string): Record<string, DayGammaBars> {
  const result: Record<string, DayGammaBars> = {};
  for (const sym of SYMBOLS) {
    const bars = loadGammaBars(date, sym);
    if (bars) result[sym] = bars;
  }
  return result;
}

/** Get summary stats for backtesting */
export function getBarsSummary(): { dates: number; symbols: string[]; oldestDate: string; newestDate: string } {
  if (!fs.existsSync(BARS_DIR)) return { dates: 0, symbols: [], oldestDate: "", newestDate: "" };
  const dates = fs.readdirSync(BARS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return {
    dates: dates.length,
    symbols: [...SYMBOLS],
    oldestDate: dates[0] || "",
    newestDate: dates[dates.length - 1] || "",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EQUITIES HISTORICAL — IV, VRP, Skew, Levels, P/C ratio per day
// ══════════════════════════════════════════════════════════════════════════════

const EQUITIES_DIR = path.resolve(__dirname, "../data/historical/equities");
const EQUITIES_SYMS = ["SPX", "QQQ", "DIA", "GLD"] as const;

export interface DayEquities {
  date: string;
  symbol: string;
  price: number;
  // Levels
  callWall: number;
  putWall: number;
  keyGamma: number;
  maxStrike: number;
  // Volatility
  atmIV30: number;
  rv30: number;
  vrp: number;           // atmIV30 - rv30
  ivRank: number;
  skew: number;
  skewRank: number;
  // Flow aggregates
  putCallRatio: number;
  gammaRatio: number;
  deltaRatio: number;
  totalDelta: number;
  // Volume
  callVolume: number;
  putVolume: number;
  // Positioning
  activityFactor: number;
  positionFactor: number;
  putControl: number;
  // 0DTE
  nextExpCallGamma: number;
  nextExpPutGamma: number;
}

function extractEquities(date: string, symbol: string, raw: any): DayEquities | null {
  if (!raw) return null;
  return {
    date,
    symbol,
    price: raw.upx || 0,
    callWall: raw.cws || 0,
    putWall: raw.pws || 0,
    keyGamma: raw.keyg || 0,
    maxStrike: raw.maxfs || 0,
    atmIV30: raw.atm_iv30 || 0,
    rv30: raw.rv30 || 0,
    vrp: (raw.atm_iv30 || 0) - (raw.rv30 || 0),
    ivRank: raw.iv_rank || 0,
    skew: raw.skew || 0,
    skewRank: raw.skew_rank || 0,
    putCallRatio: raw.put_call_ratio || 0,
    gammaRatio: raw.gamma_ratio || 0,
    deltaRatio: raw.delta_ratio || 0,
    totalDelta: raw.totaldelta || 0,
    callVolume: raw.cv || 0,
    putVolume: raw.pv || 0,
    activityFactor: raw.activity_factor || 0,
    positionFactor: raw.position_factor || 0,
    putControl: raw.putctrl || 0,
    nextExpCallGamma: raw.next_exp_call_gamma || 0,
    nextExpPutGamma: raw.next_exp_put_gamma || 0,
  };
}

/** Download equities data for a date range */
export async function downloadEquitiesRange(
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void
): Promise<{ downloaded: number; skipped: number; failed: number }> {
  const token = await getToken();
  if (!token) { onProgress?.("ERROR: No token"); return { downloaded: 0, skipped: 0, failed: 0 }; }

  const days = getTradingDays(startDate, endDate);
  let downloaded = 0, skipped = 0, failed = 0;
  const symsParam = EQUITIES_SYMS.join(",");

  onProgress?.(`Equities download: ${days.length} days`);

  for (const date of days) {
    const dayDir = path.join(EQUITIES_DIR, date);
    ensureDir(dayDir);

    // Check if already done (all symbols)
    const allExist = EQUITIES_SYMS.every(s => fs.existsSync(path.join(dayDir, `${s}.json`)));
    if (allExist) { skipped += EQUITIES_SYMS.length; continue; }

    const raw = await sgFetch(`/v3/equitiesBySyms?syms=${symsParam}&date=${date}`, token);
    if (!raw) { failed += EQUITIES_SYMS.length; await sleep(500); continue; }

    for (const sym of EQUITIES_SYMS) {
      const filePath = path.join(dayDir, `${sym}.json`);
      if (fs.existsSync(filePath)) { skipped++; continue; }

      const eq = extractEquities(date, sym, raw[sym]);
      if (eq) {
        fs.writeFileSync(filePath, JSON.stringify(eq, null, 2));
        downloaded++;
      } else { failed++; }
    }

    onProgress?.(`EQ: ${date} — ${Object.keys(raw).length} symbols`);
    await sleep(300);
  }

  onProgress?.(`Equities done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
  return { downloaded, skipped, failed };
}

/** Load equities for a date */
export function loadDayEquities(date: string): Record<string, DayEquities> {
  const result: Record<string, DayEquities> = {};
  for (const sym of EQUITIES_SYMS) {
    const fp = path.join(EQUITIES_DIR, date, `${sym}.json`);
    if (fs.existsSync(fp)) {
      try { result[sym] = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch {}
    }
  }
  return result;
}
