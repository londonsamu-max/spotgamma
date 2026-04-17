#!/usr/bin/env node
/**
 * Intraday Flow Patterns
 *
 * Per day, compute:
 *   - Strike center of mass (premium-weighted average strike) per 30-min window
 *   - Flow entropy per 30-min window (concentration indicator)
 *   - Opening 15-min flow imbalance (bull vs bear prem in first 15min)
 *   - Closing 30-min flow patterns
 *   - Flow burst detection (z-score of per-minute premium vs day avg)
 *
 * Output: data/historical/intraday-patterns/YYYY-MM-DD.json
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow");
const OUT_DIR = path.join(ROOT, "data", "historical", "intraday-patterns");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SKIP_EXISTING = args.includes("--skip-existing");
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const SYMS = new Set(["SPX", "SPY", "QQQ", "DIA", "GLD"]);
const WIN_30MIN = 30 * 60 * 1000;
const WIN_15MIN = 15 * 60 * 1000;

// Shannon entropy
function entropy(values) {
  const tot = values.reduce((a, b) => a + b, 0);
  if (tot <= 0) return 0;
  let h = 0;
  for (const v of values) {
    if (v > 0) {
      const p = v / tot;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

async function processDay(dateStr) {
  const inFile = path.join(FLOW_DIR, `${dateStr}.jsonl.gz`);
  const outFile = path.join(OUT_DIR, `${dateStr}.json`);
  if (SKIP_EXISTING && fs.existsSync(outFile)) return { date: dateStr, skipped: true };
  if (!fs.existsSync(inFile)) return { date: dateStr, error: "no_flow" };

  // Per-sym aggregation
  // by30MinWindow[sym][t0] → { strikes: {strike: prem}, bullPrem, bearPrem, trades, premSum }
  const bySym30 = {};
  // Opening 15 min bull vs bear per sym
  const opening = {};
  // Closing 30 min bull vs bear per sym
  const closing = {};
  // Day first/last timestamps per sym
  const dayBounds = {};
  // Per-minute premium for burst detection (only top 3 syms to save memory)
  const perMinPrem = {}; // sym → Map<minute_ms, premium>

  const rl = readline.createInterface({
    input: fs.createReadStream(inFile).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (!t.sym || !SYMS.has(t.sym) || !t.ts || !t.strike) continue;

    const prem = t.premium || 0;
    if (prem < 500) continue; // basic noise filter

    const isBull = (t.cp === "C" && t.side === "BUY") || (t.cp === "P" && t.side === "SELL");
    const isBear = (t.cp === "C" && t.side === "SELL") || (t.cp === "P" && t.side === "BUY");

    // 30-min window
    const win30 = Math.floor(t.ts / WIN_30MIN) * WIN_30MIN;
    if (!bySym30[t.sym]) bySym30[t.sym] = {};
    if (!bySym30[t.sym][win30]) {
      bySym30[t.sym][win30] = { strikes: {}, bullPrem: 0, bearPrem: 0, trades: 0, premSum: 0, strikesMap: new Map() };
    }
    const w = bySym30[t.sym][win30];
    w.trades++;
    w.premSum += prem;
    if (isBull) w.bullPrem += prem;
    if (isBear) w.bearPrem += prem;
    w.strikesMap.set(t.strike, (w.strikesMap.get(t.strike) || 0) + prem);

    // Track day bounds
    if (!dayBounds[t.sym]) dayBounds[t.sym] = { first: t.ts, last: t.ts };
    if (t.ts < dayBounds[t.sym].first) dayBounds[t.sym].first = t.ts;
    if (t.ts > dayBounds[t.sym].last) dayBounds[t.sym].last = t.ts;

    // Per-minute premium for burst detection (SPX, SPY, QQQ only)
    if (t.sym === "SPX" || t.sym === "SPY" || t.sym === "QQQ") {
      const minKey = Math.floor(t.ts / 60000) * 60000;
      if (!perMinPrem[t.sym]) perMinPrem[t.sym] = new Map();
      perMinPrem[t.sym].set(minKey, (perMinPrem[t.sym].get(minKey) || 0) + prem);
    }
  }

  // Compute derived features per sym
  const outBySym = {};
  for (const sym of Object.keys(bySym30)) {
    const windows = Object.keys(bySym30[sym]).map(Number).sort((a, b) => a - b);
    const windowData = windows.map(w => {
      const d = bySym30[sym][w];
      // Center of mass
      let comNumer = 0, comDenom = 0;
      for (const [strike, prem] of d.strikesMap) {
        comNumer += strike * prem;
        comDenom += prem;
      }
      const centerOfMass = comDenom > 0 ? comNumer / comDenom : null;
      // Entropy over strikes (higher = more dispersed)
      const strikeValues = Array.from(d.strikesMap.values());
      const h = entropy(strikeValues);
      // Normalize entropy vs log(N strikes)
      const maxH = strikeValues.length > 1 ? Math.log2(strikeValues.length) : 1;
      const hNorm = maxH > 0 ? h / maxH : 0;
      return {
        t0: w,
        t0iso: new Date(w).toISOString(),
        trades: d.trades,
        premSum: Math.round(d.premSum),
        bullPrem: Math.round(d.bullPrem),
        bearPrem: Math.round(d.bearPrem),
        bullBearBias: (d.bullPrem - d.bearPrem) / (d.bullPrem + d.bearPrem || 1),
        centerOfMass: centerOfMass ? +centerOfMass.toFixed(2) : null,
        nStrikes: d.strikesMap.size,
        entropy: +h.toFixed(3),
        entropyNorm: +hNorm.toFixed(3),
      };
    });

    // Opening 15 min imbalance
    const bound = dayBounds[sym];
    const openingT1 = bound.first + WIN_15MIN;
    const opWindows = windowData.filter(w => w.t0 < openingT1);
    const openBullPrem = opWindows.reduce((s, w) => s + w.bullPrem, 0);
    const openBearPrem = opWindows.reduce((s, w) => s + w.bearPrem, 0);

    // Closing 30 min imbalance
    const closingT0 = bound.last - WIN_30MIN;
    const clWindows = windowData.filter(w => w.t0 >= closingT0);
    const closeBullPrem = clWindows.reduce((s, w) => s + w.bullPrem, 0);
    const closeBearPrem = clWindows.reduce((s, w) => s + w.bearPrem, 0);

    // COM migration (first vs last window)
    const firstCom = windowData[0]?.centerOfMass;
    const lastCom = windowData[windowData.length - 1]?.centerOfMass;
    const comMigration = firstCom && lastCom ? lastCom - firstCom : null;
    const comMigrationPct = firstCom && lastCom ? (lastCom - firstCom) / firstCom : null;

    // Flow bursts: minutes where premium > 3 × mean
    let bursts = [];
    if (perMinPrem[sym]) {
      const vals = Array.from(perMinPrem[sym].values());
      if (vals.length > 10) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
        for (const [minMs, prem] of perMinPrem[sym]) {
          const z = (prem - mean) / (sd || 1);
          if (z >= 3) bursts.push({ t: minMs, tIso: new Date(minMs).toISOString(), prem: Math.round(prem), z: +z.toFixed(2) });
        }
        bursts.sort((a, b) => b.z - a.z);
        bursts = bursts.slice(0, 10); // top 10 bursts
      }
    }

    outBySym[sym] = {
      windows: windowData,
      openingBullPrem: openBullPrem,
      openingBearPrem: openBearPrem,
      openingBias: (openBullPrem - openBearPrem) / (openBullPrem + openBearPrem || 1),
      closingBullPrem: closeBullPrem,
      closingBearPrem: closeBearPrem,
      closingBias: (closeBullPrem - closeBearPrem) / (closeBullPrem + closeBearPrem || 1),
      firstCom, lastCom, comMigration, comMigrationPct,
      bursts,
    };
  }

  const out = { date: dateStr, bySym: outBySym };
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { date: dateStr, syms: Object.keys(outBySym).length };
}

async function main() {
  const days = dayArg
    ? [dayArg]
    : fs.readdirSync(FLOW_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
        .map(f => f.replace(".jsonl.gz", ""))
        .sort();

  console.log(`Processing ${days.length} days for intraday patterns...`);
  const startTime = Date.now();
  let processed = 0;

  for (const day of days) {
    const t0 = Date.now();
    const res = await processDay(day);
    if (res.skipped) continue;
    if (res.error) { console.log(`  ${day} ERROR ${res.error}`); continue; }
    processed++;
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    if (processed % 20 === 0) console.log(`  ${day} — ${res.syms} syms, ${el}s`);
  }

  const el = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} days. ${el}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
