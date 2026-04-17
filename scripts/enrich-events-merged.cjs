#!/usr/bin/env node
/**
 * Event feature enricher
 *
 * Reads: data/backtest-v2/events-merged.jsonl
 * Writes: data/backtest-v2/events-enriched-merged.jsonl
 *
 * Adds ~40 features per event:
 *   - Dominance + ratios (call/put gamma, OI, delta)
 *   - Gamma magnitude buckets + bar-structure context (gap to next bar, concentration)
 *   - Distance to walls + regime flags
 *   - Day of week + opex proximity + minute-of-session buckets
 *   - Macro (VIX, DXY, TLT from yahoo)
 *   - Day-over-day deltas (dominance_delta, gamma_delta, oi_delta)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_IN = path.join(ROOT, "data", "backtest-v2", "events-merged.jsonl");
const EVENTS_OUT = path.join(ROOT, "data", "backtest-v2", "events-enriched-merged.jsonl");
const GAMMA_DIR = path.join(ROOT, "data", "historical", "gamma-bars");
const YAHOO_DIR = path.join(ROOT, "data", "historical", "yahoo-prices");
const FLOW_FEAT_DIR = path.join(ROOT, "data", "historical", "flow-features");

// -- Helpers --
function gammaBucket(g) {
  const a = Math.abs(g);
  if (a < 100e6) return "small";
  if (a < 500e6) return "med";
  if (a < 1e9) return "large";
  return "mega";
}

function dayOfWeek(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()];
}

function thirdFriday(year, month) {
  // month is 1-12
  const first = new Date(Date.UTC(year, month - 1, 1));
  const dow = first.getUTCDay();
  const offset = (5 - dow + 7) % 7;
  const firstFri = 1 + offset;
  return new Date(Date.UTC(year, month - 1, firstFri + 14));
}

function daysToOpex(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  let opex = thirdFriday(d.getUTCFullYear(), d.getUTCMonth() + 1);
  if (d > opex) {
    opex = thirdFriday(
      d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(),
      d.getUTCMonth() === 11 ? 1 : d.getUTCMonth() + 2
    );
  }
  return Math.round((opex - d) / 86400000);
}

function isOpexDay(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const opex = thirdFriday(d.getUTCFullYear(), d.getUTCMonth() + 1);
  return d.getUTCFullYear() === opex.getUTCFullYear() &&
         d.getUTCMonth() === opex.getUTCMonth() &&
         d.getUTCDate() === opex.getUTCDate();
}

function isQuarterlyOpex(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  if (!isOpexDay(dateStr)) return false;
  const m = d.getUTCMonth() + 1;
  return m === 3 || m === 6 || m === 9 || m === 12;
}

function minuteBucket(i) {
  if (i < 30) return "open";
  if (i < 150) return "morn";
  if (i < 270) return "mid";
  if (i < 360) return "aft";
  return "close";
}

function vixBucket(v) {
  if (v < 15) return "v_low";
  if (v < 20) return "low";
  if (v < 25) return "mid";
  if (v < 30) return "high";
  return "extreme";
}

function trend5d(prices) {
  if (prices.length < 5) return "flat";
  const first = prices[prices.length - 5];
  const last = prices[prices.length - 1];
  const pct = (last - first) / first;
  if (pct > 0.02) return "up";
  if (pct < -0.02) return "down";
  return "flat";
}

function previousTradingDate(dateStr) {
  // Walk back 1 day at a time up to 5 days looking for gamma-bars dir
  const d = new Date(dateStr + "T12:00:00Z");
  for (let i = 1; i <= 5; i++) {
    const prev = new Date(d - i * 86400000);
    const s = prev.toISOString().slice(0, 10);
    if (fs.existsSync(path.join(GAMMA_DIR, s))) return s;
  }
  return null;
}

// -- Preload macro data --
function loadYahoo(sym) {
  const f = path.join(YAHOO_DIR, `${sym}.json`);
  if (!fs.existsSync(f)) return {};
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  const byDate = {};
  for (const r of arr) byDate[r.date] = r;
  return byDate;
}

const VIX = loadYahoo("VIX");
const DXY = loadYahoo("DXY");
const TLT = loadYahoo("TLT");

// Cache for day gamma bars (avoid re-parsing)
const gammaCache = new Map();
function getGammaBars(date, sym) {
  const k = `${date}_${sym}`;
  if (gammaCache.has(k)) return gammaCache.get(k);
  const f = path.join(GAMMA_DIR, date, `${sym}.json`);
  if (!fs.existsSync(f)) { gammaCache.set(k, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    gammaCache.set(k, j);
    return j;
  } catch { gammaCache.set(k, null); return null; }
}

// -- Prev day lookup map for strikes --
function buildPrevStrikeIndex(date, sym) {
  const prev = previousTradingDate(date);
  if (!prev) return null;
  const gb = getGammaBars(prev, sym);
  if (!gb || !gb.allBars) return null;
  const map = {};
  for (const b of gb.allBars) map[b.strike] = b;
  return { prevDate: prev, map };
}

// -- Per-event enrichment --
function enrichEvent(ev, prevIdx, daySameAllBars) {
  const e = { ...ev };

  // 1. Dominance
  const absCall = Math.abs(e.callGamma);
  const absPut = Math.abs(e.putGamma);
  const totAbs = absCall + absPut;
  e.dominance = totAbs > 0 ? absCall / totAbs : 0.5;
  // Signed dominance (keeps sign info for call vs put)
  const callP = e.callGamma >= 0 ? e.callGamma : -e.callGamma;
  const putP = e.putGamma >= 0 ? e.putGamma : -e.putGamma;
  e.dominance_signed = (e.callGamma - e.putGamma) / (callP + putP || 1);

  // 2. OI ratio + delta ratio
  const totOI = e.callOI + e.putOI;
  e.oiRatio = totOI > 0 ? e.callOI / totOI : 0.5;
  const absCD = Math.abs(e.callDelta), absPD = Math.abs(e.putDelta);
  e.deltaRatio = (absCD + absPD) > 0 ? absCD / (absCD + absPD) : 0.5;

  // 3. Gamma sign + bucket
  e.gammaSign = e.totalGamma > 0 ? 1 : (e.totalGamma < 0 ? -1 : 0);
  e.gammaBucket = gammaBucket(e.totalGamma);

  // 4. Distance to walls (pct of strike)
  e.distToCallWallPct = e.callWall > 0 ? (e.strike - e.callWall) / e.callWall : 0;
  e.distToPutWallPct = e.putWall > 0 ? (e.strike - e.putWall) / e.putWall : 0;
  e.distToZeroGammaPct = e.zeroGamma > 0 ? (e.strike - e.zeroGamma) / e.zeroGamma : 0;
  e.strikeAboveZeroGamma = e.strike > e.zeroGamma;
  e.priceAboveZeroGamma = e.openPrice > e.zeroGamma;

  // 5. Spot distance
  e.distSpotToStrikePct = (e.openPrice - e.strike) / e.openPrice;

  // 6. Day of week + opex
  e.dayOfWeek = dayOfWeek(e.date);
  e.isOpex = isOpexDay(e.date);
  e.isQuarterlyOpex = isQuarterlyOpex(e.date);
  e.daysToOpex = daysToOpex(e.date);

  // 7. Minute bucket + session context
  e.minuteBucket = minuteBucket(e.minuteOfSession);
  e.sessionProgress = +(e.minuteOfSession / 390).toFixed(3);
  e.sessionRangeBeforeTouchPct = (e.sessionHigh - e.sessionLow) / e.openPrice;
  e.priceRelToOpenPct = (e.priceAtTouch - e.openPrice) / e.openPrice;

  // 8. Gamma structure context — find neighboring bars in same day allBars
  const nearby = daySameAllBars
    .filter(b => Math.abs(b.strike - e.strike) / e.strike < 0.02 && b.strike !== e.strike)
    .sort((a, b) => Math.abs(a.strike - e.strike) - Math.abs(b.strike - e.strike));

  const above = daySameAllBars
    .filter(b => b.strike > e.strike && Math.abs(b.totalGamma) > 50e6)
    .sort((a, b) => a.strike - b.strike);
  const below = daySameAllBars
    .filter(b => b.strike < e.strike && Math.abs(b.totalGamma) > 50e6)
    .sort((a, b) => b.strike - a.strike);
  e.gapToNextBarAbovePct = above[0] ? (above[0].strike - e.strike) / e.strike : null;
  e.gapToNextBarBelowPct = below[0] ? (e.strike - below[0].strike) / e.strike : null;
  e.nextBarAboveGamma = above[0] ? Math.round(above[0].totalGamma / 1e6) : null;
  e.nextBarBelowGamma = below[0] ? Math.round(below[0].totalGamma / 1e6) : null;

  const barsWithin1Pct = daySameAllBars.filter(b =>
    Math.abs(b.strike - e.strike) / e.strike < 0.01 && Math.abs(b.totalGamma) > 50e6
  );
  e.barsWithin1Pct = barsWithin1Pct.length;

  const nearbyTotal = barsWithin1Pct.reduce((s, b) => s + Math.abs(b.totalGamma), 0);
  e.gammaConcentration = nearbyTotal > 0 ? Math.abs(e.totalGamma) / nearbyTotal : 0;

  // 9. Macro (from yahoo)
  const vix = VIX[e.date];
  e.vixLevel = vix ? vix.close : null;
  e.vixBucket = vix ? vixBucket(vix.close) : null;
  const dxy = DXY[e.date];
  e.dxyLevel = dxy ? dxy.close : null;
  const tlt = TLT[e.date];
  e.tltLevel = tlt ? tlt.close : null;

  // VIX/DXY/TLT 5d trends
  if (vix) {
    const dates = Object.keys(VIX).filter(d => d <= e.date).sort();
    const last5 = dates.slice(-5).map(d => VIX[d].close);
    e.vixTrend5d = trend5d(last5);
  }
  if (dxy) {
    const dates = Object.keys(DXY).filter(d => d <= e.date).sort();
    const last5 = dates.slice(-5).map(d => DXY[d].close);
    e.dxyTrend5d = trend5d(last5);
  }
  if (tlt) {
    const dates = Object.keys(TLT).filter(d => d <= e.date).sort();
    const last5 = dates.slice(-5).map(d => TLT[d].close);
    e.tltTrend5d = trend5d(last5);
  }

  // 10. Day-over-day deltas
  if (prevIdx && prevIdx.map[e.strike]) {
    const p = prevIdx.map[e.strike];
    const pAbsCall = Math.abs(p.callGamma || 0);
    const pAbsPut = Math.abs(p.putGamma || 0);
    const pTot = pAbsCall + pAbsPut;
    const pDom = pTot > 0 ? pAbsCall / pTot : 0.5;
    e.dominance_d1 = +pDom.toFixed(4);
    e.dominance_delta = +(e.dominance - pDom).toFixed(4);
    e.flipEvent_d1 = Math.sign(pDom - 0.5) !== Math.sign(e.dominance - 0.5);
    e.totalGamma_d1 = p.totalGamma;
    e.gamma_delta_pct = p.totalGamma !== 0 ? (e.totalGamma - p.totalGamma) / Math.abs(p.totalGamma) : 0;
    e.callOI_delta = e.callOI - (p.callOI || 0);
    e.putOI_delta = e.putOI - (p.putOI || 0);
    e.netPos_delta = e.netPositioning - (p.netPositioning || 0);
    e.prevDate = prevIdx.prevDate;
  } else {
    e.dominance_d1 = null;
    e.dominance_delta = null;
    e.flipEvent_d1 = null;
  }

  // Round floats for cleaner JSON
  for (const k of ["dominance","dominance_signed","oiRatio","deltaRatio","distToCallWallPct",
                   "distToPutWallPct","distToZeroGammaPct","distSpotToStrikePct",
                   "sessionRangeBeforeTouchPct","priceRelToOpenPct","gammaConcentration",
                   "gapToNextBarAbovePct","gapToNextBarBelowPct"]) {
    if (typeof e[k] === "number") e[k] = +e[k].toFixed(5);
  }

  return e;
}

async function main() {
  const lines = fs.readFileSync(EVENTS_IN, "utf8").split("\n").filter(Boolean);
  console.log(`Enriching ${lines.length} events...`);

  const out = fs.createWriteStream(EVENTS_OUT);
  const startTime = Date.now();
  let processed = 0;

  // Group events by (date, sym) to build per-day prevStrikeIndex once
  const byDaySym = {};
  for (const l of lines) {
    const e = JSON.parse(l);
    const k = `${e.date}_${e.sym}`;
    if (!byDaySym[k]) byDaySym[k] = [];
    byDaySym[k].push(e);
  }

  for (const [k, evs] of Object.entries(byDaySym)) {
    const [date, sym] = k.split("_");
    const prevIdx = buildPrevStrikeIndex(date, sym);
    const gb = getGammaBars(date, sym);
    const allBars = gb ? gb.allBars || [] : [];

    for (const ev of evs) {
      const enriched = enrichEvent(ev, prevIdx, allBars);
      out.write(JSON.stringify(enriched) + "\n");
      processed++;
    }

    if (processed % 500 === 0 || processed === lines.length) {
      const pct = ((processed / lines.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${processed}/${lines.length} (${pct}%) — ${elapsed}s`);
    }
  }

  out.end();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} enriched in ${elapsed}s`);
  console.log(`Output: ${EVENTS_OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
