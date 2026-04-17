/**
 * Historical Chart Data Fetcher — SpotGamma chart_data endpoint
 *
 * This endpoint works for ALL historical dates (tested back to 2024+).
 * Extracts: zero_gamma, call_wall, put_wall, key_gamma, gamma_regime
 * from the raw chart_data response.
 *
 * Training signal: use ZeroGamma(day N+1) - ZeroGamma(day N) as price proxy.
 * Positive delta → market moved up. Negative → market moved down.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getToken } from "./spotgamma-scraper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_DATA_DIR = path.resolve(__dirname, "../data/historical/chart-data");
const API_BASE = "https://api.spotgamma.com";

// Symbols to download (maps to CFD targets)
const SYMBOLS = ["SPX", "QQQ", "GLD", "DIA"] as const;
type Symbol = typeof SYMBOLS[number];

// CFD mapping
const SYM_TO_CFD: Record<string, string> = {
  SPX: "NAS100",  // primary US equity → NAS100
  QQQ: "NAS100",
  DIA: "US30",
  GLD: "XAUUSD",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DayGEXSnapshot {
  date: string;           // YYYY-MM-DD
  symbol: string;
  fetchedAt: string;

  // Key levels (0 = not found)
  zeroGamma: number;      // gamma flip level
  callWall: number;       // strike with highest call gamma
  putWall: number;        // strike with highest put gamma
  keyGamma: number;       // strike with highest total |gamma|

  // Gamma regime
  totalCallGamma: number;
  totalPutGamma: number;
  gammaRatio: number;     // callGamma / (callGamma + putGamma), >0.5 = net positive

  // Top 5 gamma strikes near zero_gamma
  topStrikes: Array<{
    strike: number;
    callGamma: number;
    putGamma: number;
    totalGamma: number;
  }>;

  // Price range coverage in chart
  priceRangeMin: number;
  priceRangeMax: number;
  priceRangeMid: number;  // midpoint ≈ approximate closing price
}

export interface DayGEXDir {
  date: string;
  symbol: string;
  cfd: string;
  zeroGamma: number;
  nextZeroGamma: number;  // zeroGamma of next trading day
  zgDelta: number;        // nextZeroGamma - zeroGamma → price movement proxy
  gammaRatio: number;     // >0.5 = positive regime (dealers long gamma)
  direction: "up" | "down" | "flat";  // inferred from zgDelta
  callWallDist: number;   // zeroGamma - callWall (negative if CW above ZG)
  putWallDist: number;    // zeroGamma - putWall (positive if PW below ZG)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function sgFetch(urlPath: string, token: string, timeoutMs = 20000): Promise<any> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e: any) {
    clearTimeout(tid);
    return null;
  }
}

/** Get trading days between startDate and endDate (inclusive), excluding weekends */
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

// ── Core extraction from chart_data ──────────────────────────────────────────

function extractGEXSnapshot(date: string, symbol: string, chartData: any): DayGEXSnapshot | null {
  if (!chartData?.bars || !chartData?.curves) return null;

  const strikes: number[] = chartData.bars.strikes || [];
  const barGammaCalls: number[] = chartData.bars.cust?.gamma?.all?.calls || [];
  const barGammaPuts: number[] = chartData.bars.cust?.gamma?.all?.puts || [];

  if (strikes.length === 0) return null;

  // ── Price range from spot_prices ─────────────────────────────────────────
  const spObj: Record<string, number> = chartData.curves.spot_prices || {};
  const spVals = Object.values(spObj) as number[];
  spVals.sort((a, b) => a - b);
  const priceRangeMin = spVals[0] ?? 0;
  const priceRangeMax = spVals[spVals.length - 1] ?? 0;
  const priceRangeMid = priceRangeMin > 0 ? (priceRangeMin + priceRangeMax) / 2 : 0;

  // ── Zero Gamma (gamma flip) from curve ───────────────────────────────────
  const curveGamma: number[] = chartData.curves.cust?.gamma?.all || [];
  let zeroGamma = 0;
  for (let i = 1; i < spVals.length && i < curveGamma.length; i++) {
    if (curveGamma[i - 1] < 0 && curveGamma[i] >= 0) {
      zeroGamma = spVals[i];
      break;
    }
    if (curveGamma[i - 1] >= 0 && curveGamma[i] < 0) {
      // Flipped to negative — use first crossing
      if (zeroGamma === 0) zeroGamma = spVals[i];
    }
  }

  // ── Gamma per strike ──────────────────────────────────────────────────────
  interface StrikeGamma { strike: number; call: number; put: number; total: number }
  const strikeData: StrikeGamma[] = [];
  let totalCallGamma = 0;
  let totalPutGamma = 0;

  for (let i = 0; i < strikes.length; i++) {
    const call = Math.abs(barGammaCalls[i] ?? 0);
    const put = Math.abs(barGammaPuts[i] ?? 0);
    strikeData.push({ strike: strikes[i], call, put, total: call + put });
    totalCallGamma += call;
    totalPutGamma += put;
  }

  // ── Key levels ────────────────────────────────────────────────────────────
  const byCallGamma = [...strikeData].sort((a, b) => b.call - a.call);
  const byPutGamma  = [...strikeData].sort((a, b) => b.put - a.put);
  const byTotal     = [...strikeData].sort((a, b) => b.total - a.total);

  const callWall = byCallGamma[0]?.strike ?? 0;
  const putWall  = byPutGamma[0]?.strike ?? 0;
  const keyGamma = byTotal[0]?.strike ?? 0;

  // Top 5 by total gamma near zero_gamma (or top 5 overall)
  const refPrice = zeroGamma || priceRangeMid;
  const sorted = [...strikeData]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(s => ({ strike: s.strike, callGamma: s.call, putGamma: s.put, totalGamma: s.total }));

  const gammaRatio = (totalCallGamma + totalPutGamma) > 0
    ? totalCallGamma / (totalCallGamma + totalPutGamma)
    : 0.5;

  return {
    date,
    symbol,
    fetchedAt: new Date().toISOString(),
    zeroGamma,
    callWall,
    putWall,
    keyGamma,
    totalCallGamma,
    totalPutGamma,
    gammaRatio,
    topStrikes: sorted,
    priceRangeMin,
    priceRangeMax,
    priceRangeMid,
  };
}

// ── Fetch and store single day ────────────────────────────────────────────────

async function fetchDayGEX(date: string, symbol: string, token: string): Promise<DayGEXSnapshot | null> {
  const dir = path.join(CHART_DATA_DIR, date);
  const filePath = path.join(dir, `${symbol}.json`);

  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DayGEXSnapshot;
    } catch { /* re-fetch */ }
  }

  const chartData = await sgFetch(`/synth_oi/v1/chart_data?sym=${symbol}&date=${date}`, token);
  if (!chartData) return null;

  const snapshot = extractGEXSnapshot(date, symbol, chartData);
  if (!snapshot) return null;

  ensureDir(dir);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  return snapshot;
}

// ── Bulk download ─────────────────────────────────────────────────────────────

export interface BulkFetchResult {
  startedAt: string;
  completedAt: string;
  startDate: string;
  endDate: string;
  daysAttempted: number;
  daysSucceeded: number;
  symbolsSucceeded: Record<string, number>;
  errors: string[];
}

export async function downloadChartDataRange(
  startDate: string,
  endDate: string,
  symbols: readonly string[] = SYMBOLS,
): Promise<BulkFetchResult> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const symbolsSucceeded: Record<string, number> = {};
  let daysSucceeded = 0;

  const token = await getToken();
  if (!token) {
    return { startedAt, completedAt: new Date().toISOString(), startDate, endDate, daysAttempted: 0, daysSucceeded: 0, symbolsSucceeded, errors: ["No auth token"] };
  }

  ensureDir(CHART_DATA_DIR);
  const days = getTradingDays(startDate, endDate);
  console.log(`[CHART-HIST] Downloading ${days.length} trading days (${startDate} → ${endDate}) for ${symbols.join(",")}`);

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    let dayOk = false;

    for (const sym of symbols) {
      try {
        const snap = await fetchDayGEX(date, sym, token);
        if (snap) {
          symbolsSucceeded[sym] = (symbolsSucceeded[sym] ?? 0) + 1;
          dayOk = true;
        }
      } catch (e: any) {
        errors.push(`${date}/${sym}: ${e.message}`);
      }
      await sleep(300); // rate limit between symbol calls
    }

    if (dayOk) daysSucceeded++;

    if (i % 20 === 0) {
      console.log(`[CHART-HIST] Progress: ${i + 1}/${days.length} days — ${date}`);
    }
    await sleep(500); // rate limit between days
  }

  const completedAt = new Date().toISOString();
  console.log(`[CHART-HIST] Done — ${daysSucceeded}/${days.length} days, errors=${errors.length}`);

  return { startedAt, completedAt, startDate, endDate, daysAttempted: days.length, daysSucceeded, symbolsSucceeded, errors };
}

// ── Load and process for RL training ─────────────────────────────────────────

/**
 * Load all downloaded chart snapshots and compute day-over-day direction signal.
 * Uses ZeroGamma delta as price movement proxy (no external price source needed).
 */
export function loadGEXDirectionDataset(): DayGEXDir[] {
  if (!fs.existsSync(CHART_DATA_DIR)) return [];

  // Load all dates and symbols
  const bySymDate: Record<string, Record<string, DayGEXSnapshot>> = {};

  try {
    const dates = fs.readdirSync(CHART_DATA_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const date of dates) {
      const dateDir = path.join(CHART_DATA_DIR, date);
      for (const sym of SYMBOLS) {
        const f = path.join(dateDir, `${sym}.json`);
        if (!fs.existsSync(f)) continue;
        try {
          const snap = JSON.parse(fs.readFileSync(f, "utf-8")) as DayGEXSnapshot;
          if (!bySymDate[sym]) bySymDate[sym] = {};
          bySymDate[sym][date] = snap;
        } catch { /* skip */ }
      }
    }
  } catch { return []; }

  const dataset: DayGEXDir[] = [];

  for (const sym of SYMBOLS) {
    const cfd = SYM_TO_CFD[sym] ?? "NAS100";
    const symData = bySymDate[sym] ?? {};
    const dates = Object.keys(symData).sort();

    for (let i = 0; i < dates.length - 1; i++) {
      const date = dates[i];
      const nextDate = dates[i + 1];
      const snap = symData[date];
      const nextSnap = symData[nextDate];

      if (!snap.zeroGamma || !nextSnap.zeroGamma) continue;

      const zgDelta = nextSnap.zeroGamma - snap.zeroGamma;
      const absDelta = Math.abs(zgDelta);

      // Only use days with meaningful ZG movement (filter noise)
      const direction: "up" | "down" | "flat" =
        absDelta < 2 ? "flat" :
        zgDelta > 0 ? "up" : "down";

      dataset.push({
        date,
        symbol: sym,
        cfd,
        zeroGamma: snap.zeroGamma,
        nextZeroGamma: nextSnap.zeroGamma,
        zgDelta,
        gammaRatio: snap.gammaRatio,
        direction,
        callWallDist: snap.callWall - snap.zeroGamma,
        putWallDist: snap.zeroGamma - snap.putWall,
      });
    }
  }

  return dataset;
}

// ── Status ────────────────────────────────────────────────────────────────────

export function getChartDataStatus(): {
  totalDays: number;
  oldestDate: string;
  newestDate: string;
  symbolCoverage: Record<string, number>;
  totalSizeMB: number;
} {
  const symbolCoverage: Record<string, number> = {};
  let totalSize = 0;
  const dates: string[] = [];

  if (!fs.existsSync(CHART_DATA_DIR)) {
    return { totalDays: 0, oldestDate: "-", newestDate: "-", symbolCoverage, totalSizeMB: 0 };
  }

  try {
    const dirs = fs.readdirSync(CHART_DATA_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const date of dirs) {
      const dateDir = path.join(CHART_DATA_DIR, date);
      let dateHasData = false;
      for (const sym of SYMBOLS) {
        const f = path.join(dateDir, `${sym}.json`);
        if (fs.existsSync(f)) {
          const size = fs.statSync(f).size;
          totalSize += size;
          symbolCoverage[sym] = (symbolCoverage[sym] ?? 0) + 1;
          dateHasData = true;
        }
      }
      if (dateHasData) dates.push(date);
    }
  } catch { /* ignore */ }

  return {
    totalDays: dates.length,
    oldestDate: dates[0] ?? "-",
    newestDate: dates[dates.length - 1] ?? "-",
    symbolCoverage,
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
  };
}
