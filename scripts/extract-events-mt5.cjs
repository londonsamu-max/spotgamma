#!/usr/bin/env node
/**
 * Event extractor for US30 + XAUUSD using MT5 15-min candles
 *
 * Since ohlc-1min/DIA and /GLD are corrupted (rolling 20d in all files),
 * we use mt5-candles/{US30,XAUUSD}_M15.json which have complete 2024-01 to 2026-04 data.
 *
 * Logic:
 *   - For each day with DIA/GLD gamma bars
 *   - Convert strikes to CFD prices using dynamic ratio (session open ratio)
 *   - Walk MT5 15-min bars to detect touches at converted CFD price
 *   - Measure forward returns at 1h (4 bars), 4h (16 bars), EOD
 *   - Output to events-mt5.jsonl (merged later with events.jsonl)
 *
 * Touch buffer: 0.05% of strike (in CFD units)
 * Outcome threshold: 0.15% for clear direction
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GAMMA_DIR = path.join(ROOT, "data", "historical", "gamma-bars");
const MT5_DIR = path.join(ROOT, "data", "historical", "mt5-candles");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "events-mt5.jsonl");

const args = process.argv.slice(2);
const DAY_FILTER = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const TOUCH_BUFFER_PCT = 0.0005;
const OUTCOME_THRESHOLD_PCT = 0.0015;
const MIN_GAMMA_ABS_US30 = 5e6;   // DIA: 5M per L101
const MIN_GAMMA_ABS_XAU = 3e6;    // GLD: 3M per L101
const SPOT_WINDOW_PCT = 0.05;
const APPROACH_LOOKBACK = 3;      // 3 × 15m = 45min lookback

// CFD ↔ ETF mapping
const CFD_MAP = {
  US30: { etf: "DIA", mt5File: "US30_M15.json" },
  XAUUSD: { etf: "GLD", mt5File: "XAUUSD_M15.json" },
};

function loadGammaBars(date, etf) {
  const f = path.join(GAMMA_DIR, date, `${etf}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!j.allBars || j.allBars.length < 20) return null;
    return j;
  } catch { return null; }
}

function loadMT5Bars() {
  const out = {};
  for (const [cfd, info] of Object.entries(CFD_MAP)) {
    const f = path.join(MT5_DIR, info.mt5File);
    if (!fs.existsSync(f)) { console.warn(`Missing ${f}`); continue; }
    const arr = JSON.parse(fs.readFileSync(f, "utf8"));
    // Parse datetime and group by date (YYYY-MM-DD)
    const byDate = {};
    for (const b of arr) {
      // datetime format: "2024.01.02 01:00"
      const date = b.datetime.slice(0, 10).replace(/\./g, "-");
      const dt = b.datetime.replace(/\./g, "-").replace(" ", "T") + ":00Z";
      const tms = new Date(dt).getTime();
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push({ ...b, tms });
    }
    for (const d of Object.keys(byDate)) {
      byDate[d].sort((a, b) => a.tms - b.tms);
    }
    out[cfd] = byDate;
  }
  return out;
}

// Compute ETF → CFD ratio from minute-bar ETF data (ohlc-1min) or from previous MT5 day.
// Since ohlc-1min/DIA is corrupted, approximate ratio from recent days' CFD open / ETF close.
// Use MT5 US30 open / (approx ETF from gamma bars spotPrice which is also unreliable)
// FALLBACK: use fixed nominal ratios (US30/DIA ≈ 100, XAUUSD/GLD ≈ 10.8)
const NOMINAL_RATIOS = { US30: 100.0, XAUUSD: 10.8 };

// Better: estimate ratio per day using gamma bars' callWall which spans both.
// SpotGamma's callWall for DIA is in DIA dollars. MT5 callWall for US30 we don't have.
// But we can use the ETF close as anchor. For DIA/GLD ohlc-1min is corrupt but yahoo-prices has daily OHLC.
const yahooPath = path.join(ROOT, "data", "historical", "yahoo-prices");
function loadYahooDaily(sym) {
  const f = path.join(yahooPath, `${sym}.json`);
  if (!fs.existsSync(f)) return null;
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  const byDate = {};
  for (const r of arr) byDate[r.date] = r;
  return byDate;
}
const DIA_daily = loadYahooDaily("DIA");
const GLD_daily = loadYahooDaily("GLD");

function computeRatio(cfd, date, cfdBars) {
  // For US30: cfd open price / DIA daily open
  // For XAUUSD: cfd open / GLD daily open
  if (!cfdBars || cfdBars.length === 0) return NOMINAL_RATIOS[cfd];
  const cfdOpen = cfdBars[0].open;
  if (cfd === "US30" && DIA_daily && DIA_daily[date]) {
    return cfdOpen / DIA_daily[date].open;
  }
  if (cfd === "XAUUSD" && GLD_daily && GLD_daily[date]) {
    return cfdOpen / GLD_daily[date].open;
  }
  return NOMINAL_RATIOS[cfd];
}

function labelOutcome(priceAt, priceAfter, approach) {
  const move = (priceAfter - priceAt) / priceAt;
  if (approach === "up") {
    if (move > OUTCOME_THRESHOLD_PCT) return "break";
    if (move < -OUTCOME_THRESHOLD_PCT) return "bounce";
    return "flat";
  } else {
    if (move < -OUTCOME_THRESHOLD_PCT) return "break";
    if (move > OUTCOME_THRESHOLD_PCT) return "bounce";
    return "flat";
  }
}

function processDayCFD(cfd, date, mt5AllData) {
  const info = CFD_MAP[cfd];
  const gb = loadGammaBars(date, info.etf);
  if (!gb) return { events: [], reason: "no_gamma" };

  const dayBars = mt5AllData[cfd]?.[date];
  if (!dayBars || dayBars.length < 20) return { events: [], reason: "no_mt5_bars" };

  const openPrice = dayBars[0].open;
  const ratio = computeRatio(cfd, date, dayBars);

  // Convert strikes to CFD space
  const spotWindowLo = openPrice * (1 - SPOT_WINDOW_PCT);
  const spotWindowHi = openPrice * (1 + SPOT_WINDOW_PCT);
  const minGamma = cfd === "US30" ? MIN_GAMMA_ABS_US30 : MIN_GAMMA_ABS_XAU;

  const relevantBars = (gb.allBars || [])
    .map(b => ({ ...b, cfdPrice: b.strike * ratio }))
    .filter(b =>
      b.cfdPrice >= spotWindowLo && b.cfdPrice <= spotWindowHi &&
      Math.abs(b.totalGamma || 0) >= minGamma
    );
  if (relevantBars.length === 0) return { events: [], reason: "no_relevant_bars" };

  // Running highs/lows
  let rh = dayBars[0].high, rl = dayBars[0].low;
  const runningHigh = new Array(dayBars.length);
  const runningLow = new Array(dayBars.length);
  for (let i = 0; i < dayBars.length; i++) {
    if (dayBars[i].high > rh) rh = dayBars[i].high;
    if (dayBars[i].low < rl) rl = dayBars[i].low;
    runningHigh[i] = rh;
    runningLow[i] = rl;
  }

  const events = [];
  const touched = new Set();

  for (let i = 0; i < dayBars.length; i++) {
    const c = dayBars[i];
    if (!c.high || !c.low) continue;
    for (const gbar of relevantBars) {
      if (touched.has(gbar.strike)) continue;
      const buffer = gbar.cfdPrice * TOUCH_BUFFER_PCT;
      if ((c.low - buffer) <= gbar.cfdPrice && gbar.cfdPrice <= (c.high + buffer)) {
        touched.add(gbar.strike);
        const lb = Math.max(0, i - APPROACH_LOOKBACK);
        const prevPrice = dayBars[lb].close;
        const approach = c.close > prevPrice ? "up" : "down";

        const get = (offset) => {
          const j = i + offset;
          return j < dayBars.length ? dayBars[j].close : dayBars[dayBars.length - 1].close;
        };
        // MT5 bars are 15-min → 1h = 4 bars, 4h = 16 bars
        const price1h = get(4);
        const price4h = get(16);
        const priceEod = dayBars[dayBars.length - 1].close;

        events.push({
          date, sym: cfd, strike: gbar.strike, strikeCfdPrice: gbar.cfdPrice,
          ratioUsed: ratio,
          touchTs: new Date(c.tms).toISOString(),
          barIdx: i, minuteOfSession: i * 15,
          openPrice, sessionHigh: runningHigh[i], sessionLow: runningLow[i],
          priceBeforeApproach: prevPrice,
          priceAtTouch: c.close,
          approach,
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
          callWall: gb.callWall || 0,
          putWall: gb.putWall || 0,
          zeroGamma: gb.zeroGamma || 0,
          regime: gb.regime || "unknown",
          price1h, price4h, priceEod,
          outcome1h: labelOutcome(c.close, price1h, approach),
          outcome4h: labelOutcome(c.close, price4h, approach),
          outcomeEod: labelOutcome(c.close, priceEod, approach),
          ret1h: +((price1h - c.close) / c.close * 100).toFixed(3),
          ret4h: +((price4h - c.close) / c.close * 100).toFixed(3),
          retEod: +((priceEod - c.close) / c.close * 100).toFixed(3),
        });
      }
    }
  }
  return { events, reason: "ok" };
}

function main() {
  console.log("Loading MT5 candles...");
  const mt5AllData = loadMT5Bars();
  console.log("Loaded MT5 for:", Object.keys(mt5AllData));
  console.log(`US30 days: ${Object.keys(mt5AllData.US30 || {}).length}`);
  console.log(`XAUUSD days: ${Object.keys(mt5AllData.XAUUSD || {}).length}`);

  const days = fs.readdirSync(GAMMA_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const validDays = DAY_FILTER ? [DAY_FILTER] : days.filter(d => loadGammaBars(d, "DIA") || loadGammaBars(d, "GLD"));

  console.log(`\nProcessing ${validDays.length} days for US30 + XAUUSD...`);

  const out = fs.createWriteStream(OUT_FILE);
  let totalEvents = 0, daysProcessed = 0;
  const bySym = { US30: 0, XAUUSD: 0 };
  const reasons = {};
  const t0 = Date.now();

  for (const day of validDays) {
    for (const cfd of ["US30", "XAUUSD"]) {
      const res = processDayCFD(cfd, day, mt5AllData);
      for (const e of res.events) out.write(JSON.stringify(e) + "\n");
      totalEvents += res.events.length;
      bySym[cfd] += res.events.length;
      if (res.events.length === 0) reasons[res.reason] = (reasons[res.reason] || 0) + 1;
    }
    daysProcessed++;
    if (daysProcessed % 50 === 0) {
      console.log(`  ${daysProcessed}/${validDays.length} — ${totalEvents} events`);
    }
  }
  out.end();
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone. ${daysProcessed} days, ${totalEvents} events, ${el}s`);
  console.log(`By sym:`, bySym);
  console.log(`Skip reasons:`, reasons);
}

main();
