#!/usr/bin/env node
/**
 * Preprocess options flow history into compact features per day.
 *
 * Reads: data/historical/flow/YYYY-MM-DD.jsonl.gz (per-trade stream)
 * Writes: data/historical/flow-features/YYYY-MM-DD.json (aggregates)
 *
 * Aggregates on 3 axes:
 *   - bySymStrike: { "SPX_5765": {trades, premium, delta, gamma, inst, opening, ...} }
 *   - bySymHour:   { "SPX_14":   {...} }
 *   - byStrikeHour:{ "SPX_5765_14": {...} }  (intraday granularity)
 *
 * Also produces an overall day summary.
 *
 * Usage:
 *   node scripts/preprocess-flow-history.cjs            # all days
 *   node scripts/preprocess-flow-history.cjs 2024-11-01 # single day
 *   node scripts/preprocess-flow-history.cjs --skip-existing
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow");
const OUT_DIR = path.join(ROOT, "data", "historical", "flow-features");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SKIP_EXISTING = args.includes("--skip-existing");
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

// Tier thresholds
const INST_THRESHOLD = 50000;      // >=$50K
const MEDIUM_THRESHOLD = 10000;    // $10K-$50K
// retail = <$10K

function classifyExpiry(tradeTs, expTs) {
  if (!expTs) return "unknown";
  const daysToExp = (expTs - tradeTs) / 86400000;
  if (daysToExp < 1) return "dte0";
  if (daysToExp <= 7) return "weekly";
  if (daysToExp <= 45) return "monthly";
  return "leaps";
}

// Classify aggressive direction based on price vs spread
//   aggBuy  = BUY at/above mid  (lifted offer, bullish pressure)
//   aggSell = SELL at/below mid (hit bid, bearish pressure)
//   passive = price near mid (MM activity, hedging, or resting orders)
function classifyAggression(trade) {
  const { side, price, bid, ask } = trade;
  if (!bid || !ask || !price || ask <= bid) return "passive";
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const edgeFrac = (price - mid) / (spread / 2); // -1 at bid, +1 at ask
  if (side === "BUY" && edgeFrac >= 0.4) return "aggBuy";
  if (side === "SELL" && edgeFrac <= -0.4) return "aggSell";
  return "passive";
}

// Size-to-prevOI ratio bucket (opening proxy — trades with high ratio likely opening new positions)
function openingLikelihood(size, prevOI) {
  if (!prevOI || prevOI < 10) return "highOpen"; // brand new contract
  const r = size / prevOI;
  if (r >= 0.5) return "highOpen";
  if (r >= 0.1) return "medOpen";
  return "lowOpen"; // more likely rolling/closing
}

function emptyBucket() {
  return {
    trades: 0, premium: 0,
    callPrem: 0, putPrem: 0,
    callTrades: 0, putTrades: 0,
    netDelta: 0, netGamma: 0,
    totalSize: 0,
    inst: 0, med: 0, retail: 0,
    aggBuy: 0, aggSell: 0, passive: 0,
    aggBuyPrem: 0, aggSellPrem: 0, passivePrem: 0,
    highOpen: 0, medOpen: 0, lowOpen: 0,
    bullPrem: 0, bearPrem: 0,
    exp: { dte0: 0, weekly: 0, monthly: 0, leaps: 0, unknown: 0 },
    largest: [],   // top-5 trades by premium
    firstTs: null, lastTs: null,
  };
}

function addToBucket(b, trade, agg, openness, expClass) {
  b.trades++;
  b.premium += trade.premium || 0;
  if (trade.cp === "C") { b.callPrem += trade.premium || 0; b.callTrades++; }
  else if (trade.cp === "P") { b.putPrem += trade.premium || 0; b.putTrades++; }
  b.netDelta += trade.delta || 0;
  b.netGamma += trade.gamma || 0;
  b.totalSize += trade.size || 0;
  if (trade.premium >= INST_THRESHOLD) b.inst++;
  else if (trade.premium >= MEDIUM_THRESHOLD) b.med++;
  else b.retail++;
  b[agg]++;
  b[agg + "Prem"] += trade.premium || 0;
  b[openness]++;
  b.exp[expClass]++;
  // Bull/Bear heuristic: call buy + put sell = bull; call sell + put buy = bear
  if ((trade.cp === "C" && trade.side === "BUY") || (trade.cp === "P" && trade.side === "SELL")) {
    b.bullPrem += trade.premium || 0;
  } else if ((trade.cp === "C" && trade.side === "SELL") || (trade.cp === "P" && trade.side === "BUY")) {
    b.bearPrem += trade.premium || 0;
  }
  // Track top-5 largest
  if (trade.premium > 10000) {
    b.largest.push({
      prem: Math.round(trade.premium),
      cp: trade.cp, side: trade.side, strike: trade.strike,
      delta: Math.round(trade.delta || 0),
      agg, openness, exp: expClass,
    });
    if (b.largest.length > 5) {
      b.largest.sort((a, c) => c.prem - a.prem);
      b.largest = b.largest.slice(0, 5);
    }
  }
  if (b.firstTs === null || trade.ts < b.firstTs) b.firstTs = trade.ts;
  if (b.lastTs === null || trade.ts > b.lastTs) b.lastTs = trade.ts;
}

function finalizeBucket(b) {
  if (b.largest.length > 1) b.largest.sort((a, c) => c.prem - a.prem);
  // Round
  for (const k of ["premium","callPrem","putPrem","netDelta","netGamma","bullPrem","bearPrem","aggBuyPrem","aggSellPrem","passivePrem"]) {
    b[k] = Math.round(b[k]);
  }
  return b;
}

async function processDay(dateStr) {
  const inFile = path.join(FLOW_DIR, `${dateStr}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${dateStr}.json`);
  if (SKIP_EXISTING && fs.existsSync(outFile)) {
    return { date: dateStr, skipped: true };
  }
  if (!fs.existsSync(inFile)) {
    return { date: dateStr, error: "no_flow_file" };
  }

  const bySymStrike = {};
  const bySymHour = {};
  const byStrikeHour = {};
  const bySym = {};

  const rl = readline.createInterface({
    input: fs.createReadStream(inFile).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let totalLines = 0, parseErrors = 0;
  for await (const line of rl) {
    if (!line) continue;
    totalLines++;
    let t;
    try { t = JSON.parse(line); } catch { parseErrors++; continue; }
    if (!t.sym || !t.strike) continue; // skip malformed

    // Derive hour of trade (UTC hour — backtest code aligns timezones later)
    const hour = new Date(t.ts).getUTCHours();
    const agg = classifyAggression(t);
    const openness = openingLikelihood(t.size, t.prevOI);
    const expClass = classifyExpiry(t.ts, t.exp);

    // Keys
    const kStrike = `${t.sym}_${t.strike}`;
    const kHour = `${t.sym}_${hour}`;
    const kStrikeHour = `${t.sym}_${t.strike}_${hour}`;

    if (!bySymStrike[kStrike]) bySymStrike[kStrike] = emptyBucket();
    if (!bySymHour[kHour]) bySymHour[kHour] = emptyBucket();
    if (!byStrikeHour[kStrikeHour]) byStrikeHour[kStrikeHour] = emptyBucket();
    if (!bySym[t.sym]) bySym[t.sym] = emptyBucket();

    addToBucket(bySymStrike[kStrike], t, agg, openness, expClass);
    addToBucket(bySymHour[kHour], t, agg, openness, expClass);
    addToBucket(byStrikeHour[kStrikeHour], t, agg, openness, expClass);
    addToBucket(bySym[t.sym], t, agg, openness, expClass);
  }

  // Finalize
  for (const b of Object.values(bySymStrike)) finalizeBucket(b);
  for (const b of Object.values(bySymHour)) finalizeBucket(b);
  for (const b of Object.values(byStrikeHour)) finalizeBucket(b);
  for (const b of Object.values(bySym)) finalizeBucket(b);

  const out = {
    date: dateStr,
    totalLines, parseErrors,
    bySym,                // per-symbol day totals
    bySymStrike,          // per-symbol-strike day totals
    bySymHour,            // per-symbol-hour day totals
    byStrikeHour,         // per-symbol-strike-hour intraday
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(outFile, JSON.stringify(out));
  return { date: dateStr, trades: totalLines, strikes: Object.keys(bySymStrike).length };
}

async function main() {
  const days = dayArg
    ? [dayArg]
    : fs.readdirSync(FLOW_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
        .map(f => f.replace(".jsonl.gz", ""))
        .sort();

  console.log(`Processing ${days.length} days...`);
  const startTime = Date.now();
  let processed = 0, skipped = 0, errored = 0;

  for (const day of days) {
    const t0 = Date.now();
    try {
      const res = await processDay(day);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (res.skipped) { skipped++; console.log(`  ${day} SKIP (exists)`); }
      else if (res.error) { errored++; console.log(`  ${day} ERROR: ${res.error}`); }
      else { processed++; console.log(`  ${day} OK — ${res.trades} trades, ${res.strikes} strikes, ${elapsed}s`); }
    } catch (e) {
      errored++;
      console.error(`  ${day} FATAL:`, e.message);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} processed, ${skipped} skipped, ${errored} errored. ${totalElapsed}s total.`);
}

main().catch(e => { console.error(e); process.exit(1); });
