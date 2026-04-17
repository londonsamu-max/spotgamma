#!/usr/bin/env node
/**
 * Event enricher v4 — adds spreads + dealer positioning + intraday patterns
 *
 * Reads: events-enriched-v3.jsonl (v3 already has HIRO)
 * Writes: events-enriched-v4.jsonl
 *
 * Features added:
 *
 * SPREADS (filtered to institutional grade >$100K premium):
 *   - spreads_inst_count_at_strike (institutional spreads with leg at this strike)
 *   - spreads_straddle_count (long/short straddles at this strike)
 *   - spreads_bias_summary (net bullish vs bearish premium from spreads)
 *   - spreads_range_center (center of iron condors / strangles)
 *   - spreads_largest_prem (biggest spread involving this strike)
 *
 * DEALER POSITIONING:
 *   - dealer_calls_net_at_strike (dealer net long/short calls)
 *   - dealer_puts_net_at_strike
 *   - dealer_delta_exposure
 *   - dealer_gamma_exposure
 *   - dealer_position_type (enum)
 *
 * INTRADAY PATTERNS:
 *   - intra_opening_bias (bull/bear premium first 15min)
 *   - intra_closing_bias (last 30min)
 *   - intra_com_migration (center of mass drift over day)
 *   - intra_entropy_at_touch (concentration of flow at touch window)
 *   - intra_burst_count (number of flow bursts before touch)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v3.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v4.jsonl");
const SPREADS_DIR = path.join(ROOT, "data", "historical", "spreads");
const DEALER_DIR = path.join(ROOT, "data", "historical", "dealer-pos");
const INTRA_DIR = path.join(ROOT, "data", "historical", "intraday-patterns");

const MIN_INST_SPREAD_PREM = 100000; // $100K minimum for institutional grade

// Map CFD sym to ETF for lookups
const SYM_ETF = { US30: "DIA", XAUUSD: "GLD" };

// Cache loaders
const spreadsCache = new Map();
const dealerCache = new Map();
const intraCache = new Map();

function loadSpreadsDay(date) {
  if (spreadsCache.has(date)) return spreadsCache.get(date);
  const f = path.join(SPREADS_DIR, `${date}.json`);
  if (!fs.existsSync(f)) { spreadsCache.set(date, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    // Filter to institutional grade only
    const instSpreads = (j.spreads || []).filter(s => s.totalPrem >= MIN_INST_SPREAD_PREM);
    spreadsCache.set(date, instSpreads);
    return instSpreads;
  } catch { spreadsCache.set(date, null); return null; }
}

function loadDealerDay(date) {
  if (dealerCache.has(date)) return dealerCache.get(date);
  const f = path.join(DEALER_DIR, `${date}.json`);
  if (!fs.existsSync(f)) { dealerCache.set(date, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    dealerCache.set(date, j);
    return j;
  } catch { dealerCache.set(date, null); return null; }
}

function loadIntraDay(date) {
  if (intraCache.has(date)) return intraCache.get(date);
  const f = path.join(INTRA_DIR, `${date}.json`);
  if (!fs.existsSync(f)) { intraCache.set(date, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    intraCache.set(date, j);
    return j;
  } catch { intraCache.set(date, null); return null; }
}

function enrichSpreads(ev) {
  const spreads = loadSpreadsDay(ev.date);
  if (!spreads) { ev.spreads_available = false; return; }
  ev.spreads_available = true;

  const ethSym = SYM_ETF[ev.sym] || ev.sym;
  const touchTsMs = new Date(ev.touchTs).getTime();

  // Find spreads involving this strike (within 0.5% proximity) and BEFORE touch time
  let instCount = 0, straddleCount = 0;
  let bullPrem = 0, bearPrem = 0;
  let largestPrem = 0;
  const rangeCenters = [];

  for (const s of spreads) {
    if (s.sym !== ethSym) continue;
    if (s.ts > touchTsMs) continue; // no look-ahead
    // Check if any strike of the spread is near the event strike
    const nearStrike = (s.strikes || []).some(st => Math.abs(st - ev.strike) / ev.strike < 0.01);
    if (!nearStrike) continue;

    instCount++;
    if (s.totalPrem > largestPrem) largestPrem = s.totalPrem;

    if (s.type.includes("straddle") || s.type.includes("strangle")) {
      straddleCount++;
      if (s.strikes.length === 2) {
        rangeCenters.push((s.strikes[0] + s.strikes[1]) / 2);
      } else {
        rangeCenters.push(s.strikes[0]);
      }
    }

    if (s.bias === "bullish") bullPrem += s.totalPrem;
    else if (s.bias === "bearish") bearPrem += s.totalPrem;
  }

  ev.spreads_inst_count = instCount;
  ev.spreads_straddle_count = straddleCount;
  ev.spreads_largest_prem = largestPrem;
  ev.spreads_bull_prem = bullPrem;
  ev.spreads_bear_prem = bearPrem;
  ev.spreads_bias = bullPrem + bearPrem > 0 ? (bullPrem - bearPrem) / (bullPrem + bearPrem) : 0;
  ev.spreads_range_center = rangeCenters.length > 0 ? rangeCenters.reduce((a, b) => a + b, 0) / rangeCenters.length : null;
}

function enrichDealer(ev) {
  const d = loadDealerDay(ev.date);
  if (!d) { ev.dealer_available = false; return; }
  ev.dealer_available = true;

  const ethSym = SYM_ETF[ev.sym] || ev.sym;
  const key = `${ethSym}_${ev.strike}`;
  const entry = d.bySymStrike?.[key];
  if (!entry) {
    ev.dealer_strike_available = false;
    return;
  }
  ev.dealer_strike_available = true;
  ev.dealer_calls_net = entry.dealerCallsNet;
  ev.dealer_puts_net = entry.dealerPutsNet;
  ev.dealer_delta_exposure = entry.dealerDelta;
  ev.dealer_gamma_exposure = entry.dealerGamma;
  ev.dealer_pos_type = entry.netPositionType;
}

function enrichIntraday(ev) {
  const d = loadIntraDay(ev.date);
  if (!d) { ev.intra_available = false; return; }
  ev.intra_available = true;

  const ethSym = SYM_ETF[ev.sym] || ev.sym;
  const syncData = d.bySym?.[ethSym];
  if (!syncData) return;

  const touchTsMs = new Date(ev.touchTs).getTime();

  // Opening/closing bias
  ev.intra_opening_bias = syncData.openingBias;
  ev.intra_closing_bias = syncData.closingBias;
  ev.intra_com_migration_pct = syncData.comMigrationPct;

  // Find 30-min window containing touch
  const matchWindow = (syncData.windows || []).find(w =>
    w.t0 <= touchTsMs && touchTsMs < w.t0 + 30 * 60 * 1000
  );
  if (matchWindow) {
    ev.intra_entropy_at_touch = matchWindow.entropyNorm;
    ev.intra_bullBear_bias_at_touch = matchWindow.bullBearBias;
    ev.intra_prem_at_touch = matchWindow.premSum;
  }

  // Bursts before touch
  const burstsBeforeTouch = (syncData.bursts || []).filter(b => b.t <= touchTsMs);
  ev.intra_burst_count = burstsBeforeTouch.length;
}

function main() {
  const lines = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean);
  console.log(`Enriching ${lines.length} events with spreads + dealer + intraday...`);

  const out = fs.createWriteStream(OUT_FILE);
  const t0 = Date.now();
  let processed = 0;
  let stats = { spreads: 0, dealer: 0, intra: 0 };

  for (const line of lines) {
    const ev = JSON.parse(line);
    enrichSpreads(ev);
    enrichDealer(ev);
    enrichIntraday(ev);
    out.write(JSON.stringify(ev) + "\n");
    processed++;
    if (ev.spreads_available) stats.spreads++;
    if (ev.dealer_strike_available) stats.dealer++;
    if (ev.intra_available) stats.intra++;
    if (processed % 1000 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${processed}/${lines.length} — ${el}s`);
    }
  }
  out.end();
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} enriched in ${el}s`);
  console.log(`  with spreads: ${stats.spreads} (${(100*stats.spreads/processed).toFixed(1)}%)`);
  console.log(`  with strike-level dealer: ${stats.dealer} (${(100*stats.dealer/processed).toFixed(1)}%)`);
  console.log(`  with intraday: ${stats.intra} (${(100*stats.intra/processed).toFixed(1)}%)`);
}

main();
