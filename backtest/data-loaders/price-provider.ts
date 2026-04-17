import * as fs from "node:fs";
import * as path from "node:path";
import type { OHLCBar, MT5Candle, CFD } from "../utils/types.js";

const HIST = path.resolve(process.cwd(), "data/historical");

/** Loads 1-min OHLC for a specific ETF/index symbol on a specific date. */
export function loadOhlc1Min(symbol: string, date: string): OHLCBar[] {
  const file = path.join(HIST, "ohlc-1min", symbol, `${date}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf-8");
    if (raw.length < 10) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sort ascending by timestamp
    parsed.sort((a: OHLCBar, b: OHLCBar) => a.t - b.t);
    return parsed;
  } catch {
    return [];
  }
}

/** Cached MT5 candles per CFD/timeframe */
const mt5Cache = new Map<string, MT5Candle[]>();

function loadMt5Raw(cfd: CFD, tf: "M15" | "H1" | "D1"): MT5Candle[] {
  const key = `${cfd}_${tf}`;
  if (mt5Cache.has(key)) return mt5Cache.get(key)!;
  const file = path.join(HIST, "mt5-candles", `${key}.json`);
  if (!fs.existsSync(file)) {
    mt5Cache.set(key, []);
    return [];
  }
  const parsed: MT5Candle[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  // Parse "2024.01.02 01:00" into unix ms (assumed UTC)
  for (const c of parsed) {
    const [d, tt] = c.datetime.split(" ");
    const [Y, Mo, D] = d.split(".").map(Number);
    const [H, Mi] = tt.split(":").map(Number);
    c.t = Date.UTC(Y, Mo - 1, D, H, Mi);
  }
  parsed.sort((a, b) => a.t! - b.t!);
  mt5Cache.set(key, parsed);
  return parsed;
}

/** Get all MT5 candles for a specific date */
export function loadMt5Day(cfd: CFD, date: string, tf: "M15" | "H1" | "D1" = "M15"): MT5Candle[] {
  const all = loadMt5Raw(cfd, tf);
  const [Y, Mo, D] = date.split("-").map(Number);
  const start = Date.UTC(Y, Mo - 1, D, 0, 0);
  const end = Date.UTC(Y, Mo - 1, D, 23, 59);
  return all.filter((c) => c.t! >= start && c.t! <= end);
}

/** Get MT5 price at a specific timestamp — uses last candle at or before ts */
export function priceAt(cfd: CFD, ts: number, tf: "M15" | "H1" | "D1" = "M15"): number | null {
  const all = loadMt5Raw(cfd, tf);
  if (all.length === 0) return null;
  // Binary search for the last candle <= ts
  let lo = 0, hi = all.length - 1;
  if (all[lo].t! > ts) return null;
  if (all[hi].t! <= ts) return all[hi].close;
  while (lo < hi) {
    const m = Math.floor((lo + hi + 1) / 2);
    if (all[m].t! <= ts) lo = m;
    else hi = m - 1;
  }
  return all[lo].close;
}

/** Find list of dates where a symbol has OHLC 1-min data (non-empty) */
export function listOhlcDates(symbol: string): string[] {
  const dir = path.join(HIST, "ohlc-1min", symbol);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .filter((date) => {
      const sz = fs.statSync(path.join(dir, `${date}.json`)).size;
      return sz > 50;
    });
}
