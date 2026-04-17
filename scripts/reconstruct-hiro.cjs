#!/usr/bin/env node
/**
 * HIRO Reconstruction from Raw Flow
 *
 * HIRO (High-frequency Institutional Real-time Order flow) is the #2 predictor
 * in the live system but only exists live. This script reconstructs it from
 * raw flow files for all historical days.
 *
 * Method:
 *   1. For each 15-min window, sum notional delta × side_multiplier across trades
 *   2. side_multiplier: BUY at ask = +1 (bullish hedging needed), SELL at bid = -1
 *   3. Normalize via rolling 20d percentile
 *
 * Output: data/historical/hiro-15min/YYYY-MM-DD.json
 *   Format: { date, bySym: { SPX: [{t0, t1, notional, percentile, trend}], ... } }
 *
 * Usage:
 *   node scripts/reconstruct-hiro.cjs
 *   node scripts/reconstruct-hiro.cjs 2025-04-01   # single day
 *   node scripts/reconstruct-hiro.cjs --skip-existing
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow");
const OUT_DIR = path.join(ROOT, "data", "historical", "hiro-15min");
const HISTORY_FILE = path.join(ROOT, "data", "historical", "hiro-rolling-history.json");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SKIP_EXISTING = args.includes("--skip-existing");
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SYMS = new Set(["SPX", "SPY", "QQQ", "DIA", "GLD", "VIX", "UVIX", "IWM"]);

// Classify trade aggression → side multiplier for HIRO sign
// BUY at ask = lifting offer → institutional buyer = +1
// SELL at bid = hitting bid → institutional seller = -1
// Passive = 0 (MM hedging, not directional)
function sideMultiplier(t) {
  if (!t.bid || !t.ask || t.ask <= t.bid) return 0;
  const mid = (t.bid + t.ask) / 2;
  const edgeFrac = (t.price - mid) / ((t.ask - t.bid) / 2);
  if (t.side === "BUY" && edgeFrac >= 0.4) return 1;
  if (t.side === "SELL" && edgeFrac <= -0.4) return -1;
  return 0;
}

// For HIRO interpretation, we need to know if the trade makes dealers
// net long or short gamma/delta.
// Dealers typically take the opposite side:
//   Trader BUYS call aggressively → Dealer SHORT call → needs to buy underlying if price rises
//   Trader SELLS put aggressively → Dealer LONG put → needs to buy underlying if price falls
// Net delta impact on dealer hedging:
//   BUY CALL aggressive → dealer delta = -delta_of_call (will need to buy stock)
//   SELL CALL aggressive → dealer delta = +delta_of_call
//   BUY PUT aggressive → dealer delta = -delta_of_put (negative number, so dealer long delta)
//   SELL PUT aggressive → dealer delta = +delta_of_put (negative, dealer short delta)
// HIRO = dealer-pressure-to-buy-underlying (positive = bullish hedging)
function hiroContribution(t) {
  const agg = sideMultiplier(t);
  if (agg === 0) return 0;
  // The delta in trade is already the contract's delta (positive for calls, negative for puts)
  // Approximate dealer hedging pressure:
  //   aggressive BUY CALL → dealer sold calls → must buy stock → +delta hedging (bullish)
  //   aggressive SELL CALL → dealer bought calls → -delta hedging (bearish)
  //   aggressive BUY PUT → dealer sold puts → -delta hedging (bearish)
  //   aggressive SELL PUT → dealer bought puts → +delta hedging (bullish)
  const callPutSign = t.cp === "C" ? 1 : -1;
  // Pressure = -agg × callPutSign × |delta| × size
  // For calls bought aggressively (agg=+1, cp=+1) → pressure = -1 × 1 × delta = negative
  // But HIRO convention: positive HIRO = institutional bullish pressure
  // So we flip: pressure = agg × callPutSign × |delta| × size_factor
  const absDelta = Math.abs(t.delta || 0);
  return agg * callPutSign * absDelta;
}

async function processDay(dateStr) {
  const inFile = path.join(FLOW_DIR, `${dateStr}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${dateStr}.json`);
  if (SKIP_EXISTING && fs.existsSync(outFile)) return { date: dateStr, skipped: true };
  if (!fs.existsSync(inFile)) return { date: dateStr, error: "no_flow" };

  const bySymWindow = {}; // sym_windowStart → { contrib, trades }

  const rl = readline.createInterface({
    input: fs.createReadStream(inFile).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !SYMS.has(t.sym) || !t.ts || !t.delta || !t.cp) continue;
    const contrib = hiroContribution(t);
    if (contrib === 0) continue;

    const windowStart = Math.floor(t.ts / WINDOW_MS) * WINDOW_MS;
    const key = `${t.sym}_${windowStart}`;
    if (!bySymWindow[key]) bySymWindow[key] = { sym: t.sym, t0: windowStart, contrib: 0, trades: 0, absDelta: 0 };
    bySymWindow[key].contrib += contrib;
    bySymWindow[key].trades++;
    bySymWindow[key].absDelta += Math.abs(t.delta || 0);
  }

  // Group by sym → sorted time series
  const bySym = {};
  for (const rec of Object.values(bySymWindow)) {
    if (!bySym[rec.sym]) bySym[rec.sym] = [];
    bySym[rec.sym].push({
      t0: rec.t0,
      t0iso: new Date(rec.t0).toISOString(),
      contrib: Math.round(rec.contrib),
      trades: rec.trades,
      absDelta: Math.round(rec.absDelta),
    });
  }
  for (const sym of Object.keys(bySym)) {
    bySym[sym].sort((a, b) => a.t0 - b.t0);
  }

  // Day-level aggregates for percentile normalization (done later cross-days)
  const dayAgg = {};
  for (const sym of Object.keys(bySym)) {
    const contribs = bySym[sym].map(w => w.contrib);
    const sum = contribs.reduce((a, b) => a + b, 0);
    dayAgg[sym] = {
      totalContrib: sum,
      nWindows: contribs.length,
      min: Math.min(...contribs),
      max: Math.max(...contribs),
    };
  }

  const out = { date: dateStr, lines, bySym, dayAgg, generatedAt: new Date().toISOString() };
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { date: dateStr, lines, syms: Object.keys(bySym).length };
}

async function normalizePercentiles() {
  // After all days processed, compute rolling 20-day percentile for each (sym, hour-of-day).
  // This gives HIRO a comparable scale across days, like the live system does.
  console.log("\nNormalizing percentiles (rolling 20d)...");

  const files = fs.readdirSync(OUT_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const history = {}; // sym → array of daily totals for rolling pctl

  for (const f of files) {
    const dateStr = f.replace(".json", "");
    const dayData = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    if (!dayData.bySym) continue;

    // For each 15-min window in each sym, compute its percentile vs last 20 days of windows
    for (const [sym, windows] of Object.entries(dayData.bySym)) {
      if (!history[sym]) history[sym] = [];
      // Compute values from this day to add to history
      const todayAbs = windows.map(w => Math.abs(w.contrib));
      history[sym].push({ date: dateStr, values: todayAbs });
      // Keep last 20 days
      if (history[sym].length > 20) history[sym] = history[sym].slice(-20);

      // Compute percentile for each window
      const poolValues = history[sym].flatMap(h => h.values).sort((a, b) => a - b);
      if (poolValues.length === 0) continue;
      for (const w of windows) {
        const abs = Math.abs(w.contrib);
        // Find rank of abs in sorted pool
        let rank = 0;
        for (let i = 0; i < poolValues.length; i++) {
          if (poolValues[i] < abs) rank++;
          else break;
        }
        const pctl = Math.round((rank / poolValues.length) * 100);
        w.percentile = w.contrib >= 0 ? pctl : -pctl; // sign carries direction
        w.trend = pctl >= 70 ? (w.contrib >= 0 ? "bullish_strong" : "bearish_strong") :
                   pctl >= 40 ? (w.contrib >= 0 ? "bullish" : "bearish") : "neutral";
      }
    }

    // Overwrite file with percentile-enriched data
    fs.writeFileSync(path.join(OUT_DIR, f), JSON.stringify(dayData));
  }
  console.log("  percentile normalization done.");
}

async function main() {
  const days = dayArg
    ? [dayArg]
    : fs.readdirSync(FLOW_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
        .map(f => f.replace(".jsonl.gz", ""))
        .sort();

  console.log(`Processing ${days.length} days for HIRO reconstruction...`);
  const startTime = Date.now();
  let processed = 0, skipped = 0, errored = 0;

  for (const day of days) {
    const t0 = Date.now();
    try {
      const res = await processDay(day);
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      if (res.skipped) skipped++;
      else if (res.error) { errored++; console.log(`  ${day} ERROR: ${res.error}`); }
      else { processed++; console.log(`  ${day} OK — ${res.lines} lines, ${res.syms} syms, ${el}s`); }
    } catch (e) { errored++; console.error(`  ${day} FATAL:`, e.message); }
  }

  // Normalize percentiles across all days
  if (processed > 0 || !SKIP_EXISTING) {
    await normalizePercentiles();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} processed, ${skipped} skipped, ${errored} errored. ${elapsed}s total.`);
}

main().catch(e => { console.error(e); process.exit(1); });
