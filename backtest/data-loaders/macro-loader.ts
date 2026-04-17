/**
 * Macro data loader — yahoo-prices/*.json
 * Provides daily close prices + rolling trends for VIX, DXY, TLT, TNX, etc.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const HIST = path.resolve(process.cwd(), "data/historical/yahoo-prices");

export interface DailyBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const cache = new Map<string, DailyBar[]>();

function loadSymbol(sym: string): DailyBar[] {
  if (cache.has(sym)) return cache.get(sym)!;
  const file = path.join(HIST, `${sym}.json`);
  if (!fs.existsSync(file)) {
    cache.set(sym, []);
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  parsed.sort((a: DailyBar, b: DailyBar) => a.date.localeCompare(b.date));
  cache.set(sym, parsed);
  return parsed;
}

function findOnOrBefore(bars: DailyBar[], date: string): DailyBar | null {
  // Binary search for last bar <= date
  if (bars.length === 0) return null;
  let lo = 0, hi = bars.length - 1;
  if (bars[lo].date > date) return null;
  if (bars[hi].date <= date) return bars[hi];
  while (lo < hi) {
    const m = Math.floor((lo + hi + 1) / 2);
    if (bars[m].date <= date) lo = m;
    else hi = m - 1;
  }
  return bars[lo];
}

function closeOn(sym: string, date: string): number | null {
  const b = findOnOrBefore(loadSymbol(sym), date);
  return b?.close ?? null;
}

function nDayAgo(sym: string, date: string, n: number): number | null {
  const bars = loadSymbol(sym);
  const idx = bars.findIndex((b) => b.date >= date);
  if (idx < n) return null;
  return bars[idx - n].close;
}

export interface MacroContext {
  vix: number | null;
  vixChange5d: number | null; // % change over 5 trading days
  dxy: number | null;
  dxyTrend: "up" | "down" | "flat";
  tlt: number | null;
  tltTrend: "up" | "down" | "flat";
  tnx: number | null; // 10-year yield
  vixRegime: "low" | "mid" | "high" | "extreme"; // <15 / 15-20 / 20-30 / >30
}

export function getMacroContext(date: string): MacroContext {
  const vix = closeOn("VIX", date);
  const vix5 = nDayAgo("VIX", date, 5);
  const dxy = closeOn("DXY", date);
  const dxy5 = nDayAgo("DXY", date, 5);
  const tlt = closeOn("TLT", date);
  const tlt5 = nDayAgo("TLT", date, 5);
  const tnx = closeOn("TNX_10Y", date);

  const vixChange5d = vix && vix5 ? ((vix - vix5) / vix5) * 100 : null;
  const dxyChange = dxy && dxy5 ? ((dxy - dxy5) / dxy5) * 100 : 0;
  const tltChange = tlt && tlt5 ? ((tlt - tlt5) / tlt5) * 100 : 0;

  const dxyTrend = dxyChange > 0.5 ? "up" : dxyChange < -0.5 ? "down" : "flat";
  const tltTrend = tltChange > 0.5 ? "up" : tltChange < -0.5 ? "down" : "flat";

  let vixRegime: MacroContext["vixRegime"] = "mid";
  if (!vix) vixRegime = "mid";
  else if (vix < 15) vixRegime = "low";
  else if (vix < 20) vixRegime = "mid";
  else if (vix < 30) vixRegime = "high";
  else vixRegime = "extreme";

  return { vix, vixChange5d, dxy, dxyTrend, tlt, tltTrend, tnx, vixRegime };
}

/** VIX-based expected range (from CLAUDE.md stats) */
export function expectedDailyRange(cfd: "NAS100" | "US30" | "XAUUSD", vix: number | null): number {
  const v = vix ?? 18;
  if (cfd === "NAS100") {
    if (v < 15) return 252;
    if (v < 20) return 360;
    if (v < 25) return 491;
    if (v < 30) return 662;
    return 1020;
  } else if (cfd === "US30") {
    if (v < 15) return 350;
    if (v < 20) return 500;
    if (v < 25) return 680;
    if (v < 30) return 900;
    return 1400;
  } else {
    if (v < 15) return 25;
    if (v < 20) return 35;
    if (v < 25) return 50;
    if (v < 30) return 70;
    return 100;
  }
}
