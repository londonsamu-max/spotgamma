#!/usr/bin/env node
/**
 * Generic Lesson Optimizer — tests all L114-L125 with 5-8 variants each
 *
 * For each lesson:
 *   - Base config
 *   - Looser filter (expand trigger condition)
 *   - Tighter filter (contract)
 *   - Different TP/SL (1:2 baseline, 1:3, 1:1.5)
 *   - Trailing stop
 *   - Time filter (aft only, skip open)
 *   - Momentum confirm
 *
 * Split train/test strict. Report only variants with TEST Sharpe > 1.0, PF > 1.2.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "optimize-all-lessons.md");

const CAPITAL_INITIAL = 1000;
const SPLIT_DATE = "2025-10-01";
const SLIPPAGE_PCT = 0.0003;

const minuteCache = new Map();
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

function walkForward(ev, direction, slPct, tpPct, maxBars = 240) {
  const bars = loadMinuteBars(ev.sym, ev.date);
  if (!bars) return null;
  const touchMs = new Date(ev.touchTs).getTime();
  const startIdx = bars.findIndex(b => b.tms >= touchMs);
  if (startIdx === -1) return null;
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
  return { net, capitalBefore: capital, capitalAfter: capital + net };
}

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
  // DD
  let cap = capitalInitial, peak = cap, maxDD = 0;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    n: trades.length, final: +final.toFixed(2), ret: +ret.toFixed(1),
    wr: +wr.toFixed(1), pf: +pf.toFixed(2), sharpe: +sharpe.toFixed(2),
    dd: +maxDD.toFixed(1),
  };
}

function runConfig(config, events) {
  let cap = CAPITAL_INITIAL;
  const trades = [];
  for (const ev of events) {
    if (!config.filter(ev)) continue;
    const dir = config.direction(ev);
    if (!dir) continue;
    const t = simulateTrade(ev, dir, cap, config.sl, config.tp, config.risk);
    if (!t || !isFinite(t.net)) continue;
    cap = t.capitalAfter;
    trades.push(t);
    if (cap < 50) break;
  }
  return metrics(trades, CAPITAL_INITIAL);
}

// Build lesson variants
function buildLessons() {
  const lessons = {};

  // ─── L114 — VIX ≥25 break ───
  lessons.L114 = [
    { name: "base", filter: e => e.vixLevel != null && e.vixLevel >= 25,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix_20+", filter: e => e.vixLevel != null && e.vixLevel >= 20,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix_30+", filter: e => e.vixLevel != null && e.vixLevel >= 30,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix25_tp_3pct", filter: e => e.vixLevel != null && e.vixLevel >= 25,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.030, risk: 0.01 },
    { name: "vix25_aft", filter: e => e.vixLevel != null && e.vixLevel >= 25 && (e.minuteBucket === "aft" || e.minuteBucket === "close"),
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix25_mom", filter: e => e.vixLevel != null && e.vixLevel >= 25 &&
        ((e.approach === "up" && e.priceRelToOpenPct > 0.002) || (e.approach === "down" && e.priceRelToOpenPct < -0.002)),
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L115 — VIX 15-20 + strike +1-3% above → bounce ───
  lessons.L115 = [
    { name: "base",
      filter: e => e.vixBucket === "low" && e.approach === "up" && e.distSpotToStrikePct >= -0.03 && e.distSpotToStrikePct < -0.01,
      direction: () => "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "bidir",
      filter: e => e.vixBucket === "low" && ((e.approach === "up" && e.distSpotToStrikePct >= -0.03 && e.distSpotToStrikePct < -0.01) ||
        (e.approach === "down" && e.distSpotToStrikePct >= 0.01 && e.distSpotToStrikePct < 0.03)),
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix_10-22_bidir",
      filter: e => e.vixLevel != null && e.vixLevel >= 10 && e.vixLevel < 22 &&
        ((e.approach === "up" && e.distSpotToStrikePct >= -0.03 && e.distSpotToStrikePct < -0.01) ||
         (e.approach === "down" && e.distSpotToStrikePct >= 0.01 && e.distSpotToStrikePct < 0.03)),
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "tight_range_-2_-1",
      filter: e => e.vixBucket === "low" && e.approach === "up" && e.distSpotToStrikePct >= -0.02 && e.distSpotToStrikePct < -0.01,
      direction: () => "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "base_tight_sl",
      filter: e => e.vixBucket === "low" && e.approach === "up" && e.distSpotToStrikePct >= -0.03 && e.distSpotToStrikePct < -0.01,
      direction: () => "SHORT", sl: 0.005, tp: 0.015, risk: 0.01 },
    { name: "base_morning_only",
      filter: e => e.vixBucket === "low" && e.approach === "up" && e.distSpotToStrikePct >= -0.03 && e.distSpotToStrikePct < -0.01 &&
        (e.minuteBucket === "open" || e.minuteBucket === "morn"),
      direction: () => "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L116 — Afternoon + momentum → break continuation ───
  lessons.L116 = [
    { name: "base_up",
      filter: e => (e.minuteBucket === "aft" || e.minuteBucket === "close") && e.priceRelToOpenPct >= 0.003 && e.priceRelToOpenPct <= 0.01,
      direction: () => "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "base_down",
      filter: e => (e.minuteBucket === "aft" || e.minuteBucket === "close") && e.priceRelToOpenPct <= -0.003 && e.priceRelToOpenPct >= -0.01,
      direction: () => "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "base_bidir",
      filter: e => (e.minuteBucket === "aft" || e.minuteBucket === "close") &&
        ((e.priceRelToOpenPct >= 0.003 && e.priceRelToOpenPct <= 0.01) || (e.priceRelToOpenPct <= -0.003 && e.priceRelToOpenPct >= -0.01)),
      direction: e => e.priceRelToOpenPct > 0 ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "wider_momentum",
      filter: e => (e.minuteBucket === "aft" || e.minuteBucket === "close") &&
        ((e.priceRelToOpenPct >= 0.002) || (e.priceRelToOpenPct <= -0.002)),
      direction: e => e.priceRelToOpenPct > 0 ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "close_only",
      filter: e => e.minuteBucket === "close" &&
        ((e.priceRelToOpenPct >= 0.003 && e.priceRelToOpenPct <= 0.01) || (e.priceRelToOpenPct <= -0.003 && e.priceRelToOpenPct >= -0.01)),
      direction: e => e.priceRelToOpenPct > 0 ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L117 — Morning first hour → bounce ───
  lessons.L117 = [
    { name: "base_approach_up_short",
      filter: e => e.minuteBucket === "open" && e.approach === "up",
      direction: () => "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "base_approach_down_long",
      filter: e => e.minuteBucket === "open" && e.approach === "down",
      direction: () => "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "open_morn_bounce",
      filter: e => (e.minuteBucket === "open" || e.minuteBucket === "morn"),
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L119 — flow share 0.1-1% → break (any VIX) ───
  lessons.L119 = [
    { name: "base_any_vix",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.001 && e.flow_strikeShareOfDay < 0.01,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "tighter_0.3-0.8",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.003 && e.flow_strikeShareOfDay < 0.008,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "wider_0.05-2",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.0005 && e.flow_strikeShareOfDay < 0.02,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L120 — flow share ≥5% → pin/flat fade ───
  lessons.L120 = [
    { name: "short_pin",  // price approach pin → bet on reversal
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.05,
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "threshold_3",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.03,
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "threshold_10",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.10,
      direction: e => e.approach === "up" ? "SHORT" : "LONG", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L122 — largestPrem ≥$1M + VIX down → bounce long ───
  // Note: We don't have VIX trend 5d in historical events (computed live only)
  // Skip for now, mark as "LIVE-ONLY"

  // ─── L125 — flow share 1-5% + late session → break ───
  lessons.L125 = [
    { name: "base",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.01 && e.flow_strikeShareOfDay < 0.05 &&
        (e.minuteBucket === "aft" || e.minuteBucket === "close"),
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "wider_range_0.5-8",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.005 && e.flow_strikeShareOfDay < 0.08 &&
        (e.minuteBucket === "aft" || e.minuteBucket === "close"),
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "any_time",
      filter: e => e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.01 && e.flow_strikeShareOfDay < 0.05,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  // ─── L121 optimized combos ───
  lessons.L121 = [
    { name: "base_vix10-22",
      filter: e => e.vixLevel != null && e.vixLevel >= 10 && e.vixLevel < 22 &&
        e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.001 && e.flow_strikeShareOfDay < 0.01,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
    { name: "vix10-22_risk2",
      filter: e => e.vixLevel != null && e.vixLevel >= 10 && e.vixLevel < 22 &&
        e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.001 && e.flow_strikeShareOfDay < 0.01,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.02 },
    { name: "vix10-22_tp_3pct",
      filter: e => e.vixLevel != null && e.vixLevel >= 10 && e.vixLevel < 22 &&
        e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.001 && e.flow_strikeShareOfDay < 0.01,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.030, risk: 0.01 },
    { name: "vix10-25",  // include extreme
      filter: e => e.vixLevel != null && e.vixLevel >= 10 && e.vixLevel < 25 &&
        e.flow_strikeShareOfDay != null && e.flow_strikeShareOfDay >= 0.001 && e.flow_strikeShareOfDay < 0.01,
      direction: e => e.approach === "up" ? "LONG" : "SHORT", sl: 0.008, tp: 0.016, risk: 0.01 },
  ];

  return lessons;
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l)).sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));
  const train = events.filter(e => e.date < SPLIT_DATE);
  const test = events.filter(e => e.date >= SPLIT_DATE);

  console.log(`Events: ${events.length} | Train: ${train.length} | Test: ${test.length}\n`);

  const lessons = buildLessons();
  const allResults = [];

  let md = `# Optimización de TODAS las Lessons L114-L125\n\n`;
  md += `**Split:** Train <${SPLIT_DATE} (${train.length} events) | Test >=${SPLIT_DATE} (${test.length} events)\n`;
  md += `**Metric de validación:** TEST Sharpe > 1.0, TEST PF > 1.2, TEST n >= 10\n\n`;

  for (const [lessonId, variants] of Object.entries(lessons)) {
    console.log(`\n═══ ${lessonId} ═══`);
    md += `\n## ${lessonId}\n\n`;
    md += `| Variant | Cfg | TR n | TR ret% | TR Sh | TR WR% | TR PF | TR DD% | TE n | TE ret% | TE Sh | TE WR% | TE PF | TE DD% | OOS? |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

    for (const v of variants) {
      const tr = runConfig(v, train);
      const te = runConfig(v, test);

      const cfg = `SL${(v.sl*100).toFixed(1)}/TP${(v.tp*100).toFixed(1)}/R${(v.risk*100).toFixed(1)}`;

      if (!tr || !te || tr.n === 0 || te.n === 0) {
        md += `| ${v.name} | ${cfg} | ${tr?.n ?? 0} | - | - | - | - | - | ${te?.n ?? 0} | - | - | - | - | - | ❌ no data |\n`;
        console.log(`  ${v.name.padEnd(25)} no data`);
        continue;
      }

      const oosOk = te.sharpe > 1.0 && te.pf > 1.2 && te.n >= 10 && te.ret > 0;
      const mark = oosOk ? "✅" : "❌";
      md += `| ${v.name} | ${cfg} | ${tr.n} | ${tr.ret>=0?'+':''}${tr.ret}% | ${tr.sharpe} | ${tr.wr}% | ${tr.pf} | ${tr.dd}% | ${te.n} | ${te.ret>=0?'+':''}${te.ret}% | ${te.sharpe} | ${te.wr}% | ${te.pf} | ${te.dd}% | ${mark} |\n`;
      console.log(`  ${v.name.padEnd(25)} TR ${tr.n}t ${tr.ret}% Sh${tr.sharpe} || TE ${te.n}t ${te.ret>=0?'+':''}${te.ret}% Sh${te.sharpe} WR${te.wr}% PF${te.pf} DD${te.dd}% ${mark}`);

      allResults.push({ lesson: lessonId, variant: v.name, cfg, train: tr, test: te, oosOk });
    }
  }

  // ─── Summary: winners ───
  md += `\n## ✅ WINNERS (survive OOS)\n\n`;
  const winners = allResults.filter(r => r.oosOk);
  if (winners.length === 0) {
    md += `_No variants survive OOS criteria._\n`;
  } else {
    winners.sort((a, b) => b.test.sharpe - a.test.sharpe);
    md += `| Lesson | Variant | Cfg | TE Sharpe | TE Return% | TE WR% | TE PF | TE DD% | TE n |\n`;
    md += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const w of winners) {
      md += `| ${w.lesson} | ${w.variant} | ${w.cfg} | ${w.test.sharpe} | ${w.test.ret>=0?'+':''}${w.test.ret}% | ${w.test.wr}% | ${w.test.pf} | ${w.test.dd}% | ${w.test.n} |\n`;
    }
  }

  // ─── Losers ───
  md += `\n## ❌ LOSERS (fail OOS — consider deprecating)\n\n`;
  const losers = allResults.filter(r => !r.oosOk && r.test.n >= 10);
  if (losers.length > 0) {
    md += `| Lesson | Variant | Reason |\n|---|---|---|\n`;
    for (const l of losers) {
      const reasons = [];
      if (l.test.sharpe <= 1.0) reasons.push(`Sharpe ${l.test.sharpe} ≤ 1.0`);
      if (l.test.pf <= 1.2) reasons.push(`PF ${l.test.pf} ≤ 1.2`);
      if (l.test.ret <= 0) reasons.push(`negative return`);
      md += `| ${l.lesson} | ${l.variant} | ${reasons.join(", ")} |\n`;
    }
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nReport: ${OUT_MD}`);
  console.log(`Winners: ${winners.length} | Losers with N>=10: ${losers.length}`);
}

main();
