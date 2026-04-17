/**
 * Historical Data Fetcher for SpotGamma Backtesting
 * Fetches historical GEX, HIRO, and Tape data for past trading days.
 */

import * as fs from "fs";
import * as path from "path";
import { apiCall, streamApiCall, parseTapeFlowItem } from "./spotgamma-scraper";

// ============ PATHS ============

const DATA_DIR = path.join(process.cwd(), "data", "historical");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ============ TYPES ============

export interface HistoricalAsset {
  symbol: string;
  price: number;           // upx = settlement price used in GEX calculations
  callWall: number;        // from equitiesData cws
  putWall: number;         // from equitiesData pws
  keyGamma: number;        // from equitiesData keyg
  volTrigger: number;      // from equitiesData keyd
  maxGamma: number;        // from equitiesData maxfs
  zeroGamma: number;       // gamma flip level from synth_oi chart_data
  impliedMove: number;     // options_implied_move
  impliedMovePct: number;  // implied move as % of price
  ivRank: number;          // derived from atm_iv30
  vrp: number;             // atm_iv30 - rv30
  callGammaTotal: number;  // callsum
  putGammaTotal: number;   // putsum
  topStrikes: Array<{
    strike: number;
    callGamma: number;
    putGamma: number;
    totalGamma: number;
    isOutlier: boolean;
    levelType?: string;
  }>;
}

export interface HistoricalDayData {
  date: string;            // "YYYY-MM-DD"
  fetchedAt: string;       // ISO timestamp
  assets: {
    SPX?: HistoricalAsset;
    QQQ?: HistoricalAsset;
    GLD?: HistoricalAsset;
    DIA?: HistoricalAsset;
  };
  tape?: {                 // null if historical tape not available
    dominantFlow: "calls" | "puts" | "neutral";
    bullishPremium: number;
    bearishPremium: number;
    topTrades: Array<{
      symbol: string;
      premium: number;
      strike: number;
      callPut: "CALL" | "PUT";
      signal: "bullish" | "bearish" | "neutral";
      time: string;
    }>;
  };
  hiroAvailable?: boolean;
  hiroValue?: number;
  hiroTrend?: "bullish" | "bearish" | "neutral";
  // Prices from SpotGamma upx (settlement) — used for backtesting comparison
  // upx of day N vs upx of day N+1 = next-day close-to-close move
  sgPrices?: Record<string, number>;  // { SPX: 5800, QQQ: 480, GLD: 300, DIA: 420 }
}

export interface BacktestOptions {
  minScore?: number;
  cfd?: string;
}

export interface BacktestDayResult {
  date: string;
  setupDirection?: "LONG" | "SHORT";
  cfd?: string;
  score?: number;
  callWall?: number;
  putWall?: number;
  keyGamma?: number;
  spxPrice?: number;         // SpotGamma upx settlement price
  tapeFlow?: string;
  hiroTrend?: string;
  outcome?: "win" | "loss" | "unknown";
  priceMove?: number;        // % move day N → day N+1 (SpotGamma upx)
  note?: string;
}

export interface BacktestResult {
  totalDays: number;
  daysWithSetups: number;
  wins: number;
  losses: number;
  unknowns: number;
  winRate: number;
  results: BacktestDayResult[];
  byCfd: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byScoreRange: Record<string, { total: number; wins: number; winRate: number }>;
}

// ============ HELPERS ============

interface EquitiesResponseItem {
  trade_date: string;
  sym: string;
  upx: number;
  callsum: number;
  putsum: number;
  cws: number;
  pws: number;
  keyg: number;
  maxfs: number;
  minfs: number;
  keyd: number;
  options_implied_move: number;
  atm_iv30: number;
  rv30: number;
  [key: string]: any;
}

interface ChartDataResponse {
  sym: string;
  bars: {
    strikes: number[];
    cust: {
      gamma: {
        all: { puts: number[]; calls: number[] };
      };
    };
  };
  curves: {
    cust: {
      gamma: { all: number[] };
    };
    spot_prices: Record<string, number>;
  };
}

function detectOutliers(values: number[]): { mean: number; stdDev: number; threshold: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0, threshold: 0 };
  const absVals = values.map(v => Math.abs(v));
  const mean = absVals.reduce((a, b) => a + b, 0) / absVals.length;
  const variance = absVals.reduce((a, b) => a + (b - mean) ** 2, 0) / absVals.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev, threshold: mean + stdDev * 1.5 };
}

function extractTopStrikes(chartData: ChartDataResponse, price: number, symbol: string): HistoricalAsset["topStrikes"] {
  const nearRange: Record<string, number> = { SPX: 200, QQQ: 10, GLD: 10, DIA: 10, SPY: 10 };
  const range = nearRange[symbol] || 10;

  const strikes = chartData.bars?.strikes || [];
  const barGammaObj = chartData.bars?.cust?.gamma?.all as any;
  const barGammaPuts: number[] = barGammaObj?.puts || [];
  const barGammaCalls: number[] = barGammaObj?.calls || [];

  // Build near-price strikes
  const near: { strike: number; callGamma: number; putGamma: number; totalGamma: number }[] = [];
  const nearGammaVals: number[] = [];

  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i];
    const dist = Math.abs(strike - price);
    if (dist > range) continue;
    const callGamma = barGammaCalls[i] || 0;
    const putGamma = barGammaPuts[i] || 0;
    const totalGamma = callGamma + putGamma;
    near.push({ strike, callGamma, putGamma, totalGamma });
    nearGammaVals.push(totalGamma);
  }

  const outlierStats = detectOutliers(nearGammaVals);

  return near
    .sort((a, b) => Math.abs(b.totalGamma) - Math.abs(a.totalGamma))
    .slice(0, 10)
    .map(s => {
      const absG = Math.abs(s.totalGamma);
      const isOutlier = outlierStats.stdDev > 0 && absG > outlierStats.threshold;
      const score = outlierStats.stdDev > 0 ? (absG - outlierStats.mean) / outlierStats.stdDev : 0;
      let levelType = "Gamma";
      if (isOutlier && score > 3) levelType = "MEGA Gamma";
      else if (isOutlier && score > 2) levelType = "High Gamma";
      else if (isOutlier) levelType = "Outlier Gamma";
      return { strike: s.strike, callGamma: s.callGamma, putGamma: s.putGamma, totalGamma: s.totalGamma, isOutlier, levelType };
    });
}

function findGammaFlip(chartData: ChartDataResponse): number {
  const sp = chartData.curves?.spot_prices || {};
  const curveStrikes: number[] = [];
  const numKeys = Object.keys(sp).length;
  for (let i = 0; i < numKeys; i++) {
    if (sp[String(i)] !== undefined) curveStrikes.push(sp[String(i)]);
  }
  const curveGamma = chartData.curves?.cust?.gamma?.all || [];
  for (let i = 1; i < curveStrikes.length; i++) {
    if (curveGamma[i - 1] < 0 && curveGamma[i] >= 0) return curveStrikes[i];
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============ TAPE FILTER EXPLORATION ============

export async function exploreTapeFilters(date: string): Promise<Record<string, any>> {
  const results: Record<string, any> = {};

  // Compute timestamp for midnight ET on the given date (ET = UTC-5 or UTC-4)
  const tsDate = new Date(`${date}T14:30:00.000Z`); // 9:30 AM ET as UTC
  const tsMs = tsDate.getTime();
  const tsEnd = tsMs + 6.5 * 60 * 60 * 1000; // 4:00 PM ET

  const filterSets: Array<{ name: string; filters: any[] }> = [
    {
      name: "underlying_only",
      filters: [{ field: "underlying", operator: "isAnyOf", value: ["SPX"] }],
    },
    {
      name: "ts_gte",
      filters: [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "ts", operator: "gte", value: tsMs },
      ],
    },
    {
      name: "ts_range",
      filters: [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "ts", operator: "gte", value: tsMs },
        { field: "ts", operator: "lte", value: tsEnd },
      ],
    },
    {
      name: "date_eq",
      filters: [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "date", operator: "eq", value: date },
      ],
    },
    {
      name: "date_gte",
      filters: [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "date", operator: "gte", value: date },
      ],
    },
  ];

  for (const { name, filters } of filterSets) {
    try {
      const encoded = encodeURIComponent(JSON.stringify(filters));
      const rawData = await streamApiCall<any[]>(
        `/sg/tns_feed?filters=${encoded}&limit=50`,
        10000,
        true
      );
      if (rawData && Array.isArray(rawData) && rawData.length > 0) {
        // Sample the first item timestamps to see if date filtering worked
        const parsed = rawData.map(parseTapeFlowItem).filter(Boolean);
        const firstTs = parsed[0]?.time || "N/A";
        const lastTs = parsed[parsed.length - 1]?.time || "N/A";
        results[name] = {
          success: true,
          count: rawData.length,
          parsedCount: parsed.length,
          firstTime: firstTs,
          lastTime: lastTs,
          filters,
        };
      } else {
        results[name] = { success: false, empty: true, filters };
      }
    } catch (e: any) {
      results[name] = { success: false, error: e.message, filters };
    }
    await sleep(500);
  }

  return results;
}

// ============ FETCH SINGLE DAY ============

export async function fetchHistoricalDay(date: string): Promise<HistoricalDayData | null> {
  ensureDataDir();

  const filePath = path.join(DATA_DIR, `${date}.json`);
  if (fs.existsSync(filePath)) {
    console.log(`[HIST] ${date} already exists, skipping`);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as HistoricalDayData;
    } catch {
      return null;
    }
  }

  console.log(`[HIST] Fetching historical data for ${date}...`);

  const result: HistoricalDayData = {
    date,
    fetchedAt: new Date().toISOString(),
    assets: {},
  };

  // ── 1. Equities Summary ──────────────────────────────────────
  const syms = "SPX,SPY,QQQ,GLD,DIA,VIX";
  const equitiesData = await apiCall<Record<string, EquitiesResponseItem>>(
    `/v3/equitiesBySyms?syms=${syms}&date=${date}`,
    15000,
    1
  );

  if (!equitiesData) {
    console.log(`[HIST] ${date}: equities fetch failed`);
    return null;
  }

  // ── 2. Chart data (gamma bars) per asset ────────────────────
  const targetSymbols: Array<keyof HistoricalDayData["assets"]> = ["SPX", "QQQ", "GLD", "DIA"];

  for (const sym of targetSymbols) {
    const eq = equitiesData[sym];
    if (!eq) {
      console.log(`[HIST] ${date}: no equities data for ${sym}`);
      continue;
    }

    const price = eq.upx || 0;
    const impliedMove = eq.options_implied_move || 0;
    const impliedMovePct = price > 0 ? (impliedMove / price) * 100 : 0;
    const atm_iv30 = eq.atm_iv30 || 0;
    const rv30 = eq.rv30 || 0;

    // Fetch chart data for gamma bars
    let topStrikes: HistoricalAsset["topStrikes"] = [];
    let zeroGamma = 0;

    try {
      const chartData = await apiCall<ChartDataResponse>(
        `/synth_oi/v1/chart_data?sym=${sym}&date=${date}`,
        15000,
        1
      );
      if (chartData) {
        topStrikes = extractTopStrikes(chartData, price, sym);
        zeroGamma = findGammaFlip(chartData);
      }
    } catch (e: any) {
      console.log(`[HIST] ${date} ${sym}: chart_data failed: ${e.message}`);
    }

    await sleep(300);

    result.assets[sym] = {
      symbol: sym,
      price,
      callWall: eq.cws || 0,
      putWall: eq.pws || 0,
      keyGamma: eq.keyg || 0,
      volTrigger: eq.keyd || 0,
      maxGamma: eq.maxfs || 0,
      zeroGamma,
      impliedMove,
      impliedMovePct,
      ivRank: atm_iv30,
      vrp: atm_iv30 - rv30,
      callGammaTotal: eq.callsum || 0,
      putGammaTotal: eq.putsum || 0,
      topStrikes,
    };
  }

  // ── 3. HIRO historical ──────────────────────────────────────
  try {
    const hiroData = await apiCall<any>(`/v1/hiro?sym=SPX&date=${date}`, 10000, 0);
    if (hiroData) {
      result.hiroAvailable = true;
      // Try to extract HIRO value from response
      if (Array.isArray(hiroData) && hiroData.length > 0) {
        const item = hiroData[0];
        result.hiroValue = item.currentDaySignal ?? item.hiro_value ?? item.value ?? item.hiro ?? 0;
      } else if (typeof hiroData === "object") {
        result.hiroValue = hiroData.currentDaySignal ?? hiroData.hiro_value ?? hiroData.value ?? 0;
      }
      const hv = result.hiroValue || 0;
      result.hiroTrend = hv > 0.1 ? "bullish" : hv < -0.1 ? "bearish" : "neutral";
    } else {
      result.hiroAvailable = false;
    }
  } catch (e: any) {
    console.log(`[HIST] ${date}: HIRO fetch failed: ${e.message}`);
    result.hiroAvailable = false;
  }

  // ── 4. Tape with date filter ─────────────────────────────────
  try {
    const tsDate = new Date(`${date}T14:30:00.000Z`);
    const tsMs = tsDate.getTime();
    const tsEnd = tsMs + 6.5 * 60 * 60 * 1000;

    // Try ts-based filter first, then date-based
    const filterOptions = [
      [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "ts", operator: "gte", value: tsMs },
        { field: "ts", operator: "lte", value: tsEnd },
      ],
      [
        { field: "underlying", operator: "isAnyOf", value: ["SPX"] },
        { field: "date", operator: "eq", value: date },
      ],
    ];

    let tapeData: any[] | null = null;
    for (const filters of filterOptions) {
      const encoded = encodeURIComponent(JSON.stringify(filters));
      const raw = await streamApiCall<any[]>(
        `/sg/tns_feed?filters=${encoded}&limit=200`,
        10000,
        true
      );
      if (raw && Array.isArray(raw) && raw.length > 0) {
        tapeData = raw;
        break;
      }
      await sleep(300);
    }

    if (tapeData && tapeData.length > 0) {
      const trades = tapeData.map(parseTapeFlowItem).filter((t): t is NonNullable<ReturnType<typeof parseTapeFlowItem>> => t !== null);
      const calls = trades.filter(t => t.callPut === "CALL");
      const puts = trades.filter(t => t.callPut === "PUT");
      const callPremium = calls.reduce((s, t) => s + t.premium, 0);
      const putPremium = puts.reduce((s, t) => s + t.premium, 0);
      const dominantFlow: "calls" | "puts" | "neutral" =
        callPremium > putPremium * 1.3 ? "calls" :
        putPremium > callPremium * 1.3 ? "puts" : "neutral";

      const topTrades = [...trades]
        .sort((a, b) => b.premium - a.premium)
        .slice(0, 10)
        .map(t => ({
          symbol: t.symbol,
          premium: t.premium,
          strike: t.strike,
          callPut: t.callPut as "CALL" | "PUT",
          signal: t.signal,
          time: t.time,
        }));

      result.tape = {
        dominantFlow,
        bullishPremium: callPremium,
        bearishPremium: putPremium,
        topTrades,
      };
    }
  } catch (e: any) {
    console.log(`[HIST] ${date}: Tape fetch failed: ${e.message}`);
  }

  // ── 5. SpotGamma settlement prices (upx) for backtesting ────
  // upx = settlement price used by SpotGamma for GEX calculations = closing price
  result.sgPrices = {};
  for (const sym of ["SPX", "QQQ", "GLD", "DIA", "VIX"] as const) {
    const eq = equitiesData[sym];
    if (eq?.upx && eq.upx > 0) result.sgPrices[sym] = eq.upx;
  }

  // ── 6. Save to disk ─────────────────────────────────────────
  try {
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`[HIST] ${date}: saved — SPX=${result.sgPrices.SPX?.toFixed(0)}, QQQ=${result.sgPrices.QQQ?.toFixed(1)}, GLD=${result.sgPrices.GLD?.toFixed(1)}`);
  } catch (e: any) {
    console.log(`[HIST] ${date}: failed to save: ${e.message}`);
  }

  return result;
}

// ============ FETCH RANGE ============

export async function fetchHistoricalRange(startDate: string, endDate: string): Promise<void> {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const dates: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    // Skip weekends
    if (day !== 0 && day !== 6) {
      dates.push(cur.toISOString().split("T")[0]);
    }
    cur.setDate(cur.getDate() + 1);
  }

  console.log(`[HIST] Fetching ${dates.length} trading days from ${startDate} to ${endDate}`);

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`[HIST] Progress: ${i + 1}/${dates.length} — ${date}`);
    try {
      await fetchHistoricalDay(date);
    } catch (e: any) {
      console.log(`[HIST] ${date}: error: ${e.message}`);
    }
    // Rate limit: 2 seconds between requests
    if (i < dates.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`[HIST] Done fetching ${dates.length} days`);
}

// ============ LOAD HISTORICAL DATA ============

export function loadHistoricalData(): HistoricalDayData[] {
  ensureDataDir();
  const results: HistoricalDayData[] = [];
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
        const data = JSON.parse(raw) as HistoricalDayData;
        results.push(data);
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // directory not readable
  }
  return results;
}

// ============ BACKTEST ============
// Uses SpotGamma upx settlement prices exclusively.
// Logic: signal generated on day N close (upx_N) → compare vs day N+1 close (upx_N+1).
// CFD mapping: SPX/QQQ → NAS100, DIA → US30, GLD → XAUUSD (GLD × ~10).

const GLD_TO_XAUUSD = 9.95; // approximate GLD ETF → XAUUSD CFD multiplier

function getCFDPrice(day: HistoricalDayData, cfd: string): number {
  if (cfd === "NAS100") return day.sgPrices?.["QQQ"] ? day.sgPrices["QQQ"] * 5 : (day.assets.SPX?.price || 0);
  if (cfd === "US30")   return day.sgPrices?.["DIA"]  ? day.sgPrices["DIA"]  * 100 : 0;
  if (cfd === "XAUUSD") return day.sgPrices?.["GLD"]  ? day.sgPrices["GLD"]  * GLD_TO_XAUUSD : 0;
  return day.sgPrices?.["SPX"] || day.assets.SPX?.price || 0;
}

export function runBacktest(options: BacktestOptions = {}): BacktestResult {
  const { minScore = 0, cfd } = options;
  const allDays = loadHistoricalData().sort((a, b) => a.date.localeCompare(b.date));

  // Build date → next-day index map
  const dayByDate = new Map<string, HistoricalDayData>();
  for (const d of allDays) dayByDate.set(d.date, d);

  const results: BacktestDayResult[] = [];
  const byCfd: Record<string, { total: number; wins: number; losses: number; winRate: number }> = {};
  const byScoreRange: Record<string, { total: number; wins: number; winRate: number }> = {
    "90-100": { total: 0, wins: 0, winRate: 0 },
    "75-89":  { total: 0, wins: 0, winRate: 0 },
    "60-74":  { total: 0, wins: 0, winRate: 0 },
    "0-59":   { total: 0, wins: 0, winRate: 0 },
  };

  let totalWins = 0, totalLosses = 0, totalUnknowns = 0, daysWithSetups = 0;

  for (let i = 0; i < allDays.length; i++) {
    const day = allDays[i];
    const nextDay = allDays[i + 1]; // next trading day in dataset
    const spx = day.assets.SPX;
    if (!spx) continue;

    // ── Derive directional bias from SpotGamma structure ─────────
    let direction: "LONG" | "SHORT" | undefined;
    let setupScore = 0;
    let note = "";

    const spxPrice = spx.price;           // SpotGamma upx (settlement)
    const zeroGamma = spx.zeroGamma;      // Gamma flip from chart curves
    const keyGamma  = spx.keyGamma;       // Key Gamma official level
    const callWall  = spx.callWall;
    const putWall   = spx.putWall;

    // 1. Gamma Flip (strongest signal — dealers change hedging direction)
    if (zeroGamma > 0) {
      direction = spxPrice > zeroGamma ? "LONG" : "SHORT";
      setupScore += 35;
      note += `${direction === "LONG" ? "Above" : "Below"} GammaFlip(${zeroGamma.toFixed(0)}). `;
    } else if (keyGamma > 0) {
      direction = spxPrice > keyGamma ? "LONG" : "SHORT";
      setupScore += 20;
      note += `${direction === "LONG" ? "Above" : "Below"} KeyGamma(${keyGamma.toFixed(0)}). `;
    }
    if (!direction) continue;

    // 2. Price position between Call Wall and Put Wall
    if (callWall > 0 && putWall > 0) {
      const midRange = (callWall + putWall) / 2;
      const nearCallWall = direction === "SHORT" && spxPrice > midRange;
      const nearPutWall  = direction === "LONG"  && spxPrice < midRange;
      if (nearCallWall || nearPutWall) {
        setupScore += 15;
        note += nearCallWall ? `Near CallWall(${callWall}). ` : `Near PutWall(${putWall}). `;
      }
    }

    // 3. Tape confirmation
    if (day.tape) {
      const tapeDir = day.tape.dominantFlow;
      if ((tapeDir === "calls" && direction === "LONG") || (tapeDir === "puts" && direction === "SHORT")) {
        setupScore += 25;
        note += `Tape ${tapeDir} confirms. `;
      } else if (tapeDir !== "neutral") {
        setupScore -= 10;
        note += `Tape ${tapeDir} conflicts. `;
      }
    }

    // 4. HIRO confirmation
    if (day.hiroAvailable && day.hiroTrend) {
      if ((day.hiroTrend === "bullish" && direction === "LONG") || (day.hiroTrend === "bearish" && direction === "SHORT")) {
        setupScore += 20;
        note += `HIRO ${day.hiroTrend} confirms. `;
      } else if (day.hiroTrend !== "neutral") {
        setupScore -= 5;
        note += `HIRO ${day.hiroTrend} conflicts. `;
      }
    }

    setupScore = Math.max(0, Math.min(100, setupScore));
    if (setupScore < minScore) continue;

    daysWithSetups++;

    // ── Determine which CFDs to analyze ─────────────────────────
    const cfdsToCheck = cfd ? [cfd] : ["NAS100", "US30", "XAUUSD"];

    for (const c of cfdsToCheck) {
      // ── Outcome: compare SpotGamma upx prices day N → day N+1 ──
      let outcome: "win" | "loss" | "unknown" = "unknown";
      let priceMove = 0;
      let entryPrice = 0;
      let exitPrice  = 0;

      if (nextDay?.sgPrices) {
        entryPrice = getCFDPrice(day, c);
        exitPrice  = getCFDPrice(nextDay, c);

        if (entryPrice > 0 && exitPrice > 0) {
          priceMove = ((exitPrice - entryPrice) / entryPrice) * 100;
          // Win threshold: >0.3% move in direction (filters noise)
          if (direction === "LONG") {
            outcome = priceMove > 0.3 ? "win" : priceMove < -0.3 ? "loss" : "unknown";
          } else {
            outcome = priceMove < -0.3 ? "win" : priceMove > 0.3 ? "loss" : "unknown";
          }
          note += `SG: ${entryPrice.toFixed(0)}→${exitPrice.toFixed(0)} (${priceMove > 0 ? "+" : ""}${priceMove.toFixed(2)}%). `;
        }
      } else {
        note += "Next day not in dataset yet. ";
      }

      const dayResult: BacktestDayResult = {
        date: day.date,
        setupDirection: direction,
        cfd: c,
        score: setupScore,
        callWall,
        putWall,
        keyGamma,
        spxPrice,
        tapeFlow: day.tape?.dominantFlow,
        hiroTrend: day.hiroTrend,
        outcome,
        priceMove,
        note: note.trim(),
      };
      results.push(dayResult);

      if (outcome === "win") totalWins++;
      else if (outcome === "loss") totalLosses++;
      else totalUnknowns++;

      if (!byCfd[c]) byCfd[c] = { total: 0, wins: 0, losses: 0, winRate: 0 };
      byCfd[c].total++;
      if (outcome === "win") byCfd[c].wins++;
      if (outcome === "loss") byCfd[c].losses++;

      const range =
        setupScore >= 90 ? "90-100" :
        setupScore >= 75 ? "75-89"  :
        setupScore >= 60 ? "60-74"  : "0-59";
      byScoreRange[range].total++;
      if (outcome === "win") byScoreRange[range].wins++;
    }
  }

  for (const c of Object.keys(byCfd)) {
    const b = byCfd[c];
    b.winRate = (b.wins + b.losses) > 0 ? Math.round(b.wins / (b.wins + b.losses) * 100) : 0;
  }
  for (const r of Object.keys(byScoreRange)) {
    const b = byScoreRange[r];
    b.winRate = b.total > 0 ? Math.round(b.wins / b.total * 100) : 0;
  }

  const totalResolved = totalWins + totalLosses;
  return {
    totalDays: allDays.length,
    daysWithSetups,
    wins: totalWins,
    losses: totalLosses,
    unknowns: totalUnknowns,
    winRate: totalResolved > 0 ? Math.round(totalWins / totalResolved * 100) : 0,
    results: results.sort((a, b) => b.date.localeCompare(a.date)),
    byCfd,
    byScoreRange,
  };
}
