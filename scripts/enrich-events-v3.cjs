#!/usr/bin/env node
/**
 * Event enricher v3 — adds HIRO reconstructed from raw flow
 *
 * Reads: events-enriched-v2-merged.jsonl (v2 with flow features)
 * Writes: events-enriched-v3.jsonl
 *
 * HIRO features added per event:
 *   - hiro_spx_current (HIRO percentile of 15-min window containing touch)
 *   - hiro_spx_1h_prior (HIRO percentile 4 windows ago)
 *   - hiro_qqq_current, hiro_dia_current, hiro_gld_current
 *   - hiro_consensus_score (majority bullish vs bearish)
 *   - hiro_trend_symbol (local trend of the relevant symbol)
 *
 * For SPY/QQQ events: use SPX+QQQ+SPY HIRO
 * For US30 events: use DIA HIRO
 * For XAUUSD events: use GLD HIRO
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2-merged.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v3.jsonl");
const HIRO_DIR = path.join(ROOT, "data", "historical", "hiro-15min");

const hiroCache = new Map();
function loadHiroDay(date) {
  if (hiroCache.has(date)) return hiroCache.get(date);
  const f = path.join(HIRO_DIR, `${date}.json`);
  if (!fs.existsSync(f)) { hiroCache.set(date, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    hiroCache.set(date, j);
    return j;
  } catch { hiroCache.set(date, null); return null; }
}

// For a given touchTs, find the HIRO window that contains it, plus N windows back
function getHiroAtMoment(hiroDay, sym, touchTsMs, backWindows = 0) {
  if (!hiroDay || !hiroDay.bySym || !hiroDay.bySym[sym]) return null;
  const windows = hiroDay.bySym[sym];
  // Windows are sorted by t0 ascending
  let matchIdx = -1;
  for (let i = 0; i < windows.length; i++) {
    if (windows[i].t0 <= touchTsMs && touchTsMs < windows[i].t0 + 15 * 60 * 1000) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) {
    // Touch is before/after HIRO windows — find nearest
    for (let i = windows.length - 1; i >= 0; i--) {
      if (windows[i].t0 <= touchTsMs) { matchIdx = i; break; }
    }
  }
  if (matchIdx === -1) return null;
  const targetIdx = Math.max(0, matchIdx - backWindows);
  return windows[targetIdx];
}

// Symbols to query depending on CFD
const HIRO_SYMS = {
  SPY: ["SPX", "SPY", "QQQ"],
  QQQ: ["QQQ", "SPX", "SPY"],
  US30: ["DIA", "SPX"],
  XAUUSD: ["GLD"],
};

function enrichEvent(ev) {
  const hiroDay = loadHiroDay(ev.date);
  if (!hiroDay) {
    ev.hiro_available = false;
    return ev;
  }
  ev.hiro_available = true;

  const touchTsMs = new Date(ev.touchTs).getTime();
  const syms = HIRO_SYMS[ev.sym] || [];

  for (const sym of syms) {
    const current = getHiroAtMoment(hiroDay, sym, touchTsMs, 0);
    const prior = getHiroAtMoment(hiroDay, sym, touchTsMs, 4); // 1 hour ago (4 x 15min)
    if (current) {
      ev[`hiro_${sym.toLowerCase()}_pctl`] = current.percentile;
      ev[`hiro_${sym.toLowerCase()}_contrib`] = Math.round(current.contrib / 1e6); // in M
      ev[`hiro_${sym.toLowerCase()}_trend`] = current.trend;
    }
    if (prior) {
      ev[`hiro_${sym.toLowerCase()}_pctl_1h_prior`] = prior.percentile;
      // Delta: how did HIRO evolve in the last hour?
      if (current) {
        ev[`hiro_${sym.toLowerCase()}_delta_1h`] = current.percentile - prior.percentile;
      }
    }
  }

  // Consensus score across all available symbols
  const pctls = [];
  for (const sym of ["SPX", "QQQ", "SPY", "DIA", "GLD"]) {
    const v = ev[`hiro_${sym.toLowerCase()}_pctl`];
    if (v != null) pctls.push(v);
  }
  if (pctls.length > 0) {
    const avg = pctls.reduce((a, b) => a + b, 0) / pctls.length;
    ev.hiro_avg_pctl = +avg.toFixed(1);
    const bull = pctls.filter(p => p > 20).length;
    const bear = pctls.filter(p => p < -20).length;
    ev.hiro_consensus = bull > bear ? "bullish" : bear > bull ? "bearish" : "mixed";
    ev.hiro_extreme_count = pctls.filter(p => Math.abs(p) >= 70).length;
  }

  return ev;
}

function main() {
  const lines = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean);
  console.log(`Enriching ${lines.length} events with HIRO...`);

  const out = fs.createWriteStream(OUT_FILE);
  const t0 = Date.now();
  let processed = 0, withHiro = 0;
  const consensusCounts = { bullish: 0, bearish: 0, mixed: 0 };

  for (const line of lines) {
    const ev = JSON.parse(line);
    const enriched = enrichEvent(ev);
    out.write(JSON.stringify(enriched) + "\n");
    processed++;
    if (enriched.hiro_available) withHiro++;
    if (enriched.hiro_consensus) consensusCounts[enriched.hiro_consensus]++;
    if (processed % 1000 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${processed}/${lines.length} (${(100*processed/lines.length).toFixed(0)}%) — ${el}s`);
    }
  }
  out.end();
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} enriched in ${el}s`);
  console.log(`  with HIRO: ${withHiro} (${(100*withHiro/processed).toFixed(1)}%)`);
  console.log(`  consensus:`, consensusCounts);
}

main();
