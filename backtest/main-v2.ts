/**
 * Backtest v2 — uses ALL available historical data (except flow which is still downloading).
 *
 * New vs v1:
 *   - Uses yahoo-prices (VIX, DXY, TLT) for macro context
 *   - Uses synth-oi-daily for regime + VRP + IV rank + skew
 *   - Uses candle patterns from MT5 M15
 *   - Monday filter (skip entries)
 *   - Multi-factor scoring per trade
 *   - Circuit breaker (stop trading after -$15 on the day)
 *   - Scenario tagging + aggregation (identify WINNING setups)
 *
 * Usage:
 *   npx tsx backtest/main-v2.ts --start 2025-01-01 [--end YYYY-MM-DD] [--days N]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reconstructSnapshot, cycleTimestamps } from "./core/replay-engine.js";
import { generateAllIntents, type EnrichedIntent, type ScenarioTag } from "./core/decision-engine-v2.js";
import { simulateIntent } from "./core/executor-sim.js";
import { simulateWithEtfTrigger } from "./core/executor-sim-v2.js";
import { loadMt5Day, loadOhlc1Min } from "./data-loaders/price-provider.js";
import { ensureFlowLoaded } from "./data-loaders/hiro-reconstructor.js";
import type {
  BacktestReport, DayResult, ClosedTrade, CFD, TradeMode,
} from "./utils/types.js";

const CFDS: CFD[] = ["NAS100", "US30", "XAUUSD"];
const HIST = path.resolve(process.cwd(), "data/historical");
const OUT_DIR = path.resolve(process.cwd(), "backtest/output");
const STARTING_EQUITY = 918.78;
const CIRCUIT_BREAKER_DAILY_LOSS = -15.0; // stop trading once a day's PnL goes below this

interface TradeWithScenario extends ClosedTrade {
  scenario?: ScenarioTag;
  multiFactorScore?: number;
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

function findUsableDays(startDate?: string, endDate?: string, maxDays?: number): string[] {
  const gammaBarDir = path.join(HIST, "gamma-bars");
  if (!fs.existsSync(gammaBarDir)) return [];
  const allDates = fs.readdirSync(gammaBarDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const filtered = allDates.filter((d) => {
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
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

/** Run a day with circuit breaker + enriched tracking */
function runDay(date: string): DayResult & { tradesRich: TradeWithScenario[] } {
  const intentsCollected: EnrichedIntent[] = [];
  const timestamps = cycleTimestamps(date);

  for (let i = 0; i < timestamps.length; i += 3) {
    const t = timestamps[i];
    const snapshot = reconstructSnapshot(date, t);
    if (!snapshot) continue;
    const intents = generateAllIntents(snapshot, date);
    intentsCollected.push(...intents);
  }

  // Dedup (same CFD+direction+level within tolerance)
  const unique: EnrichedIntent[] = [];
  for (const intent of intentsCollected) {
    const dup = unique.find((u) =>
      u.cfd === intent.cfd &&
      u.direction === intent.direction &&
      Math.abs(u.exactLevel - intent.exactLevel) < (intent.cfd === "XAUUSD" ? 2 : 10)
    );
    if (!dup) unique.push(intent);
    else if (intent.multiFactorScore > dup.multiFactorScore) {
      // Replace with higher-score one
      const idx = unique.indexOf(dup);
      unique[idx] = intent;
    }
  }

  // Simulate with circuit breaker: sort by intent creation time
  unique.sort((a, b) => a.createdAt - b.createdAt);

  const tradesRich: TradeWithScenario[] = [];
  let dailyPnl = 0;
  let breakerTripped = false;

  for (const intent of unique) {
    if (breakerTripped) break;
    // Use ETF-based trigger executor (v10): detects trigger on ETF price, executes on CFD
    const cfdCandles = loadMt5Day(intent.cfd, date, "M15");
    const etfCandles = loadOhlc1Min(intent.etfSymbol, date);
    let trade = null;
    if (etfCandles.length > 0) {
      trade = simulateWithEtfTrigger({
        intent,
        etfCandles,
        cfdCandles,
        nextBarEtf: intent.tpEtfStrike ? { strike: intent.tpEtfStrike } : undefined,
        prevBarEtf: intent.slEtfStrike ? { strike: intent.slEtfStrike } : undefined,
      });
    } else {
      // Fallback to CFD-based trigger when no ETF OHLC (e.g. pre-2025)
      trade = simulateIntent(intent, cfdCandles);
    }
    if (!trade) continue;
    const tr: TradeWithScenario = { ...trade, scenario: intent.scenario, multiFactorScore: intent.multiFactorScore };
    tradesRich.push(tr);
    dailyPnl += trade.pnlDollars;
    if (dailyPnl < CIRCUIT_BREAKER_DAILY_LOSS) {
      breakerTripped = true;
    }
  }

  // CFD OHLC for context
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

  const wins = tradesRich.filter((t) => t.pnlDollars > 0).length;
  const losses = tradesRich.filter((t) => t.pnlDollars < 0).length;
  const breakeven = tradesRich.length - wins - losses;
  const pnlDollars = tradesRich.reduce((s, t) => s + t.pnlDollars, 0);
  const pnlByCfd: any = { NAS100: 0, US30: 0, XAUUSD: 0 };
  const pnlByMode: any = { scalp: 0, intraday: 0, swing: 0 };
  for (const t of tradesRich) {
    pnlByCfd[t.cfd] = (pnlByCfd[t.cfd] || 0) + t.pnlDollars;
    pnlByMode[t.tradeMode] = (pnlByMode[t.tradeMode] || 0) + t.pnlDollars;
  }

  return {
    date, cfdOpenClose, totalTrades: tradesRich.length, wins, losses, breakeven,
    pnlDollars: Math.round(pnlDollars * 100) / 100,
    pnlByCfd, pnlByMode, trades: tradesRich,
    notes: breakerTripped ? "CIRCUIT_BREAKER_TRIPPED" : undefined,
    tradesRich,
  };
}

/** Group trades by scenario signature and rank by PnL */
function analyzeScenarios(allTrades: TradeWithScenario[]) {
  const buckets: Record<string, { count: number; netPnl: number; winRate: number; avgPnl: number; trades: TradeWithScenario[] }> = {};
  for (const t of allTrades) {
    if (!t.scenario) continue;
    const key = [
      t.cfd, t.scenario.direction, t.scenario.mode,
      `regime=${t.scenario.regime}`,
      `vrp=${t.scenario.vrpSign}`,
      `vix=${t.scenario.vixRegime}`,
      `dxy=${t.scenario.dxyTrend}`,
      `struct=${t.scenario.structure}`,
      `bar=${t.scenario.barSizeBucket}`,
      `iv=${t.scenario.ivRankBucket}`,
      `dow=${t.scenario.dayOfWeek}`,
    ].join("|");
    if (!buckets[key]) buckets[key] = { count: 0, netPnl: 0, winRate: 0, avgPnl: 0, trades: [] };
    buckets[key].count++;
    buckets[key].netPnl += t.pnlDollars;
    buckets[key].trades.push(t);
  }
  for (const k in buckets) {
    const b = buckets[k];
    const wins = b.trades.filter((t) => t.pnlDollars > 0).length;
    b.winRate = Math.round((wins / b.count) * 1000) / 10;
    b.avgPnl = Math.round((b.netPnl / b.count) * 100) / 100;
    b.netPnl = Math.round(b.netPnl * 100) / 100;
    delete (b as any).trades;
  }

  // Also aggregate by simpler axes
  const bySimple: any = {
    byRegime: {}, byVrp: {}, byVix: {}, byDxy: {}, byStructure: {}, byBarSize: {}, byIvRank: {},
  };
  const addTo = (obj: any, key: string, t: TradeWithScenario) => {
    if (!obj[key]) obj[key] = { count: 0, netPnl: 0, wins: 0 };
    obj[key].count++;
    obj[key].netPnl += t.pnlDollars;
    if (t.pnlDollars > 0) obj[key].wins++;
  };
  for (const t of allTrades) {
    if (!t.scenario) continue;
    addTo(bySimple.byRegime, t.scenario.regime, t);
    addTo(bySimple.byVrp, t.scenario.vrpSign, t);
    addTo(bySimple.byVix, t.scenario.vixRegime, t);
    addTo(bySimple.byDxy, t.scenario.dxyTrend, t);
    addTo(bySimple.byStructure, t.scenario.structure, t);
    addTo(bySimple.byBarSize, t.scenario.barSizeBucket, t);
    addTo(bySimple.byIvRank, t.scenario.ivRankBucket, t);
  }
  for (const axis of Object.keys(bySimple)) {
    for (const k of Object.keys(bySimple[axis])) {
      const b = bySimple[axis][k];
      b.winRate = Math.round((b.wins / b.count) * 1000) / 10;
      b.netPnl = Math.round(b.netPnl * 100) / 100;
      b.avgPnl = Math.round((b.netPnl / b.count) * 100) / 100;
    }
  }

  return { combinations: buckets, byAxis: bySimple };
}

async function main() {
  const args = parseArgs();
  const maxDays = args.days ? parseInt(args.days) : undefined;
  const startDate = args.start || undefined;
  const endDate = args.end || undefined;

  const days = findUsableDays(startDate, endDate, maxDays);
  console.log(`Backtest v2: ${days.length} days (${days[0]} → ${days[days.length - 1]})`);
  if (days.length === 0) return;

  const t0 = Date.now();
  const dayResults: (DayResult & { tradesRich: TradeWithScenario[] })[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    // Preload flow data for HIRO reconstruction (only if flow file exists for this day)
    try { await ensureFlowLoaded(d); } catch (e) { /* no flow yet, HIRO returns null */ }
    const res = runDay(d);
    dayResults.push(res);
    if ((i + 1) % 20 === 0 || i === days.length - 1) {
      const pct = ((i + 1) / days.length * 100).toFixed(1);
      console.log(`  [${pct}%] ${d} (${dayOfWeek(d)}): ${res.totalTrades} trades, PnL $${res.pnlDollars}${res.notes ? " BREAKER" : ""}`);
    }
  }

  const allTrades: TradeWithScenario[] = dayResults.flatMap((d) => d.tradesRich);

  // Aggregate by axis
  const pnlByCfd: any = { NAS100: 0, US30: 0, XAUUSD: 0 };
  const pnlByMode: any = { scalp: 0, intraday: 0, swing: 0 };
  const pnlByDow: any = {};
  const pnlByMonth: any = {};
  for (const t of allTrades) {
    pnlByCfd[t.cfd] += t.pnlDollars;
    pnlByMode[t.tradeMode] += t.pnlDollars;
  }
  for (const d of dayResults) {
    const dow = dayOfWeek(d.date);
    pnlByDow[dow] = (pnlByDow[dow] || 0) + d.pnlDollars;
    const m = d.date.slice(0, 7);
    pnlByMonth[m] = (pnlByMonth[m] || 0) + d.pnlDollars;
  }

  const wins = allTrades.filter((t) => t.pnlDollars > 0);
  const losses = allTrades.filter((t) => t.pnlDollars < 0);
  const netPnl = allTrades.reduce((s, t) => s + t.pnlDollars, 0);

  let equity = STARTING_EQUITY;
  let peak = equity;
  let maxDd = 0;
  for (const d of dayResults) {
    equity += d.pnlDollars;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const breakerDays = dayResults.filter((d) => d.notes === "CIRCUIT_BREAKER_TRIPPED").length;
  const scenarioAnalysis = analyzeScenarios(allTrades);

  // Top 20 scenarios by netPnl
  const scenarioEntries = Object.entries(scenarioAnalysis.combinations);
  const topScenarios = scenarioEntries.sort((a, b) => b[1].netPnl - a[1].netPnl).slice(0, 25);
  const bottomScenarios = scenarioEntries.sort((a, b) => a[1].netPnl - b[1].netPnl).slice(0, 15);

  const report = {
    startDate: days[0],
    endDate: days[days.length - 1],
    daysProcessed: days.length,
    breakerDays,
    totalTrades: allTrades.length,
    winRate: allTrades.length > 0 ? Math.round(wins.length / allTrades.length * 1000) / 10 : 0,
    netPnlDollars: Math.round(netPnl * 100) / 100,
    pnlByCfd: Object.fromEntries(Object.entries(pnlByCfd).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])),
    pnlByMode: Object.fromEntries(Object.entries(pnlByMode).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])),
    pnlByDayOfWeek: Object.fromEntries(Object.entries(pnlByDow).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])),
    pnlByMonth: Object.fromEntries(Object.entries(pnlByMonth).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])),
    avgWin: wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnlDollars, 0) / wins.length * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnlDollars, 0) / losses.length * 100) / 100 : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.pnlDollars)) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.pnlDollars)) : 0,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    maxDrawdownPct: Math.round((maxDd / STARTING_EQUITY) * 10000) / 100,
    startingEquity: STARTING_EQUITY,
    endingEquity: Math.round(equity * 100) / 100,
    scenarioAnalysis: {
      byAxis: scenarioAnalysis.byAxis,
      top25Scenarios: topScenarios.map(([k, v]) => ({ scenario: k, ...v })),
      bottom15Scenarios: bottomScenarios.map(([k, v]) => ({ scenario: k, ...v })),
    },
    daysSample: dayResults.slice(-20).map((d) => ({
      date: d.date, pnl: d.pnlDollars, trades: d.totalTrades, wins: d.wins, losses: d.losses, breaker: !!d.notes,
    })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportFile = path.join(OUT_DIR, `v2-backtest-${days[0]}-to-${days[days.length - 1]}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // CSV with scenarios
  const csvHeader = "date,cfd,direction,mode,entry,exit,pnlPts,pnlDollars,exitReason,score,regime,vrp,vix,dxy,structure,barSize,ivRank,dow";
  const rows = [csvHeader];
  for (const d of dayResults) {
    for (const t of d.tradesRich) {
      rows.push([
        d.date, t.cfd, t.direction, t.tradeMode, t.entry, t.exit, t.pnlPts, t.pnlDollars, t.exitReason,
        t.multiFactorScore ?? "",
        t.scenario?.regime ?? "", t.scenario?.vrpSign ?? "", t.scenario?.vixRegime ?? "",
        t.scenario?.dxyTrend ?? "", t.scenario?.structure ?? "", t.scenario?.barSizeBucket ?? "",
        t.scenario?.ivRankBucket ?? "", t.scenario?.dayOfWeek ?? "",
      ].join(","));
    }
  }
  const csvFile = path.join(OUT_DIR, `v2-trades-${days[0]}-to-${days[days.length - 1]}.csv`);
  fs.writeFileSync(csvFile, rows.join("\n"));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== BACKTEST v2 DONE — ${elapsed}s ===`);
  console.log(`Days: ${days.length} | Trades: ${allTrades.length} | WR: ${report.winRate}%`);
  console.log(`Net PnL: $${report.netPnlDollars}  (${STARTING_EQUITY} → $${report.endingEquity})`);
  console.log(`Max DD: $${report.maxDrawdown} (${report.maxDrawdownPct}%)`);
  console.log(`Circuit breaker tripped: ${breakerDays} days`);
  console.log(`\nBy CFD:   NAS $${report.pnlByCfd.NAS100}, US30 $${report.pnlByCfd.US30}, XAU $${report.pnlByCfd.XAUUSD}`);
  console.log(`By Mode:  scalp $${report.pnlByMode.scalp}, intraday $${report.pnlByMode.intraday}, swing $${report.pnlByMode.swing}`);
  console.log(`\n🏆 TOP 10 SCENARIOS:`);
  for (const s of report.scenarioAnalysis.top25Scenarios.slice(0, 10)) {
    console.log(`   $${s.netPnl.toFixed(2)} (n=${s.count}, WR=${s.winRate}%, avg=$${s.avgPnl}) — ${s.scenario.slice(0, 100)}`);
  }
  console.log(`\nReport: ${reportFile}`);
  console.log(`CSV:    ${csvFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
