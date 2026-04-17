#!/usr/bin/env node
/**
 * OOS Validation
 *
 * Reads: events-enriched.jsonl
 * Split: TRAIN = date < 2025-10-01, TEST = date >= 2025-10-01
 *
 * Procedure:
 *   1. Discovery on TRAIN only (same thresholds)
 *   2. Re-compute TEST stats for each TRAIN discovery
 *   3. Publish only rules where:
 *      - Sign of edge matches (both bounce+ or both break+)
 *      - |edge_test| >= 0.5 * |edge_train| (keeps at least half the edge)
 *      - N_test >= 40
 *
 * Also tests top bivariate combinations with same criteria.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "oos-validated.md");

const SPLIT_DATE = "2025-10-01";
const MIN_N_TRAIN = 100;
const MIN_N_TEST = 40;
const MIN_EDGE_TRAIN_PP = 5;
const EDGE_RETENTION = 0.5;
const PRIMARY_HORIZONS = ["outcome1h", "outcome4h", "outcomeEod"];

// Same buckets as discovery.cjs
const BUCKETS = {
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
  sym: "cat", approach: "cat", gammaSign: "cat", gammaBucket: "cat", gammaType: "cat",
  regime: "cat", strikeAboveZeroGamma: "cat", priceAboveZeroGamma: "cat",
  dayOfWeek: "cat", isOpex: "cat", isQuarterlyOpex: "cat", minuteBucket: "cat",
  vixBucket: "cat", vixTrend5d: "cat", dxyTrend5d: "cat", tltTrend5d: "cat",
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

function rates(events, horizon) {
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

function validateHorizon(trainEvs, testEvs, horizon) {
  const trainBase = rates(trainEvs, horizon);
  const testBase = rates(testEvs, horizon);

  const survivors = [];

  // --- UNIVARIATE ---
  for (const [feat, def] of Object.entries(BUCKETS)) {
    const trainByBucket = {}, testByBucket = {};
    for (const e of trainEvs) {
      const k = bucketize(e[feat], def);
      (trainByBucket[k] ||= []).push(e);
    }
    for (const e of testEvs) {
      const k = bucketize(e[feat], def);
      (testByBucket[k] ||= []).push(e);
    }
    for (const [k, trEvs] of Object.entries(trainByBucket)) {
      if (trEvs.length < MIN_N_TRAIN) continue;
      const tr = rates(trEvs, horizon);
      const edgeTrB = (tr.bouncePct - trainBase.bouncePct) * 100;
      const edgeTrK = (tr.breakPct - trainBase.breakPct) * 100;
      const magTr = Math.max(Math.abs(edgeTrB), Math.abs(edgeTrK));
      if (magTr < MIN_EDGE_TRAIN_PP) continue;

      const teEvs = testByBucket[k] || [];
      if (teEvs.length < MIN_N_TEST) continue;
      const te = rates(teEvs, horizon);
      const edgeTeB = (te.bouncePct - testBase.bouncePct) * 100;
      const edgeTeK = (te.breakPct - testBase.breakPct) * 100;

      // Check retention: same-sign, |edge_test| >= 50% |edge_train|
      const signOkB = edgeTrB * edgeTeB > 0 && Math.abs(edgeTeB) >= EDGE_RETENTION * Math.abs(edgeTrB);
      const signOkK = edgeTrK * edgeTeK > 0 && Math.abs(edgeTeK) >= EDGE_RETENTION * Math.abs(edgeTrK);

      if (signOkB || signOkK) {
        survivors.push({
          kind: "univariate",
          feature: feat,
          bucket: k,
          n_train: tr.n, n_test: te.n,
          edge_tr_b: +edgeTrB.toFixed(1), edge_te_b: +edgeTeB.toFixed(1),
          edge_tr_k: +edgeTrK.toFixed(1), edge_te_k: +edgeTeK.toFixed(1),
          bouncePct_tr: (tr.bouncePct * 100).toFixed(1), bouncePct_te: (te.bouncePct * 100).toFixed(1),
          breakPct_tr: (tr.breakPct * 100).toFixed(1), breakPct_te: (te.breakPct * 100).toFixed(1),
          retention_b: signOkB ? (edgeTeB / edgeTrB).toFixed(2) : "X",
          retention_k: signOkK ? (edgeTeK / edgeTrK).toFixed(2) : "X",
          signal: Math.abs(edgeTrB) > Math.abs(edgeTrK) ? (edgeTrB > 0 ? "BOUNCE+" : "BOUNCE-") : (edgeTrK > 0 ? "BREAK+" : "BREAK-"),
        });
      }
    }
  }

  survivors.sort((a, b) => Math.max(Math.abs(b.edge_te_b), Math.abs(b.edge_te_k))
                        - Math.max(Math.abs(a.edge_te_b), Math.abs(a.edge_te_k)));
  return { trainBase, testBase, survivors };
}

function validateBivariate(trainEvs, testEvs, horizon, features) {
  const trainBase = rates(trainEvs, horizon);
  const testBase = rates(testEvs, horizon);
  const survivors = [];

  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const f1 = features[i], f2 = features[j];
      const def1 = BUCKETS[f1], def2 = BUCKETS[f2];

      const tr = {}, te = {};
      for (const e of trainEvs) {
        const k = `${bucketize(e[f1], def1)}__${bucketize(e[f2], def2)}`;
        (tr[k] ||= []).push(e);
      }
      for (const e of testEvs) {
        const k = `${bucketize(e[f1], def1)}__${bucketize(e[f2], def2)}`;
        (te[k] ||= []).push(e);
      }
      for (const [k, trEvs] of Object.entries(tr)) {
        if (trEvs.length < MIN_N_TRAIN) continue;
        const r_tr = rates(trEvs, horizon);
        const ed_tr_b = (r_tr.bouncePct - trainBase.bouncePct) * 100;
        const ed_tr_k = (r_tr.breakPct - trainBase.breakPct) * 100;
        const magTr = Math.max(Math.abs(ed_tr_b), Math.abs(ed_tr_k));
        if (magTr < MIN_EDGE_TRAIN_PP + 2) continue; // higher bar for pairs

        const teEvs = te[k] || [];
        if (teEvs.length < MIN_N_TEST) continue;
        const r_te = rates(teEvs, horizon);
        const ed_te_b = (r_te.bouncePct - testBase.bouncePct) * 100;
        const ed_te_k = (r_te.breakPct - testBase.breakPct) * 100;

        const okB = ed_tr_b * ed_te_b > 0 && Math.abs(ed_te_b) >= EDGE_RETENTION * Math.abs(ed_tr_b);
        const okK = ed_tr_k * ed_te_k > 0 && Math.abs(ed_te_k) >= EDGE_RETENTION * Math.abs(ed_tr_k);

        if (okB || okK) {
          const [b1, b2] = k.split("__");
          survivors.push({
            kind: "bivariate",
            f1, b1, f2, b2,
            n_train: r_tr.n, n_test: r_te.n,
            edge_tr_b: +ed_tr_b.toFixed(1), edge_te_b: +ed_te_b.toFixed(1),
            edge_tr_k: +ed_tr_k.toFixed(1), edge_te_k: +ed_te_k.toFixed(1),
            bouncePct_tr: (r_tr.bouncePct * 100).toFixed(1), bouncePct_te: (r_te.bouncePct * 100).toFixed(1),
            breakPct_tr: (r_tr.breakPct * 100).toFixed(1), breakPct_te: (r_te.breakPct * 100).toFixed(1),
            signal: Math.abs(ed_tr_b) > Math.abs(ed_tr_k) ? (ed_tr_b > 0 ? "BOUNCE+" : "BOUNCE-") : (ed_tr_k > 0 ? "BREAK+" : "BREAK-"),
          });
        }
      }
    }
  }
  survivors.sort((a, b) => Math.max(Math.abs(b.edge_te_b), Math.abs(b.edge_te_k))
                        - Math.max(Math.abs(a.edge_te_b), Math.abs(a.edge_te_k)));
  return survivors;
}

function main() {
  const lines = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean);
  const events = lines.map(l => JSON.parse(l));

  const train = events.filter(e => e.date < SPLIT_DATE);
  const test = events.filter(e => e.date >= SPLIT_DATE);

  console.log(`Total: ${events.length}`);
  console.log(`Train: ${train.length} (${train[0]?.date} → ${train[train.length - 1]?.date})`);
  console.log(`Test:  ${test.length} (${test[0]?.date} → ${test[test.length - 1]?.date})`);

  let report = `# OOS Validation Report — ${new Date().toISOString().slice(0, 10)}\n\n`;
  report += `**Split date:** ${SPLIT_DATE}\n`;
  report += `**Train N:** ${train.length} events (${train[0]?.date} → ${train[train.length - 1]?.date})\n`;
  report += `**Test N:**  ${test.length} events (${test[0]?.date} → ${test[test.length - 1]?.date})\n`;
  report += `**Min N train:** ${MIN_N_TRAIN} | **Min N test:** ${MIN_N_TEST}\n`;
  report += `**Min edge train:** ${MIN_EDGE_TRAIN_PP}pp | **Edge retention:** ≥${EDGE_RETENTION * 100}%\n\n`;
  report += `Survivors = rules where edge direction persists AND test-edge ≥ ${EDGE_RETENTION * 100}% of train-edge.\n\n`;

  for (const h of PRIMARY_HORIZONS) {
    const { trainBase, testBase, survivors } = validateHorizon(train, test, h);
    report += `## Horizon: ${h}\n\n`;
    report += `Train baseline: bounce ${(trainBase.bouncePct * 100).toFixed(1)}% / break ${(trainBase.breakPct * 100).toFixed(1)}% / flat ${(trainBase.flatPct * 100).toFixed(1)}%\n`;
    report += `Test baseline:  bounce ${(testBase.bouncePct * 100).toFixed(1)}% / break ${(testBase.breakPct * 100).toFixed(1)}% / flat ${(testBase.flatPct * 100).toFixed(1)}%\n\n`;

    report += `### Univariate survivors (${survivors.length})\n\n`;
    if (survivors.length === 0) {
      report += `_No survivors with retention ≥ ${EDGE_RETENTION * 100}%._\n\n`;
    } else {
      report += `| Feature | Bucket | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | retention | signal |\n`;
      report += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
      for (const s of survivors.slice(0, 25)) {
        const dominant = Math.abs(s.edge_tr_b) >= Math.abs(s.edge_tr_k) ? 'b' : 'k';
        const edgeTr = dominant === 'b' ? s.edge_tr_b : s.edge_tr_k;
        const edgeTe = dominant === 'b' ? s.edge_te_b : s.edge_te_k;
        const ret = dominant === 'b' ? s.retention_b : s.retention_k;
        report += `| ${s.feature} | ${s.bucket} | ${s.n_train} | ${s.n_test} | ${s.bouncePct_tr} | ${s.bouncePct_te} | ${s.breakPct_tr} | ${s.breakPct_te} | ${edgeTr >= 0 ? "+" : ""}${edgeTr}pp | ${edgeTe >= 0 ? "+" : ""}${edgeTe}pp | ${ret}x | ${s.signal} |\n`;
      }
      report += `\n`;
    }

    // Bivariate on top features (only for 4h horizon)
    if (h === "outcome4h" && survivors.length > 0) {
      const topFeats = [...new Set(survivors.slice(0, 20).map(s => s.feature))].slice(0, 10);
      if (topFeats.length >= 2) {
        const bi = validateBivariate(train, test, h, topFeats);
        report += `### Bivariate survivors (${bi.length}) — using features: ${topFeats.join(", ")}\n\n`;
        if (bi.length === 0) {
          report += `_No bivariate survivors._\n\n`;
        } else {
          report += `| Feat1 | B1 | Feat2 | B2 | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | signal |\n`;
          report += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
          for (const s of bi.slice(0, 20)) {
            const dom = Math.abs(s.edge_tr_b) >= Math.abs(s.edge_tr_k) ? 'b' : 'k';
            const edgeTr = dom === 'b' ? s.edge_tr_b : s.edge_tr_k;
            const edgeTe = dom === 'b' ? s.edge_te_b : s.edge_te_k;
            report += `| ${s.f1} | ${s.b1} | ${s.f2} | ${s.b2} | ${s.n_train} | ${s.n_test} | ${s.bouncePct_tr} | ${s.bouncePct_te} | ${s.breakPct_tr} | ${s.breakPct_te} | ${edgeTr >= 0 ? "+" : ""}${edgeTr}pp | ${edgeTe >= 0 ? "+" : ""}${edgeTe}pp | ${s.signal} |\n`;
          }
          report += `\n`;
        }
      }
    }
  }

  fs.writeFileSync(OUT_FILE, report);
  console.log(`\nWritten: ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
}

main();
