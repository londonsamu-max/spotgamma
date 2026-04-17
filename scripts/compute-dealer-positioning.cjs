#!/usr/bin/env node
/**
 * Dealer Positioning Inference
 *
 * Estimate dealer's net option position per strike by aggregating all trades
 * and taking the opposite side (market makers absorb retail/institutional flow).
 *
 * Per strike per day:
 *   dealer_net_calls_bought = retail_sold_calls - retail_bought_calls (net)
 *   dealer_net_puts_bought = retail_sold_puts - retail_bought_puts (net)
 *   dealer_delta_exposure = sum(delta × size × dealer_side)
 *   dealer_gamma_exposure = sum(gamma × size × dealer_side)
 *
 * These give us dealer hedging DEMAND per strike (absent from snapshots).
 *
 * Output: data/historical/dealer-pos/YYYY-MM-DD.json
 *   { date, bySymStrike: { "SPX_5800": { dealerDelta, dealerGamma, dealerCallsNet, dealerPutsNet, ... } } }
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow");
const OUT_DIR = path.join(ROOT, "data", "historical", "dealer-pos");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SKIP_EXISTING = args.includes("--skip-existing");
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const SYMS = new Set(["SPX", "SPY", "QQQ", "DIA", "GLD"]);
const MIN_AGGRESSION = 0.3; // trade must be aggressive enough to infer dealer side

// Returns +1 if trade is aggressive buy (retail bought → dealer sold)
// -1 if aggressive sell, 0 if passive
function tradeAggression(t) {
  if (!t.bid || !t.ask || t.ask <= t.bid) return 0;
  const mid = (t.bid + t.ask) / 2;
  const edge = (t.price - mid) / ((t.ask - t.bid) / 2);
  if (t.side === "BUY" && edge >= MIN_AGGRESSION) return 1;
  if (t.side === "SELL" && edge <= -MIN_AGGRESSION) return -1;
  return 0;
}

async function processDay(dateStr) {
  const inFile = path.join(FLOW_DIR, `${dateStr}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${dateStr}.json`);
  if (SKIP_EXISTING && fs.existsSync(outFile)) return { date: dateStr, skipped: true };
  if (!fs.existsSync(inFile)) return { date: dateStr, error: "no_flow" };

  const bySymStrike = {};

  const rl = readline.createInterface({
    input: fs.createReadStream(inFile).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !SYMS.has(t.sym) || !t.strike || !t.cp) continue;

    const agg = tradeAggression(t);
    if (agg === 0) continue; // can't infer dealer side from passive trades

    // Dealer takes opposite side
    // If agg=+1 (retail bought) → dealer sold this contract → dealer short 1 contract
    // Dealer's delta/gamma exposure CHANGE = -agg × contract_delta/gamma × size
    const dealerSide = -agg;
    const size = t.size || 1;

    const key = `${t.sym}_${t.strike}`;
    if (!bySymStrike[key]) {
      bySymStrike[key] = {
        sym: t.sym, strike: t.strike,
        dealerCallsNet: 0,  // >0 = dealer net long calls; <0 = dealer net short calls
        dealerPutsNet: 0,
        dealerDelta: 0,     // net delta exposure dealer has
        dealerGamma: 0,     // net gamma exposure dealer has
        nTradesInferred: 0,
        premiumSum: 0,
      };
    }
    const b = bySymStrike[key];
    b.nTradesInferred++;
    b.premiumSum += t.premium || 0;

    if (t.cp === "C") {
      b.dealerCallsNet += dealerSide * size;
    } else if (t.cp === "P") {
      b.dealerPutsNet += dealerSide * size;
    }
    b.dealerDelta += dealerSide * (t.delta || 0) * size;
    b.dealerGamma += dealerSide * (t.gamma || 0) * size;
  }

  // Finalize
  for (const b of Object.values(bySymStrike)) {
    b.dealerDelta = Math.round(b.dealerDelta);
    b.dealerGamma = Math.round(b.dealerGamma);
    b.premiumSum = Math.round(b.premiumSum);
    // Net position interpretation
    b.netPositionType =
      b.dealerCallsNet < -10 && b.dealerPutsNet < -10 ? "short_both_fragile" :
      b.dealerCallsNet < -10 ? "short_calls_resistance" :
      b.dealerPutsNet > 10 ? "long_puts_support" :
      b.dealerPutsNet < -10 ? "short_puts_fragile_support" :
      b.dealerCallsNet > 10 ? "long_calls_support" :
      "balanced";
  }

  const out = { date: dateStr, bySymStrike, nStrikes: Object.keys(bySymStrike).length };
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { date: dateStr, strikes: Object.keys(bySymStrike).length };
}

async function main() {
  const days = dayArg
    ? [dayArg]
    : fs.readdirSync(FLOW_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
        .map(f => f.replace(".jsonl.gz", ""))
        .sort();

  console.log(`Processing ${days.length} days for dealer positioning...`);
  const startTime = Date.now();
  let processed = 0;

  for (const day of days) {
    const t0 = Date.now();
    const res = await processDay(day);
    if (res.skipped) continue;
    if (res.error) { console.log(`  ${day} ERROR ${res.error}`); continue; }
    processed++;
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${day} — ${res.strikes} strikes, ${el}s`);
  }

  const el = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} days. ${el}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
