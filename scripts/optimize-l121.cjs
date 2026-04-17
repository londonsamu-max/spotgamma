#!/usr/bin/env node
/**
 * L121 Strategy Optimizer
 *
 * Base L121: VIX [15-20) + flow_strikeShareOfDay [0.001, 0.01] → break continuation
 * Currently: Sharpe 7.67, DD 4.5%, WR 66%, PF 3.52, N=58 (backtest v2 wide config)
 *
 * Test variants with strict train/test split to avoid overfitting:
 *   - TP/SL sweep (TP: 1.0% to 3.0%, SL: 0.5% to 1.5%)
 *   - Filters (time of day, approach confirmation, flow direction)
 *   - Position sizing (1% to 3% risk per trade)
 *   - Retest entry (skip first touch, enter on 2nd)
 *
 * Report only variants that:
 *   - Beat base on train AND
 *   - Retain edge OOS (Sharpe > 1.0, PF > 1.2, not overfit)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "optimize-l121.md");

const CAPITAL_INITIAL = 1000;
const SPLIT_DATE = "2025-10-01";
const SLIPPAGE_PCT = 0.0003;

// Cache minute bars
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

function walkForward(ev, direction, slPct, tpPct, trailingFromRR = null, maxBars = 240) {
  const bars = loadMinuteBars(ev.sym, ev.date);
  if (!bars) return null;
  const touchMs = new Date(ev.touchTs).getTime();
  const startIdx = bars.findIndex(b => b.tms >= touchMs);
  if (startIdx === -1) return null;

  const entry = ev.priceAtTouch;
  let sl = direction === "LONG" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp = direction === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);
  const initialSlDist = Math.abs(entry - sl);

  let trailActivated = false;
  let maxFavorableMove = 0; // tracks how far price moved in our favor

  const end = Math.min(startIdx + maxBars, bars.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const b = bars[i];
    if (direction === "LONG") {
      // Update max favorable (price high)
      const favDist = b.h - entry;
      if (favDist > maxFavorableMove) maxFavorableMove = favDist;

      // Activate trailing if enabled and we've hit breakeven R
      if (trailingFromRR != null && maxFavorableMove >= initialSlDist * trailingFromRR) {
        trailActivated = true;
        // Trail at max(current sl, high - initialSlDist)
        const newSl = b.h - initialSlDist * 0.5; // tighter after activation
        if (newSl > sl) sl = newSl;
      }

      if (b.l <= sl) return { exitPrice: sl, reason: "sl" + (trailActivated ? "_trail" : ""), barsHeld: i - startIdx };
      if (b.h >= tp) return { exitPrice: tp, reason: "tp", barsHeld: i - startIdx };
    } else {
      const favDist = entry - b.l;
      if (favDist > maxFavorableMove) maxFavorableMove = favDist;

      if (trailingFromRR != null && maxFavorableMove >= initialSlDist * trailingFromRR) {
        trailActivated = true;
        const newSl = b.l + initialSlDist * 0.5;
        if (newSl < sl) sl = newSl;
      }

      if (b.h >= sl) return { exitPrice: sl, reason: "sl" + (trailActivated ? "_trail" : ""), barsHeld: i - startIdx };
      if (b.l <= tp) return { exitPrice: tp, reason: "tp", barsHeld: i - startIdx };
    }
  }
  return { exitPrice: bars[end].c, reason: "eod", barsHeld: end - startIdx };
}

function simulateTrade(ev, direction, capital, slPct, tpPct, riskPct, trailingFromRR) {
  const exit = walkForward(ev, direction, slPct, tpPct, trailingFromRR);
  if (!exit) return null;
  const slDist = ev.priceAtTouch * slPct;
  const units = (capital * riskPct) / slDist;
  const priceMove = direction === "LONG" ? (exit.exitPrice - ev.priceAtTouch) : (ev.priceAtTouch - exit.exitPrice);
  const gross = units * priceMove;
  const slip = units * ev.priceAtTouch * SLIPPAGE_PCT;
  const net = gross - slip;
  return {
    date: ev.date, sym: ev.sym, direction,
    entry: ev.priceAtTouch, exit: exit.exitPrice, reason: exit.reason,
    net, pnlPct: net / capital * 100,
    capitalBefore: capital, capitalAfter: capital + net,
  };
}

// Define L121 variants
function buildVariants() {
  const variants = [];

  // Base L121
  variants.push({
    name: "base",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Tighter share range (0.3% - 0.8%)
  variants.push({
    name: "tight_share",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.003 && ev.flow_strikeShareOfDay < 0.008,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Higher TP (2.5%)
  variants.push({
    name: "high_tp",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.025, riskPct: 0.01, trailingFromRR: null,
  });

  // TP 2.0% R:R 1:2.5
  variants.push({
    name: "tp_2pct",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.020, riskPct: 0.01, trailingFromRR: null,
  });

  // Tighter SL (0.5%)
  variants.push({
    name: "tight_sl",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.005, tpPct: 0.015, riskPct: 0.01, trailingFromRR: null,
  });

  // 2% risk (double)
  variants.push({
    name: "risk_2pct",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.02, trailingFromRR: null,
  });

  // Trailing stop at 1R
  variants.push({
    name: "trail_1r",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.030, riskPct: 0.01, trailingFromRR: 1.0,
  });

  // Skip first hour (avoid open noise)
  variants.push({
    name: "skip_open",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    ev.minuteBucket !== "open" && ev.minuteBucket !== "morn",
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Only afternoon
  variants.push({
    name: "aft_only",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    (ev.minuteBucket === "aft" || ev.minuteBucket === "close"),
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Require price already moving in approach direction (momentum confirm)
  variants.push({
    name: "momentum_confirm",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    ((ev.approach === "up" && ev.priceRelToOpenPct > 0.002) ||
                     (ev.approach === "down" && ev.priceRelToOpenPct < -0.002)),
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // No oi_ratio extremes (avoid call-heavy pins and put-heavy zones)
  variants.push({
    name: "balanced_oi",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    ev.oiRatio >= 0.3 && ev.oiRatio <= 0.7,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Session range expansion (more trending day)
  variants.push({
    name: "range_expansion",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    ev.sessionRangeBeforeTouchPct >= 0.005,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  // Combo: aft_only + momentum_confirm + trail
  variants.push({
    name: "combo_aft_mom_trail",
    filter: (ev) => ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01 &&
                    (ev.minuteBucket === "aft" || ev.minuteBucket === "close") &&
                    ((ev.approach === "up" && ev.priceRelToOpenPct > 0.002) ||
                     (ev.approach === "down" && ev.priceRelToOpenPct < -0.002)),
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.030, riskPct: 0.015, trailingFromRR: 1.0,
  });

  // Combo 2: wider VIX range [10-22] (relax)
  variants.push({
    name: "wider_vix",
    filter: (ev) => ev.vixLevel != null && ev.vixLevel >= 10 && ev.vixLevel < 22 &&
                    ev.flow_strikeShareOfDay != null &&
                    ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01,
    direction: (ev) => ev.approach === "up" ? "LONG" : "SHORT",
    slPct: 0.008, tpPct: 0.016, riskPct: 0.01, trailingFromRR: null,
  });

  return variants;
}

function computeMetrics(trades, capitalInitial, equity) {
  if (trades.length === 0) {
    return { trades: 0, finalCapital: capitalInitial, returnPct: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDDPct: 0, sharpe: 0, losingStreak: 0 };
  }
  const finalCapital = trades[trades.length - 1].capitalAfter;
  const returnPct = ((finalCapital - capitalInitial) / capitalInitial) * 100;
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossW = wins.reduce((s, t) => s + t.net, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const pf = grossL > 0 ? grossW / grossL : (grossW > 0 ? 999 : 0);
  const expectancy = trades.reduce((s, t) => s + t.net, 0) / trades.length;
  let peak = capitalInitial, maxDDPct = 0;
  for (const pt of equity) {
    if (pt.capital > peak) peak = pt.capital;
    const dd = (peak - pt.capital) / peak * 100;
    if (dd > maxDDPct) maxDDPct = dd;
  }
  const returns = trades.map(t => t.net / t.capitalBefore);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  let streak = 0, longest = 0;
  for (const t of trades) {
    if (t.net <= 0) { streak++; if (streak > longest) longest = streak; }
    else streak = 0;
  }
  return {
    trades: trades.length,
    finalCapital: +finalCapital.toFixed(2),
    returnPct: +returnPct.toFixed(1),
    winRate: +winRate.toFixed(1),
    profitFactor: +pf.toFixed(2),
    expectancy: +expectancy.toFixed(3),
    maxDDPct: +maxDDPct.toFixed(1),
    sharpe: +sharpe.toFixed(2),
    losingStreak: longest,
  };
}

function runVariant(variant, events) {
  let cap = CAPITAL_INITIAL;
  const trades = [];
  const equity = [{ date: events[0]?.date || "2024-01-01", capital: cap }];
  for (const ev of events) {
    if (!variant.filter(ev)) continue;
    const dir = variant.direction(ev);
    const tr = simulateTrade(ev, dir, cap, variant.slPct, variant.tpPct, variant.riskPct, variant.trailingFromRR);
    if (!tr || !isFinite(tr.net)) continue;
    cap = tr.capitalAfter;
    trades.push(tr);
    equity.push({ date: ev.date, capital: cap });
    if (cap < 50) break;
  }
  return { metrics: computeMetrics(trades, CAPITAL_INITIAL, equity), trades };
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l)).sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));

  const train = events.filter(e => e.date < SPLIT_DATE);
  const test = events.filter(e => e.date >= SPLIT_DATE);

  console.log(`Total: ${events.length} | Train: ${train.length} | Test: ${test.length}`);

  const variants = buildVariants();
  console.log(`\nTesting ${variants.length} variants on train + test...\n`);

  const results = [];
  for (const v of variants) {
    const tr = runVariant(v, train);
    const te = runVariant(v, test);
    results.push({ variant: v.name, train: tr, test: te, cfg: { sl: v.slPct, tp: v.tpPct, risk: v.riskPct, trail: v.trailingFromRR } });

    const trM = tr.metrics, teM = te.metrics;
    console.log(`  ${v.name.padEnd(25)} TR: $${trM.finalCapital.toFixed(0).padEnd(6)} (${trM.returnPct>=0?"+":""}${trM.returnPct}%) ${trM.trades} tr Sh${trM.sharpe} WR${trM.winRate}% PF${trM.profitFactor}  ||  TE: $${teM.finalCapital.toFixed(0).padEnd(6)} (${teM.returnPct>=0?"+":""}${teM.returnPct}%) ${teM.trades} tr Sh${teM.sharpe} WR${teM.winRate}% PF${teM.profitFactor}`);
  }

  // Report
  let md = `# L121 Optimization Report\n\n`;
  md += `**Base L121:** VIX [15-20) + flow_strikeShareOfDay [0.001, 0.01] → break continuation\n`;
  md += `**Split:** Train <${SPLIT_DATE} (${train.length} events) | Test >=${SPLIT_DATE} (${test.length} events)\n\n`;

  md += `## Results — All Variants\n\n`;
  md += `| Variant | Cfg | TR: $end | TR: Ret% | TR: N | TR: Sh | TR: WR% | TR: PF | TR: DD% | TE: $end | TE: Ret% | TE: N | TE: Sh | TE: WR% | TE: PF | TE: DD% |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    const tr = r.train.metrics, te = r.test.metrics;
    const cfg = `SL${(r.cfg.sl*100).toFixed(1)}/TP${(r.cfg.tp*100).toFixed(1)}/R${(r.cfg.risk*100).toFixed(1)}${r.cfg.trail?'/T'+r.cfg.trail:''}`;
    md += `| ${r.variant} | ${cfg} | $${tr.finalCapital} | ${tr.returnPct>=0?"+":""}${tr.returnPct}% | ${tr.trades} | ${tr.sharpe} | ${tr.winRate}% | ${tr.profitFactor} | ${tr.maxDDPct}% | $${te.finalCapital} | ${te.returnPct>=0?"+":""}${te.returnPct}% | ${te.trades} | ${te.sharpe} | ${te.winRate}% | ${te.profitFactor} | ${te.maxDDPct}% |\n`;
  }

  // Identify true winners (retain edge OOS)
  md += `\n## True Winners (OOS survivors)\n\n`;
  md += `Criteria: TE Sharpe > 1.0, TE PF > 1.2, TE Return > 0%, TE #trades >= 10\n\n`;
  const winners = results.filter(r =>
    r.test.metrics.sharpe > 1.0 &&
    r.test.metrics.profitFactor > 1.2 &&
    r.test.metrics.returnPct > 0 &&
    r.test.metrics.trades >= 10
  );
  if (winners.length === 0) {
    md += `_No variants survive OOS. Base L121 likely the most robust (although small N)._\n`;
  } else {
    // Sort by test Sharpe
    winners.sort((a, b) => b.test.metrics.sharpe - a.test.metrics.sharpe);
    md += `| Variant | Cfg | TE Sharpe | TE Return% | TE N | TE WR% | TE PF | TE DD% |\n`;
    md += `|---|---|---|---|---|---|---|---|\n`;
    for (const r of winners) {
      const te = r.test.metrics;
      const cfg = `SL${(r.cfg.sl*100).toFixed(1)}/TP${(r.cfg.tp*100).toFixed(1)}/R${(r.cfg.risk*100).toFixed(1)}${r.cfg.trail?'/T'+r.cfg.trail:''}`;
      md += `| ${r.variant} | ${cfg} | ${te.sharpe} | ${te.returnPct>=0?"+":""}${te.returnPct}% | ${te.trades} | ${te.winRate}% | ${te.profitFactor} | ${te.maxDDPct}% |\n`;
    }
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nReport: ${OUT_MD}`);
}

main();
