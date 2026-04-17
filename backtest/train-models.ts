/**
 * Train both models using 300 days of historical data (Jan 2025 - Feb 2026).
 *
 * 1. Drift Model: ETF→CFD ratio by hour + VIX regime
 * 2. Bounce Model: logistic regression on bar-touch events
 *
 * Test set: March 2026 (out-of-sample)
 *
 * Usage: npx tsx backtest/train-models.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildDriftModel } from "./models/drift-model.js";
import { trainBounceModel, type TrainingExample, type BounceFeatures } from "./models/bounce-model.js";
import { loadOhlc1Min, loadMt5Day } from "./data-loaders/price-provider.js";
import { getTopGammaBars, CFD_SYMBOLS, loadGammaBars, computeConversionRatio } from "./data-loaders/gamma-provider.js";
import { getRegime } from "./data-loaders/synth-oi-loader.js";
import { getMacroContext } from "./data-loaders/macro-loader.js";
import { getRiskReversal } from "./data-loaders/risk-reversal-loader.js";
import type { CFD, GammaBar } from "./utils/types.js";

const HIST = path.resolve(process.cwd(), "data/historical");
const TRAIN_START = "2025-01-01";
const TRAIN_END = "2026-02-28";
const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];
const PRIMARY_ETF: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };
const OI_SYM: Record<CFD, string> = { NAS100: "SPX", US30: "DIA", XAUUSD: "GLD" };

function findDays(): string[] {
  const dir = path.join(HIST, "gamma-bars");
  return fs.readdirSync(dir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= TRAIN_START && d <= TRAIN_END)
    .sort();
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  TRAINING MODELS (Jan 2025 → Feb 2026)");
  console.log("═══════════════════════════════════════════\n");

  // ── 1. Drift Models ──
  console.log("▶ DRIFT MODELS");
  for (const cfd of CFDS) {
    await buildDriftModel(cfd, TRAIN_START, TRAIN_END);
  }

  // ── 2. Bounce Model ──
  console.log("\n▶ BOUNCE MODEL — collecting bar-touch events...");

  const days = findDays();
  const examples: TrainingExample[] = [];
  let skipped = 0;

  for (let di = 0; di < days.length; di++) {
    const date = days[di];
    const dow = new Date(date + "T12:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    for (const cfd of CFDS) {
      const etfSym = PRIMARY_ETF[cfd];
      const etfBars = loadOhlc1Min(etfSym, date);
      const cfdCandles = loadMt5Day(cfd, date, "M15");
      if (etfBars.length < 10 || cfdCandles.length < 5) continue;

      // Get fat gamma bars for this day
      const etfSpotPrices: Record<string, number> = {};
      for (const sym of CFD_SYMBOLS[cfd]) {
        const gb = loadGammaBars(date, sym);
        if (gb) etfSpotPrices[sym] = gb.spotPrice;
      }
      const cfdOpen = cfdCandles[0].open;
      const fatBars = getTopGammaBars(date, cfd, cfdOpen, etfSpotPrices, 10, Infinity)
        .filter(b => Math.abs(b.netGamma) > 100e6);

      // Get daily context
      const regime = getRegime(OI_SYM[cfd], date);
      const macro = getMacroContext(date);
      const rr = getRiskReversal(etfSym, date);

      if (!regime || !rr || rr.rr === null) { skipped++; continue; }

      // For each fat bar, check if ETF price touched it during the day
      for (const bar of fatBars) {
        const strike = bar.strike;
        const tol = { SPX: 2, QQQ: 0.3, SPY: 0.3, DIA: 0.3, GLD: 0.2 }[etfSym] ?? 1;

        // Find touch events
        for (let i = 1; i < etfBars.length; i++) {
          const c = etfBars[i];
          if (strike < c.l - tol || strike > c.h + tol) continue;

          // TOUCHED! Now determine: did it bounce or break?
          // Look at next 30 minutes of price action
          const futureCandles = etfBars.slice(i + 1, i + 31);
          if (futureCandles.length < 5) break;

          const priceAtTouch = c.c;
          const priceAfter30min = futureCandles[futureCandles.length - 1].c;
          const maxAdvance = Math.max(...futureCandles.map(f => f.h)) - priceAtTouch;
          const maxDecline = priceAtTouch - Math.min(...futureCandles.map(f => f.l));

          // Bounce = price moved AWAY from the bar direction
          // For support bar (gamma > 0): bounce = price went UP after touching
          // For resistance bar (gamma < 0): bounce = price went DOWN after touching
          let bounced: boolean;
          let pnlIfBounce: number;

          if (bar.netGamma > 0) {
            // Support bar — bounce means price went up
            bounced = priceAfter30min > priceAtTouch + tol;
            pnlIfBounce = priceAfter30min - priceAtTouch;
          } else {
            // Resistance bar — bounce (rejection) means price went down
            bounced = priceAfter30min < priceAtTouch - tol;
            pnlIfBounce = priceAtTouch - priceAfter30min;
          }

          const features: BounceFeatures = {
            vrp: regime.vrp,
            gammaSign: bar.netGamma > 0 ? 1 : -1,
            barSizeLog: Math.log10(Math.abs(bar.netGamma) + 1),
            riskReversal: rr.rr!,
            rrDelta5d: rr.rrDelta5d ?? 0,
            vixLevel: macro.vix ?? 18,
            ivRank: regime.ivRank,
            dayOfWeek: Math.max(0, dow - 1), // Mon=0..Fri=4
          };

          examples.push({ features, bounced, pnlIfBounce });

          // Only record FIRST touch per bar per day (avoid duplicates)
          break;
        }
      }
    }

    if ((di + 1) % 30 === 0) {
      console.log(`    Processed ${di + 1}/${days.length} days, ${examples.length} events so far...`);
    }
  }

  console.log(`\n  Total events: ${examples.length} (skipped ${skipped} days missing data)`);
  console.log(`  Bounce rate: ${(examples.filter(e => e.bounced).length / examples.length * 100).toFixed(1)}%`);
  console.log(`  Avg PnL if bounce: ${(examples.filter(e => e.bounced).reduce((s, e) => s + e.pnlIfBounce, 0) / examples.filter(e => e.bounced).length).toFixed(2)}`);

  if (examples.length < 50) {
    console.log("  ⚠️ Too few examples for reliable model. Need more data.");
    return;
  }

  // Train
  const model = trainBounceModel(examples);

  console.log("\n═══════════════════════════════════════════");
  console.log("  MODELS TRAINED SUCCESSFULLY");
  console.log(`  Drift: 3 CFD models saved`);
  console.log(`  Bounce: ${model.trainingSamples} samples, ${(model.accuracy * 100).toFixed(1)}% accuracy`);
  console.log(`  Feature importance:`);
  for (const [k, v] of Object.entries(model.featureImportance).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    const bar = "█".repeat(Math.round(v as number / 2));
    console.log(`    ${k.padEnd(16)} ${String(v).padStart(5)}% ${bar}`);
  }
  console.log("═══════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exit(1); });
