#!/usr/bin/env node
/**
 * Capital Backtest v2 — Minute-by-minute walk forward
 *
 * Improvements over v1:
 *   - Walks minute bars to detect SL/TP hits precisely (no look-ahead bias)
 *   - Realistic SL/TP (0.5% SL, 1.0% TP — R:R 1:2)
 *   - Also tests wider SL/TP (0.7% SL, 1.5% TP)
 *   - Fixed L114 direction (use approach, not gammaType)
 *   - Monte Carlo shuffle for robustness
 *   - Per-year + per-sym breakdown
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const OHLC_DIR = path.join(ROOT, "data", "historical", "ohlc-1min");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "capital-results-v2.md");

const CAPITAL_INITIAL = 1000;
const RISK_PER_TRADE = 0.01;  // 1% risk
const SLIPPAGE_PCT = 0.0003;  // 0.03% round-trip

// Cache minute bars per (sym, date)
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

// Walk minute bars from touch forward, return exit info
function walkForward(ev, direction, slPct, tpPct, maxBars = 240) {
  const bars = loadMinuteBars(ev.sym, ev.date);
  if (!bars) return null;
  const touchMs = new Date(ev.touchTs).getTime();
  const startIdx = bars.findIndex(b => b.tms >= touchMs);
  if (startIdx === -1) return null;

  const entry = ev.priceAtTouch;
  const sl = direction === "LONG" ? entry * (1 - slPct) : entry * (1 + slPct);
  const tp = direction === "LONG" ? entry * (1 + tpPct) : entry * (1 - tpPct);

  // Walk minute bars
  const end = Math.min(startIdx + maxBars, bars.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const b = bars[i];
    if (direction === "LONG") {
      if (b.l <= sl) return { exitPrice: sl, reason: "sl", barsHeld: i - startIdx };
      if (b.h >= tp) return { exitPrice: tp, reason: "tp", barsHeld: i - startIdx };
    } else {
      if (b.h >= sl) return { exitPrice: sl, reason: "sl", barsHeld: i - startIdx };
      if (b.l <= tp) return { exitPrice: tp, reason: "tp", barsHeld: i - startIdx };
    }
  }
  // EOD exit
  return { exitPrice: bars[end].c, reason: "eod", barsHeld: end - startIdx };
}

function simulateTrade(ev, direction, capital, slPct, tpPct) {
  const entry = ev.priceAtTouch;
  const exit = walkForward(ev, direction, slPct, tpPct);
  if (!exit) return null;
  const slDist = entry * slPct;
  const units = (capital * RISK_PER_TRADE) / slDist;
  const priceMove = direction === "LONG" ? (exit.exitPrice - entry) : (entry - exit.exitPrice);
  const gross = units * priceMove;
  const slip = units * entry * SLIPPAGE_PCT;
  const net = gross - slip;
  return {
    date: ev.date, sym: ev.sym, strike: ev.strike, direction,
    entry, exit: exit.exitPrice, reason: exit.reason, barsHeld: exit.barsHeld,
    units, net, gross, slip,
    pnlPct: net / capital * 100,
    capitalBefore: capital,
    capitalAfter: capital + net,
  };
}

// Strategies — all use approach for direction (break continuation) or explicit bounce (countertrend)
const strategies = {
  "L114_break": (ev) => {
    if (ev.vixLevel != null && ev.vixLevel >= 25) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    return null;
  },
  "L115_bounce": (ev) => {
    // VIX 15-20 + strike 1-3% above spot + approach up → strike holds → SHORT
    if (ev.vixBucket === "low" && ev.approach === "up" &&
        ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      return { direction: "SHORT" };
    }
    // Mirror: strike 1-3% below spot + approach down → strike holds → LONG
    if (ev.vixBucket === "low" && ev.approach === "down" &&
        ev.distSpotToStrikePct >= 0.01 && ev.distSpotToStrikePct < 0.03) {
      return { direction: "LONG" };
    }
    return null;
  },
  "L121_break": (ev) => {
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    return null;
  },
  "L120_skip_pin": (ev) => null, // doesn't trade — just filters out pins
  "ensemble_HIGH_conf": (ev) => {
    // Only tier-⭐⭐⭐ lessons: L114, L115, L121
    // Priority: L121 > L115 > L114

    // L120 PIN filter — skip
    if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.05) return null;

    // L121: strongest edge
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    // L115: bounce
    if (ev.vixBucket === "low" && ev.approach === "up" &&
        ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      return { direction: "SHORT" };
    }
    if (ev.vixBucket === "low" && ev.approach === "down" &&
        ev.distSpotToStrikePct >= 0.01 && ev.distSpotToStrikePct < 0.03) {
      return { direction: "LONG" };
    }
    // L114: VIX high break
    if (ev.vixLevel != null && ev.vixLevel >= 25) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    return null;
  },
  "ensemble_ALL_tiers": (ev) => {
    // L120 skip
    if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.05) return null;

    // L121 highest
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    // L115
    if (ev.vixBucket === "low" && ev.approach === "up" &&
        ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      return { direction: "SHORT" };
    }
    if (ev.vixBucket === "low" && ev.approach === "down" &&
        ev.distSpotToStrikePct >= 0.01 && ev.distSpotToStrikePct < 0.03) {
      return { direction: "LONG" };
    }
    // L114
    if (ev.vixLevel != null && ev.vixLevel >= 25) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    // L116 afternoon momentum
    if ((ev.minuteBucket === "aft" || ev.minuteBucket === "close")) {
      if (ev.priceRelToOpenPct >= 0.003 && ev.priceRelToOpenPct <= 0.01) {
        return { direction: "LONG" };
      }
      if (ev.priceRelToOpenPct <= -0.003 && ev.priceRelToOpenPct >= -0.01) {
        return { direction: "SHORT" };
      }
    }
    // L119 moderate share break (any VIX)
    if (ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    return null;
  },
  "random_control": (ev) => {
    return Math.random() < 0.5 ? { direction: Math.random() < 0.5 ? "LONG" : "SHORT" } : null;
  },
};

function computeMetrics(trades, capitalInitial, equity) {
  if (trades.length === 0) {
    return { trades: 0, finalCapital: capitalInitial, returnPct: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDDPct: 0, sharpe: 0, avgTrade: 0, losingStreak: 0 };
  }
  const finalCapital = trades[trades.length - 1].capitalAfter;
  const returnPct = ((finalCapital - capitalInitial) / capitalInitial) * 100;
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossW = wins.reduce((s, t) => s + t.net, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const profitFactor = grossL > 0 ? grossW / grossL : (grossW > 0 ? 999 : 0);
  const expectancy = trades.reduce((s, t) => s + t.net, 0) / trades.length;

  let peak = capitalInitial, maxDD = 0, maxDDPct = 0;
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
    profitFactor: +profitFactor.toFixed(2),
    avgTrade: +expectancy.toFixed(3),
    maxDDPct: +maxDDPct.toFixed(1),
    sharpe: +sharpe.toFixed(2),
    losingStreak: longest,
  };
}

function runStrategy(name, fn, events, slPct, tpPct) {
  let cap = CAPITAL_INITIAL;
  const trades = [];
  const equity = [{ date: events[0].date, capital: cap }];
  for (const ev of events) {
    const sig = fn(ev);
    if (!sig || !sig.direction) continue;
    const tr = simulateTrade(ev, sig.direction, cap, slPct, tpPct);
    if (!tr || !isFinite(tr.net)) continue;
    cap = tr.capitalAfter;
    trades.push(tr);
    equity.push({ date: ev.date, capital: cap });
    if (cap < 50) break;
  }
  return { metrics: computeMetrics(trades, CAPITAL_INITIAL, equity), trades, equity };
}

function runMonteCarloShuffle(trades, capitalInitial, n = 500) {
  // Shuffle the trade sequence and recompute final capital n times
  const finals = [];
  for (let iter = 0; iter < n; iter++) {
    const shuffled = trades.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let cap = capitalInitial;
    let minCap = cap;
    for (const t of shuffled) {
      // Recompute PnL relative to this capital (keeping risk proportion)
      const pnlPct = t.net / t.capitalBefore;
      cap *= (1 + pnlPct);
      if (cap < minCap) minCap = cap;
      if (cap < capitalInitial * 0.1) break; // ruined
    }
    finals.push(cap);
  }
  finals.sort((a, b) => a - b);
  return {
    median: finals[Math.floor(n / 2)],
    p05: finals[Math.floor(n * 0.05)],
    p95: finals[Math.floor(n * 0.95)],
    min: finals[0],
    max: finals[n - 1],
    ruinPct: (finals.filter(f => f < capitalInitial * 0.5).length / n) * 100,
  };
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l))
                      .sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));
  console.log(`Loaded ${events.length} events | period: ${events[0].date} → ${events[events.length - 1].date}`);

  // Test two SL/TP regimes
  const slTpConfigs = [
    { name: "tight", sl: 0.003, tp: 0.006 },
    { name: "medium", sl: 0.005, tp: 0.010 },
    { name: "wide", sl: 0.008, tp: 0.016 },
  ];

  let md = `# Capital Backtest v2 — Minute-by-Minute Walk Forward\n\n`;
  md += `**Capital inicial:** $${CAPITAL_INITIAL}\n`;
  md += `**Risk per trade:** ${(RISK_PER_TRADE * 100).toFixed(1)}%\n`;
  md += `**Slippage:** ${(SLIPPAGE_PCT * 100).toFixed(2)}% round-trip\n`;
  md += `**Período:** ${events[0].date} → ${events[events.length - 1].date} (${events.length} eventos)\n`;
  md += `**Universo:** SPY + QQQ (native ETF gamma bars)\n\n`;
  md += `## Walk-forward: se caminan bars de 1-min desde el touch, detectando SL/TP intra-barra.\n\n`;

  for (const cfg of slTpConfigs) {
    console.log(`\n── SL/TP config: ${cfg.name} (SL ${(cfg.sl*100).toFixed(1)}%, TP ${(cfg.tp*100).toFixed(1)}%, R:R 1:2) ──`);
    md += `\n## SL/TP ${cfg.name} — SL=${(cfg.sl * 100).toFixed(1)}%, TP=${(cfg.tp * 100).toFixed(1)}% (R:R 1:2)\n\n`;
    md += `| Estrategia | # Trades | Capital final | Return % | Win% | PF | Expectancy $ | Max DD % | Sharpe | L-Streak |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;

    const results = {};
    for (const [name, fn] of Object.entries(strategies)) {
      if (name === "L120_skip_pin") continue; // filter-only
      const res = runStrategy(name, fn, events, cfg.sl, cfg.tp);
      results[name] = res;
      const m = res.metrics;
      console.log(`  ${name.padEnd(25)} → $${m.finalCapital.toFixed(2).padEnd(10)} (${m.returnPct >= 0 ? "+" : ""}${m.returnPct}%) [${m.trades} trades, Sharpe ${m.sharpe}, DD ${m.maxDDPct}%, WR ${m.winRate}%, PF ${m.profitFactor}]`);
      md += `| ${name} | ${m.trades} | $${m.finalCapital.toFixed(2)} | ${m.returnPct >= 0 ? "+" : ""}${m.returnPct}% | ${m.winRate}% | ${m.profitFactor} | ${m.avgTrade} | ${m.maxDDPct}% | ${m.sharpe} | ${m.losingStreak} |\n`;
    }

    // Monte Carlo on best strategy
    const topStrat = Object.entries(results).sort((a, b) => b[1].metrics.finalCapital - a[1].metrics.finalCapital)[0];
    if (topStrat && topStrat[1].trades.length >= 50) {
      const mc = runMonteCarloShuffle(topStrat[1].trades, CAPITAL_INITIAL, 500);
      md += `\n### Monte Carlo shuffle (top strat = ${topStrat[0]}, N=500 shuffles)\n\n`;
      md += `- **Mediana:** $${mc.median.toFixed(2)}\n`;
      md += `- **P05:** $${mc.p05.toFixed(2)} (5% peor caso)\n`;
      md += `- **P95:** $${mc.p95.toFixed(2)} (5% mejor caso)\n`;
      md += `- **Ruinas** (drops below $500): ${mc.ruinPct.toFixed(1)}%\n\n`;
      console.log(`  MC ${topStrat[0]}: median=$${mc.median.toFixed(0)}, P05=$${mc.p05.toFixed(0)}, P95=$${mc.p95.toFixed(0)}, ruin=${mc.ruinPct.toFixed(1)}%`);
    }
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`\nReport: ${OUT_MD}`);
}

main();
