/**
 * Backtest Main Orchestrator
 *
 * Usage:
 *   node --loader ts-node/esm backtest/main.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--days N]
 *   or: ts-node backtest/main.ts
 *
 * For simplicity this file is plain JS-compatible TS so we can run via tsc+node or ts-node.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reconstructSnapshot, cycleTimestamps } from "./core/replay-engine.js";
import { generateAllIntents } from "./core/decision-engine.js";
import { simulateIntent } from "./core/executor-sim.js";
import { loadMt5Day, listOhlcDates } from "./data-loaders/price-provider.js";
import type {
  BacktestReport, DayResult, ClosedTrade, CFD, TradeMode, TradeIntent,
} from "./utils/types.js";

const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];
const MODES: TradeMode[] = ["scalp", "intraday", "swing"];
const HIST = path.resolve(process.cwd(), "data/historical");
const OUT_DIR = path.resolve(process.cwd(), "backtest/output");
const STARTING_EQUITY = 918.78;

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

/** Find days where all three CFDs have MT5 data + at least SPX gamma bar */
function findUsableDays(startDate?: string, endDate?: string, maxDays?: number): string[] {
  const gammaBarDir = path.join(HIST, "gamma-bars");
  if (!fs.existsSync(gammaBarDir)) return [];
  const allDates = fs.readdirSync(gammaBarDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const filtered = allDates.filter((d) => {
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    // require SPX gamma + NAS100 MT5 candles
    const spxFile = path.join(gammaBarDir, d, "SPX.json");
    if (!fs.existsSync(spxFile)) return false;
    const mt5 = loadMt5Day("NAS100", d, "M15");
    return mt5.length > 10;
  });
  return maxDays ? filtered.slice(-maxDays) : filtered;
}

function dayOfWeek(date: string): string {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
}

function runDay(date: string): DayResult {
  const intentsCollected: TradeIntent[] = [];
  const timestamps = cycleTimestamps(date);

  // Generate intents by running the decision engine every 3rd M15 candle (~45 min apart)
  for (let i = 0; i < timestamps.length; i += 3) {
    const t = timestamps[i];
    const snapshot = reconstructSnapshot(date, t);
    if (!snapshot) continue;
    const intents = generateAllIntents(snapshot, date);
    intentsCollected.push(...intents);
  }

  // Deduplicate near-identical intents (same CFD+direction+level within 5pts)
  const unique: TradeIntent[] = [];
  for (const intent of intentsCollected) {
    const dup = unique.find((u) =>
      u.cfd === intent.cfd &&
      u.direction === intent.direction &&
      Math.abs(u.exactLevel - intent.exactLevel) < (intent.cfd === "XAUUSD" ? 2 : 10)
    );
    if (!dup) unique.push(intent);
  }

  // Simulate each intent against the day's M15 candles
  const trades: ClosedTrade[] = [];
  for (const intent of unique) {
    const candles = loadMt5Day(intent.cfd, date, "M15");
    const trade = simulateIntent(intent, candles);
    if (trade) trades.push(trade);
  }

  // Day open/close/high/low per CFD
  const cfdOpenClose: any = {};
  for (const cfd of CFDS) {
    const cc = loadMt5Day(cfd, date, "M15");
    if (cc.length === 0) continue;
    cfdOpenClose[cfd] = {
      open: cc[0].open,
      close: cc[cc.length - 1].close,
      high: Math.max(...cc.map((c) => c.high)),
      low: Math.min(...cc.map((c) => c.low)),
    };
  }

  // Aggregate
  const wins = trades.filter((t) => t.pnlDollars > 0).length;
  const losses = trades.filter((t) => t.pnlDollars < 0).length;
  const breakeven = trades.length - wins - losses;
  const pnlDollars = trades.reduce((s, t) => s + t.pnlDollars, 0);
  const pnlByCfd: any = { NAS100: 0, US30: 0, XAUUSD: 0 };
  const pnlByMode: any = { scalp: 0, intraday: 0, swing: 0 };
  for (const t of trades) {
    pnlByCfd[t.cfd] = (pnlByCfd[t.cfd] || 0) + t.pnlDollars;
    pnlByMode[t.tradeMode] = (pnlByMode[t.tradeMode] || 0) + t.pnlDollars;
  }

  return {
    date,
    cfdOpenClose,
    totalTrades: trades.length,
    wins, losses, breakeven,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    pnlByCfd,
    pnlByMode,
    trades,
  };
}

async function main() {
  const args = parseArgs();
  const maxDays = args.days ? parseInt(args.days) : undefined;
  const startDate = args.start || undefined;
  const endDate = args.end || undefined;

  const days = findUsableDays(startDate, endDate, maxDays);
  console.log(`Backtest: ${days.length} days usable (${days[0]} → ${days[days.length - 1]})`);
  if (days.length === 0) {
    console.error("No usable days. Need both gamma-bars and MT5 candles.");
    process.exit(1);
  }

  const t0 = Date.now();
  const dayResults: DayResult[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const res = runDay(d);
    dayResults.push(res);
    const progress = ((i + 1) / days.length * 100).toFixed(1);
    console.log(`  [${progress}%] ${d} (${dayOfWeek(d)}): ${res.totalTrades} trades, PnL $${res.pnlDollars.toFixed(2)}`);
  }

  // Aggregate report
  const allTrades = dayResults.flatMap((d) => d.trades);
  const pnlByCfd: any = { NAS100: 0, US30: 0, XAUUSD: 0 };
  const pnlByMode: any = { scalp: 0, intraday: 0, swing: 0 };
  const pnlByDow: any = {};
  for (const t of allTrades) {
    pnlByCfd[t.cfd] += t.pnlDollars;
    pnlByMode[t.tradeMode] += t.pnlDollars;
  }
  for (const d of dayResults) {
    const dow = dayOfWeek(d.date);
    pnlByDow[dow] = (pnlByDow[dow] || 0) + d.pnlDollars;
  }

  const wins = allTrades.filter((t) => t.pnlDollars > 0);
  const losses = allTrades.filter((t) => t.pnlDollars < 0);
  const netPnl = allTrades.reduce((s, t) => s + t.pnlDollars, 0);

  // Equity curve + max drawdown
  let equity = STARTING_EQUITY;
  let peak = equity;
  let maxDd = 0;
  for (const d of dayResults) {
    equity += d.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const report: BacktestReport = {
    startDate: days[0],
    endDate: days[days.length - 1],
    daysProcessed: days.length,
    totalTrades: allTrades.length,
    winRate: allTrades.length > 0 ? wins.length / allTrades.length : 0,
    netPnlDollars: Math.round(netPnl * 100) / 100,
    pnlByCfd: Object.fromEntries(Object.entries(pnlByCfd).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])) as any,
    pnlByMode: Object.fromEntries(Object.entries(pnlByMode).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])) as any,
    pnlByDayOfWeek: Object.fromEntries(Object.entries(pnlByDow).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])),
    avgWin: wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnlDollars, 0) / wins.length * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnlDollars, 0) / losses.length * 100) / 100 : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.pnlDollars)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.pnlDollars)) : 0,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    maxDrawdownPct: Math.round((maxDd / STARTING_EQUITY) * 10000) / 100,
    startingEquity: STARTING_EQUITY,
    endingEquity: Math.round(equity * 100) / 100,
    days: dayResults,
  };

  // Write output
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportFile = path.join(OUT_DIR, `backtest-${days[0]}-to-${days[days.length - 1]}.json`);
  const tradesCsv = path.join(OUT_DIR, `trades-${days[0]}-to-${days[days.length - 1]}.csv`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // Trades CSV
  const csvHeader = "date,cfd,direction,mode,entry,exit,pnlPts,pnlDollars,durationMin,exitReason,maxAdverse,maxFavorable,id";
  const csvRows = [csvHeader];
  for (const d of dayResults) {
    for (const t of d.trades) {
      csvRows.push([
        d.date, t.cfd, t.direction, t.tradeMode,
        t.entry, t.exit, t.pnlPts, t.pnlDollars, t.durationMin,
        t.exitReason, t.maxAdverse, t.maxFavorable, t.intentId
      ].join(","));
    }
  }
  fs.writeFileSync(tradesCsv, csvRows.join("\n"));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== BACKTEST DONE — ${elapsed}s ===`);
  console.log(`Days: ${days.length} | Trades: ${allTrades.length} | WR: ${(report.winRate * 100).toFixed(1)}%`);
  console.log(`Net PnL: $${report.netPnlDollars}  (start $${STARTING_EQUITY} → end $${report.endingEquity})`);
  console.log(`Max DD: $${report.maxDrawdown} (${report.maxDrawdownPct}%)`);
  console.log(`By CFD: NAS $${report.pnlByCfd.NAS100}, US30 $${report.pnlByCfd.US30}, XAU $${report.pnlByCfd.XAUUSD}`);
  console.log(`By Mode: scalp $${report.pnlByMode.scalp}, intraday $${report.pnlByMode.intraday}, swing $${report.pnlByMode.swing}`);
  console.log(`\nReport: ${reportFile}`);
  console.log(`Trades CSV: ${tradesCsv}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
