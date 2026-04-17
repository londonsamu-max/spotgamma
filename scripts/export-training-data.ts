/**
 * Export training data to JSON for Python training script.
 * Memory-efficient: processes one symbol at a time.
 * Includes exact outcomes from 1-min candles AND TradingView intraday bars when available.
 *
 * Resolution priority: 1-min > 1h > 2h > 4h > daily (approximate)
 *
 * Usage: NODE_OPTIONS="--max-old-space-size=6144" npx tsx scripts/export-training-data.ts
 * Output: /tmp/training-data-535k.json
 */

import { buildEpisodeDataset } from "../server/historical-simulator";
import { generateIntradayEpisodes, intradayToPPOEpisodes } from "../server/intraday-episode-generator";
import { buildPPOState } from "../server/ppo-agent";
import { normalizeForInference } from "../server/ppo-inference";
import { barResolutionStats } from "../server/exact-outcome";
import fs from "fs";
import path from "path";

const OUTPUT_FILE = path.resolve(__dirname, "../data/training-data-535k.json");
const timeSlots = [0.35, 0.48, 0.65];

console.log("=== Export Training Data with Exact Outcomes ===\n");

// Step 1: Daily episodes (small, ~2000)
console.log("Step 1: Building daily episodes...");
const dailyDataset = buildEpisodeDataset();
console.log(`  Daily: ${dailyDataset.length}`);

// Step 2: Intraday episodes (large, ~535K) — generated per-symbol to save memory
console.log("Step 2: Building intraday episodes with exact outcomes (1-min + TV bars)...");
const intradayRaw = generateIntradayEpisodes();
console.log(`  Intraday raw: ${intradayRaw.length.toLocaleString()}`);

// Count exact outcomes
const withExact = intradayRaw.filter(ep => ep.has1MinData).length;
console.log(`  With exact intraday outcomes: ${withExact.toLocaleString()} (${(withExact / Math.max(intradayRaw.length, 1) * 100).toFixed(1)}%)`);
console.log(`  Bar resolution breakdown: 1-min=${barResolutionStats["1min"].toLocaleString()}, 1h=${barResolutionStats["1h"].toLocaleString()}, 2h=${barResolutionStats["2h"].toLocaleString()}, 4h=${barResolutionStats["4h"].toLocaleString()}, none=${barResolutionStats["none"].toLocaleString()}`);

// Step 3: Convert to PPO episodes
console.log("Step 3: Converting to PPO format...");
const intradayDataset = intradayToPPOEpisodes(intradayRaw);

// Free raw data
(intradayRaw as any).length = 0;

const fullDataset = [...dailyDataset, ...intradayDataset];
console.log(`  Total: ${fullDataset.length.toLocaleString()}`);

// Step 4: Normalize and export — write in chunks to avoid OOM
console.log("Step 4: Normalizing and exporting...");

const writeStream = fs.createWriteStream(OUTPUT_FILE);
writeStream.write("[");

let count = 0;
let skipped = 0;
let exactCount = 0;

for (let i = 0; i < fullDataset.length; i++) {
  const ep = fullDataset[i] as any;
  const timeNorm = timeSlots[i % timeSlots.length];

  try {
    const ppoState = buildPPOState(ep, timeNorm);
    const normalized = normalizeForInference(ppoState);

    // Validate
    if ((normalized.length !== 42 && normalized.length !== 46) || normalized.some(v => !isFinite(v))) {
      skipped++;
      continue;
    }

    const entry: any = {
      s: normalized.map(v => Math.round(v * 10000) / 10000), // reduce precision for smaller file
      date: ep.date,
      priceDeltaPct: ep.priceDeltaPct ?? 0,
      atrPct: ep.atrPct ?? 1.0,
      dayHigh: ep.dayHigh ?? 0,
      dayLow: ep.dayLow ?? 0,
      price: ep.price ?? 0,
    };

    // Add exact outcomes if available
    if (ep.has1MinData) {
      entry.has1Min = true;
      if (ep.exactOutcomeLong) entry.exactLong = ep.exactOutcomeLong;
      if (ep.exactOutcomeShort) entry.exactShort = ep.exactOutcomeShort;
      exactCount++;
    }

    if (count > 0) writeStream.write(",");
    writeStream.write(JSON.stringify(entry));
    count++;

    if (count % 50000 === 0) {
      console.log(`  Exported ${count.toLocaleString()}/${fullDataset.length.toLocaleString()} (${(count/fullDataset.length*100).toFixed(1)}%)`);
    }
  } catch {
    skipped++;
  }
}

writeStream.write("]");
writeStream.end();

writeStream.on("finish", () => {
  const sizeMB = fs.statSync(OUTPUT_FILE).size / 1024 / 1024;
  console.log(`\n=== EXPORT COMPLETE ===`);
  console.log(`Episodes: ${count.toLocaleString()}`);
  console.log(`Skipped: ${skipped.toLocaleString()}`);
  console.log(`With exact intraday outcomes: ${exactCount.toLocaleString()} (${(exactCount/count*100).toFixed(1)}%)`);
  console.log(`Bar resolution: 1-min=${barResolutionStats["1min"].toLocaleString()}, 1h=${barResolutionStats["1h"].toLocaleString()}, 2h=${barResolutionStats["2h"].toLocaleString()}, 4h=${barResolutionStats["4h"].toLocaleString()}, none=${barResolutionStats["none"].toLocaleString()}`);
  console.log(`File: ${OUTPUT_FILE} (${sizeMB.toFixed(1)} MB)`);
  console.log(`\nRun training: python3 scripts/train-multihead-cpu.py 500`);
});
