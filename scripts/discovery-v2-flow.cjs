#!/usr/bin/env node
/**
 * Discovery v2 — includes flow features
 *
 * Two analyses:
 *   A) FLOW-ONLY subset (events with flow_atStrike_available=true)
 *      - Runs univariate on flow features with lower MIN_N (50)
 *      - Runs bivariate flow × non-flow
 *   B) Full dataset: univariate on flow features with MIN_N=80
 *      (events without flow will be "null" bucket, excluded automatically)
 *
 * Also does OOS validation with same split date.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v2.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "discoveries-v2-flow.md");

const SPLIT_DATE = "2025-10-01";
const MIN_N_FLOW_SUBSET = 50;   // lower since subset is smaller
const MIN_N_TEST = 30;
const MIN_EDGE_PP = 5;
const EDGE_RETENTION = 0.5;

// Flow feature buckets
const FLOW_BUCKETS = {
  flow_cpRatio: { type: "numeric", breaks: [0.2, 0.4, 0.6, 0.8] },
  flow_bullBearBias: { type: "numeric", breaks: [-0.5, -0.2, 0.2, 0.5] },
  flow_instShare: { type: "numeric", breaks: [0.005, 0.02, 0.05] },
  flow_instCount: { type: "numeric", breaks: [0, 3, 10] },
  flow_aggBias: { type: "numeric", breaks: [-0.3, -0.1, 0.1, 0.3] },
  flow_highOpenShare: { type: "numeric", breaks: [0.005, 0.02, 0.1] },
  flow_dte0Share: { type: "numeric", breaks: [0.1, 0.3, 0.6] },
  flow_monthlyShare: { type: "numeric", breaks: [0.1, 0.3, 0.6] },
  flow_leapsShare: { type: "numeric", breaks: [0.005, 0.05, 0.15] },
  flow_strikeShareOfDay: { type: "numeric", breaks: [0.001, 0.01, 0.05] },
  flow_netDelta: { type: "numeric", breaks: [-1e7, -1e6, 1e6, 1e7] },
  flow_largestPrem: { type: "numeric", breaks: [50000, 200000, 1000000] },
  flow_trades: { type: "numeric", breaks: [50, 500, 2000] },
};

// Non-flow features (subset from v1 discovery — highest signal)
const CORE_BUCKETS = {
  vixBucket: "cat",
  vixTrend5d: "cat",
  minuteBucket: "cat",
  sessionProgress: { type: "numeric", breaks: [0.1, 0.3, 0.5, 0.7, 0.9] },
  priceRelToOpenPct: { type: "numeric", breaks: [-0.01, -0.003, 0.003, 0.01] },
  distSpotToStrikePct: { type: "numeric", breaks: [-0.03, -0.01, 0.01, 0.03] },
  oiRatio: { type: "numeric", breaks: [0.3, 0.5, 0.7] },
  gammaBucket: "cat",
  dominance: { type: "numeric", breaks: [0.2, 0.4, 0.6, 0.8] },
  approach: "cat",
  gammaType: "cat",
  sym: "cat",
};

const ALL_BUCKETS = { ...FLOW_BUCKETS, ...CORE_BUCKETS };

function bucketize(value, def) {
  if (value == null) return "null";
  if (def === "cat") return String(value);
  if (def.type === "numeric") {
    const breaks = def.breaks;
    if (value < breaks[0]) return `<${breaks[0]}`;
    for (let i = 0; i < breaks.length - 1; i++) {
      if (value >= breaks[i] && value < breaks[i + 1]) return `[${breaks[i]},${breaks[i + 1]})`;
    }
    return `>=${breaks[breaks.length - 1]}`;
  }
  return String(value);
}

function rates(events, horizon) {
  let b = 0, br = 0, f = 0;
  for (const e of events) {
    const o = e[horizon];
    if (o === "bounce") b++;
    else if (o === "break") br++;
    else f++;
  }
  const n = events.length;
  return { n, bouncePct: n > 0 ? b / n : 0, breakPct: n > 0 ? br / n : 0 };
}

function univariate(events, horizon, buckets, minN) {
  const baseline = rates(events, horizon);
  const discoveries = [];
  for (const [feat, def] of Object.entries(buckets)) {
    const byBucket = {};
    for (const e of events) {
      const k = bucketize(e[feat], def);
      if (k === "null") continue; // skip missing
      (byBucket[k] ||= []).push(e);
    }
    for (const [bkt, evs] of Object.entries(byBucket)) {
      if (evs.length < minN) continue;
      const r = rates(evs, horizon);
      const eb = (r.bouncePct - baseline.bouncePct) * 100;
      const ek = (r.breakPct - baseline.breakPct) * 100;
      if (Math.max(Math.abs(eb), Math.abs(ek)) >= MIN_EDGE_PP) {
        discoveries.push({
          feat, bucket: bkt, n: r.n,
          bouncePct: (r.bouncePct * 100).toFixed(1),
          breakPct: (r.breakPct * 100).toFixed(1),
          edgeB: +eb.toFixed(1), edgeK: +ek.toFixed(1),
          signal: Math.abs(eb) > Math.abs(ek) ? (eb > 0 ? "BOUNCE+" : "BOUNCE-") : (ek > 0 ? "BREAK+" : "BREAK-"),
        });
      }
    }
  }
  discoveries.sort((a, b) => Math.max(Math.abs(b.edgeB), Math.abs(b.edgeK))
                          - Math.max(Math.abs(a.edgeB), Math.abs(a.edgeK)));
  return { baseline, discoveries };
}

function bivariate(events, horizon, feats1, feats2, minN) {
  const baseline = rates(events, horizon);
  const pairs = [];
  for (const f1 of feats1) {
    for (const f2 of feats2) {
      if (f1 === f2) continue;
      const d1 = ALL_BUCKETS[f1], d2 = ALL_BUCKETS[f2];
      const byBucket = {};
      for (const e of events) {
        const k1 = bucketize(e[f1], d1), k2 = bucketize(e[f2], d2);
        if (k1 === "null" || k2 === "null") continue;
        const key = `${k1}__${k2}`;
        (byBucket[key] ||= []).push(e);
      }
      for (const [k, evs] of Object.entries(byBucket)) {
        if (evs.length < minN) continue;
        const r = rates(evs, horizon);
        const eb = (r.bouncePct - baseline.bouncePct) * 100;
        const ek = (r.breakPct - baseline.breakPct) * 100;
        if (Math.max(Math.abs(eb), Math.abs(ek)) >= MIN_EDGE_PP + 1) {
          const [b1, b2] = k.split("__");
          pairs.push({
            f1, b1, f2, b2, n: r.n,
            bouncePct: (r.bouncePct * 100).toFixed(1),
            breakPct: (r.breakPct * 100).toFixed(1),
            edgeB: +eb.toFixed(1), edgeK: +ek.toFixed(1),
          });
        }
      }
    }
  }
  pairs.sort((a, b) => Math.max(Math.abs(b.edgeB), Math.abs(b.edgeK))
                     - Math.max(Math.abs(a.edgeB), Math.abs(a.edgeK)));
  return pairs;
}

function oosCheck(events, horizon, feat, bucket, def) {
  const train = events.filter(e => e.date < SPLIT_DATE);
  const test = events.filter(e => e.date >= SPLIT_DATE);
  const getBucket = (ev, d) => def === "cat" ? String(ev[feat]) : bucketize(ev[feat], def);
  const trEvs = train.filter(e => getBucket(e, def) === bucket);
  const teEvs = test.filter(e => getBucket(e, def) === bucket);
  const trBase = rates(train, horizon);
  const teBase = rates(test, horizon);
  const tr = rates(trEvs, horizon);
  const te = rates(teEvs, horizon);
  return {
    n_train: tr.n, n_test: te.n,
    edge_tr_b: +((tr.bouncePct - trBase.bouncePct) * 100).toFixed(1),
    edge_tr_k: +((tr.breakPct - trBase.breakPct) * 100).toFixed(1),
    edge_te_b: +((te.bouncePct - teBase.bouncePct) * 100).toFixed(1),
    edge_te_k: +((te.breakPct - teBase.breakPct) * 100).toFixed(1),
  };
}

function main() {
  const all = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const withFlow = all.filter(e => e.flow_atStrike_available);

  console.log(`Total: ${all.length} | With flow: ${withFlow.length}`);

  let report = `# Discovery v2 — Flow Features — ${new Date().toISOString().slice(0, 10)}\n\n`;
  report += `**Total events:** ${all.length}\n`;
  report += `**With strike-level flow:** ${withFlow.length} (${(100 * withFlow.length / all.length).toFixed(1)}%)\n`;
  report += `**Min N (flow subset):** ${MIN_N_FLOW_SUBSET}\n`;
  report += `**Min edge:** ${MIN_EDGE_PP}pp\n\n`;

  for (const h of ["outcome1h", "outcome4h", "outcomeEod"]) {
    const { baseline, discoveries } = univariate(withFlow, h, FLOW_BUCKETS, MIN_N_FLOW_SUBSET);
    report += `## Horizon: ${h}\n\n`;
    report += `**Flow subset baseline:** bounce ${(baseline.bouncePct * 100).toFixed(1)}% | break ${(baseline.breakPct * 100).toFixed(1)}%\n\n`;

    report += `### Univariate FLOW features (top 20)\n\n`;
    report += `| Feature | Bucket | N | bounce% | break% | edge_b | edge_k | signal | OOS ret |\n`;
    report += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const d of discoveries.slice(0, 20)) {
      const oos = oosCheck(withFlow, h, d.feat, d.bucket, FLOW_BUCKETS[d.feat]);
      const dom = Math.abs(d.edgeB) > Math.abs(d.edgeK) ? "b" : "k";
      const edgeTr = dom === "b" ? oos.edge_tr_b : oos.edge_tr_k;
      const edgeTe = dom === "b" ? oos.edge_te_b : oos.edge_te_k;
      const sameSign = edgeTr * edgeTe > 0;
      const retention = edgeTr !== 0 ? (edgeTe / edgeTr).toFixed(2) : "0";
      const ret = sameSign && Math.abs(edgeTe) >= EDGE_RETENTION * Math.abs(edgeTr) ? `${retention}x ✓` :
                   sameSign ? `${retention}x weak` :
                   `sign flip ✗`;
      const arrow = (v) => v >= 0 ? `+${v}` : `${v}`;
      report += `| ${d.feat} | ${d.bucket} | ${d.n} | ${d.bouncePct} | ${d.breakPct} | ${arrow(d.edgeB)}pp | ${arrow(d.edgeK)}pp | ${d.signal} | ${ret} (Ntr=${oos.n_train} Nte=${oos.n_test}) |\n`;
    }
    report += `\n`;

    // Bivariate flow × core
    if (h === "outcome4h") {
      const topFlowFeats = [...new Set(discoveries.slice(0, 10).map(d => d.feat))];
      const coreFeats = Object.keys(CORE_BUCKETS);
      const pairs = bivariate(withFlow, h, topFlowFeats, coreFeats, MIN_N_FLOW_SUBSET);
      report += `### Bivariate FLOW × CORE (top 25) — 4h horizon\n\n`;
      report += `| FlowFeat | Bucket | CoreFeat | Bucket | N | bounce% | break% | edge_b | edge_k | OOS |\n`;
      report += `|---|---|---|---|---|---|---|---|---|---|\n`;
      for (const p of pairs.slice(0, 25)) {
        // OOS for pair
        const d1 = ALL_BUCKETS[p.f1], d2 = ALL_BUCKETS[p.f2];
        const getK = (ev) => `${bucketize(ev[p.f1], d1)}__${bucketize(ev[p.f2], d2)}`;
        const train = withFlow.filter(e => e.date < SPLIT_DATE && getK(e) === `${p.b1}__${p.b2}`);
        const test = withFlow.filter(e => e.date >= SPLIT_DATE && getK(e) === `${p.b1}__${p.b2}`);
        const trBase = rates(withFlow.filter(e => e.date < SPLIT_DATE), h);
        const teBase = rates(withFlow.filter(e => e.date >= SPLIT_DATE), h);
        const trRates = rates(train, h);
        const teRates = rates(test, h);
        const dom = Math.abs(p.edgeB) > Math.abs(p.edgeK) ? "b" : "k";
        const edTrB = (trRates.bouncePct - trBase.bouncePct) * 100;
        const edTrK = (trRates.breakPct - trBase.breakPct) * 100;
        const edTeB = (teRates.bouncePct - teBase.bouncePct) * 100;
        const edTeK = (teRates.breakPct - teBase.breakPct) * 100;
        const edTr = dom === "b" ? edTrB : edTrK;
        const edTe = dom === "b" ? edTeB : edTeK;
        const retention = edTr !== 0 ? (edTe / edTr).toFixed(2) : "0";
        const sameSign = edTr * edTe > 0;
        const ret = sameSign && Math.abs(edTe) >= EDGE_RETENTION * Math.abs(edTr) ? `✓ ${retention}x Nte=${test.length}` :
                     sameSign ? `weak ${retention}x Nte=${test.length}` :
                     `flip Nte=${test.length}`;
        const arrow = (v) => v >= 0 ? `+${v}` : `${v}`;
        report += `| ${p.f1} | ${p.b1} | ${p.f2} | ${p.b2} | ${p.n} | ${p.bouncePct} | ${p.breakPct} | ${arrow(p.edgeB)}pp | ${arrow(p.edgeK)}pp | ${ret} |\n`;
      }
      report += `\n`;
    }
  }

  fs.writeFileSync(OUT_FILE, report);
  console.log(`\nWritten: ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
}

main();
