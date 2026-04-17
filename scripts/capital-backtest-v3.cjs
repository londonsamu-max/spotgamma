#!/usr/bin/env node
/**
 * Capital Backtest v3 — Complete universe (SPY + QQQ + US30 + XAUUSD)
 *
 * Walks:
 *   - SPY/QQQ events: 1-min bars from ohlc-1min/
 *   - US30/XAUUSD events: 15-min bars from mt5-candles/
 *
 * Uses only OOS-validated winners from optimize-all-lessons.cjs:
 *   - L114-vix30+ (Sharpe 8.48, WR 75%)
 *   - L121-wide (Sharpe 6.24, +133% OOS with 2% risk)
 *   - L119-tighter (Sharpe 5.62, WR 63%)
 *   - L115-bidir (Sharpe 2.91)
 *   - L116-down (Sharpe 2.33)
 *
 * Strategies:
 *   1. Buy&Hold SPY (benchmark)
 *   2. L121-wide solo (risk 2%)
 *   3. L119-tighter solo
 *   4. L114-vix30+ solo (most selective)
 *   5. Ensemble OPTIMAL (all 5 winners, priority L121 > L119 > L114 > L115 > L116-down)
 *   6. Ensemble + L116-down filter
 *   7. Random control
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2-merged.jsonl");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const MT5_DIR = path.join(ROOT, "data", "historical", "mt5-candles");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "capital-results-v3.md");

const CAPITAL_INITIAL = 1000;
const RISK_PER_TRADE = 0.01;
const SLIPPAGE_PCT = 0.0003;

// Cache minute/15min bars
const minuteCache = new Map();
const mt5AllData = {};

function loadMinuteBars(sym, date) {
  const k = `${sym}_${date}`;
  if (minuteCache.has(k)) return minuteCache.get(k);
  const f = path.join(OHLC_DIR, sym, `${date}.json`);
  if (!fs.existsSync(f)) { minuteCache.set(k, null); return null; }
  try {
    let arr = JSON.parse(fs.readFileSync(f, "utf8"));
    arr = arr.map(b => ({ ...b, tms: typeof b.t === "number" ? b.t : new Date(b.t.replace(" ", "T") + "Z").getTime() }))
             .sort((a, b) => a.tms - b.tms);
    const day = new Date(date + "T00:00:00Z").getTime();
    arr = arr.filter(b => b.tms >= day && b.tms < day + 86400000);
    minuteCache.set(k, arr);
    return arr;
  } catch { minuteCache.set(k, null); return null; }
}

function loadMT5Full(cfd) {
  if (mt5AllData[cfd]) return mt5AllData[cfd];
  const f = path.join(MT5_DIR, `${cfd}_M15.json`);
  if (!fs.existsSync(f)) { mt5AllData[cfd] = {}; return {}; }
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  const byDate = {};
  for (const b of arr) {
    const date = b.datetime.slice(0, 10).replace(/\./g, "-");
    const dt = b.datetime.replace(/\./g, "-").replace(" ", "T") + ":00Z";
    const tms = new Date(dt).getTime();
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({ ...b, tms, h: b.high, l: b.low, c: b.close });
  }
  for (const d of Object.keys(byDate)) byDate[d].sort((a, b) => a.tms - b.tms);
  mt5AllData[cfd] = byDate;
  return byDate;
}

function getBars(sym, date) {
  if (sym === "US30" || sym === "XAUUSD") {
    const all = loadMT5Full(sym);
    return all[date] || null;
  }
  return loadMinuteBars(sym, date);
}

function walkForward(ev, direction, slPct, tpPct) {
  const bars = getBars(ev.sym, ev.date);
  if (!bars || bars.length === 0) return null;
  const touchMs = new Date(ev.touchTs).getTime();
  const startIdx = bars.findIndex(b => b.tms >= touchMs);
  if (startIdx === -1) return null;

  // maxBars: 1-min for ETFs = 240 (4h), 15-min for CFDs = 16 (4h)
  const maxBars = (ev.sym === "US30" || ev.sym === "XAUUSD") ? 16 : 240;
  const entry = ev.priceAtTouch;
  const sl = direction === "LONG" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp = direction === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);

  const end = Math.min(startIdx + maxBars, bars.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const b = bars[i];
    if (direction === "LONG") {
      if (b.l <= sl) return { exitPrice: sl, reason: "sl" };
      if (b.h >= tp) return { exitPrice: tp, reason: "tp" };
    } else {
      if (b.h >= sl) return { exitPrice: sl, reason: "sl" };
      if (b.l <= tp) return { exitPrice: tp, reason: "tp" };
    }
  }
  return { exitPrice: bars[end].c, reason: "eod" };
}

function simulateTrade(ev, direction, capital, slPct, tpPct, riskPct) {
  const exit = walkForward(ev, direction, slPct, tpPct);
  if (!exit) return null;
  const slDist = ev.priceAtTouch * slPct;
  const units = (capital * riskPct) / slDist;
  const move = direction === "LONG" ? (exit.exitPrice - ev.priceAtTouch) : (ev.priceAtTouch - exit.exitPrice);
  const gross = units * move;
  const slip = units * ev.priceAtTouch * SLIPPAGE_PCT;
  const net = gross - slip;
  return { date: ev.date, sym: ev.sym, direction, net, capitalBefore: capital, capitalAfter: capital + net };
}

// Strategies using OOS-validated variants
const strategies = {
  "L114_vix30": {
    filter: (ev) => ev.vixLevel != null && ev.vixLevel >= 30,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    sl: 0.008, tp: 0.016, risk: 0.01,
  },
  "L119_tighter": {
    filter: (ev) => ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.003 && ev.flow_strikeShareOfDay < 0.008,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    sl: 0.008, tp: 0.016, risk: 0.01,
  },
  "L121_wide_risk2": {
    filter: (ev) => ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
                     ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    sl: 0.008, tp: 0.016, risk: 0.02,
  },
  "L115_bidir": {
    filter: (ev) => ev.vixBucket === "low" &&
      ((ev.approach === "up" && ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) ||
       (ev.approach === "down" && ev.distSpotToStrikePct >= 0.01 && ev.distSpotToStrikePct < 0.03)),
    direction: (ev) => ev.approach === "up" ? "SHORT" : "LONG",
    sl: 0.008, tp: 0.016, risk: 0.01,
  },
  "L116_down": {
    filter: (ev) => (ev.minuteBucket === "aft" || ev.minuteBucket === "close") &&
                     ev.priceRelToOpenPct <= -0.003 && ev.priceRelToOpenPct >= -0.01,
    direction: () => "SHORT",
    sl: 0.008, tp: 0.016, risk: 0.01,
  },
  // Ensemble OPTIMAL: priority L121 > L119 > L114 > L115 > L116
  "Ensemble_OPTIMAL": {
    filterAndDirection: (ev) => {
      // L121-wide first (strongest)
      if (ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
          ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
        return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.02, tp: 0.016 };
      }
      // L119-tighter
      if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.003 && ev.flow_strikeShareOfDay < 0.008) {
        return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
      }
      // L114-vix30+
      if (ev.vixLevel != null && ev.vixLevel >= 30) {
        return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
      }
      // L115-bidir
      if (ev.vixBucket === "low" &&
          ((ev.approach === "up" && ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) ||
           (ev.approach === "down" && ev.distSpotToStrikePct >= 0.01 && ev.distSpotToStrikePct < 0.03))) {
        return { direction: ev.approach === "up" ? "SHORT" : "LONG", risk: 0.01, tp: 0.016 };
      }
      // L116-down
      if ((ev.minuteBucket === "aft" || ev.minuteBucket === "close") &&
          ev.priceRelToOpenPct <= -0.003 && ev.priceRelToOpenPct >= -0.01) {
        return { direction: "SHORT", risk: 0.01, tp: 0.016 };
      }
      return null;
    },
    sl: 0.008,
  },
  "random_control": {
    filter: () => Math.random() < 0.15,
    direction: () => Math.random() < 0.5 ? "LONG" : "SHORT",
    sl: 0.008, tp: 0.016, risk: 0.01,
  },
};

function metrics(trades, capitalInitial) {
  if (trades.length === 0) return null;
  const final = trades[trades.length - 1].capitalAfter;
  const ret = ((final - capitalInitial) / capitalInitial) * 100;
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const wr = (wins.length / trades.length) * 100;
  const gw = wins.reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
  const returns = trades.map(t => t.net / t.capitalBefore);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  let cap = capitalInitial, peak = cap, maxDD = 0;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return { n: trades.length, final: +final.toFixed(2), ret: +ret.toFixed(1),
    wr: +wr.toFixed(1), pf: +pf.toFixed(2), sharpe: +sharpe.toFixed(2), dd: +maxDD.toFixed(1) };
}

function runStrategy(name, cfg, events) {
  let cap = CAPITAL_INITIAL;
  const trades = [];
  const bySymCount = {};
  for (const ev of events) {
    let direction, riskPct, tpPct;
    if (cfg.filterAndDirection) {
      const res = cfg.filterAndDirection(ev);
      if (!res) continue;
      direction = res.direction;
      riskPct = res.risk;
      tpPct = res.tp;
    } else {
      if (!cfg.filter(ev)) continue;
      direction = cfg.direction(ev);
      riskPct = cfg.risk;
      tpPct = cfg.tp;
    }
    if (!direction) continue;
    const t = simulateTrade(ev, direction, cap, cfg.sl, tpPct, riskPct);
    if (!t || !isFinite(t.net)) continue;
    cap = t.capitalAfter;
    trades.push(t);
    bySymCount[ev.sym] = (bySymCount[ev.sym] || 0) + 1;
    if (cap < 50) break;
  }
  return { metrics: metrics(trades, CAPITAL_INITIAL), bySym: bySymCount };
}

// Buy & Hold SPY
function buyHoldSpy(events) {
  const spy = events.filter(e => e.sym === "SPY").sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));
  if (spy.length === 0) return null;
  const startPrice = spy[0].openPrice;
  const endPrice = spy[spy.length - 1].priceEod;
  const ret = (endPrice - startPrice) / startPrice * 100;
  return { n: 0, final: +(CAPITAL_INITIAL * (1 + ret/100)).toFixed(2), ret: +ret.toFixed(1), wr: 0, pf: 0, sharpe: 0, dd: 0 };
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l)).sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));

  const bySym = {};
  for (const e of events) bySym[e.sym] = (bySym[e.sym] || 0) + 1;
  console.log(`Events: ${events.length} | By sym:`, bySym);
  console.log(`Period: ${events[0].date} → ${events[events.length - 1].date}\n`);

  console.log(`═══ Strategy Results ($1000 → ???) ═══\n`);

  let md = `# Capital Backtest v3 — Complete Universe (SPY + QQQ + US30 + XAUUSD)\n\n`;
  md += `**Capital inicial:** $${CAPITAL_INITIAL}\n`;
  md += `**Eventos totales:** ${events.length} | SPY: ${bySym.SPY} QQQ: ${bySym.QQQ} US30: ${bySym.US30 || 0} XAUUSD: ${bySym.XAUUSD || 0}\n`;
  md += `**Período:** ${events[0].date} → ${events[events.length - 1].date}\n`;
  md += `**Slippage:** ${(SLIPPAGE_PCT*100).toFixed(2)}% round-trip\n`;
  md += `**SL/TP:** 0.8% / 1.6% (R:R 1:2)\n\n`;

  md += `## Resultados\n\n`;
  md += `| Estrategia | # Trades | Capital final | Return % | WR | PF | Sharpe | Max DD | SPY | QQQ | US30 | XAU |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

  // Buy & Hold benchmark
  const bh = buyHoldSpy(events);
  if (bh) {
    md += `| Buy&Hold SPY | ${bh.n} | $${bh.final} | ${bh.ret>=0?'+':''}${bh.ret}% | - | - | - | - | - | - | - | - |\n`;
    console.log(`  ${"Buy&Hold SPY".padEnd(25)} → $${bh.final.toFixed(0).padEnd(8)} (${bh.ret>=0?'+':''}${bh.ret}%)`);
  }

  const results = {};
  for (const [name, cfg] of Object.entries(strategies)) {
    const res = runStrategy(name, cfg, events);
    results[name] = res;
    const m = res.metrics;
    if (!m) continue;
    const bs = res.bySym;
    md += `| ${name} | ${m.n} | $${m.final} | ${m.ret>=0?'+':''}${m.ret}% | ${m.wr}% | ${m.pf} | ${m.sharpe} | ${m.dd}% | ${bs.SPY||0} | ${bs.QQQ||0} | ${bs.US30||0} | ${bs.XAUUSD||0} |\n`;
    console.log(`  ${name.padEnd(25)} → $${m.final.toFixed(0).padEnd(8)} (${m.ret>=0?'+':''}${m.ret}%) [${m.n} trades, Sh ${m.sharpe}, WR ${m.wr}%, PF ${m.pf}, DD ${m.dd}%]`);
  }

  // Ranking
  md += `\n## Ranking por Return\n\n`;
  const sorted = Object.entries(results).filter(([_, r]) => r.metrics).sort((a, b) => b[1].metrics.final - a[1].metrics.final);
  for (let i = 0; i < sorted.length; i++) {
    const [n, r] = sorted[i];
    md += `${i+1}. **${n}**: $${r.metrics.final} (${r.metrics.ret>=0?'+':''}${r.metrics.ret}%)\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nReport: ${OUT_MD}`);
}

main();
