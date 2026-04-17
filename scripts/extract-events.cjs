#!/usr/bin/env node
/**
 * Event extractor + outcome labeler (v2 — native strikes)
 *
 * For each valid day, for each sym in [SPY, QQQ, DIA, GLD]:
 *   - Load gamma bars (native strikes in sym space)
 *   - Load minute bars (1-min from ohlc-1min/SYM/YYYY-MM-DD.json)
 *   - Detect FIRST touch of each strike during session
 *   - Measure forward returns at 15m / 1h / 4h / EOD
 *   - Label outcome: bounce / break / flat (direction-aware)
 *
 * Output: data/backtest-v2/events.jsonl (one event per line)
 *
 * NOTE: DIA/GLD ohlc-1min has rolling ~20-day data (bug in scraper). Only those days work.
 *       SPY/QQQ have full per-day files from 2024-01 to 2026-04.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GAMMA_DIR = path.join(ROOT, "data", "historical", "gamma-bars");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const OUT_DIR = path.join(ROOT, "data", "backtest-v2");
const OUT_FILE = path.join(OUT_DIR, "events.jsonl");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const SYM_FILTER = args.includes("--sym") ? args[args.indexOf("--sym") + 1] : null;
const DAY_FILTER = args.includes("--day") ? args[args.indexOf("--day") + 1] : null;

const SYMS = ["SPY", "QQQ", "DIA", "GLD"];
const TOUCH_BUFFER_PCT = 0.0005;       // ±0.05% of strike counts as touch
const OUTCOME_THRESHOLD_PCT = 0.0015;  // ±0.15% = clear direction (scaled to typical intraday move)
const MIN_GAMMA_ABS = 10e6;            // skip strikes with |gamma| < 10M (scale is absolute)
const SPOT_WINDOW_PCT = 0.05;          // only strikes within ±5% of spot
const APPROACH_LOOKBACK = 10;          // 10 minute bars to determine approach direction

function parseTs(t) {
  if (typeof t === "number") return t;
  if (typeof t === "string") return new Date(t.includes("T") ? t : t.replace(" ", "T") + "Z").getTime();
  return 0;
}

function loadGammaBars(date, sym) {
  const f = path.join(GAMMA_DIR, date, `${sym}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!j.allBars || j.allBars.length < 20) return null;
    return j;
  } catch { return null; }
}

function loadMinuteBarsForDate(date, sym) {
  const f = path.join(OHLC_DIR, sym, `${date}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    let arr = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!arr.length) return null;
    // Normalize timestamps + sort ascending
    arr = arr.map(b => ({ ...b, tms: parseTs(b.t) })).sort((a, b) => a.tms - b.tms);
    // Filter to bars that actually match this date (critical for DIA/GLD broken rolling data)
    const dayStart = new Date(date + "T00:00:00Z").getTime();
    const dayEnd = dayStart + 86400000;
    const dayBars = arr.filter(b => b.tms >= dayStart && b.tms < dayEnd);
    return dayBars.length > 50 ? dayBars : null;
  } catch { return null; }
}

function labelOutcome(priceAt, priceAfter, approach) {
  const move = (priceAfter - priceAt) / priceAt;
  if (approach === "up") {
    if (move > OUTCOME_THRESHOLD_PCT) return "break";    // continued up through strike
    if (move < -OUTCOME_THRESHOLD_PCT) return "bounce";  // rejected, went back down
    return "flat";
  } else {
    if (move < -OUTCOME_THRESHOLD_PCT) return "break";   // continued down
    if (move > OUTCOME_THRESHOLD_PCT) return "bounce";   // rejected, bounced up
    return "flat";
  }
}

function processDaySym(date, sym) {
  const gb = loadGammaBars(date, sym);
  if (!gb) return { events: [], reason: "no_gamma" };

  const bars = loadMinuteBarsForDate(date, sym);
  if (!bars) return { events: [], reason: "no_minute_bars" };

  // Estimate spot from first bar (gb.spotPrice is unreliable)
  const openPrice = bars[0].c;
  const spotWindowLo = openPrice * (1 - SPOT_WINDOW_PCT);
  const spotWindowHi = openPrice * (1 + SPOT_WINDOW_PCT);

  // Pre-filter session lows/highs running
  const runningHigh = new Array(bars.length);
  const runningLow = new Array(bars.length);
  let rh = bars[0].h, rl = bars[0].l;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].h > rh) rh = bars[i].h;
    if (bars[i].l < rl) rl = bars[i].l;
    runningHigh[i] = rh;
    runningLow[i] = rl;
  }

  // Filter relevant gamma strikes
  const relevantBars = (gb.allBars || []).filter(b =>
    b.strike >= spotWindowLo && b.strike <= spotWindowHi &&
    Math.abs(b.totalGamma || 0) >= MIN_GAMMA_ABS
  );
  if (relevantBars.length === 0) return { events: [], reason: "no_relevant_bars" };

  const events = [];
  const touched = new Set();

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (!c.h || !c.l) continue;
    for (const gbar of relevantBars) {
      if (touched.has(gbar.strike)) continue;
      const buffer = gbar.strike * TOUCH_BUFFER_PCT;
      if ((c.l - buffer) <= gbar.strike && gbar.strike <= (c.h + buffer)) {
        touched.add(gbar.strike);

        // Approach direction from prior bars
        const lb = Math.max(0, i - APPROACH_LOOKBACK);
        const prevPrice = bars[lb].c;
        const approach = c.c > prevPrice ? "up" : "down";

        // Forward returns
        const get = (offset) => {
          const j = i + offset;
          return j < bars.length ? bars[j].c : bars[bars.length - 1].c;
        };
        const price15 = get(15), price60 = get(60), price240 = get(240);
        const priceEod = bars[bars.length - 1].c;

        events.push({
          date, sym, strike: gbar.strike,
          touchTs: new Date(c.tms).toISOString(),
          barIdx: i,
          minuteOfSession: i,
          openPrice, sessionHigh: runningHigh[i], sessionLow: runningLow[i],
          priceBeforeApproach: prevPrice,
          priceAtTouch: c.c,
          approach,
          // Strike-level gamma features
          callGamma: gbar.callGamma || 0,
          putGamma: gbar.putGamma || 0,
          netGamma: gbar.netGamma || 0,
          totalGamma: gbar.totalGamma || 0,
          netPositioning: gbar.netPositioning || 0,
          callDelta: gbar.callDelta || 0,
          putDelta: gbar.putDelta || 0,
          callOI: gbar.callOI || 0,
          putOI: gbar.putOI || 0,
          oiChange: gbar.oiChange || 0,
          gammaType: gbar.type,
          // Day-level context from gamma file
          callWall: gb.callWall || 0,
          putWall: gb.putWall || 0,
          zeroGamma: gb.zeroGamma || 0,
          regime: gb.regime || "unknown",
          // Forward prices
          price15m: price15,
          price1h: price60,
          price4h: price240,
          priceEod,
          // Outcomes
          outcome15m: labelOutcome(c.c, price15, approach),
          outcome1h: labelOutcome(c.c, price60, approach),
          outcome4h: labelOutcome(c.c, price240, approach),
          outcomeEod: labelOutcome(c.c, priceEod, approach),
          // Forward returns in pct
          ret15m: +((price15 - c.c) / c.c * 100).toFixed(3),
          ret1h: +((price60 - c.c) / c.c * 100).toFixed(3),
          ret4h: +((price240 - c.c) / c.c * 100).toFixed(3),
          retEod: +((priceEod - c.c) / c.c * 100).toFixed(3),
        });
      }
    }
  }

  return { events, reason: "ok" };
}

function main() {
  const days = fs.readdirSync(GAMMA_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  // Find days with valid gamma data (any sym with allBars > 20)
  const validDays = [];
  for (const d of days) {
    if (DAY_FILTER && d !== DAY_FILTER) continue;
    const hasAny = SYMS.some(s => loadGammaBars(d, s));
    if (hasAny) validDays.push(d);
  }

  console.log(`Processing ${validDays.length} days × ${SYM_FILTER ? 1 : SYMS.length} syms...`);

  const out = fs.createWriteStream(OUT_FILE);
  let totalEvents = 0, daysProcessed = 0;
  const skipReasons = {};
  const symCounts = {};
  const startTime = Date.now();

  for (const day of validDays) {
    const syms = SYM_FILTER ? [SYM_FILTER] : SYMS;
    for (const sym of syms) {
      const res = processDaySym(day, sym);
      for (const e of res.events) out.write(JSON.stringify(e) + "\n");
      totalEvents += res.events.length;
      symCounts[sym] = (symCounts[sym] || 0) + res.events.length;
      if (res.events.length === 0) {
        skipReasons[res.reason] = (skipReasons[res.reason] || 0) + 1;
      }
    }
    daysProcessed++;
    if (daysProcessed % 50 === 0 || daysProcessed === validDays.length) {
      const pct = ((daysProcessed / validDays.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ${daysProcessed}/${validDays.length} days (${pct}%) — ${totalEvents} events — ${elapsed}s`);
    }
  }

  out.end();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${daysProcessed} days, ${totalEvents} events, ${elapsed}s`);
  console.log(`Events per sym:`, symCounts);
  console.log(`Skip reasons:`, skipReasons);
  console.log(`Output: ${OUT_FILE}`);
}

main();
