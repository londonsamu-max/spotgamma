/**
 * Drift Prediction Model
 *
 * Models the ratio CFD_price / ETF_price throughout the day.
 * The ratio isn't constant — it drifts based on:
 *   - Time of day (pre-market vs open vs close)
 *   - VIX regime (high vol = wider spreads = more drift)
 *   - Day of week
 *
 * Training: for each 15-min candle where both ETF (OHLC 1-min) and CFD (MT5 M15)
 * have data, compute the ratio. Build a lookup table by hour bucket + VIX regime.
 *
 * Prediction: given (ETF symbol, ETF price, hour, VIX), predict the CFD price.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadOhlc1Min, loadMt5Day, listOhlcDates } from "../data-loaders/price-provider.js";
import { getMacroContext } from "../data-loaders/macro-loader.js";
import type { CFD } from "../utils/types.js";

const OUT_DIR = path.resolve(process.cwd(), "backtest/models");

interface DriftSample {
  hour: number;         // 0-23 UTC
  vixRegime: string;    // low/mid/high/extreme
  ratio: number;        // CFD / ETF
  cfdPrice: number;
  etfPrice: number;
}

interface DriftTable {
  cfd: CFD;
  etfSym: string;
  buckets: Record<string, { // key = "hour_vixRegime"
    mean: number;
    median: number;
    std: number;
    count: number;
    p25: number;
    p75: number;
  }>;
  globalMean: number;
  globalStd: number;
}

const PRIMARY_ETF: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

/** Build drift model for a CFD from historical data */
export async function buildDriftModel(
  cfd: CFD,
  startDate: string = "2025-01-01",
  endDate: string = "2026-02-28",
): Promise<DriftTable> {
  const etfSym = PRIMARY_ETF[cfd];
  const dates = listOhlcDates(etfSym).filter(d => d >= startDate && d <= endDate);
  console.log(`  Drift model ${cfd}/${etfSym}: ${dates.length} days`);

  const samples: DriftSample[] = [];

  for (const date of dates) {
    const macro = getMacroContext(date);
    const vixRegime = macro.vixRegime;

    // Get ETF prices at each hour mark
    const etfBars = loadOhlc1Min(etfSym, date);
    const cfdBars = loadMt5Day(cfd, date, "M15");
    if (etfBars.length === 0 || cfdBars.length === 0) continue;

    // For each M15 candle, find matching ETF price
    for (const cfdBar of cfdBars) {
      const t = cfdBar.t!;
      const hour = new Date(t).getUTCHours();

      // Find closest ETF bar
      const etfClose = etfBars.reduce((best, bar) =>
        Math.abs(bar.t - t) < Math.abs(best.t - t) ? bar : best
      );
      if (Math.abs(etfClose.t - t) > 15 * 60 * 1000) continue; // skip if >15min apart
      if (etfClose.c === 0 || cfdBar.close === 0) continue;

      const ratio = cfdBar.close / etfClose.c;
      if (ratio < 0.5 || ratio > 500) continue; // sanity check

      samples.push({ hour, vixRegime, ratio, cfdPrice: cfdBar.close, etfPrice: etfClose.c });
    }
  }

  console.log(`    ${samples.length} samples collected`);

  // Aggregate by hour + vixRegime
  const buckets: DriftTable["buckets"] = {};
  const groupedSamples: Record<string, number[]> = {};

  for (const s of samples) {
    const key = `${s.hour}_${s.vixRegime}`;
    if (!groupedSamples[key]) groupedSamples[key] = [];
    groupedSamples[key].push(s.ratio);
  }

  for (const [key, ratios] of Object.entries(groupedSamples)) {
    ratios.sort((a, b) => a - b);
    const n = ratios.length;
    const mean = ratios.reduce((s, r) => s + r, 0) / n;
    const median = ratios[Math.floor(n / 2)];
    const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const p25 = ratios[Math.floor(n * 0.25)];
    const p75 = ratios[Math.floor(n * 0.75)];
    buckets[key] = { mean, median, std, count: n, p25, p75 };
  }

  const allRatios = samples.map(s => s.ratio);
  const globalMean = allRatios.reduce((s, r) => s + r, 0) / allRatios.length;
  const globalStd = Math.sqrt(allRatios.reduce((s, r) => s + (r - globalMean) ** 2, 0) / allRatios.length);

  const model: DriftTable = { cfd, etfSym, buckets, globalMean, globalStd };

  // Save
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `drift-${cfd}.json`), JSON.stringify(model, null, 2));
  console.log(`    Saved: ${Object.keys(buckets).length} buckets, global ratio=${globalMean.toFixed(4)} ±${globalStd.toFixed(4)}`);

  return model;
}

// Cache loaded models
const modelCache = new Map<CFD, DriftTable>();

export function loadDriftModel(cfd: CFD): DriftTable | null {
  if (modelCache.has(cfd)) return modelCache.get(cfd)!;
  const file = path.join(OUT_DIR, `drift-${cfd}.json`);
  if (!fs.existsSync(file)) return null;
  const model: DriftTable = JSON.parse(fs.readFileSync(file, "utf-8"));
  modelCache.set(cfd, model);
  return model;
}

/** Predict CFD price given ETF price, hour, and VIX regime */
export function predictCfdPrice(
  cfd: CFD,
  etfPrice: number,
  hour: number,
  vixRegime: string,
): { predicted: number; confidence: number; ratio: number } | null {
  const model = loadDriftModel(cfd);
  if (!model) return null;

  const key = `${hour}_${vixRegime}`;
  const bucket = model.buckets[key];

  if (bucket && bucket.count >= 5) {
    return {
      predicted: etfPrice * bucket.median,
      confidence: Math.min(1, bucket.count / 50), // higher sample = higher confidence
      ratio: bucket.median,
    };
  }

  // Fallback: use global mean
  return {
    predicted: etfPrice * model.globalMean,
    confidence: 0.3, // low confidence fallback
    ratio: model.globalMean,
  };
}

/** Predict the drift RANGE: what CFD price range corresponds to ETF touching a strike */
export function predictCfdRange(
  cfd: CFD,
  etfStrike: number,
  hour: number,
  vixRegime: string,
): { low: number; mid: number; high: number } | null {
  const model = loadDriftModel(cfd);
  if (!model) return null;

  const key = `${hour}_${vixRegime}`;
  const bucket = model.buckets[key] ?? { mean: model.globalMean, p25: model.globalMean * 0.999, p75: model.globalMean * 1.001 };

  return {
    low: etfStrike * bucket.p25,
    mid: etfStrike * (bucket.mean ?? model.globalMean),
    high: etfStrike * bucket.p75,
  };
}
