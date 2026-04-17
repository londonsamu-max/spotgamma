#!/usr/bin/env node
/**
 * Dominance Flip Analyzer
 *
 * Per-strike call/put dominance analysis. Reads gammaBars from getAgentView,
 * compares to previous snapshot in agent-state.json, and flags:
 *   - Flip zones (dominance 0.40-0.60)
 *   - Flip events (dominance crossed 0.5 between cycles)
 *   - Hardening/weakening (dominance delta vs prev cycle)
 *
 * Usage:
 *   node scripts/compute-dominance.cjs            # full analysis, prints report
 *   node scripts/compute-dominance.cjs --json     # output JSON only
 *   node scripts/compute-dominance.cjs --save     # also save snapshot to agent-state.json
 *
 * Output snapshot shape (for agent-state.json.dominanceSnapshot):
 *   {
 *     ts: ISO,
 *     NAS100: [{ sym, strike, cfdPrice, gamma, dominance, category, prev?, delta?, flip? }],
 *     US30:   [...],
 *     XAUUSD: [...]
 *   }
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "data", "agent-state.json");
const FLIP_LOG = path.join(ROOT, "data", "flip-events.jsonl");
const DASHBOARD = "http://localhost:3099";

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");
const SAVE = args.includes("--save");

// Dominance buckets
const CATEGORY = (dom) => {
  if (dom >= 0.8) return "call_strong";
  if (dom >= 0.6) return "call_mod";
  if (dom >= 0.4) return "flip_zone";
  if (dom >= 0.2) return "put_mod";
  return "put_strong";
};

// Compute per-strike dominance + gamma direction interpretation
function analyzeBars(bars, prevSnapshotByKey = {}) {
  return bars.map(b => {
    const absCall = Math.abs(b.callGamma || 0);
    const absPut = Math.abs(b.putGamma || 0);
    const total = absCall + absPut;
    if (total === 0) return null;
    const dom = absCall / total;
    const cat = CATEGORY(dom);
    const key = `${b.symbol}_${b.strike}`;
    const prev = prevSnapshotByKey[key];
    const delta = prev !== undefined ? +(dom - prev.dominance).toFixed(4) : null;
    // Flip event = crossed 0.5 threshold
    let flip = null;
    if (prev && Math.sign(prev.dominance - 0.5) !== Math.sign(dom - 0.5)) {
      flip = prev.dominance > 0.5 ? "call_to_put" : "put_to_call";
    }
    // Dealer positioning combining dominance + sign
    // callGamma sign: positive=dealer long calls (rare), negative=dealer short calls (resistance)
    // putGamma sign: positive=dealer long puts (support by hedging), negative=dealer short puts (support below)
    let dealerInterp;
    if (cat === "call_strong" || cat === "call_mod") {
      dealerInterp = b.callGamma > 0 ? "dealer_long_calls_support" : "dealer_short_calls_resistance";
    } else if (cat === "put_strong" || cat === "put_mod") {
      dealerInterp = b.putGamma > 0 ? "dealer_long_puts_support" : "dealer_short_puts_support_fragile";
    } else {
      dealerInterp = "mixed_flip_zone";
    }
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
    };
  }).filter(Boolean);
}

function prevToMap(prevSnapshot) {
  const map = {};
  if (!prevSnapshot) return map;
  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    for (const row of (prevSnapshot[cfd] || [])) {
      map[`${row.sym}_${row.strike}`] = row;
    }
  }
  return map;
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  // Load previous snapshot
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const prevSnap = state.dominanceSnapshot || null;
  const prevMap = prevToMap(prevSnap);

  // Fetch live
  const raw = await fetchJson(`${DASHBOARD}/api/trpc/market.getAgentView`);
  const av = raw?.result?.data?.json || raw?.result?.data;
  const ts = new Date().toISOString();

  const snapshot = {
    ts,
    NAS100: analyzeBars(av.cfds.NAS100.gammaBars || [], prevMap),
    US30:   analyzeBars(av.cfds.US30.gammaBars   || [], prevMap),
    XAUUSD: analyzeBars(av.cfds.XAUUSD.gammaBars || [], prevMap),
  };

  // Collect flip events
  const flipEvents = [];
  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    for (const r of snapshot[cfd]) {
      if (r.flip) flipEvents.push({ ts, cfd, ...r });
    }
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ snapshot, flipEvents }, null, 2));
    return;
  }

  // Pretty report
  console.log(`\n=== DOMINANCE ANALYSIS — ${ts} ===`);
  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    console.log(`\n── ${cfd} (price=${av.cfds[cfd].price}) ──`);
    for (const r of snapshot[cfd].slice(0, 10)) {
      const flipTag = r.flip ? ` 🔄FLIP(${r.flip})` : "";
      const deltaTag = r.delta !== null && r.delta !== undefined
        ? ` Δ${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)}pp`
        : "";
      const catColor = {
        "call_strong": "▓▓▓ CALL★",
        "call_mod":    "▓▓░ call ",
        "flip_zone":   "░▓░ FLIP⚠",
        "put_mod":     "░▓▓ put  ",
        "put_strong":  "░▓▓ PUT★ "
      }[r.category];
      console.log(
        `  ${r.sym}${r.strike} @${r.cfdPrice} ` +
        `γ=${r.gammaM >= 0 ? "+" : ""}${r.gammaM}M ` +
        `dom=${(r.dominance * 100).toFixed(1).padStart(5)}% ${catColor}` +
        `${deltaTag}${flipTag}  [${r.dealerInterp}]`
      );
    }
  }

  if (flipEvents.length > 0) {
    console.log(`\n🔄 FLIP EVENTS (${flipEvents.length}):`);
    for (const e of flipEvents) {
      console.log(`  ${e.cfd} ${e.sym}${e.strike} @${e.cfdPrice}: ${e.prev?.toFixed(2)} → ${e.dominance} (${e.flip})`);
    }
  } else {
    console.log("\n(no flip events this cycle)");
  }

  // Flip zones summary (strikes currently in 0.40-0.60 band)
  const flipZones = [];
  for (const cfd of ["NAS100", "US30", "XAUUSD"]) {
    for (const r of snapshot[cfd]) {
      if (r.category === "flip_zone") flipZones.push({ cfd, ...r });
    }
  }
  if (flipZones.length > 0) {
    console.log(`\n⚠ STRIKES IN FLIP ZONE (dominance 0.40-0.60):`);
    for (const z of flipZones) {
      console.log(`  ${z.cfd} ${z.sym}${z.strike} @${z.cfdPrice}: dom=${(z.dominance * 100).toFixed(1)}% γ=${z.gammaM}M — transicionando`);
    }
  }

  if (SAVE) {
    state.dominanceSnapshot = snapshot;
    // Append to flipHistory (rolling 100)
    state.flipHistory = [...(state.flipHistory || []).slice(-99 + flipEvents.length), ...flipEvents].slice(-100);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    // Append flipEvents to jsonl log
    for (const e of flipEvents) {
      fs.appendFileSync(FLIP_LOG, JSON.stringify(e) + "\n");
    }
    console.log(`\n✓ Saved snapshot to agent-state.json (${flipEvents.length} flips logged)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
