#!/usr/bin/env node
/**
 * Capital Backtest V5 — MEGA ensemble con TODAS las lessons descubiertas
 *
 * Lessons incluidas (tier priority):
 *   L121-wide, L126, L128, L129 (core ⭐⭐⭐)
 *   L127, L130 (HIRO)
 *   L131-L136 (NEW: spreads + dealer + intraday)
 *   L119-tighter (flow fallback)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v4.jsonl");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const MT5_DIR = path.join(ROOT, "data", "historical", "mt5-candles");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "capital-results-v5.md");

const CAPITAL_INITIAL = 1000;
const SLIPPAGE_PCT = 0.0003;

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
  if (sym === "US30" || sym === "XAUUSD") return loadMT5Full(sym)[date] || null;
  return loadMinuteBars(sym, date);
}

function walkForward(ev, direction, slPct, tpPct) {
  const bars = getBars(ev.sym, ev.date);
  if (!bars || bars.length === 0) return null;
  const touchMs = new Date(ev.touchTs).getTime();
  const startIdx = bars.findIndex(b => b.tms >= touchMs);
  if (startIdx === -1) return null;
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

// MEGA ensemble V5 with priority cascade
function ensembleV5(ev) {
  // L121-wide strongest (flow-based)
  if (ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
      ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.02, tp: 0.016, lesson: "L121" };
  }
  // L126 HIRO bearish + aft
  if (ev.hiro_consensus === "bearish" && (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016, lesson: "L126" };
  }
  // L128 QQQ HIRO drop + VIX high
  if (ev.hiro_qqq_delta_1h != null && ev.hiro_qqq_delta_1h < -30 &&
      (ev.vixBucket === "high" || ev.vixBucket === "extreme")) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.02, tp: 0.016, lesson: "L128" };
  }
  // L129 HIRO avg bear + aft
  if (ev.hiro_avg_pctl != null && ev.hiro_avg_pctl >= -50 && ev.hiro_avg_pctl < -20 &&
      (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016, lesson: "L129" };
  }
  // L130 QQQ HIRO extreme bear
  if (ev.hiro_qqq_pctl != null && ev.hiro_qqq_pctl < -70) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.01, tp: 0.016, lesson: "L130" };
  }
  // L132 spreads strong bearish bias + afternoon
  if (ev.spreads_bias != null && ev.spreads_bias < -0.5 &&
      (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016, lesson: "L132" };
  }
  // L135 straddle count moderate + HIRO bearish
  if (ev.spreads_straddle_count >= 5 && ev.spreads_straddle_count < 15 && ev.hiro_consensus === "bearish") {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016, lesson: "L135" };
  }
  // L131 intra burst + approach up
  if (ev.intra_burst_count != null && ev.intra_burst_count >= 1 && ev.intra_burst_count < 3 &&
      ev.approach === "up") {
    return { direction: "LONG", risk: 0.01, tp: 0.016, lesson: "L131" };
  }
  // L127 SPY HIRO positive + VIX mid → bounce
  if (ev.hiro_spy_pctl != null && ev.hiro_spy_pctl >= 0 && ev.hiro_spy_pctl < 30 && ev.vixBucket === "mid") {
    return { direction: ev.approach === "up" ? "SHORT" : "LONG", risk: 0.015, tp: 0.016, lesson: "L127" };
  }
  // L119 tighter flow share fallback
  if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.003 && ev.flow_strikeShareOfDay < 0.008) {
    return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.01, tp: 0.016, lesson: "L119" };
  }
  return null;
}

const strategies = {
  "L121_wide_risk2": (ev) => {
    if (ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
        ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.02, tp: 0.016 };
    }
    return null;
  },
  "Ensemble_V4": (ev) => {
    if (ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
        ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.02, tp: 0.016 };
    }
    if (ev.hiro_consensus === "bearish" && (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
    }
    if (ev.hiro_avg_pctl != null && ev.hiro_avg_pctl >= -50 && ev.hiro_avg_pctl < -20 &&
        (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
    }
    if (ev.hiro_qqq_pctl != null && ev.hiro_qqq_pctl < -70) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.01, tp: 0.016 };
    }
    return null;
  },
  "Ensemble_V5_MEGA": ensembleV5,
  // Individual new lessons
  "L131_burst_up": (ev) => {
    if (ev.intra_burst_count != null && ev.intra_burst_count >= 1 && ev.intra_burst_count < 3 && ev.approach === "up") {
      return { direction: "LONG", risk: 0.01, tp: 0.016 };
    }
    return null;
  },
  "L132_spreads_bear_aft": (ev) => {
    if (ev.spreads_bias != null && ev.spreads_bias < -0.5 &&
        (ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
    }
    return null;
  },
  "L135_straddle_hiro_bear": (ev) => {
    if (ev.spreads_straddle_count >= 5 && ev.spreads_straddle_count < 15 && ev.hiro_consensus === "bearish") {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", risk: 0.015, tp: 0.016 };
    }
    return null;
  },
  "random_control": () => Math.random() < 0.15 ? { direction: Math.random() < 0.5 ? "LONG" : "SHORT", risk: 0.01, tp: 0.016 } : null,
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

function runStrategy(fn, events) {
  let cap = CAPITAL_INITIAL;
  const trades = [];
  const byLesson = {};
  const SL = 0.008;
  for (const ev of events) {
    const r = fn(ev);
    if (!r || !r.direction) continue;
    const t = simulateTrade(ev, r.direction, cap, SL, r.tp || 0.016, r.risk || 0.01);
    if (!t || !isFinite(t.net)) continue;
    cap = t.capitalAfter;
    const lesson = r.lesson || "auto";
    trades.push({ ...t, lesson });
    byLesson[lesson] = (byLesson[lesson] || 0) + 1;
    if (cap < 50) break;
  }
  return { metrics: metrics(trades, CAPITAL_INITIAL), byLesson };
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l)).sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));

  console.log(`Events: ${events.length} | Period: ${events[0].date} → ${events[events.length - 1].date}\n`);
  console.log(`═══ V5 MEGA — with spreads + dealer + intraday ═══\n`);

  let md = `# Capital Backtest V5 — MEGA Ensemble (11+ lessons)\n\n`;
  md += `**Events:** ${events.length}\n\n`;
  md += `| Strategy | N | Capital | Return | WR | PF | Sharpe | DD |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;

  const results = {};
  for (const [name, fn] of Object.entries(strategies)) {
    const res = runStrategy(fn, events);
    results[name] = res;
    const m = res.metrics;
    if (!m) { md += `| ${name} | 0 | - | - | - | - | - | - |\n`; continue; }
    md += `| ${name} | ${m.n} | $${m.final} | ${m.ret>=0?'+':''}${m.ret}% | ${m.wr}% | ${m.pf} | ${m.sharpe} | ${m.dd}% |\n`;
    console.log(`  ${name.padEnd(25)} → $${m.final.toFixed(0).padEnd(8)} (${m.ret>=0?'+':''}${m.ret}%) [${m.n}t, Sh ${m.sharpe}, WR ${m.wr}%, DD ${m.dd}%]`);
  }

  if (results["Ensemble_V5_MEGA"]?.byLesson) {
    md += `\n## V5 Breakdown by lesson fired\n\n`;
    md += `| Lesson | Trades |\n|---|---|\n`;
    for (const [l, n] of Object.entries(results["Ensemble_V5_MEGA"].byLesson).sort((a, b) => b[1] - a[1])) {
      md += `| ${l} | ${n} |\n`;
    }
  }

  md += `\n## Ranking\n\n`;
  const sorted = Object.entries(results).filter(([_, r]) => r.metrics).sort((a, b) => b[1].metrics.final - a[1].metrics.final);
  for (let i = 0; i < sorted.length; i++) {
    const [n, r] = sorted[i];
    md += `${i+1}. **${n}**: $${r.metrics.final} (${r.metrics.ret>=0?'+':''}${r.metrics.ret}%) Sh ${r.metrics.sharpe}\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nReport: ${OUT_MD}`);
}

main();
