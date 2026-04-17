/**
 * Event-driven backtest — L60 proximity-triggered.
 *
 * Iterates every 1-min ETF candle. When price touches a gamma bar,
 * scores HIRO + candle + VRP + gamma sign (L60) and decides BOUNCE or BREAK.
 *
 * Usage: npx tsx backtest/main-event.ts --start 2026-03-01 --end 2026-03-31
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runEventDrivenDay } from "./core/event-driven-engine.js";
import { simulateWithEtfTrigger } from "./core/executor-sim-v2.js";
import { loadMt5Day, loadOhlc1Min } from "./data-loaders/price-provider.js";
import { ensureFlowProcessedLoaded } from "./data-loaders/flow-analyzer-fast.js";
import type { ClosedTrade, CFD, TradeMode } from "./utils/types.js";
import { BROKER_SPECS } from "./utils/types.js";
import type { EnrichedIntent, ScenarioTag } from "./core/decision-engine-v2.js";

const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];
const HIST = path.resolve(process.cwd(), "data/historical");
const OUT_DIR = path.resolve(process.cwd(), "backtest/output");
const STARTING_EQUITY = 918.78;
const CIRCUIT_BREAKER = -15;

interface TradeWithScore extends ClosedTrade {
  scenario?: ScenarioTag;
  l60Total?: number;
  rationale?: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: any = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      out[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      if (typeof out[args[i].slice(2)] === "string") i++;
    }
  }
  return out;
}

function findUsableDays(startDate?: string, endDate?: string): string[] {
  const dir = path.join(HIST, "gamma-bars");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => {
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return fs.existsSync(path.join(dir, d, "SPX.json"));
    })
    .sort();
}

function dayOfWeek(date: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(date + "T12:00:00Z").getUTCDay()];
}

async function main() {
  const args = parseArgs();
  const days = findUsableDays(args.start, args.end);
  console.log(`Event-driven backtest: ${days.length} days (${days[0]} → ${days[days.length - 1]})`);

  const t0 = Date.now();
  const allTrades: TradeWithScore[] = [];
  let equity = STARTING_EQUITY;
  let peak = equity;
  let maxDd = 0;
  const pnlByCfd: Record<CFD, number> = { NAS100: 0, US30: 0, XAUUSD: 0 };
  const pnlByMode: Record<TradeMode, number> = { scalp: 0, intraday: 0, swing: 0 };
  const pnlByDow: Record<string, number> = {};

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const dow = dayOfWeek(d);

    // Load pre-processed flow (lightweight, no OOM)
    try { ensureFlowProcessedLoaded(d); } catch {}

    // Run event-driven engine for all CFDs
    const allIntents: EnrichedIntent[] = [];
    for (const cfd of CFDS) {
      const intents = await runEventDrivenDay(cfd, d);
      allIntents.push(...intents);
    }

    // Sort by creation time
    allIntents.sort((a, b) => a.createdAt - b.createdAt);

    // Simulate fills with ETF trigger (entry already at correct CFD price)
    let dayPnl = 0;
    let breaker = false;
    const dayTrades: TradeWithScore[] = [];

    for (const intent of allIntents) {
      if (breaker) break;

      // For event-driven: entry is already at CFD price, just simulate SL/TP
      const cfdCandles = loadMt5Day(intent.cfd, d, "M15");
      const etfCandles = loadOhlc1Min(intent.etfSymbol, d);

      const trade = simulateWithEtfTrigger({
        intent,
        etfCandles,
        cfdCandles,
        nextBarEtf: intent.tpEtfStrike ? { strike: intent.tpEtfStrike } : undefined,
        prevBarEtf: intent.slEtfStrike ? { strike: intent.slEtfStrike } : undefined,
      });

      if (!trade) continue;
      const tr: TradeWithScore = {
        ...trade,
        scenario: intent.scenario,
        l60Total: intent.multiFactorScore,
        rationale: intent.rationale,
      };
      dayTrades.push(tr);
      dayPnl += trade.pnlDollars;
      if (dayPnl < CIRCUIT_BREAKER) breaker = true;
    }

    // Day stats
    allTrades.push(...dayTrades);
    equity += dayPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;

    for (const t of dayTrades) {
      pnlByCfd[t.cfd] += t.pnlDollars;
      pnlByMode[t.tradeMode] += t.pnlDollars;
    }
    pnlByDow[dow] = (pnlByDow[dow] || 0) + dayPnl;

    const wins = dayTrades.filter((t) => t.pnlDollars > 0).length;
    const losses = dayTrades.filter((t) => t.pnlDollars < 0).length;
    if (dayTrades.length > 0 || (i + 1) % 5 === 0) {
      console.log(`  ${d} (${dow}): ${dayTrades.length} trades (${wins}W/${losses}L) PnL $${dayPnl.toFixed(2)}${breaker ? " BREAKER" : ""}`);
    }
  }

  // Summary
  const wins = allTrades.filter((t) => t.pnlDollars > 0);
  const losses = allTrades.filter((t) => t.pnlDollars < 0);
  const netPnl = allTrades.reduce((s, t) => s + t.pnlDollars, 0);
  const wr = allTrades.length > 0 ? Math.round((wins.length / allTrades.length) * 1000) / 10 : 0;

  // Save report
  const report = {
    engine: "event-driven-L60",
    startDate: days[0], endDate: days[days.length - 1],
    daysProcessed: days.length,
    totalTrades: allTrades.length,
    winRate: wr,
    netPnlDollars: Math.round(netPnl * 100) / 100,
    startingEquity: STARTING_EQUITY,
    endingEquity: Math.round(equity * 100) / 100,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    maxDrawdownPct: Math.round((maxDd / STARTING_EQUITY) * 10000) / 100,
    avgWin: wins.length > 0 ? Math.round((wins.reduce((s, t) => s + t.pnlDollars, 0) / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round((losses.reduce((s, t) => s + t.pnlDollars, 0) / losses.length) * 100) / 100 : 0,
    pnlByCfd: Object.fromEntries(Object.entries(pnlByCfd).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    pnlByMode: Object.fromEntries(Object.entries(pnlByMode).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    pnlByDayOfWeek: Object.fromEntries(Object.entries(pnlByDow).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    trades: allTrades.map((t) => ({
      date: new Date(t.entryTs).toISOString().slice(0, 10),
      time: new Date(t.entryTs).toISOString().slice(11, 16),
      cfd: t.cfd, dir: t.direction, mode: t.tradeMode,
      entry: t.entry, exit: t.exit,
      pnlPts: t.pnlPts, pnlDollars: t.pnlDollars,
      exitReason: t.exitReason,
      l60Score: t.l60Total,
      rationale: t.rationale?.slice(0, 120),
      durationMin: t.durationMin,
    })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportFile = path.join(OUT_DIR, `event-driven-${days[0]}-to-${days[days.length - 1]}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== EVENT-DRIVEN BACKTEST DONE — ${elapsed}s ===`);
  console.log(`Days: ${days.length} | Trades: ${allTrades.length} | WR: ${wr}%`);
  console.log(`Net PnL: $${report.netPnlDollars} (${STARTING_EQUITY} → $${report.endingEquity})`);
  console.log(`Max DD: $${report.maxDrawdown} (${report.maxDrawdownPct}%)`);
  console.log(`By CFD: NAS $${report.pnlByCfd.NAS100}, US30 $${report.pnlByCfd.US30}, XAU $${report.pnlByCfd.XAUUSD}`);
  console.log(`By Mode: scalp $${report.pnlByMode.scalp}, intraday $${report.pnlByMode.intraday}, swing $${report.pnlByMode.swing}`);
  console.log(`\nTrades detail:`);
  for (const t of report.trades) {
    const icon = t.pnlDollars > 0 ? "✅" : t.pnlDollars < 0 ? "❌" : "⬜";
    console.log(`  ${icon} ${t.date} ${t.time} ${t.cfd} ${t.dir} ${t.mode} entry=${t.entry} exit=${t.exit} $${t.pnlDollars} (${t.exitReason}) L60=${t.l60Score}`);
  }
  console.log(`\nReport: ${reportFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
