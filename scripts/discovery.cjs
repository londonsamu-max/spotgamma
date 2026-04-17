#!/usr/bin/env node
/**
 * Discovery Engine
 *
 * Reads: data/backtest-v2/events-enriched.jsonl
 * Writes: data/backtest-v2/discoveries.md (ranked combinations with edge)
 *
 * Strategy:
 *   1. Univariate: for each feature, bucket events, compute bounce/break rate per bucket
 *      Flag buckets with N >= MIN_N AND |rate - baseline| >= MIN_EFFECT_PP
 *   2. Bivariate: top univariate features, pairwise grid, flag cells with edge
 *   3. Outcome horizon: primarily 4h (most equilibrated distribution)
 *
 * Success criterion for publishing: N_train>=150 AND |edge|>=5pp AND directionally actionable
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "discoveries.md");

const HORIZONS = ["outcome15m", "outcome1h", "outcome4h", "outcomeEod"];
const PRIMARY_HORIZON = "outcome4h";
const MIN_N = 80;           // minimum cell N to consider
const MIN_EFFECT_PP = 4;    // minimum effect size in percentage points to flag

// Bucket definitions — either categorical (enum) or numeric (array of thresholds)
const BUCKETS = {
  // Continuous features: bucketize
  dominance: { type: "numeric", breaks: [0.2, 0.4, 0.6, 0.8] },
  dominance_signed: { type: "numeric", breaks: [-0.6, -0.2, 0.2, 0.6] },
  oiRatio: { type: "numeric", breaks: [0.3, 0.5, 0.7] },
  deltaRatio: { type: "numeric", breaks: [0.3, 0.5, 0.7] },
  distToCallWallPct: { type: "numeric", breaks: [-0.05, -0.02, 0, 0.02, 0.05] },
  distToPutWallPct: { type: "numeric", breaks: [-0.05, -0.02, 0, 0.02, 0.05] },
  distToZeroGammaPct: { type: "numeric", breaks: [-0.05, -0.02, 0, 0.02, 0.05] },
  distSpotToStrikePct: { type: "numeric", breaks: [-0.03, -0.01, 0.01, 0.03] },
  sessionProgress: { type: "numeric", breaks: [0.1, 0.3, 0.5, 0.7, 0.9] },
  sessionRangeBeforeTouchPct: { type: "numeric", breaks: [0.003, 0.007, 0.015] },
  priceRelToOpenPct: { type: "numeric", breaks: [-0.01, -0.003, 0.003, 0.01] },
  gammaConcentration: { type: "numeric", breaks: [0.2, 0.4, 0.6, 0.8] },
  gapToNextBarAbovePct: { type: "numeric", breaks: [0.002, 0.005, 0.01] },
  gapToNextBarBelowPct: { type: "numeric", breaks: [0.002, 0.005, 0.01] },
  barsWithin1Pct: { type: "numeric", breaks: [2, 5, 10] },
  vixLevel: { type: "numeric", breaks: [15, 20, 25, 30] },
  dominance_delta: { type: "numeric", breaks: [-0.2, -0.05, 0.05, 0.2] },
  gamma_delta_pct: { type: "numeric", breaks: [-0.5, -0.1, 0.1, 0.5] },
  netPos_delta: { type: "numeric", breaks: [-5000, -500, 500, 5000] },
  minuteOfSession: { type: "numeric", breaks: [60, 180, 300] },
  daysToOpex: { type: "numeric", breaks: [3, 7, 14] },

  // Categorical: pass through
  sym: "cat",
  approach: "cat",
  gammaSign: "cat",
  gammaBucket: "cat",
  gammaType: "cat",
  regime: "cat",
  strikeAboveZeroGamma: "cat",
  priceAboveZeroGamma: "cat",
  dayOfWeek: "cat",
  isOpex: "cat",
  isQuarterlyOpex: "cat",
  minuteBucket: "cat",
  vixBucket: "cat",
  vixTrend5d: "cat",
  dxyTrend5d: "cat",
  tltTrend5d: "cat",
  flipEvent_d1: "cat",
};

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

function computeRates(events, horizon) {
  let b = 0, br = 0, f = 0;
  for (const e of events) {
    const o = e[horizon];
    if (o === "bounce") b++;
    else if (o === "break") br++;
    else f++;
  }
  const n = events.length;
  return { n, bouncePct: n > 0 ? b / n : 0, breakPct: n > 0 ? br / n : 0, flatPct: n > 0 ? f / n : 0 };
}

function univariateAnalysis(events, horizon) {
  const baseline = computeRates(events, horizon);
  const discoveries = [];
  for (const [feat, def] of Object.entries(BUCKETS)) {
    // Group events by bucket
    const byBucket = {};
    for (const e of events) {
      const bkt = bucketize(e[feat], def);
      if (!byBucket[bkt]) byBucket[bkt] = [];
      byBucket[bkt].push(e);
    }
    for (const [bkt, evs] of Object.entries(byBucket)) {
      if (evs.length < MIN_N) continue;
      const r = computeRates(evs, horizon);
      const bounceEdge = (r.bouncePct - baseline.bouncePct) * 100;
      const breakEdge = (r.breakPct - baseline.breakPct) * 100;
      if (Math.abs(bounceEdge) >= MIN_EFFECT_PP || Math.abs(breakEdge) >= MIN_EFFECT_PP) {
        discoveries.push({
          feature: feat,
          bucket: bkt,
          n: r.n,
          bouncePct: (r.bouncePct * 100).toFixed(1),
          breakPct: (r.breakPct * 100).toFixed(1),
          flatPct: (r.flatPct * 100).toFixed(1),
          bounceEdge: +bounceEdge.toFixed(1),
          breakEdge: +breakEdge.toFixed(1),
          dominant: Math.abs(bounceEdge) > Math.abs(breakEdge) ? "bounce" : "break",
          signal: bounceEdge > 0 ? "bounce+" : (breakEdge > 0 ? "break+" : "neutral"),
        });
      }
    }
  }
  discoveries.sort((a, b) => Math.max(Math.abs(b.bounceEdge), Math.abs(b.breakEdge))
                          - Math.max(Math.abs(a.bounceEdge), Math.abs(a.breakEdge)));
  return { baseline, discoveries };
}

function bivariateAnalysis(events, horizon, topFeatures) {
  const baseline = computeRates(events, horizon);
  const pairs = [];
  for (let i = 0; i < topFeatures.length; i++) {
    for (let j = i + 1; j < topFeatures.length; j++) {
      const f1 = topFeatures[i], f2 = topFeatures[j];
      const def1 = BUCKETS[f1], def2 = BUCKETS[f2];
      const byBucket = {};
      for (const e of events) {
        const k = `${bucketize(e[f1], def1)}__${bucketize(e[f2], def2)}`;
        if (!byBucket[k]) byBucket[k] = [];
        byBucket[k].push(e);
      }
      for (const [k, evs] of Object.entries(byBucket)) {
        if (evs.length < MIN_N) continue;
        const r = computeRates(evs, horizon);
        const bounceEdge = (r.bouncePct - baseline.bouncePct) * 100;
        const breakEdge = (r.breakPct - baseline.breakPct) * 100;
        const mag = Math.max(Math.abs(bounceEdge), Math.abs(breakEdge));
        if (mag >= MIN_EFFECT_PP + 1) { // slightly higher bar for pairs
          const [b1, b2] = k.split("__");
          pairs.push({
            feat1: f1, bucket1: b1, feat2: f2, bucket2: b2,
            n: r.n,
            bouncePct: (r.bouncePct * 100).toFixed(1),
            breakPct: (r.breakPct * 100).toFixed(1),
            bounceEdge: +bounceEdge.toFixed(1),
            breakEdge: +breakEdge.toFixed(1),
            dominant: Math.abs(bounceEdge) > Math.abs(breakEdge) ? "bounce" : "break",
          });
        }
      }
    }
  }
  pairs.sort((a, b) => Math.max(Math.abs(b.bounceEdge), Math.abs(b.breakEdge))
                     - Math.max(Math.abs(a.bounceEdge), Math.abs(a.breakEdge)));
  return pairs;
}

function main() {
  const lines = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${events.length} events`);

  // Run discovery for 4h horizon (primary)
  let report = `# Discovery Report — ${new Date().toISOString().slice(0, 10)}\n\n`;
  report += `**Total events:** ${events.length}\n`;
  report += `**Symbols:** ${[...new Set(events.map(e => e.sym))].join(", ")}\n`;
  report += `**Date range:** ${events[0].date} → ${events[events.length - 1].date}\n`;
  report += `**Min N per cell:** ${MIN_N}\n`;
  report += `**Min edge (pp):** ${MIN_EFFECT_PP}\n\n`;

  for (const horizon of HORIZONS) {
    const { baseline, discoveries } = univariateAnalysis(events, horizon);
    report += `## Horizon: ${horizon}\n\n`;
    report += `**Baseline:** bounce ${(baseline.bouncePct * 100).toFixed(1)}% | break ${(baseline.breakPct * 100).toFixed(1)}% | flat ${(baseline.flatPct * 100).toFixed(1)}% (N=${baseline.n})\n\n`;

    report += `### Univariate — Top ${Math.min(30, discoveries.length)} discoveries\n\n`;
    report += `| Feature | Bucket | N | bounce% | break% | flat% | edge_bounce | edge_break | signal |\n`;
    report += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const d of discoveries.slice(0, 30)) {
      const arrow = (v) => v > 0 ? `+${v}` : `${v}`;
      report += `| ${d.feature} | ${d.bucket} | ${d.n} | ${d.bouncePct} | ${d.breakPct} | ${d.flatPct} | ${arrow(d.bounceEdge)}pp | ${arrow(d.breakEdge)}pp | ${d.signal} |\n`;
    }
    report += `\n`;

    // Bivariate on top 12 unique features
    if (horizon === PRIMARY_HORIZON) {
      const topFeats = [...new Set(discoveries.slice(0, 40).map(d => d.feature))].slice(0, 12);
      report += `### Bivariate (top-12 features combined) — Top 30 pair discoveries\n\n`;
      const pairs = bivariateAnalysis(events, horizon, topFeats);
      report += `Top features used: ${topFeats.join(", ")}\n\n`;
      report += `| Feat1 | Bucket1 | Feat2 | Bucket2 | N | bounce% | break% | edge_bounce | edge_break |\n`;
      report += `|---|---|---|---|---|---|---|---|---|\n`;
      for (const p of pairs.slice(0, 30)) {
        const arrow = (v) => v > 0 ? `+${v}` : `${v}`;
        report += `| ${p.feat1} | ${p.bucket1} | ${p.feat2} | ${p.bucket2} | ${p.n} | ${p.bouncePct} | ${p.breakPct} | ${arrow(p.bounceEdge)}pp | ${arrow(p.breakEdge)}pp |\n`;
      }
      report += `\n`;
    }
  }

  fs.writeFileSync(OUT_FILE, report);
  console.log(`Written: ${OUT_FILE}`);
  console.log(`Size: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
}

main();
