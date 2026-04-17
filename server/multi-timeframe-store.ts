/**
 * Multi-Timeframe Store
 * Circular buffer of market snapshots taken every 15 minutes.
 * Stores last 16 snapshots (= 4 hours of context).
 * Persists to data/market-snapshots-rolling.json for recovery.
 */

import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "market-snapshots-rolling.json");
const MAX_SNAPSHOTS = 16; // 4 hours at 15-min intervals
const MIN_INTERVAL_MS = 14 * 60 * 1000; // 14 min (slight buffer under 15)

// ─── Types ────────────────────────────────────────────────

export interface TimeframeSnapshot {
  timestamp: string; // ISO
  cfdPrices: Record<string, { price: number; changePct: number }>;
  hiro: Record<string, {
    value: number;
    percentile: number;
    trend: string;
  }>;
  tape: Record<string, {
    sentiment: string;
    sentimentScore: number;
    netDelta: number;
    dominantFlow: string;
    totalPremium: number;
  }>;
  trace: {
    netGexBias: string;
    gexRatio: number;
    totalPositiveGex: number;
    totalNegativeGex: number;
    maxGexStrike: number;
    gammaFlip: number;
  } | null;
  marketStatus: string;
  sessionDate: string;
}

export interface MultiTimeframeView {
  snapshots: TimeframeSnapshot[];
  count: number;
  oldestAt: string | null;
  newestAt: string | null;
  // Computed deltas
  hiroDeltas: Record<string, {
    delta1h: number | null;
    delta2h: number | null;
    delta4h: number | null;
    currentPercentile: number;
    trend1h: string; // rising, falling, flat
  }>;
  gexFlips4h: number; // count of bias changes in window
  tapeAccumulation: Record<string, {
    net1h: number; // net sentiment score sum last 1h
    net4h: number; // net sentiment score sum last 4h
  }>;
  priceRanges: Record<string, {
    high4h: number;
    low4h: number;
    current: number;
    positionInRange: number; // 0-100
  }>;
}

// ─── State ────────────────────────────────────────────────

let _snapshots: TimeframeSnapshot[] = [];
let _lastSnapshotAt = 0;

// Load from disk on startup
function loadFromDisk(): void {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const raw = fs.readFileSync(SNAPSHOT_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _snapshots = parsed.slice(-MAX_SNAPSHOTS);
        if (_snapshots.length > 0) {
          _lastSnapshotAt = new Date(_snapshots[_snapshots.length - 1].timestamp).getTime();
        }
        console.log(`[MultiTimeframe] Loaded ${_snapshots.length} snapshots from disk`);
      }
    }
  } catch (e) {
    console.log("[MultiTimeframe] No previous snapshots found, starting fresh");
  }
}

function saveToDisk(): void {
  try {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(_snapshots, null, 2));
  } catch (e) {
    console.error("[MultiTimeframe] Failed to persist snapshots:", e);
  }
}

// Initialize on module load
loadFromDisk();

// ─── Record Snapshot ──────────────────────────────────────

export function recordSnapshot(marketData: any): boolean {
  const now = Date.now();

  // Only record every 15 minutes
  if (now - _lastSnapshotAt < MIN_INTERVAL_MS) return false;

  // Don't record if market is closed (no new data)
  if (!marketData || marketData.marketStatus === "closed") return false;

  try {
    const snapshot: TimeframeSnapshot = {
      timestamp: new Date().toISOString(),
      cfdPrices: extractCfdPrices(marketData.cfdPrices),
      hiro: extractHiro(marketData.hiro),
      tape: extractTape(marketData.tape),
      trace: extractTrace(marketData.traceData),
      marketStatus: marketData.marketStatus || "unknown",
      sessionDate: marketData.sessionDate || new Date().toISOString().split("T")[0],
    };

    _snapshots.push(snapshot);

    // Maintain circular buffer
    if (_snapshots.length > MAX_SNAPSHOTS) {
      _snapshots = _snapshots.slice(-MAX_SNAPSHOTS);
    }

    _lastSnapshotAt = now;
    saveToDisk();

    console.log(`[MultiTimeframe] Recorded snapshot #${_snapshots.length} at ${snapshot.timestamp}`);
    return true;
  } catch (e) {
    console.error("[MultiTimeframe] Error recording snapshot:", e);
    return false;
  }
}

// ─── Get Multi-Timeframe View ─────────────────────────────

export function getMultiTimeframeView(): MultiTimeframeView {
  const now = Date.now();
  const snaps = _snapshots;

  const view: MultiTimeframeView = {
    snapshots: snaps,
    count: snaps.length,
    oldestAt: snaps.length > 0 ? snaps[0].timestamp : null,
    newestAt: snaps.length > 0 ? snaps[snaps.length - 1].timestamp : null,
    hiroDeltas: {},
    gexFlips4h: 0,
    tapeAccumulation: {},
    priceRanges: {},
  };

  if (snaps.length < 2) return view;

  const latest = snaps[snaps.length - 1];

  // ─── HIRO Deltas ───
  const symbols = Object.keys(latest.hiro);
  for (const sym of symbols) {
    const currentPct = latest.hiro[sym]?.percentile ?? 0;

    const snap1h = findSnapshotAgo(snaps, now, 60);
    const snap2h = findSnapshotAgo(snaps, now, 120);
    const snap4h = findSnapshotAgo(snaps, now, 240);

    const pct1h = snap1h?.hiro[sym]?.percentile ?? null;
    const pct2h = snap2h?.hiro[sym]?.percentile ?? null;
    const pct4h = snap4h?.hiro[sym]?.percentile ?? null;

    const delta1h = pct1h !== null ? currentPct - pct1h : null;
    const delta2h = pct2h !== null ? currentPct - pct2h : null;
    const delta4h = pct4h !== null ? currentPct - pct4h : null;

    let trend1h = "flat";
    if (delta1h !== null) {
      if (delta1h > 5) trend1h = "rising";
      else if (delta1h < -5) trend1h = "falling";
    }

    view.hiroDeltas[sym] = { delta1h, delta2h, delta4h, currentPercentile: currentPct, trend1h };
  }

  // ─── GEX Flips ───
  let flips = 0;
  for (let i = 1; i < snaps.length; i++) {
    const prevBias = snaps[i - 1].trace?.netGexBias;
    const curBias = snaps[i].trace?.netGexBias;
    if (prevBias && curBias && prevBias !== curBias) flips++;
  }
  view.gexFlips4h = flips;

  // ─── Tape Accumulation ───
  const tapeSymbols = Object.keys(latest.tape);
  for (const sym of tapeSymbols) {
    let net1h = 0, net4h = 0;

    for (const snap of snaps) {
      const age = now - new Date(snap.timestamp).getTime();
      const score = snap.tape[sym]?.sentimentScore ?? 0;
      net4h += score;
      if (age <= 60 * 60 * 1000) net1h += score;
    }

    view.tapeAccumulation[sym] = { net1h, net4h };
  }

  // ─── Price Ranges ───
  const cfdKeys = Object.keys(latest.cfdPrices);
  for (const key of cfdKeys) {
    const prices = snaps
      .map(s => s.cfdPrices[key]?.price)
      .filter((p): p is number => p !== undefined && p > 0);

    if (prices.length === 0) continue;

    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const current = latest.cfdPrices[key]?.price ?? 0;
    const range = high - low;
    const positionInRange = range > 0 ? ((current - low) / range) * 100 : 50;

    view.priceRanges[key] = { high4h: high, low4h: low, current, positionInRange };
  }

  return view;
}

// ─── Helpers ──────────────────────────────────────────────

function findSnapshotAgo(snaps: TimeframeSnapshot[], now: number, minutesAgo: number): TimeframeSnapshot | null {
  const targetMs = now - minutesAgo * 60 * 1000;
  let closest: TimeframeSnapshot | null = null;
  let closestDiff = Infinity;

  for (const s of snaps) {
    const diff = Math.abs(new Date(s.timestamp).getTime() - targetMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = s;
    }
  }

  // Only return if within 20 minutes of target
  if (closestDiff > 20 * 60 * 1000) return null;
  return closest;
}

function extractCfdPrices(cfdPrices: any): Record<string, { price: number; changePct: number }> {
  if (!cfdPrices) return {};
  const result: Record<string, { price: number; changePct: number }> = {};
  for (const key of ["nas100", "us30", "xauusd", "vix", "uvix"]) {
    if (cfdPrices[key]?.price > 0) {
      result[key] = { price: cfdPrices[key].price, changePct: cfdPrices[key].changePct ?? 0 };
    }
  }
  return result;
}

function extractHiro(hiro: any): Record<string, { value: number; percentile: number; trend: string }> {
  if (!hiro?.perAsset) return {};
  const result: Record<string, { value: number; percentile: number; trend: string }> = {};
  for (const [sym, data] of Object.entries(hiro.perAsset) as [string, any][]) {
    const min = data.hiroRange30dMin ?? 0;
    const max = data.hiroRange30dMax ?? 0;
    const range = max - min;
    const percentile = range > 0 ? ((data.hiroValue - min) / range) * 100 : 50;
    result[sym] = {
      value: data.hiroValue ?? 0,
      percentile: Math.max(0, Math.min(100, percentile)),
      trend: data.hiroTrend ?? "neutral",
    };
  }
  return result;
}

function extractTape(tape: any): Record<string, { sentiment: string; sentimentScore: number; netDelta: number; dominantFlow: string; totalPremium: number }> {
  if (!tape?.perAsset) return {};
  const result: Record<string, any> = {};
  for (const [sym, data] of Object.entries(tape.perAsset) as [string, any][]) {
    result[sym] = {
      sentiment: data.sentiment ?? "neutral",
      sentimentScore: data.sentimentScore ?? 0,
      netDelta: data.netDelta ?? 0,
      dominantFlow: data.dominantFlow ?? "neutral",
      totalPremium: data.totalPremium ?? 0,
    };
  }
  return result;
}

function extractTrace(traceData: any): TimeframeSnapshot["trace"] {
  if (!traceData) return null;
  return {
    netGexBias: traceData.netGexBias ?? "neutral",
    gexRatio: traceData.gexRatio ?? 0,
    totalPositiveGex: traceData.totalPositiveGex ?? 0,
    totalNegativeGex: traceData.totalNegativeGex ?? 0,
    maxGexStrike: traceData.maxGexStrike ?? 0,
    gammaFlip: traceData.gammaFlip ?? 0,
  };
}
