#!/usr/bin/env node
/**
 * Capital Backtest — $1000 → ???
 *
 * Simulates 7 trading strategies on historical events and measures final capital
 * with full metrics (Sharpe, max DD, win rate, profit factor, etc).
 *
 * Strategies:
 *   1. Buy & Hold SPY (market beta baseline)
 *   2. Random entries at gamma bars (sanity check — should lose to costs)
 *   3. L114 only (VIX ≥25 → SHORT break)
 *   4. L115 only (VIX 15-20 + strike +1-3% above → LONG bounce)
 *   5. L121 only (strongest edge — moderate share + VIX low → SHORT break)
 *   6. Ensemble L114+L115+L121+L122 with conflict resolution
 *   7. Ensemble + L116 filter (afternoon + momentum)
 *
 * Risk per trade: 1% of capital (conservative)
 * SL/TP: next gamma bar with buffer, or 0.3% fallback
 * Spread: 1 tick per trade
 *
 * Output: data/backtest-v2/capital-results.md + equity-curves.csv
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const OUT_MD = path.join(ROOT, "data", "backtest-v2", "capital-results.md");
const OUT_CSV = path.join(ROOT, "data", "backtest-v2", "equity-curves.csv");

const CAPITAL_INITIAL = 1000;
const RISK_PER_TRADE = 0.01;  // 1% risk per trade
const SLIPPAGE_PCT = 0.0003;  // 0.03% per round-trip (entry + exit)

// Strategy logic: return { trade: boolean, direction: "LONG"|"SHORT", confidence }
const strategies = {
  "1_buy_hold": (_ev, _ctx) => null, // computed separately
  "2_random": (ev) => {
    const rand = Math.random();
    if (rand < 0.5) return null;
    return { direction: rand < 0.75 ? "LONG" : "SHORT" };
  },
  "3_L114_only": (ev) => {
    // VIX ≥25 + strike is resistance → SHORT
    if (ev.vixLevel != null && ev.vixLevel >= 25 && ev.gammaType === "resistance") {
      return { direction: "SHORT" };
    }
    // VIX ≥25 + strike is support + approach down → LONG (break down expected, fade)
    // NOT trading this — L114 is only break bias
    return null;
  },
  "4_L115_only": (ev) => {
    // VIX 15-20 + strike +1-3% above price at touch → BOUNCE LONG
    // Our events measure touch — if approach was up, means price hit strike from below
    // Bounce LONG = price reverses back up from the resistance touch... wait, L115 says
    // strike is 1-3% above spot = resistance. Bounce = reject. So SHORT at the touch (bearish rejection).
    // Actually: "VIX normal + strike just above spot → BOUNCE" means the strike HOLDS as resistance.
    // Entry: SHORT at strike, expecting rejection.
    if (ev.vixBucket === "low" && ev.approach === "up" && ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      // strike is 1-3% above spot (distSpotToStrike = (spot-strike)/spot so negative when strike above spot)
      return { direction: "SHORT" };
    }
    return null;
  },
  "5_L121_only": (ev) => {
    // flow share 0.1-1% + VIX low → break
    // Means strike is getting moderate attention and will break. Direction = continuation of approach.
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT" };
    }
    return null;
  },
  "6_ensemble": (ev) => {
    // Multi-lesson with priority
    // L121 strongest → break continuation
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", conf: "HIGH" };
    }
    // L114: VIX extreme → break at resistance
    if (ev.vixLevel != null && ev.vixLevel >= 25) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", conf: "MED" };
    }
    // L115: VIX normal + strike above → bounce short
    if (ev.vixBucket === "low" && ev.approach === "up" && ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      return { direction: "SHORT", conf: "MED" };
    }
    // L120: flow share >=5% → PIN → no trade
    if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.05) {
      return null; // skip
    }
    return null;
  },
  "7_ensemble_plus_L116": (ev) => {
    // Same as 6 but add L116 filter for afternoon momentum breaks
    // L121
    if (ev.vixBucket === "low" && ev.flow_strikeShareOfDay != null &&
        ev.flow_strikeShareOfDay >= 0.001 && ev.flow_strikeShareOfDay < 0.01) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", conf: "HIGH" };
    }
    // L114
    if (ev.vixLevel != null && ev.vixLevel >= 25) {
      return { direction: ev.approach === "up" ? "LONG" : "SHORT", conf: "MED" };
    }
    // L115
    if (ev.vixBucket === "low" && ev.approach === "up" && ev.distSpotToStrikePct >= -0.03 && ev.distSpotToStrikePct < -0.01) {
      return { direction: "SHORT", conf: "MED" };
    }
    // L116: afternoon + momentum → break continuation
    if ((ev.minuteBucket === "aft" || ev.minuteBucket === "close") &&
        ev.priceRelToOpenPct >= 0.003 && ev.priceRelToOpenPct <= 0.01) {
      return { direction: "LONG", conf: "MED" }; // price already up → continuation
    }
    if ((ev.minuteBucket === "aft" || ev.minuteBucket === "close") &&
        ev.priceRelToOpenPct <= -0.003 && ev.priceRelToOpenPct >= -0.01) {
      return { direction: "SHORT", conf: "MED" };
    }
    if (ev.flow_strikeShareOfDay != null && ev.flow_strikeShareOfDay >= 0.05) return null;
    return null;
  },
};

// Simulate one trade: given entry price and SL/TP levels, look forward to see which hits
function simulateTrade(ev, direction, capital) {
  // SL: use next bar below (for LONG) or above (for SHORT). If missing, fallback to %
  const entryPrice = ev.priceAtTouch;
  const touchTs = ev.touchTs;

  // Determine SL, TP from event data
  // For LONG: TP = 0.5% up from entry (conservative), SL = 0.3% down
  // For SHORT: TP = 0.5% down, SL = 0.3% up
  const slPct = 0.003;  // 0.3%
  const tpPct = 0.005;  // 0.5% → 1.67:1 R:R
  const sl = direction === "LONG" ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
  const tp = direction === "LONG" ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);

  // Position sizing: risk RISK_PER_TRADE of capital, SL distance
  const riskDollars = capital * RISK_PER_TRADE;
  const slDistance = Math.abs(entryPrice - sl);
  const units = riskDollars / slDistance;

  // Use forward prices from event (priceAfter15m, 1h, 4h, EOD)
  // Check if price crossed TP or SL at any horizon
  const horizons = [
    { label: "15m", price: ev.price15m },
    { label: "1h", price: ev.price1h },
    { label: "4h", price: ev.price4h },
    { label: "eod", price: ev.priceEod },
  ];

  // Walk forward — use max/min between intervals to detect SL/TP hits
  // Simplification: we only have checkpoint prices. Check which gets hit first
  // by looking at CUMULATIVE max up / min down from entry
  let maxUp = entryPrice, maxDown = entryPrice;
  let exit = { price: ev.priceEod, label: "eod" }; // fallback
  for (const h of horizons) {
    if (h.price == null) continue;
    if (direction === "LONG") {
      if (h.price >= tp) {
        exit = { price: tp, label: `tp_hit_${h.label}` };
        break;
      }
      if (h.price <= sl) {
        exit = { price: sl, label: `sl_hit_${h.label}` };
        break;
      }
    } else {
      if (h.price <= tp) {
        exit = { price: tp, label: `tp_hit_${h.label}` };
        break;
      }
      if (h.price >= sl) {
        exit = { price: sl, label: `sl_hit_${h.label}` };
        break;
      }
    }
  }
  if (!exit.label.startsWith("tp_hit") && !exit.label.startsWith("sl_hit")) {
    exit = { price: ev.priceEod, label: "eod_close" };
  }

  // P&L
  const priceMove = direction === "LONG" ? (exit.price - entryPrice) : (entryPrice - exit.price);
  const gross = units * priceMove;
  const slip = units * entryPrice * SLIPPAGE_PCT;
  const net = gross - slip;

  return {
    date: ev.date, sym: ev.sym, strike: ev.strike, direction,
    entryPrice, exitPrice: exit.price, exitReason: exit.label,
    units, slDistance, riskDollars, gross, slip, net,
    pnlPct: net / capital * 100,
    capitalBefore: capital,
    capitalAfter: capital + net,
  };
}

// Buy & Hold SPY: compute total return over period
function buyHoldSpy(events, capitalInitial) {
  const spyEvents = events.filter(e => e.sym === "SPY").sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));
  if (spyEvents.length === 0) return { trades: 0, finalCapital: capitalInitial, equity: [] };
  const startPrice = spyEvents[0].openPrice;
  const endPrice = spyEvents[spyEvents.length - 1].priceEod;
  const ret = (endPrice - startPrice) / startPrice;
  // Equity curve: 1 point per day, linear interpolation
  const byDate = {};
  for (const e of spyEvents) {
    if (!byDate[e.date]) byDate[e.date] = e.openPrice;
  }
  const dates = Object.keys(byDate).sort();
  const equity = dates.map(d => ({ date: d, capital: capitalInitial * (byDate[d] / startPrice) }));
  return {
    trades: 0,
    finalCapital: capitalInitial * (1 + ret),
    returnPct: ret * 100,
    equity,
  };
}

// Compute metrics for a set of trades
function computeMetrics(trades, capitalInitial, equity) {
  if (trades.length === 0) {
    return {
      trades: 0, finalCapital: capitalInitial, returnPct: 0,
      winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, expectancy: 0,
      maxDD: 0, maxDDPct: 0, sharpe: 0, longestLosingStreak: 0,
    };
  }

  const finalCapital = trades[trades.length - 1].capitalAfter;
  const returnPct = ((finalCapital - capitalInitial) / capitalInitial) * 100;

  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.net, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.net, 0) / losses.length : 0;
  const grossWins = wins.reduce((s, t) => s + t.net, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
  const expectancy = trades.reduce((s, t) => s + t.net, 0) / trades.length;

  // Max drawdown
  let peak = capitalInitial, maxDD = 0, maxDDPct = 0;
  for (const pt of equity) {
    if (pt.capital > peak) peak = pt.capital;
    const dd = peak - pt.capital;
    const ddPct = (dd / peak) * 100;
    if (dd > maxDD) { maxDD = dd; maxDDPct = ddPct; }
  }

  // Sharpe (per-trade returns, annualize assuming ~1 trade/day avg)
  const returns = trades.map(t => t.net / t.capitalBefore);
  const avgR = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sdR = Math.sqrt(returns.reduce((s, r) => s + (r - avgR) ** 2, 0) / returns.length);
  const sharpe = sdR > 0 ? (avgR / sdR) * Math.sqrt(252) : 0;

  // Longest losing streak
  let cur = 0, longest = 0;
  for (const t of trades) {
    if (t.net <= 0) { cur++; if (cur > longest) longest = cur; }
    else cur = 0;
  }

  return {
    trades: trades.length,
    finalCapital: +finalCapital.toFixed(2),
    returnPct: +returnPct.toFixed(1),
    winRate: +(winRate * 100).toFixed(1),
    profitFactor: profitFactor === Infinity ? 999 : +profitFactor.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    expectancy: +expectancy.toFixed(3),
    maxDD: +maxDD.toFixed(2),
    maxDDPct: +maxDDPct.toFixed(1),
    sharpe: +sharpe.toFixed(2),
    longestLosingStreak: longest,
  };
}

function main() {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l))
                      .sort((a, b) => new Date(a.touchTs) - new Date(b.touchTs));
  console.log(`Loaded ${events.length} events`);

  const results = {};
  const allEquityCurves = {};

  // Buy & hold
  const bh = buyHoldSpy(events, CAPITAL_INITIAL);
  results["1_buy_hold_SPY"] = { ...bh, metrics: { trades: 0, finalCapital: bh.finalCapital, returnPct: bh.returnPct } };
  allEquityCurves["1_buy_hold_SPY"] = bh.equity;

  // Run other strategies
  for (const [name, strategy] of Object.entries(strategies)) {
    if (name === "1_buy_hold") continue;
    let capital = CAPITAL_INITIAL;
    const trades = [];
    const equity = [{ date: events[0].date, capital }];

    for (const ev of events) {
      const signal = strategy(ev);
      if (!signal || !signal.direction) continue;
      const trade = simulateTrade(ev, signal.direction, capital);
      if (!isFinite(trade.net)) continue;
      capital = trade.capitalAfter;
      if (capital < 50) { // stop if capital decimated
        trades.push(trade);
        equity.push({ date: ev.date, capital });
        break;
      }
      trades.push(trade);
      equity.push({ date: ev.date, capital });
    }
    const metrics = computeMetrics(trades, CAPITAL_INITIAL, equity);
    results[name] = { metrics, equity };
    allEquityCurves[name] = equity;
  }

  // ── Generate report ──
  let md = `# Capital Backtest Report — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `**Capital inicial:** $${CAPITAL_INITIAL}\n`;
  md += `**Risk per trade:** ${(RISK_PER_TRADE * 100).toFixed(1)}%\n`;
  md += `**Slippage:** ${(SLIPPAGE_PCT * 100).toFixed(2)}% per round-trip\n`;
  md += `**Eventos totales:** ${events.length}\n`;
  md += `**Período:** ${events[0].date} → ${events[events.length - 1].date}\n`;
  md += `**SL/TP:** 0.3% SL, 0.5% TP (R:R 1.67:1)\n\n`;

  md += `## Resumen comparativo\n\n`;
  md += `| Estrategia | # Trades | Capital final | Return % | Win% | PF | Expectancy | Max DD % | Sharpe | Losing streak |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const [name, r] of Object.entries(results)) {
    const m = r.metrics;
    md += `| ${name} | ${m.trades ?? 0} | $${(m.finalCapital ?? CAPITAL_INITIAL).toFixed(2)} | ${(m.returnPct ?? 0) >= 0 ? "+" : ""}${m.returnPct ?? 0}% | ${m.winRate ?? "-"}% | ${m.profitFactor ?? "-"} | ${m.expectancy ?? "-"} | ${m.maxDDPct ?? "-"}% | ${m.sharpe ?? "-"} | ${m.longestLosingStreak ?? "-"} |\n`;
  }
  md += `\n`;

  md += `## Interpretación\n\n`;
  const sorted = Object.entries(results).sort((a, b) => (b[1].metrics.finalCapital ?? 0) - (a[1].metrics.finalCapital ?? 0));
  md += `**Ranking por capital final:**\n`;
  for (let i = 0; i < sorted.length; i++) {
    const [name, r] = sorted[i];
    md += `${i + 1}. **${name}**: $${(r.metrics.finalCapital ?? CAPITAL_INITIAL).toFixed(2)} (${(r.metrics.returnPct ?? 0) >= 0 ? "+" : ""}${r.metrics.returnPct ?? 0}%)\n`;
  }

  fs.writeFileSync(OUT_MD, md);
  console.log(`Report written: ${OUT_MD}`);

  // Equity curves CSV (wide format)
  const allDates = new Set();
  for (const curve of Object.values(allEquityCurves)) {
    for (const pt of curve) allDates.add(pt.date);
  }
  const sortedDates = Array.from(allDates).sort();
  const lookupByDate = {};
  for (const [name, curve] of Object.entries(allEquityCurves)) {
    lookupByDate[name] = {};
    let last = CAPITAL_INITIAL;
    for (const pt of curve) {
      lookupByDate[name][pt.date] = pt.capital;
      last = pt.capital;
    }
  }

  const headers = ["date", ...Object.keys(allEquityCurves)];
  const csvRows = [headers.join(",")];
  const fwdFill = {};
  for (const d of sortedDates) {
    const row = [d];
    for (const name of Object.keys(allEquityCurves)) {
      if (lookupByDate[name][d] != null) fwdFill[name] = lookupByDate[name][d];
      row.push((fwdFill[name] ?? CAPITAL_INITIAL).toFixed(2));
    }
    csvRows.push(row.join(","));
  }
  fs.writeFileSync(OUT_CSV, csvRows.join("\n"));
  console.log(`Equity CSV: ${OUT_CSV}`);

  // Print summary to stdout
  console.log(`\n${"=".repeat(90)}`);
  console.log(`RESULTADO FINAL — $${CAPITAL_INITIAL} → ?`);
  console.log(`${"=".repeat(90)}`);
  for (const [name, r] of sorted) {
    const m = r.metrics;
    const capitalStr = `$${(m.finalCapital ?? CAPITAL_INITIAL).toFixed(2)}`;
    const retStr = `${(m.returnPct ?? 0) >= 0 ? "+" : ""}${m.returnPct ?? 0}%`;
    console.log(`  ${name.padEnd(25)} → ${capitalStr.padEnd(12)} (${retStr.padEnd(8)}) [${m.trades ?? 0} trades, Sharpe ${m.sharpe ?? "-"}, DD ${m.maxDDPct ?? "-"}%]`);
  }
}

main();
