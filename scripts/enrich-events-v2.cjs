#!/usr/bin/env node
/**
 * Event feature enricher v2 — adds flow features
 *
 * Reads: data/backtest-v2/events-enriched.jsonl (output of v1 enricher)
 * Writes: data/backtest-v2/events-enriched-v2.jsonl
 *
 * Adds ~15 flow features per event from flow-features/YYYY-MM-DD.json
 * using byStrikeHour to avoid look-ahead (only flow accumulated UP TO touch hour).
 *
 * Features added:
 *   - flow_trades, flow_premium, flow_callPrem, flow_putPrem
 *   - flow_cpRatio (call/total)
 *   - flow_bullPrem, flow_bearPrem, flow_bullBearBias
 *   - flow_instCount, flow_instShare, flow_instPrem
 *   - flow_aggBuyPrem, flow_aggSellPrem, flow_aggBias
 *   - flow_highOpenShare (opening conviction)
 *   - flow_netDelta, flow_netGamma
 *   - flow_dte0Share, flow_monthlyShare (expiry concentration)
 *   - flow_largestPrem (top trade at this strike)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const FLOW_DIR = path.join(ROOT, "data", "historical", "flow-features");

// US market open = 14:30 UTC (EDT) / 13:30 UTC (EST) — use minute-of-session to derive hour
// Given bars are 1-min from market open, hour = 9 + floor(minuteOfSession / 60) (ET)
// But our flow data is in UTC hours. US market open UTC hour ≈ 13 or 14 depending on DST.
// For simplicity, derive from the touch timestamp itself.

function getTouchHourUTC(touchTs) {
  const d = new Date(touchTs);
  return d.getUTCHours();
}

// Merge two buckets (b += a)
function mergeBucket(target, src) {
  target.trades += src.trades || 0;
  target.premium += src.premium || 0;
  target.callPrem += src.callPrem || 0;
  target.putPrem += src.putPrem || 0;
  target.netDelta += src.netDelta || 0;
  target.netGamma += src.netGamma || 0;
  target.inst += src.inst || 0;
  target.med += src.med || 0;
  target.retail += src.retail || 0;
  target.aggBuy += src.aggBuy || 0;
  target.aggSell += src.aggSell || 0;
  target.aggBuyPrem += src.aggBuyPrem || 0;
  target.aggSellPrem += src.aggSellPrem || 0;
  target.highOpen += src.highOpen || 0;
  target.medOpen += src.medOpen || 0;
  target.lowOpen += src.lowOpen || 0;
  target.bullPrem += src.bullPrem || 0;
  target.bearPrem += src.bearPrem || 0;
  if (src.exp) {
    for (const k of ["dte0", "weekly", "monthly", "leaps", "unknown"]) {
      target.exp[k] = (target.exp[k] || 0) + (src.exp[k] || 0);
    }
  }
  if (src.largest) {
    for (const lt of src.largest) {
      target.largest.push(lt);
    }
  }
}

function emptyAcc() {
  return {
    trades: 0, premium: 0, callPrem: 0, putPrem: 0,
    netDelta: 0, netGamma: 0, inst: 0, med: 0, retail: 0,
    aggBuy: 0, aggSell: 0, aggBuyPrem: 0, aggSellPrem: 0,
    highOpen: 0, medOpen: 0, lowOpen: 0, bullPrem: 0, bearPrem: 0,
    exp: { dte0: 0, weekly: 0, monthly: 0, leaps: 0, unknown: 0 },
    largest: [],
  };
}

// Cache flow data per date
const flowCache = new Map();
function loadFlow(date) {
  if (flowCache.has(date)) return flowCache.get(date);
  const f = path.join(FLOW_DIR, `${date}.json`);
  if (!fs.existsSync(f)) { flowCache.set(date, null); return null; }
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    flowCache.set(date, j);
    return j;
  } catch { flowCache.set(date, null); return null; }
}

function getFlowUpToHour(flow, sym, strike, maxHour) {
  // Sum byStrikeHour for [sym_strike_h] where h <= maxHour
  if (!flow || !flow.byStrikeHour) return null;
  const acc = emptyAcc();
  let found = false;
  for (const [key, bucket] of Object.entries(flow.byStrikeHour)) {
    const [s, strk, h] = key.split("_");
    if (s === sym && Number(strk) === strike && Number(h) <= maxHour) {
      mergeBucket(acc, bucket);
      found = true;
    }
  }
  return found ? acc : null;
}

function getFlowDaySym(flow, sym) {
  // Day-level totals per sym (for normalization context)
  if (!flow || !flow.bySym || !flow.bySym[sym]) return null;
  return flow.bySym[sym];
}

function addFlowFeatures(ev) {
  const flow = loadFlow(ev.date);
  if (!flow) {
    ev.flow_available = false;
    return ev;
  }
  ev.flow_available = true;

  const touchHour = getTouchHourUTC(ev.touchTs);
  const accAtStrike = getFlowUpToHour(flow, ev.sym, ev.strike, touchHour);
  const daySym = getFlowDaySym(flow, ev.sym);

  if (!accAtStrike) {
    ev.flow_atStrike_available = false;
    // Still record day-level sym context
    if (daySym) {
      ev.flow_daySym_premium = daySym.premium;
      ev.flow_daySym_instShare = daySym.trades > 0 ? daySym.inst / daySym.trades : 0;
    }
    return ev;
  }

  const a = accAtStrike;
  const tot = a.premium || 1;
  const totTrades = a.trades || 1;

  ev.flow_atStrike_available = true;
  ev.flow_trades = a.trades;
  ev.flow_premium = a.premium;
  ev.flow_cpRatio = a.callPrem / (a.callPrem + a.putPrem || 1); // 0-1, >0.5 = call-dominated flow
  ev.flow_bullPrem = a.bullPrem;
  ev.flow_bearPrem = a.bearPrem;
  ev.flow_bullBearBias = (a.bullPrem - a.bearPrem) / (a.bullPrem + a.bearPrem || 1);
  ev.flow_instCount = a.inst;
  ev.flow_instShare = a.inst / totTrades;
  ev.flow_instPrem = a.inst * 50000; // approx floor (inst bucket is >=$50K)
  ev.flow_aggBuyPrem = a.aggBuyPrem;
  ev.flow_aggSellPrem = a.aggSellPrem;
  ev.flow_aggBias = (a.aggBuyPrem - a.aggSellPrem) / (a.aggBuyPrem + a.aggSellPrem || 1);
  ev.flow_highOpenShare = a.highOpen / totTrades;
  ev.flow_netDelta = a.netDelta;
  ev.flow_netGamma = a.netGamma;
  const expTot = a.exp.dte0 + a.exp.weekly + a.exp.monthly + a.exp.leaps || 1;
  ev.flow_dte0Share = a.exp.dte0 / expTot;
  ev.flow_monthlyShare = a.exp.monthly / expTot;
  ev.flow_leapsShare = a.exp.leaps / expTot;
  ev.flow_largestPrem = a.largest.length > 0 ? Math.max(...a.largest.map(t => t.prem)) : 0;

  // Relative to day-sym total (is this strike getting outsized attention?)
  if (daySym) {
    ev.flow_strikeShareOfDay = daySym.premium > 0 ? a.premium / daySym.premium : 0;
  }

  // Round floats
  for (const k of ["flow_cpRatio","flow_bullBearBias","flow_instShare","flow_aggBias",
                   "flow_highOpenShare","flow_dte0Share","flow_monthlyShare","flow_leapsShare",
                   "flow_strikeShareOfDay"]) {
    if (typeof ev[k] === "number") ev[k] = +ev[k].toFixed(4);
  }

  return ev;
}

function main() {
  const lines = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean);
  console.log(`Enriching ${lines.length} events with flow features...`);

  const out = fs.createWriteStream(OUT_FILE);
  const startTime = Date.now();
  let processed = 0;
  let withFlow = 0, withStrikeFlow = 0;

  for (const line of lines) {
    const ev = JSON.parse(line);
    const enriched = addFlowFeatures(ev);
    out.write(JSON.stringify(enriched) + "\n");
    processed++;
    if (enriched.flow_available) withFlow++;
    if (enriched.flow_atStrike_available) withStrikeFlow++;

    if (processed % 1000 === 0) {
      const pct = ((processed / lines.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${processed}/${lines.length} (${pct}%) — ${elapsed}s`);
    }
  }

  out.end();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. ${processed} enriched in ${elapsed}s`);
  console.log(`  with flow data: ${withFlow} (${(100 * withFlow / processed).toFixed(1)}%)`);
  console.log(`  with strike flow: ${withStrikeFlow} (${(100 * withStrikeFlow / processed).toFixed(1)}%)`);
  console.log(`Output: ${OUT_FILE}`);
}

main();
