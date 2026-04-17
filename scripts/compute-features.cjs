#!/usr/bin/env node
/**
 * Live Feature Computer — supersedes compute-dominance.cjs
 *
 * Per-strike feature computation for live decision-making.
 * Reads getAgentView, computes all features needed by L113-L125,
 * evaluates which lessons fire for each strike, saves snapshot.
 *
 * Features computed per strike:
 *   - callDominance (L113)
 *   - flow_share_of_day (L119/L120/L125) — from tape.strikeFlow
 *   - flow_largest_prem (L122/L123) — from institutionalFlow.bigTrades
 *   - flow_inst_share (L124) — estimated
 *   - vix_bucket (L114/L115)
 *   - vix_trend_5d (L122/L123/L124)
 *   - dist_spot_to_strike_pct (L115)
 *   - minute_bucket (L116/L117)
 *   - price_rel_to_open_pct (L116)
 *   - oi_ratio (L118)
 *
 * Active lessons per strike output to agent-state.json.dominanceSnapshot
 *
 * Usage:
 *   node scripts/compute-features.cjs            # print report
 *   node scripts/compute-features.cjs --save     # save + log activations
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "data", "agent-state.json");
const FLIP_LOG = path.join(ROOT, "data", "flip-events.jsonl");
const ACTIVATION_LOG = path.join(ROOT, "data", "lesson-activations.jsonl");
const DASHBOARD = "http://localhost:3099";

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");
const SAVE = args.includes("--save");

// ── Helpers ──
const CATEGORY = (dom) => {
  if (dom >= 0.8) return "call_strong";
  if (dom >= 0.6) return "call_mod";
  if (dom >= 0.4) return "flip_zone";
  if (dom >= 0.2) return "put_mod";
  return "put_strong";
};

const vixBucket = (v) => {
  if (v == null) return "unknown";
  if (v < 15) return "v_low";
  if (v < 20) return "low";
  if (v < 25) return "mid";
  if (v < 30) return "high";
  return "extreme";
};

const minuteBucket = (m) => {
  if (m < 30) return "open";
  if (m < 150) return "morn";
  if (m < 270) return "mid";
  if (m < 360) return "aft";
  return "close";
};

function shareBucket(share) {
  if (share == null) return "none";
  if (share < 0.001) return "none";
  if (share < 0.01) return "low";     // L119 target zone
  if (share < 0.05) return "mod";     // L125 target zone
  return "high";                       // L120 target zone
}

function computeCurrentMinuteOfSession(tsMs) {
  // Market open = 9:30 ET = 13:30 or 14:30 UTC depending on DST
  const d = new Date(tsMs);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  // US is UTC-5 (EST) or UTC-4 (EDT). Approximate: open = 13:30 UTC EDT (14:30 EST)
  // Use a simpler rule: open at UTC 13:30 for spring/summer, 14:30 for fall/winter
  const month = d.getUTCMonth();
  const isEDT = month >= 2 && month <= 10; // March-November approx
  const openHour = isEDT ? 13 : 14;
  const openMin = 30;
  const curMin = utcHour * 60 + utcMin;
  const openMinAbs = openHour * 60 + openMin;
  return curMin - openMinAbs; // can be negative (pre-market) or >390 (after hours)
}

function vixTrend5d(history) {
  if (!history || history.length < 5) return "unknown";
  const first = history[0].vix;
  const last = history[history.length - 1].vix;
  const pct = (last - first) / first;
  if (pct > 0.05) return "up";
  if (pct < -0.05) return "down";
  return "flat";
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Compute HIRO consensus across available symbols for the CFD
function computeHiroAvg(hiroObj) {
  if (!hiroObj) return null;
  const pctls = Object.values(hiroObj).map(h => h?.percentile).filter(p => p != null);
  if (pctls.length === 0) return null;
  return pctls.reduce((a, b) => a + b, 0) / pctls.length;
}

function computeHiroConsensus(hiroObj) {
  if (!hiroObj) return null;
  const pctls = Object.values(hiroObj).map(h => h?.percentile).filter(p => p != null);
  if (pctls.length === 0) return null;
  const bull = pctls.filter(p => p > 20).length;
  const bear = pctls.filter(p => p < -20).length;
  return bull > bear ? "bullish" : bear > bull ? "bearish" : "mixed";
}

function qqqDelta1h(hiroHistObj) {
  // Would require hiroHistory with 1h prior snapshots — placeholder for future
  return null;
}

// ── Strike feature computation ──
function analyzeBars(bars, prevSnap, tapeData, instTrades, vixLevel, vixTrend, minBucket, priceRelOpen, currentPrice, hiroData) {
  // Build lookup of tape.strikeFlow by strike
  const tapeByStrike = {};
  let tapeTotal = 0;
  if (tapeData) {
    tapeTotal = tapeData.totalPremium || 0;
    for (const sf of tapeData.strikeFlow || []) {
      tapeByStrike[sf.strike] = sf;
    }
  }

  // Build lookup of institutional largest trades by strike
  const instByStrike = {};
  if (instTrades && Array.isArray(instTrades)) {
    for (const t of instTrades) {
      const key = t.strike;
      if (!instByStrike[key]) instByStrike[key] = { largestPrem: 0, count: 0, totalPrem: 0 };
      if (t.premium > instByStrike[key].largestPrem) instByStrike[key].largestPrem = t.premium;
      instByStrike[key].count++;
      instByStrike[key].totalPrem += t.premium;
    }
  }

  const prevMap = {};
  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    for (const row of (prevSnap?.[cfd] || [])) {
      prevMap[`${row.sym}_${row.strike}`] = row;
    }
  }

  return bars.map(b => {
    const absCall = Math.abs(b.callGamma || 0);
    const absPut = Math.abs(b.putGamma || 0);
    const total = absCall + absPut;
    if (total === 0) return null;
    const dom = absCall / total;
    const cat = CATEGORY(dom);
    const prevKey = `${b.symbol}_${b.strike}`;
    const prev = prevMap[prevKey];
    const delta = prev !== undefined ? +(dom - prev.dominance).toFixed(4) : null;
    let flip = null;
    if (prev && Math.sign(prev.dominance - 0.5) !== Math.sign(dom - 0.5)) {
      flip = prev.dominance > 0.5 ? "call_to_put" : "put_to_call";
    }

    // Dealer interpretation (L113)
    let dealerInterp;
    if (cat === "call_strong" || cat === "call_mod") {
      dealerInterp = b.callGamma > 0 ? "dealer_long_calls_support" : "dealer_short_calls_resistance";
    } else if (cat === "put_strong" || cat === "put_mod") {
      dealerInterp = b.putGamma > 0 ? "dealer_long_puts_support" : "dealer_short_puts_support_fragile";
    } else {
      dealerInterp = "mixed_flip_zone";
    }

    // Flow share of day (from tape.strikeFlow)
    const sf = tapeByStrike[b.strike];
    const strikePrem = sf ? (sf.callPrem + sf.putPrem) : 0;
    const flowShareOfDay = tapeTotal > 0 && sf ? strikePrem / tapeTotal : 0;
    const shareBkt = shareBucket(flowShareOfDay);

    // Institutional at strike
    const inst = instByStrike[b.strike] || null;
    const largestPrem = inst?.largestPrem || 0;
    const instCount = inst?.count || 0;
    const instTotalPrem = inst?.totalPrem || 0;

    // OI ratio
    const totOI = (b.callOI || 0) + (b.putOI || 0);
    const oiRatio = totOI > 0 ? b.callOI / totOI : 0.5;

    // Distance spot to strike (pct)
    const distSpotToStrikePct = (currentPrice - b.cfdPrice) / currentPrice;

    // ── EVALUATE LESSONS ──
    const lessonsActive = [];
    const lessonFlags = {};

    // ═══ OPTIMIZED 2026-04-17 — Only OOS-validated winners ═══

    // L114-vix30+ ⭐⭐⭐ OPTIMAL: VIX ≥30 → break cont. Sharpe 8.48, WR 75%, PF 3.1, DD 4.7% (N=53 OOS)
    if (vixLevel != null && vixLevel >= 30) {
      lessonsActive.push("L114-vix30+");
      lessonFlags["L114-vix30+"] = { signal: "break_strong", direction: "approach_cont", tier: "⭐⭐⭐" };
    }
    // L114-vix25_aft ⭐⭐ secondary: VIX ≥25 + afternoon. Sharpe 3.22, PF 1.57 (N=219)
    else if (vixLevel != null && vixLevel >= 25 && (minBucket === "aft" || minBucket === "close")) {
      lessonsActive.push("L114-vix25_aft");
      lessonFlags["L114-vix25_aft"] = { signal: "break", direction: "approach_cont", tier: "⭐⭐" };
    }

    // L115-bidir ⭐⭐ OPTIMIZED: VIX low + strike ±1-3% → bounce bidirectional
    // Approach up + strike +1-3% above spot → SHORT at rejection
    // Approach down + strike 1-3% below spot → LONG at rejection
    const distStrikeAboveSpotPct = (b.cfdPrice - currentPrice) / currentPrice;
    if (vixBucket(vixLevel) === "low") {
      if (distStrikeAboveSpotPct >= 0.01 && distStrikeAboveSpotPct < 0.03) {
        lessonsActive.push("L115-bidir");
        lessonFlags["L115-bidir"] = { signal: "bounce", direction: "SHORT", reason: "strike_above_resistance", tier: "⭐⭐" };
      }
      else if (distStrikeAboveSpotPct <= -0.01 && distStrikeAboveSpotPct > -0.03) {
        lessonsActive.push("L115-bidir");
        lessonFlags["L115-bidir"] = { signal: "bounce", direction: "LONG", reason: "strike_below_support", tier: "⭐⭐" };
      }
    }

    // L116-down ⭐⭐ OPTIMIZED: afternoon + price already DOWN 0.3-1% → SHORT continuation
    // NOTE: only DOWN direction survives OOS — UP version deprecated
    if ((minBucket === "aft" || minBucket === "close") &&
        priceRelOpen != null && priceRelOpen <= -0.003 && priceRelOpen >= -0.01) {
      lessonsActive.push("L116-down");
      lessonFlags["L116-down"] = { signal: "break", direction: "SHORT", tier: "⭐⭐" };
    }

    // L117 ⛔ DEPRECATED — morning bounce failed OOS, no longer fires

    // L118 ⚠️ INACTIVE — requires callOI/putOI split server-side

    // L119-tighter ⭐⭐⭐ OPTIMAL: share [0.3%, 0.8%] → break. Sharpe 5.62, WR 63%, PF 2.3 (N=90)
    if (flowShareOfDay >= 0.003 && flowShareOfDay < 0.008) {
      lessonsActive.push("L119-tighter");
      lessonFlags["L119-tighter"] = { signal: "break_strong", direction: "approach_cont", share: +flowShareOfDay.toFixed(4), tier: "⭐⭐⭐" };
    }
    // L119-base (wider): any VIX + share 0.1-1%. Sharpe 3.99, PF 1.75 (N=178)
    else if (flowShareOfDay >= 0.001 && flowShareOfDay < 0.01) {
      lessonsActive.push("L119-base");
      lessonFlags["L119-base"] = { signal: "break", direction: "approach_cont", share: +flowShareOfDay.toFixed(4), tier: "⭐⭐" };
    }

    // L120 ⛔ directional DEPRECATED — use as TP magnetic target only, no entry
    if (flowShareOfDay >= 0.05) {
      lessonsActive.push("L120-tp_magnet");
      lessonFlags["L120-tp_magnet"] = { signal: "pin", use_as: "TP_target_only", share: +flowShareOfDay.toFixed(4), tier: "⚠️" };
    }

    // L121-wide ⭐⭐⭐ OPTIMAL: VIX [10-22) + share [0.1%, 1%] → break cont.
    // Sharpe 6.24, WR 60%, PF 2.52, DD 10.5% (N=101 OOS). Best flow-based edge.
    // With 2% risk per trade → +133% OOS in 7 months (DD 20%).
    if (flowShareOfDay >= 0.001 && flowShareOfDay < 0.01 &&
        vixLevel != null && vixLevel >= 10 && vixLevel < 22) {
      lessonsActive.push("L121-wide");
      lessonFlags["L121-wide"] = {
        signal: "break_strong",
        direction: "approach_cont",
        share: +flowShareOfDay.toFixed(4),
        suggestedRiskPct: 0.02, // override — 2% instead of 1% since edge is strong
        tier: "⭐⭐⭐"
      };
    }

    // L122/L123/L124 ⚠️ REQUIRE vixTrend5d (still building memory) — fire only after 5 daily cycles
    if (largestPrem >= 1000000 && vixTrend === "down") {
      lessonsActive.push("L122");
      lessonFlags.L122 = { signal: "bounce", direction: "LONG", tier: "⭐⭐" };
    }
    if (largestPrem >= 200000 && largestPrem < 1000000 && vixTrend === "flat") {
      lessonsActive.push("L123");
      lessonFlags.L123 = { signal: "break", tier: "⭐" };
    }
    if (instCount < 3 && vixTrend === "flat" && sf) {
      lessonsActive.push("L124");
      lessonFlags.L124 = { signal: "break_retail", tier: "⭐" };
    }

    // L125 ⛔ DEPRECATED — fail OOS

    // ═══ L126-L130 discovered from HIRO reconstruction OOS ═══

    // HIRO avg percentile + consensus passed in from caller
    const hiroAvg = hiroData?.avgPctl ?? null;
    const hiroConsensus = hiroData?.consensus ?? null;
    const qqqHiro = hiroData?.qqqPctl ?? null;

    // L126 ⭐⭐⭐: HIRO consensus bearish + afternoon → BREAK (N=104 OOS, retention 3.4x)
    if (hiroConsensus === "bearish" && (minBucket === "aft" || minBucket === "close")) {
      lessonsActive.push("L126");
      lessonFlags.L126 = { signal: "break", direction: "approach_cont", tier: "⭐⭐⭐" };
    }

    // L129 ⭐⭐: HIRO avg moderately bearish + afternoon → BREAK (N=64 OOS, retention 6.03x)
    if (hiroAvg != null && hiroAvg >= -50 && hiroAvg < -20 && (minBucket === "aft" || minBucket === "close")) {
      lessonsActive.push("L129");
      lessonFlags.L129 = { signal: "break", direction: "approach_cont", hiroAvg: Math.round(hiroAvg), tier: "⭐⭐" };
    }

    // L130 ⭐⭐: QQQ HIRO extreme bearish → BREAK (N=132 OOS, retention 0.88x)
    if (qqqHiro != null && qqqHiro < -70) {
      lessonsActive.push("L130");
      lessonFlags.L130 = { signal: "break", direction: "approach_cont", qqqHiro, tier: "⭐⭐" };
    }

    // Aggregate directional bias from active lessons
    let bounceCount = 0, breakCount = 0, pinCount = 0;
    for (const flag of Object.values(lessonFlags)) {
      const s = flag.signal || "";
      if (s.includes("bounce")) bounceCount++;
      else if (s.includes("break")) breakCount++;
      else if (s === "pin" || s === "flat") pinCount++;
    }
    const netSignal = breakCount > bounceCount + pinCount ? "break" :
                      bounceCount > breakCount + pinCount ? "bounce" :
                      pinCount > 0 ? "pin" : "mixed";

    return {
      sym: b.symbol,
      strike: b.strike,
      cfdPrice: Math.round(b.cfdPrice),
      gammaM: Math.round(b.gamma / 1e6),
      callGammaM: Math.round((b.callGamma || 0) / 1e6),
      putGammaM: Math.round((b.putGamma || 0) / 1e6),
      dominance: +dom.toFixed(4),
      category: cat,
      dealerInterp,
      prev: prev?.dominance,
      delta,
      flip,
      type: b.type,
      oiRatio: +oiRatio.toFixed(3),
      distSpotToStrikePct: +distSpotToStrikePct.toFixed(4),
      flowShareOfDay: +flowShareOfDay.toFixed(5),
      flowShareBucket: shareBkt,
      largestPrem: largestPrem,
      instCount,
      instTotalPrem,
      lessonsActive,
      netSignal,
      convictionScore: breakCount - bounceCount,
    };
  }).filter(Boolean);
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const prevSnap = state.dominanceSnapshot || null;
  const vixHistory = state.vixHistory || [];

  // Fetch live
  const raw = await fetchJson(`${DASHBOARD}/api/trpc/market.getAgentView`);
  const av = raw?.result?.data?.json || raw?.result?.data;
  const ts = new Date().toISOString();
  const tsMs = Date.now();

  // Extract VIX
  const vixLevel = av.vanna?.vix ?? null;
  const vixBkt = vixBucket(vixLevel);

  // Update VIX history (rolling 5 entries, one per day)
  const today = ts.slice(0, 10);
  const lastEntry = vixHistory[vixHistory.length - 1];
  let newHistory = vixHistory.slice();
  if (!lastEntry || lastEntry.date !== today) {
    newHistory.push({ date: today, vix: vixLevel });
    newHistory = newHistory.slice(-5);
  }
  const vxTrend = vixTrend5d(newHistory);

  // Compute minute of session
  const moSession = computeCurrentMinuteOfSession(tsMs);
  const minBucket = moSession >= 0 && moSession <= 390 ? minuteBucket(moSession) : "closed";

  // Institutional bigTrades (all symbols aggregated)
  const instTrades = av.institutionalFlow?.bigTrades || [];

  // Per-CFD analysis
  const snapshot = { ts, vix: vixLevel, vixTrend: vxTrend, minuteBucket: minBucket };
  const flipEvents = [];
  const activationsSummary = { total: 0, byLesson: {} };

  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    const cfdData = av.cfds[cfd];
    if (!cfdData) continue;

    const bars = cfdData.gammaBars || [];
    const currentPrice = cfdData.price;

    // Session open price for priceRelOpen — approximate from gammaBars.cfdPrice[0] or rawLevels
    // For live, just use sessionOpen if available, otherwise currentPrice as fallback (priceRelOpen=0)
    const sessionOpen = cfdData.sessionOpen || cfdData.openPrice || currentPrice;
    const priceRelOpen = (currentPrice - sessionOpen) / sessionOpen;

    // Per-sym tape data (used for strikeFlow)
    // NAS100 uses SPX primary tape; US30 uses DIA; XAU uses GLD
    const primarySym = cfd === "NAS100" ? "SPX" : cfd === "US30" ? "DIA" : "GLD";
    const tapeData = cfdData.tape?.[primarySym] || null;

    // HIRO data for L126/L129/L130
    const hiroData = {
      avgPctl: computeHiroAvg(cfdData.hiro),
      consensus: computeHiroConsensus(cfdData.hiro),
      qqqPctl: cfd === "NAS100" ? (cfdData.hiro?.QQQ?.percentile ?? null) : null,
    };

    const results = analyzeBars(bars, prevSnap, tapeData, instTrades, vixLevel, vxTrend, minBucket, priceRelOpen, currentPrice, hiroData);
    snapshot[cfd] = results;

    // Collect flip events + activations
    for (const r of results) {
      if (r.flip) flipEvents.push({ ts, cfd, ...r });
      for (const lesson of r.lessonsActive) {
        activationsSummary.byLesson[lesson] = (activationsSummary.byLesson[lesson] || 0) + 1;
        activationsSummary.total++;
      }
    }
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ snapshot, flipEvents, activationsSummary }, null, 2));
    return;
  }

  // Pretty report
  console.log(`\n═══ FEATURES — ${ts} ═══`);
  console.log(`VIX: ${vixLevel} (${vixBkt}) | Trend 5d: ${vxTrend} | Minute: ${moSession} (${minBucket})`);

  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    const rows = snapshot[cfd];
    if (!rows) continue;
    const cfdData = av.cfds[cfd];
    console.log(`\n── ${cfd} (price=${cfdData.price}) ──`);
    for (const r of rows.slice(0, 10)) {
      const lessonTag = r.lessonsActive.length > 0 ? ` 🎯${r.lessonsActive.join(",")}` : "";
      const sig = r.netSignal !== "mixed" ? ` [${r.netSignal.toUpperCase()}]` : "";
      const flipTag = r.flip ? ` 🔄${r.flip}` : "";
      console.log(
        `  ${r.sym}${r.strike} @${r.cfdPrice} ` +
        `γ=${r.gammaM>=0?"+":""}${r.gammaM}M dom=${(r.dominance*100).toFixed(0)}% ` +
        `share=${(r.flowShareOfDay*100).toFixed(2)}% ` +
        `oi=${(r.oiRatio*100).toFixed(0)}% ` +
        `$max=${r.largestPrem>0 ? "$"+(r.largestPrem/1e3).toFixed(0)+"K" : "-"}` +
        `${lessonTag}${sig}${flipTag}`
      );
    }
  }

  console.log(`\n📊 LESSON ACTIVATIONS: ${activationsSummary.total}`);
  for (const [l, n] of Object.entries(activationsSummary.byLesson).sort()) {
    console.log(`  ${l}: ${n} strikes`);
  }

  if (flipEvents.length > 0) {
    console.log(`\n🔄 FLIP EVENTS (${flipEvents.length}):`);
    for (const e of flipEvents) {
      console.log(`  ${e.cfd} ${e.sym}${e.strike} @${e.cfdPrice}: ${e.prev?.toFixed(2)} → ${e.dominance} (${e.flip})`);
    }
  }

  if (SAVE) {
    state.dominanceSnapshot = snapshot;
    state.vixHistory = newHistory;
    // Append to flipHistory rolling 100
    state.flipHistory = [...(state.flipHistory || []), ...flipEvents].slice(-100);
    // Log activations summary per cycle
    state.lastActivations = { ts, ...activationsSummary };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    // Append flip events + lesson activations to jsonl
    for (const e of flipEvents) {
      fs.appendFileSync(FLIP_LOG, JSON.stringify(e) + "\n");
    }
    if (activationsSummary.total > 0) {
      fs.appendFileSync(ACTIVATION_LOG, JSON.stringify({ ts, ...activationsSummary }) + "\n");
    }
    console.log(`\n✓ Saved. ${flipEvents.length} flips, ${activationsSummary.total} activations logged`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
