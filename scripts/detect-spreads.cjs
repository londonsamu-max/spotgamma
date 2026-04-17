#!/usr/bin/env node
/**
 * Institutional Spread Detector
 *
 * Scans raw flow for multi-leg spread patterns:
 *   - Call spread: BUY low-strike CALL + SELL high-strike CALL, same exp, within 5s
 *   - Put spread: BUY high-strike PUT + SELL low-strike PUT, same exp, within 5s
 *   - Straddle: BUY CALL + BUY PUT at same strike, same exp
 *   - Strangle: BUY CALL + BUY PUT at different strikes, same exp
 *   - Iron condor: SELL put spread + SELL call spread
 *
 * Output: data/historical/spreads/YYYY-MM-DD.json
 *   Format: { date, spreads: [{type, legs[], strikes[], totalPrem, sym, implication, targetRange}] }
 *
 * Each spread gives implicit price targets / ranges the institutional is betting on.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow");
const OUT_DIR = path.join(ROOT, "data", "historical", "spreads");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SKIP_EXISTING = args.includes("--skip-existing");
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const WINDOW_MS = 2000;  // tighter window — spreads usually <2s
const MIN_LEG_PREMIUM = 5000;   // filter noise — individual leg >=$5K
const MIN_SPREAD_PREMIUM = 20000; // combined >=$20K
const SYMS = new Set(["SPX", "SPY", "QQQ", "DIA", "GLD", "VIX"]);

function parseSideAgg(t) {
  if (!t.bid || !t.ask || t.ask <= t.bid) return "passive";
  const mid = (t.bid + t.ask) / 2;
  const edge = (t.price - mid) / ((t.ask - t.bid) / 2);
  if (t.side === "BUY" && edge >= 0.4) return "aggBuy";
  if (t.side === "SELL" && edge <= -0.4) return "aggSell";
  return "passive";
}

// Identify spread type from list of 2-4 trades
function classifySpread(trades) {
  if (trades.length < 2) return null;
  // Must have same sym and same expiration
  const sym = trades[0].sym, exp = trades[0].exp;
  if (!trades.every(t => t.sym === sym && t.exp === exp)) return null;

  // Total premium
  const totalPrem = trades.reduce((s, t) => s + (t.premium || 0), 0);
  if (totalPrem < MIN_SPREAD_PREMIUM) return null;

  // Separate calls and puts
  const calls = trades.filter(t => t.cp === "C").sort((a, b) => a.strike - b.strike);
  const puts = trades.filter(t => t.cp === "P").sort((a, b) => a.strike - b.strike);

  // 2-leg patterns
  if (trades.length === 2) {
    // Call spread: buy low, sell high (bullish) OR buy high, sell low (bearish)
    if (calls.length === 2 && puts.length === 0) {
      const [low, high] = calls;
      const lowAgg = parseSideAgg(low), highAgg = parseSideAgg(high);
      if (lowAgg === "aggBuy" && highAgg === "aggSell") {
        return {
          type: "bull_call_spread", sym, exp, totalPrem,
          strikes: [low.strike, high.strike],
          bias: "bullish",
          targetRange: { low: low.strike, high: high.strike },
          maxProfit: (high.strike - low.strike) - (low.price - high.price),
          implication: `Apuesta precio sube hacia ${high.strike} — TP implícito`,
        };
      }
      if (lowAgg === "aggSell" && highAgg === "aggBuy") {
        return {
          type: "bear_call_spread", sym, exp, totalPrem,
          strikes: [low.strike, high.strike],
          bias: "bearish",
          targetRange: { low: low.strike, high: high.strike },
          implication: `Apuesta precio se queda debajo de ${low.strike} — resistencia implícita`,
        };
      }
    }
    // Put spread
    if (puts.length === 2 && calls.length === 0) {
      const [low, high] = puts;
      const lowAgg = parseSideAgg(low), highAgg = parseSideAgg(high);
      if (highAgg === "aggBuy" && lowAgg === "aggSell") {
        return {
          type: "bear_put_spread", sym, exp, totalPrem,
          strikes: [low.strike, high.strike],
          bias: "bearish",
          targetRange: { low: low.strike, high: high.strike },
          implication: `Apuesta precio baja hacia ${low.strike} — TP implícito`,
        };
      }
      if (highAgg === "aggSell" && lowAgg === "aggBuy") {
        return {
          type: "bull_put_spread", sym, exp, totalPrem,
          strikes: [low.strike, high.strike],
          bias: "bullish",
          targetRange: { low: low.strike, high: high.strike },
          implication: `Apuesta precio se queda arriba de ${high.strike} — soporte implícito`,
        };
      }
    }
    // Straddle (both at same strike)
    if (calls.length === 1 && puts.length === 1 && calls[0].strike === puts[0].strike) {
      const cAgg = parseSideAgg(calls[0]), pAgg = parseSideAgg(puts[0]);
      if (cAgg === "aggBuy" && pAgg === "aggBuy") {
        return {
          type: "long_straddle", sym, exp, totalPrem,
          strikes: [calls[0].strike],
          bias: "volatility_expansion",
          implication: `Apuesta mov grande desde ${calls[0].strike} — esperan breakout`,
        };
      }
      if (cAgg === "aggSell" && pAgg === "aggSell") {
        return {
          type: "short_straddle", sym, exp, totalPrem,
          strikes: [calls[0].strike],
          bias: "pin",
          implication: `Apuesta precio se queda cerca de ${calls[0].strike} — PIN fuerte`,
        };
      }
    }
    // Strangle
    if (calls.length === 1 && puts.length === 1 && calls[0].strike !== puts[0].strike) {
      const cAgg = parseSideAgg(calls[0]), pAgg = parseSideAgg(puts[0]);
      if (cAgg === "aggBuy" && pAgg === "aggBuy") {
        return {
          type: "long_strangle", sym, exp, totalPrem,
          strikes: [puts[0].strike, calls[0].strike],
          bias: "volatility_expansion",
          implication: `Apuesta break fuera rango ${puts[0].strike}-${calls[0].strike}`,
        };
      }
      if (cAgg === "aggSell" && pAgg === "aggSell") {
        return {
          type: "short_strangle", sym, exp, totalPrem,
          strikes: [puts[0].strike, calls[0].strike],
          bias: "range",
          implication: `Apuesta precio se queda en rango ${puts[0].strike}-${calls[0].strike}`,
        };
      }
    }
  }

  // 4-leg: iron condor
  if (trades.length === 4 && calls.length === 2 && puts.length === 2) {
    // Need: bear call spread + bull put spread
    const [putLow, putHigh] = puts;
    const [callLow, callHigh] = calls;
    const phAgg = parseSideAgg(putHigh), plAgg = parseSideAgg(putLow);
    const clAgg = parseSideAgg(callLow), chAgg = parseSideAgg(callHigh);
    if (plAgg === "aggBuy" && phAgg === "aggSell" && clAgg === "aggSell" && chAgg === "aggBuy") {
      return {
        type: "iron_condor", sym, exp, totalPrem,
        strikes: [putLow.strike, putHigh.strike, callLow.strike, callHigh.strike],
        bias: "range",
        targetRange: { low: putHigh.strike, high: callLow.strike },
        implication: `Apuesta precio entre ${putHigh.strike}-${callLow.strike} — rango confianza alta`,
      };
    }
  }

  return null;
}

async function processDay(dateStr) {
  const inFile = path.join(FLOW_DIR, `${dateStr}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${dateStr}.json`);
  if (SKIP_EXISTING && fs.existsSync(outFile)) return { date: dateStr, skipped: true };
  if (!fs.existsSync(inFile)) return { date: dateStr, error: "no_flow" };

  // Buffer of recent trades (all trades in last WINDOW_MS)
  const buffer = [];
  const spreads = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(inFile).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !SYMS.has(t.sym) || !t.ts) continue;
    if ((t.premium || 0) < MIN_LEG_PREMIUM) continue; // filter noise early

    // Drop from buffer trades older than window
    while (buffer.length > 0 && t.ts - buffer[0].ts > WINDOW_MS) buffer.shift();

    // Only 2-leg spreads (most common, O(N × buffer))
    // Match against same sym + same exp + close ts
    for (let i = buffer.length - 1; i >= 0; i--) {
      const c = buffer[i];
      if (c.sym !== t.sym || c.exp !== t.exp) continue;
      if (c.strike === t.strike && c.cp === t.cp) continue; // skip same contract
      const spread = classifySpread([c, t]);
      if (spread) {
        spreads.push({ ts: t.ts, ...spread });
        break; // only match first valid pair
      }
    }

    buffer.push(t);
  }

  const out = { date: dateStr, spreads, total: spreads.length };
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { date: dateStr, spreads: spreads.length };
}

async function main() {
  const days = dayArg
    ? [dayArg]
    : fs.readdirSync(FLOW_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
        .map(f => f.replace(".jsonl.gz", ""))
        .sort();

  console.log(`Processing ${days.length} days for spread detection...`);
  const startTime = Date.now();
  let processed = 0, totalSpreads = 0;

  for (const day of days) {
    const t0 = Date.now();
    const res = await processDay(day);
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    if (res.skipped) continue;
    if (res.error) { console.log(`  ${day} ERROR ${res.error}`); continue; }
    processed++;
    totalSpreads += res.spreads;
    console.log(`  ${day} — ${res.spreads} spreads, ${el}s`);
  }

  const el = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} days, ${totalSpreads} spreads detected. ${el}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
