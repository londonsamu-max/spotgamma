/**
 * Pre-process raw flow .jsonl.gz files into lightweight summary files.
 *
 * For each day, streams ALL trades and produces per-5min-bucket aggregates:
 *   - HIRO (net delta per symbol)
 *   - Institutional trades (>$50K)
 *   - Strike concentration (top 10 strikes by premium)
 *   - P/C ratio
 *   - Aggressive flow
 *   - Expiry breakdown (0DTE, weekly, monthly, LEAPS)
 *   - Opening vs closing
 *
 * Output: data/historical/flow-processed/{date}.json (~50-200KB per day)
 *
 * Usage: npx tsx backtest/preprocess-flow.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as readline from "node:readline";

const FLOW_DIR = path.resolve(process.cwd(), "data/historical/flow");
const OUT_DIR = path.resolve(process.cwd(), "data/historical/flow-processed");
const BUCKET_MS = 5 * 60 * 1000;
const SYMBOLS = ["SPX", "QQQ", "SPY", "GLD", "DIA", "VIX"];

interface RawTrade {
  sym: string; ts: number; delta: number; gamma: number;
  strike: number; size: number; side: "BUY" | "SELL" | "UNK";
  price: number; bid: number; ask: number;
  iv: number; prevOI: number; premium: number;
  cp: "C" | "P"; exp: number;
}

interface BucketAgg {
  t: number; // bucket start
  sym: string;
  netDelta: number;
  netPremium: number;
  tradeCount: number;
  callCount: number;
  putCount: number;
  buyCount: number;
  sellCount: number;
  aggBuyPrem: number;
  aggSellPrem: number;
  instBullPrem: number;
  instBearPrem: number;
  instCount: number;
  largeDeltaNet: number;
  openingCount: number;
  closingCount: number;
  zeroDteNetDelta: number;
  weeklyNetDelta: number;
  monthlyNetDelta: number;
  leapsNetDelta: number;
  // Top strikes by premium in this bucket
  topStrikes: { strike: number; netPrem: number; netDelta: number; callPrem: number; putPrem: number; count: number }[];
  // Top institutional trades
  instTrades: { strike: number; cp: string; side: string; premium: number; delta: number; size: number; exp: number; aggressive: boolean }[];
}

function bucketKey(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

async function processDay(date: string): Promise<void> {
  const inFile = path.join(FLOW_DIR, `${date}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${date}.json`);

  if (fs.existsSync(outFile)) return; // already processed
  if (!fs.existsSync(inFile)) return;

  // Aggregate structure: sym → bucketTs → BucketAgg
  const agg = new Map<string, Map<number, BucketAgg>>();
  // Strike tracking per bucket per sym
  const strikeAgg = new Map<string, Map<number, Map<number, { netPrem: number; netDelta: number; callPrem: number; putPrem: number; count: number }>>>();

  const stream = fs.createReadStream(inFile).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let tradeCount = 0;

  for await (const line of rl) {
    if (!line.trim() || line.includes('"__meta":true')) continue;
    let t: RawTrade;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !t.ts || !SYMBOLS.includes(t.sym)) continue;
    tradeCount++;

    const bk = bucketKey(t.ts);
    const sign = t.side === "BUY" ? 1 : t.side === "SELL" ? -1 : 0;
    const absPrem = Math.abs(t.premium);
    const signedDelta = sign * t.delta * t.size;

    // Get/create bucket
    if (!agg.has(t.sym)) agg.set(t.sym, new Map());
    const symMap = agg.get(t.sym)!;
    if (!symMap.has(bk)) {
      symMap.set(bk, {
        t: bk, sym: t.sym,
        netDelta: 0, netPremium: 0, tradeCount: 0,
        callCount: 0, putCount: 0, buyCount: 0, sellCount: 0,
        aggBuyPrem: 0, aggSellPrem: 0,
        instBullPrem: 0, instBearPrem: 0, instCount: 0,
        largeDeltaNet: 0, openingCount: 0, closingCount: 0,
        zeroDteNetDelta: 0, weeklyNetDelta: 0, monthlyNetDelta: 0, leapsNetDelta: 0,
        topStrikes: [], instTrades: [],
      });
    }
    const b = symMap.get(bk)!;

    b.netDelta += signedDelta;
    b.netPremium += sign * t.premium;
    b.tradeCount++;
    if (t.cp === "C") b.callCount++; else b.putCount++;
    if (sign > 0) b.buyCount++; else if (sign < 0) b.sellCount++;

    // Aggressive
    if (t.side === "BUY" && t.price >= t.ask * 0.99) b.aggBuyPrem += absPrem;
    if (t.side === "SELL" && t.price <= t.bid * 1.01) b.aggSellPrem += absPrem;

    // Institutional
    if (absPrem >= 50000) {
      b.instCount++;
      if (signedDelta > 0) b.instBullPrem += absPrem;
      else b.instBearPrem += absPrem;
      const isAgg = (t.side === "BUY" && t.price >= t.ask * 0.99) || (t.side === "SELL" && t.price <= t.bid * 1.01);
      // Keep top 5 per bucket (by premium)
      if (b.instTrades.length < 5 || absPrem > (b.instTrades[b.instTrades.length - 1]?.premium ?? 0)) {
        b.instTrades.push({
          strike: t.strike, cp: t.cp, side: t.side,
          premium: t.premium, delta: t.delta, size: t.size,
          exp: t.exp, aggressive: isAgg,
        });
        b.instTrades.sort((a, b2) => Math.abs(b2.premium) - Math.abs(a.premium));
        if (b.instTrades.length > 5) b.instTrades.pop();
      }
    }

    // Large delta
    if (Math.abs(t.delta * t.size) > 1000000) b.largeDeltaNet += signedDelta;

    // Opening vs closing
    if (t.prevOI > 0 && t.size > t.prevOI * 0.1) b.openingCount++;
    else b.closingCount++;

    // Expiry bucket
    const dte = Math.round((t.exp - t.ts) / 86400000);
    if (dte <= 0) b.zeroDteNetDelta += signedDelta;
    else if (dte <= 5) b.weeklyNetDelta += signedDelta;
    else if (dte <= 30) b.monthlyNetDelta += signedDelta;
    else b.leapsNetDelta += signedDelta;

    // Strike aggregation
    if (!strikeAgg.has(t.sym)) strikeAgg.set(t.sym, new Map());
    const symStrikes = strikeAgg.get(t.sym)!;
    if (!symStrikes.has(bk)) symStrikes.set(bk, new Map());
    const bkStrikes = symStrikes.get(bk)!;
    if (!bkStrikes.has(t.strike)) bkStrikes.set(t.strike, { netPrem: 0, netDelta: 0, callPrem: 0, putPrem: 0, count: 0 });
    const s = bkStrikes.get(t.strike)!;
    s.netPrem += sign * t.premium;
    s.netDelta += signedDelta;
    if (t.cp === "C") s.callPrem += absPrem; else s.putPrem += absPrem;
    s.count++;
  }

  // Attach top 10 strikes per bucket
  for (const [sym, symMap] of agg) {
    const symStrikes = strikeAgg.get(sym);
    if (!symStrikes) continue;
    for (const [bk, bucket] of symMap) {
      const bkStrikes = symStrikes.get(bk);
      if (!bkStrikes) continue;
      const sorted = Array.from(bkStrikes.entries())
        .sort((a, b) => (b[1].callPrem + b[1].putPrem) - (a[1].callPrem + a[1].putPrem))
        .slice(0, 10);
      bucket.topStrikes = sorted.map(([strike, v]) => ({ strike, ...v }));
    }
  }

  // Build output: flat array of buckets sorted by sym then time
  const output: BucketAgg[] = [];
  for (const [, symMap] of agg) {
    for (const [, bucket] of symMap) {
      output.push(bucket);
    }
  }
  output.sort((a, b) => a.t - b.t || a.sym.localeCompare(b.sym));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output));
  const outSize = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`  ${date}: ${tradeCount} trades → ${output.length} buckets (${outSize}KB)`);
}

async function main() {
  const args = process.argv.slice(2);
  let startDate = "", endDate = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start") startDate = args[++i];
    if (args[i] === "--end") endDate = args[++i];
  }

  const files = fs.readdirSync(FLOW_DIR)
    .filter((f) => f.endsWith(".jsonl.gz"))
    .map((f) => f.replace(".jsonl.gz", ""))
    .filter((d) => {
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort();

  console.log(`Pre-processing ${files.length} flow files...`);
  const t0 = Date.now();

  for (const date of files) {
    await processDay(date);
  }

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Output: ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
