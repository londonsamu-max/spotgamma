/**
 * Yahoo Finance Historical Price Fetcher
 *
 * Fetches daily OHLCV data from Yahoo Finance (free, no API key).
 * Used to supplement SpotGamma GEX history with real price data.
 *
 * Symbols:
 *   ^GSPC  → SPX (S&P 500)
 *   ^NDX   → NAS100 (Nasdaq 100)
 *   ^DJI   → US30 (Dow Jones)
 *   GLD    → XAUUSD proxy (Gold ETF)
 *   QQQ    → QQQ ETF
 *   DIA    → DIA ETF
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_DIR = path.resolve(__dirname, "../data/historical/yahoo-prices");

// SpotGamma symbol → Yahoo Finance symbol
export const SG_TO_YAHOO: Record<string, string> = {
  SPX: "%5EGSPC",   // ^GSPC
  NAS100: "%5ENDX", // ^NDX
  US30: "%5EDJI",   // ^DJI
  XAUUSD: "GLD",
  QQQ: "QQQ",
  GLD: "GLD",
  DIA: "DIA",
};

// CFD target → Yahoo symbol
export const CFD_TO_YAHOO: Record<string, string> = {
  NAS100: "%5ENDX",
  US30: "%5EDJI",
  XAUUSD: "GLD",
};

export interface DayPrice {
  date: string;   // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number;
}

export interface YahooPriceCache {
  symbol: string;
  yahooSymbol: string;
  fetchedAt: string;
  prices: DayPrice[];  // sorted ascending by date
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cachePath(yahooSymbol: string): string {
  const safe = yahooSymbol.replace(/%5E/g, "^").replace(/[^a-zA-Z0-9^]/g, "_");
  return path.join(PRICE_DIR, `${safe}.json`);
}

/** Fetch historical daily prices from Yahoo Finance (up to 2 years) */
export async function fetchYahooPrices(yahooSymbol: string, forceRefresh = false): Promise<DayPrice[]> {
  ensureDir(PRICE_DIR);
  const filePath = cachePath(yahooSymbol);

  // Use cache if fresh (< 24 hours old)
  if (!forceRefresh && fs.existsSync(filePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(filePath, "utf-8")) as YahooPriceCache;
      const ageHours = (Date.now() - new Date(cache.fetchedAt).getTime()) / 3600000;
      if (ageHours < 24 && cache.prices.length > 0) {
        console.log(`[YAHOO] ${yahooSymbol}: ${cache.prices.length} cached prices (${ageHours.toFixed(1)}h old)`);
        return cache.prices;
      }
    } catch { /* re-fetch */ }
  }

  const urlSymbol = yahooSymbol; // already URL-encoded for ^
  const period1 = Math.floor(new Date("2023-01-01").getTime() / 1000); // 2 years back
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${urlSymbol}?interval=1d&period1=${period1}&period2=${period2}`;

  console.log(`[YAHOO] Fetching ${yahooSymbol}...`);

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (!resp.ok) {
      console.warn(`[YAHOO] ${yahooSymbol}: HTTP ${resp.status}`);
      return loadCacheOrEmpty(filePath);
    }

    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      console.warn(`[YAHOO] ${yahooSymbol}: no chart result`);
      return loadCacheOrEmpty(filePath);
    }

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const adjClose: number[] = result.indicators?.adjclose?.[0]?.adjclose || [];

    const prices: DayPrice[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quote.close?.[i];
      if (!close || isNaN(close)) continue;

      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      prices.push({
        date,
        open:     quote.open?.[i] ?? close,
        high:     quote.high?.[i] ?? close,
        low:      quote.low?.[i] ?? close,
        close,
        volume:   quote.volume?.[i] ?? 0,
        adjClose: adjClose[i] ?? close,
      });
    }

    // Sort ascending
    prices.sort((a, b) => a.date.localeCompare(b.date));

    const cache: YahooPriceCache = {
      symbol: yahooSymbol,
      yahooSymbol,
      fetchedAt: new Date().toISOString(),
      prices,
    };
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf-8");
    console.log(`[YAHOO] ${yahooSymbol}: ${prices.length} prices saved (${prices[0]?.date} → ${prices[prices.length - 1]?.date})`);
    return prices;

  } catch (e: any) {
    clearTimeout(tid);
    console.warn(`[YAHOO] ${yahooSymbol} error: ${e.message}`);
    return loadCacheOrEmpty(filePath);
  }
}

function loadCacheOrEmpty(filePath: string): DayPrice[] {
  try {
    if (fs.existsSync(filePath)) {
      const cache = JSON.parse(fs.readFileSync(filePath, "utf-8")) as YahooPriceCache;
      return cache.prices;
    }
  } catch { /* ignore */ }
  return [];
}

/** Build a date → close price map for quick lookup */
export function buildPriceMap(prices: DayPrice[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of prices) {
    map[p.date] = p.adjClose || p.close;
  }
  return map;
}

/** Fetch prices for all CFD targets — sequential with delay to avoid rate limits */
export async function fetchAllCFDPrices(): Promise<Record<string, Record<string, number>>> {
  const results: Record<string, Record<string, number>> = {};

  // All symbols to fetch: [key, yahooSymbol]
  const allEntries: [string, string][] = [
    ["NAS100", "%5ENDX"],
    ["US30",   "%5EDJI"],
    ["XAUUSD", "GLD"],
    ["SPX",    "%5EGSPC"],
    ["QQQ",    "QQQ"],
    ["GLD",    "GLD"],
    ["DIA",    "DIA"],
  ];

  for (const [key, yahoo] of allEntries) {
    const prices = await fetchYahooPrices(yahoo);
    results[key] = buildPriceMap(prices);
    // 1.5s between requests to avoid 429
    await new Promise(r => setTimeout(r, 1500));
  }

  return results;
}

/** Get status of cached Yahoo price data */
export function getYahooPriceStatus(): {
  symbols: string[];
  totalDays: Record<string, number>;
  dateRanges: Record<string, { oldest: string; newest: string }>;
} {
  ensureDir(PRICE_DIR);
  const files = fs.readdirSync(PRICE_DIR).filter(f => f.endsWith(".json"));
  const symbols: string[] = [];
  const totalDays: Record<string, number> = {};
  const dateRanges: Record<string, { oldest: string; newest: string }> = {};

  for (const file of files) {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(PRICE_DIR, file), "utf-8")) as YahooPriceCache;
      const sym = cache.symbol;
      symbols.push(sym);
      totalDays[sym] = cache.prices.length;
      if (cache.prices.length > 0) {
        dateRanges[sym] = {
          oldest: cache.prices[0].date,
          newest: cache.prices[cache.prices.length - 1].date,
        };
      }
    } catch { /* skip */ }
  }

  return { symbols, totalDays, dateRanges };
}
