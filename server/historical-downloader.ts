/**
 * Historical Data Downloader — SpotGamma
 * Downloads and stores historical data from all available SG endpoints:
 * 1. GEX History (synth_oi/v1/historical) — daily levels per symbol
 * 2. Tape Flow (tns_feed) — tick-by-tick options flow per session
 * 3. Tape Summary (tns_flow_sum) — aggregated flow per session
 * 4. TRACE Intraday Gamma (v1/oi/intradayGamma) — 5-min GEX heatmap
 * 5. EquityHub GEX by strike (synth_oi/v1/gex) — GEX per strike per day
 * 6. Gamma/Delta Tilt (gammaTilt/deltaTilt) — historical since 2015
 * 7. Daily OHLC (twelve_series 1day) — daily prices since 2015
 * 8. EquityHub Chart Data (synth_oi/v1/chart_data) — gamma/delta curves per date
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getToken, streamApiCall, parseTapeFlowItem, fetchGammaTilt, fetchDeltaTilt, fetchTwelveSeries } from "./spotgamma-scraper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data/historical");
const API_BASE = "https://api.spotgamma.com";
const STREAM_API_BASE = "https://api.stream.spotgamma.com";

// Symbols to download
const GEX_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "DIA", "VIX"];
const TAPE_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "DIA", "VIX", "UVIX"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 100;
}

async function sgFetch(url: string, token: string, timeoutMs = 30000): Promise<any> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
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
      console.warn(`[HIST] ${resp.status} for ${url.substring(0, 120)}`);
      return null;
    }
    return await resp.json();
  } catch (e: any) {
    clearTimeout(tid);
    if (e.name === "AbortError") {
      console.warn(`[HIST] Timeout for ${url.substring(0, 120)}`);
    } else {
      console.warn(`[HIST] Fetch error: ${e.message}`);
    }
    return null;
  }
}

/** Get trading days for the last N business days ending on a given date */
function getTradingDays(count: number, endDate?: string): string[] {
  const days: string[] = [];
  const d = endDate ? new Date(endDate + "T12:00:00Z") : new Date();
  while (days.length < count) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(d.toISOString().split("T")[0]);
    }
    d.setDate(d.getDate() - 1);
  }
  return days;
}

/** Convert date string + time to epoch ms (ET timezone) */
function toEpochET(dateStr: string, hours: number, minutes: number): number {
  // Create date in ET by using a rough offset approach
  // ET is UTC-4 (EDT) or UTC-5 (EST)
  const isDST = isDaylightSaving(new Date(dateStr));
  const offset = isDST ? 4 : 5;
  const d = new Date(`${dateStr}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`);
  d.setHours(d.getHours() + offset); // Convert ET to UTC
  return d.getTime();
}

function isDaylightSaving(d: Date): boolean {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul);
}

// ── 1. GEX History ──────────────────────────────────────────────────────────

export async function downloadGEXHistory(): Promise<{ symbol: string; rows: number }[]> {
  const token = await getToken();
  if (!token) { console.warn("[HIST] No token"); return []; }

  const dir = path.join(DATA_DIR, "gex-history");
  ensureDir(dir);

  const results: { symbol: string; rows: number }[] = [];

  for (const sym of GEX_SYMBOLS) {
    const filePath = path.join(dir, `${sym}.json`);
    console.log(`[HIST] Downloading GEX history: ${sym}...`);

    // limit=500 unlocks full history (~2 years back to 2024-03-13)
    // Without limit, SpotGamma returns only the most recent 30 rows
    const data = await sgFetch(
      `${API_BASE}/synth_oi/v1/historical?sym=${sym}&limit=500`,
      token,
      60000,
    );

    if (data) {
      const rows = Array.isArray(data) ? data.length : (data.data?.length ?? 0);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[HIST] GEX ${sym}: ${rows} rows saved`);
      results.push({ symbol: sym, rows });
    } else {
      results.push({ symbol: sym, rows: 0 });
    }

    // Rate limit: 500ms between requests
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// ── 2. Tape Flow (tick-by-tick) ─────────────────────────────────────────────

export async function downloadTapeFlow(
  date: string,
  symbols?: string[],
): Promise<{ date: string; symbol: string; records: number }[]> {
  const token = await getToken();
  if (!token) { console.warn("[HIST] No token"); return []; }

  const dir = path.join(DATA_DIR, "tape-flow", date);
  ensureDir(dir);

  const syms = symbols ?? TAPE_SYMBOLS;
  const results: { date: string; symbol: string; records: number }[] = [];

  // Session: 9:30 AM - 4:00 PM ET
  const fromTs = toEpochET(date, 9, 30);
  const toTs = toEpochET(date, 16, 0);

  for (const sym of syms) {
    const filePath = path.join(dir, `${sym}.json`);
    if (fileExists(filePath)) {
      const existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const count = Array.isArray(existing) ? existing.length : 0;
      console.log(`[HIST] Tape ${sym} ${date}: already downloaded (${count} records)`);
      results.push({ date, symbol: sym, records: count });
      continue;
    }

    console.log(`[HIST] Downloading tape flow: ${sym} ${date}...`);

    // Use streamApiCall with MessagePack (same as live tape scraper)
    const filters = JSON.stringify([
      { field: "underlying", operator: "isAnyOf", value: [sym] },
      { field: "ts", value: fromTs, id: "min_date_time", operator: ">=" },
      { field: "ts", value: toTs, id: "max_date_time", operator: "<=" },
    ]);
    const encoded = encodeURIComponent(filters);
    const sorting = encodeURIComponent(JSON.stringify([{ field: "ts", sort: "asc" }]));

    // Try MessagePack binary first (what the live scraper uses)
    const rawData = await streamApiCall<any[]>(
      `/sg/tns_feed?filters=${encoded}&sorting=${sorting}&limit=5000`,
      60000,
      true, // MessagePack binary
    );

    let allRecords: any[] = [];
    if (rawData && Array.isArray(rawData)) {
      // Parse raw MessagePack arrays into structured objects
      allRecords = rawData
        .map(item => {
          const parsed = parseTapeFlowItem(item);
          return parsed;
        })
        .filter(t => t !== null);
    }

    // Fallback: try JSON if MessagePack returned nothing
    if (allRecords.length === 0) {
      const jsonData = await sgFetch(
        `${STREAM_API_BASE}/sg/tns_feed?filters=${encoded}&sorting=${sorting}&offset=0&limit=5000`,
        token,
        60000,
      );
      if (jsonData && Array.isArray(jsonData)) {
        allRecords = jsonData;
      }
    }

    if (allRecords.length > 0) {
      fs.writeFileSync(filePath, JSON.stringify(allRecords, null, 2), "utf-8");
      console.log(`[HIST] Tape ${sym} ${date}: ${allRecords.length} records saved`);
    } else {
      console.log(`[HIST] Tape ${sym} ${date}: no data`);
    }

    results.push({ date, symbol: sym, records: allRecords.length });
  }

  return results;
}

// ── 3. Tape Summary ─────────────────────────────────────────────────────────

export async function downloadTapeSummary(date: string): Promise<any> {
  const token = await getToken();
  if (!token) return null;

  const dir = path.join(DATA_DIR, "tape-summary");
  ensureDir(dir);

  const filePath = path.join(dir, `${date}.json`);
  if (fileExists(filePath)) {
    console.log(`[HIST] Tape summary ${date}: already downloaded`);
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  const fromTs = toEpochET(date, 9, 30);
  const toTs = toEpochET(date, 16, 0);

  const filters = JSON.stringify([
    { field: "ts", value: fromTs, id: "min_date_time", operator: ">=" },
    { field: "ts", value: toTs, id: "max_date_time", operator: "<=" },
  ]);

  const url = `${STREAM_API_BASE}/sg/tns_flow_sum?filters=${encodeURIComponent(filters)}`;
  console.log(`[HIST] Downloading tape summary: ${date}...`);

  const data = await sgFetch(url, token, 30000);
  if (data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[HIST] Tape summary ${date}: saved`);
  }

  return data;
}

// ── 4. TRACE Intraday Gamma ─────────────────────────────────────────────────

export async function downloadTraceGamma(
  date: string,
  symbols?: string[],
): Promise<{ date: string; symbol: string; size: number }[]> {
  const token = await getToken();
  if (!token) { console.warn("[HIST] No token"); return []; }

  const dir = path.join(DATA_DIR, "trace-gamma", date);
  ensureDir(dir);

  const syms = symbols ?? ["SPX", "SPY", "QQQ", "GLD"];
  const results: { date: string; symbol: string; size: number }[] = [];

  for (const sym of syms) {
    const filePath = path.join(dir, `${sym}.json`);
    if (fileExists(filePath)) {
      const size = fs.statSync(filePath).size;
      console.log(`[HIST] TRACE ${sym} ${date}: already downloaded (${(size / 1024).toFixed(0)}KB)`);
      results.push({ date, symbol: sym, size });
      continue;
    }

    console.log(`[HIST] Downloading TRACE gamma: ${sym} ${date}...`);

    const url = `${API_BASE}/v1/oi/intradayGamma?sym=${sym}&date=${date}`;
    const data = await sgFetch(url, token, 60000);

    if (data) {
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, json, "utf-8");
      console.log(`[HIST] TRACE ${sym} ${date}: ${(json.length / 1024).toFixed(0)}KB saved`);
      results.push({ date, symbol: sym, size: json.length });
    } else {
      results.push({ date, symbol: sym, size: 0 });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// ── 5. EquityHub GEX by strike (per day) ────────────────────────────────────

export async function downloadEquityGEX(
  date: string,
  symbols?: string[],
): Promise<{ date: string; symbol: string; strikes: number }[]> {
  const token = await getToken();
  if (!token) { console.warn("[HIST] No token"); return []; }

  const dir = path.join(DATA_DIR, "equity-gex", date);
  ensureDir(dir);

  const syms = symbols ?? GEX_SYMBOLS;
  const results: { date: string; symbol: string; strikes: number }[] = [];

  for (const sym of syms) {
    const filePath = path.join(dir, `${sym}.json`);
    if (fileExists(filePath)) {
      console.log(`[HIST] EquityGEX ${sym} ${date}: already downloaded`);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      results.push({ date, symbol: sym, strikes: Array.isArray(data) ? data.length : 0 });
      continue;
    }

    console.log(`[HIST] Downloading EquityHub GEX: ${sym} ${date}...`);

    // Try both endpoints
    let data = await sgFetch(
      `${API_BASE}/synth_oi/v1/gex?sym=${sym}&date=${date}`,
      token,
    );

    if (!data) {
      // Alternative: v3/equitiesBySyms with date
      data = await sgFetch(
        `${API_BASE}/v3/equitiesBySyms?syms=${sym}&date=${date}`,
        token,
      );
    }

    if (data) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
      const strikes = Array.isArray(data) ? data.length :
        (data.data ? (Array.isArray(data.data) ? data.data.length : Object.keys(data.data).length) : 0);
      console.log(`[HIST] EquityGEX ${sym} ${date}: ${strikes} strikes saved`);
      results.push({ date, symbol: sym, strikes });
    } else {
      results.push({ date, symbol: sym, strikes: 0 });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

// ── 6. Gamma Tilt + Delta Tilt (historical since 2015) ──────────────────────

const TILT_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD"];

export async function downloadGammaDeltaTilt(): Promise<{
  symbol: string;
  gammaTiltRows: number;
  deltaTiltRows: number;
}[]> {
  const dir = path.join(DATA_DIR, "tilt-history");
  ensureDir(dir);

  const results: { symbol: string; gammaTiltRows: number; deltaTiltRows: number }[] = [];

  for (const sym of TILT_SYMBOLS) {
    console.log(`[HIST] Downloading gammaTilt + deltaTilt: ${sym}...`);

    // Gamma Tilt
    const gammaTiltPath = path.join(dir, `${sym}_gamma.json`);
    let gammaTiltRows = 0;
    try {
      const gammaTilt = await fetchGammaTilt(sym);
      if (gammaTilt.length > 0) {
        fs.writeFileSync(gammaTiltPath, JSON.stringify(gammaTilt, null, 2), "utf-8");
        gammaTiltRows = gammaTilt.length;
        console.log(`[HIST] GammaTilt ${sym}: ${gammaTiltRows} rows`);
      }
    } catch (e: any) {
      console.warn(`[HIST] GammaTilt ${sym} error: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 400));

    // Delta Tilt
    const deltaTiltPath = path.join(dir, `${sym}_delta.json`);
    let deltaTiltRows = 0;
    try {
      const deltaTilt = await fetchDeltaTilt(sym);
      if (deltaTilt.length > 0) {
        fs.writeFileSync(deltaTiltPath, JSON.stringify(deltaTilt, null, 2), "utf-8");
        deltaTiltRows = deltaTilt.length;
        console.log(`[HIST] DeltaTilt ${sym}: ${deltaTiltRows} rows`);
      }
    } catch (e: any) {
      console.warn(`[HIST] DeltaTilt ${sym} error: ${e.message}`);
    }

    results.push({ symbol: sym, gammaTiltRows, deltaTiltRows });
    await new Promise(r => setTimeout(r, 400));
  }

  return results;
}

/** Load gamma tilt from disk for a symbol (returns date→value map) */
export function loadGammaTilt(symbol: string): Record<string, number> {
  const filePath = path.join(DATA_DIR, "tilt-history", `${symbol}_gamma.json`);
  if (!fileExists(filePath)) return {};
  try {
    const arr: { date: string; gammaTilt: number }[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const map: Record<string, number> = {};
    for (const r of arr) if (r.date) map[r.date] = r.gammaTilt;
    return map;
  } catch { return {}; }
}

/** Load delta tilt from disk for a symbol (returns date→value map) */
export function loadDeltaTilt(symbol: string): Record<string, number> {
  const filePath = path.join(DATA_DIR, "tilt-history", `${symbol}_delta.json`);
  if (!fileExists(filePath)) return {};
  try {
    const arr: { date: string; deltaTilt: number }[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const map: Record<string, number> = {};
    for (const r of arr) if (r.date) map[r.date] = r.deltaTilt;
    return map;
  } catch { return {}; }
}

// ── 7. Daily OHLC (twelve_series 1day) — prices since 2015 ──────────────────

const OHLC_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "DIA"];

export async function downloadDailyOHLC(): Promise<{
  symbol: string;
  rows: number;
  from: string;
  to: string;
}[]> {
  const dir = path.join(DATA_DIR, "daily-ohlc");
  ensureDir(dir);

  const results: { symbol: string; rows: number; from: string; to: string }[] = [];

  for (const sym of OHLC_SYMBOLS) {
    const filePath = path.join(dir, `${sym}.json`);
    console.log(`[HIST] Downloading daily OHLC: ${sym} (since 2015)...`);

    try {
      // Try full history (2015), fallback to shorter range if 500 error
      let bars = await fetchTwelveSeries(sym, "2015-01-01", "1day");
      if (bars.length === 0) {
        console.log(`[HIST] ${sym}: full range failed, trying 2019...`);
        bars = await fetchTwelveSeries(sym, "2019-01-01", "1day");
      }
      if (bars.length === 0) {
        console.log(`[HIST] ${sym}: 2019 failed, trying 2022...`);
        bars = await fetchTwelveSeries(sym, "2022-01-01", "1day");
      }
      if (bars.length > 0) {
        fs.writeFileSync(filePath, JSON.stringify(bars, null, 2), "utf-8");
        const firstDate = new Date(bars[0].t * 1000).toISOString().slice(0, 10);
        const lastDate = new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10);
        console.log(`[HIST] Daily OHLC ${sym}: ${bars.length} bars, ${firstDate} → ${lastDate}`);
        results.push({ symbol: sym, rows: bars.length, from: firstDate, to: lastDate });
      } else {
        console.log(`[HIST] Daily OHLC ${sym}: no data`);
        results.push({ symbol: sym, rows: 0, from: "", to: "" });
      }
    } catch (e: any) {
      console.warn(`[HIST] Daily OHLC ${sym} error: ${e.message}`);
      results.push({ symbol: sym, rows: 0, from: "", to: "" });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

/** Load daily OHLC from disk: returns date→{o,h,l,c,v} map */
export function loadDailyOHLC(symbol: string): Record<string, { o: number; h: number; l: number; c: number; v: number }> {
  const filePath = path.join(DATA_DIR, "daily-ohlc", `${symbol}.json`);
  if (!fileExists(filePath)) return {};
  try {
    const bars: { t: number; o: number; h: number; l: number; c: number; v?: number }[] =
      JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const map: Record<string, { o: number; h: number; l: number; c: number; v: number }> = {};
    for (const b of bars) {
      if (b.t > 0 && b.c > 0) {
        const dateStr = new Date(b.t * 1000).toISOString().slice(0, 10);
        map[dateStr] = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 };
      }
    }
    return map;
  } catch { return {}; }
}

// ── 8. EquityHub Chart Data (gamma/delta curves by strike per date) ─────────

export async function downloadChartData(
  days: number = 30,
  symbols?: string[],
): Promise<{ date: string; symbol: string; size: number }[]> {
  const token = await getToken();
  if (!token) { console.warn("[HIST] No token"); return []; }

  const dir = path.join(DATA_DIR, "chart-data");
  ensureDir(dir);

  const syms = symbols ?? ["SPX", "QQQ", "GLD", "DIA"];
  const tradingDays = getTradingDays(days);
  const results: { date: string; symbol: string; size: number }[] = [];

  for (const date of tradingDays) {
    const dateDir = path.join(dir, date);
    ensureDir(dateDir);

    for (const sym of syms) {
      const filePath = path.join(dateDir, `${sym}.json`);
      if (fileExists(filePath)) {
        const size = fs.statSync(filePath).size;
        results.push({ date, symbol: sym, size });
        continue;
      }

      console.log(`[HIST] Downloading chart_data: ${sym} ${date}...`);
      const data = await sgFetch(
        `${API_BASE}/synth_oi/v1/chart_data?sym=${sym}&date=${date}`,
        token,
        30000,
      );

      if (data && data.curves) {
        const json = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, json, "utf-8");
        console.log(`[HIST] chart_data ${sym} ${date}: ${(json.length / 1024).toFixed(0)}KB`);
        results.push({ date, symbol: sym, size: json.length });
      } else {
        results.push({ date, symbol: sym, size: 0 });
      }

      await new Promise(r => setTimeout(r, 400));
    }
  }

  return results;
}

// ── Master download: all data for N days ────────────────────────────────────

export interface DownloadResult {
  startedAt: string;
  completedAt: string;
  daysProcessed: number;
  gexHistory: { symbol: string; rows: number }[];
  tapeFlow: { date: string; symbol: string; records: number }[];
  tapeSummary: { date: string; saved: boolean }[];
  traceGamma: { date: string; symbol: string; size: number }[];
  equityGex: { date: string; symbol: string; strikes: number }[];
  tiltHistory: { symbol: string; gammaTiltRows: number; deltaTiltRows: number }[];
  dailyOHLC: { symbol: string; rows: number; from: string; to: string }[];
  chartData: { date: string; symbol: string; size: number }[];
  errors: string[];
}

export async function downloadAllHistorical(days: number = 10): Promise<DownloadResult> {
  const startedAt = new Date().toISOString();
  const tradingDays = getTradingDays(days);
  const errors: string[] = [];

  console.log(`[HIST] ═══════════════════════════════════════════════`);
  console.log(`[HIST] Starting historical download: ${days} trading days`);
  console.log(`[HIST] Dates: ${tradingDays[tradingDays.length - 1]} → ${tradingDays[0]}`);
  console.log(`[HIST] ═══════════════════════════════════════════════`);

  // 0a. Daily OHLC (years of price data since 2015)
  let dailyOHLC: { symbol: string; rows: number; from: string; to: string }[] = [];
  try {
    console.log(`\n[HIST] ── Step 0a/8: Daily OHLC (since 2015) ──`);
    dailyOHLC = await downloadDailyOHLC();
  } catch (e: any) {
    errors.push(`Daily OHLC: ${e.message}`);
    console.error(`[HIST] Daily OHLC error: ${e.message}`);
  }

  // 0b. Gamma/Delta Tilt (years of historical data)
  let tiltHistory: { symbol: string; gammaTiltRows: number; deltaTiltRows: number }[] = [];
  try {
    console.log(`\n[HIST] ── Step 0b/8: Gamma+Delta Tilt History ──`);
    tiltHistory = await downloadGammaDeltaTilt();
  } catch (e: any) {
    errors.push(`Tilt History: ${e.message}`);
    console.error(`[HIST] Tilt History error: ${e.message}`);
  }

  // 1. GEX History (one call per symbol, returns all historical data)
  let gexHistory: { symbol: string; rows: number }[] = [];
  try {
    console.log(`\n[HIST] ── Step 1/8: GEX History ──`);
    gexHistory = await downloadGEXHistory();
  } catch (e: any) {
    errors.push(`GEX History: ${e.message}`);
    console.error(`[HIST] GEX History error: ${e.message}`);
  }

  // 2-5: Per-day data
  const tapeFlow: { date: string; symbol: string; records: number }[] = [];
  const tapeSummary: { date: string; saved: boolean }[] = [];
  const traceGamma: { date: string; symbol: string; size: number }[] = [];
  const equityGex: { date: string; symbol: string; strikes: number }[] = [];

  for (const date of tradingDays) {
    console.log(`\n[HIST] ── Processing ${date} ──`);

    // 2. Tape Flow
    try {
      console.log(`[HIST] Step 2/6: Tape Flow ${date}`);
      const tf = await downloadTapeFlow(date);
      tapeFlow.push(...tf);
    } catch (e: any) {
      errors.push(`Tape Flow ${date}: ${e.message}`);
    }

    // 3. Tape Summary
    try {
      console.log(`[HIST] Step 3/6: Tape Summary ${date}`);
      const ts = await downloadTapeSummary(date);
      tapeSummary.push({ date, saved: !!ts });
    } catch (e: any) {
      errors.push(`Tape Summary ${date}: ${e.message}`);
    }

    // 4. TRACE Intraday Gamma
    try {
      console.log(`[HIST] Step 4/6: TRACE Gamma ${date}`);
      const tg = await downloadTraceGamma(date);
      traceGamma.push(...tg);
    } catch (e: any) {
      errors.push(`TRACE Gamma ${date}: ${e.message}`);
    }

    // 5. EquityHub GEX
    try {
      console.log(`[HIST] Step 5/6: EquityHub GEX ${date}`);
      const eg = await downloadEquityGEX(date);
      equityGex.push(...eg);
    } catch (e: any) {
      errors.push(`EquityHub GEX ${date}: ${e.message}`);
    }

    // Rate limit between days
    await new Promise(r => setTimeout(r, 1000));
  }

  // 6. EquityHub Chart Data (gamma/delta curves per date)
  let chartData: { date: string; symbol: string; size: number }[] = [];
  try {
    console.log(`\n[HIST] ── Step 6/8: EquityHub Chart Data ──`);
    chartData = await downloadChartData(days);
  } catch (e: any) {
    errors.push(`Chart Data: ${e.message}`);
    console.error(`[HIST] Chart Data error: ${e.message}`);
  }

  const completedAt = new Date().toISOString();
  const result: DownloadResult = {
    startedAt,
    completedAt,
    daysProcessed: tradingDays.length,
    gexHistory,
    tapeFlow,
    tapeSummary,
    traceGamma,
    equityGex,
    tiltHistory,
    dailyOHLC,
    chartData,
    errors,
  };

  // Save download manifest
  const manifestPath = path.join(DATA_DIR, "download-manifest.json");
  ensureDir(DATA_DIR);
  fs.writeFileSync(manifestPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`\n[HIST] ═══════════════════════════════════════════════`);
  console.log(`[HIST] Download complete!`);
  console.log(`[HIST] Days: ${tradingDays.length}`);
  console.log(`[HIST] Daily OHLC: ${dailyOHLC.filter(o => o.rows > 0).length}/${dailyOHLC.length} symbols`);
  console.log(`[HIST] GEX History: ${gexHistory.filter(g => g.rows > 0).length}/${gexHistory.length} symbols`);
  console.log(`[HIST] Tape Flow: ${tapeFlow.filter(t => t.records > 0).length} symbol-days`);
  console.log(`[HIST] TRACE Gamma: ${traceGamma.filter(t => t.size > 0).length} symbol-days`);
  console.log(`[HIST] Chart Data: ${chartData.filter(c => c.size > 0).length} symbol-days`);
  console.log(`[HIST] Errors: ${errors.length}`);
  console.log(`[HIST] ═══════════════════════════════════════════════`);

  return result;
}

// ── Get download status ─────────────────────────────────────────────────────

export function getDownloadStatus(): {
  totalFiles: number;
  totalSizeMB: number;
  categories: Record<string, { files: number; sizeMB: number; dates: string[] }>;
} {
  const categories: Record<string, { files: number; sizeMB: number; dates: string[] }> = {};

  if (!fs.existsSync(DATA_DIR)) {
    return { totalFiles: 0, totalSizeMB: 0, categories };
  }

  let totalFiles = 0;
  let totalSize = 0;

  const dirs = ["gex-history", "tape-flow", "tape-summary", "trace-gamma", "equity-gex", "tilt-history", "daily-ohlc", "chart-data"];
  for (const dir of dirs) {
    const dirPath = path.join(DATA_DIR, dir);
    if (!fs.existsSync(dirPath)) {
      categories[dir] = { files: 0, sizeMB: 0, dates: [] };
      continue;
    }

    let files = 0;
    let size = 0;
    const dates = new Set<string>();

    function scanDir(p: string) {
      for (const entry of fs.readdirSync(p)) {
        const fp = path.join(p, entry);
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) {
          dates.add(entry); // date folders
          scanDir(fp);
        } else if (entry.endsWith(".json")) {
          files++;
          size += stat.size;
        }
      }
    }

    scanDir(dirPath);
    categories[dir] = { files, sizeMB: Math.round(size / 1024 / 1024 * 100) / 100, dates: [...dates].sort() };
    totalFiles += files;
    totalSize += size;
  }

  return {
    totalFiles,
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    categories,
  };
}
