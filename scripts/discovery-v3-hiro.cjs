#!/usr/bin/env node
/**
 * Discovery v3 — HIRO features + multi-factor combos
 *
 * Reads: events-enriched-v3.jsonl
 * Tests univariate + bivariate on HIRO features, plus HIRO × flow combos.
 * Only events with hiro_available=true.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v3.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "discoveries-v3-hiro.md");

const SPLIT_DATE = "2025-10-01";
const MIN_N_UNI = 80;
const MIN_N_BI = 50;
const MIN_EDGE = 5;

const HIRO_BUCKETS = {
  hiro_spx_pctl: { type: "numeric", breaks: [-70, -30, 0, 30, 70] },
  hiro_qqq_pctl: { type: "numeric", breaks: [-70, -30, 0, 30, 70] },
  hiro_spy_pctl: { type: "numeric", breaks: [-70, -30, 0, 30, 70] },
  hiro_dia_pctl: { type: "numeric", breaks: [-70, -30, 0, 30, 70] },
  hiro_gld_pctl: { type: "numeric", breaks: [-70, -30, 0, 30, 70] },
  hiro_spx_delta_1h: { type: "numeric", breaks: [-30, -10, 10, 30] },
  hiro_qqq_delta_1h: { type: "numeric", breaks: [-30, -10, 10, 30] },
  hiro_avg_pctl: { type: "numeric", breaks: [-50, -20, 0, 20, 50] },
  hiro_consensus: "cat",
  hiro_extreme_count: { type: "numeric", breaks: [1, 2, 3] },
};

// Context buckets (for bivariate)
const CTX_BUCKETS = {
  vixBucket: "cat",
  sym: "cat",
  approach: "cat",
  minuteBucket: "cat",
  flow_strikeShareOfDay: { type: "numeric", breaks: [0.001, 0.01, 0.05] },
  priceRelToOpenPct: { type: "numeric", breaks: [-0.01, -0.003, 0.003, 0.01] },
  distSpotToStrikePct: { type: "numeric", breaks: [-0.03, -0.01, 0.01, 0.03] },
};

function bucketize(value, def) {
  if (value == null) return "null";
  if (def === "cat") return String(value);
  const breaks = def.breaks;
  if (value < breaks[0]) return `<${breaks[0]}`;
  for (let i = 0; i < breaks.length - 1; i++) {
    if (value >= breaks[i] && value < breaks[i + 1]) return `[${breaks[i]},${breaks[i + 1]})`;
  }
  return `>=${breaks[breaks.length - 1]}`;
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
  const base = rates(events, horizon);
  const disc = [];
  for (const [feat, def] of Object.entries(buckets)) {
    const byBkt = {};
    for (const e of events) {
      const k = bucketize(e[feat], def);
      if (k === "null") continue;
      (byBkt[k] ||= []).push(e);
    }
    for (const [k, evs] of Object.entries(byBkt)) {
      if (evs.length < minN) continue;
      const r = rates(evs, horizon);
      const eb = (r.bouncePct - base.bouncePct) * 100;
      const ek = (r.breakPct - base.breakPct) * 100;
      if (Math.max(Math.abs(eb), Math.abs(ek)) >= MIN_EDGE) {
        disc.push({
          feat, bucket: k, n: r.n,
          bouncePct: (r.bouncePct * 100).toFixed(1),
          breakPct: (r.breakPct * 100).toFixed(1),
          eb: +eb.toFixed(1), ek: +ek.toFixed(1),
          signal: Math.abs(eb) > Math.abs(ek) ? (eb > 0 ? "BOUNCE+" : "BOUNCE-") : (ek > 0 ? "BREAK+" : "BREAK-"),
        });
      }
    }
  }
  disc.sort((a, b) => Math.max(Math.abs(b.eb), Math.abs(b.ek)) - Math.max(Math.abs(a.eb), Math.abs(a.ek)));
  return { base, disc };
}

function bivariate(events, horizon, feats1, feats2, minN) {
  const base = rates(events, horizon);
  const pairs = [];
  for (const f1 of feats1) {
    for (const f2 of feats2) {
      if (f1 === f2) continue;
      const d1 = HIRO_BUCKETS[f1] || CTX_BUCKETS[f1];
      const d2 = HIRO_BUCKETS[f2] || CTX_BUCKETS[f2];
      if (!d1 || !d2) continue;
      const byBkt = {};
      for (const e of events) {
        const k1 = bucketize(e[f1], d1), k2 = bucketize(e[f2], d2);
        if (k1 === "null" || k2 === "null") continue;
        const k = `${k1}__${k2}`;
        (byBkt[k] ||= []).push(e);
      }
      for (const [k, evs] of Object.entries(byBkt)) {
        if (evs.length < minN) continue;
        const r = rates(evs, horizon);
        const eb = (r.bouncePct - base.bouncePct) * 100;
        const ek = (r.breakPct - base.breakPct) * 100;
        if (Math.max(Math.abs(eb), Math.abs(ek)) >= MIN_EDGE + 1) {
          const [b1, b2] = k.split("__");
          pairs.push({
            f1, b1, f2, b2, n: r.n,
            bouncePct: (r.bouncePct * 100).toFixed(1),
            breakPct: (r.breakPct * 100).toFixed(1),
            eb: +eb.toFixed(1), ek: +ek.toFixed(1),
          });
        }
      }
    }
  }
  pairs.sort((a, b) => Math.max(Math.abs(b.eb), Math.abs(b.ek)) - Math.max(Math.abs(a.eb), Math.abs(a.ek)));
  return pairs;
}

function oosCheck(events, horizon, filterFn) {
  const train = events.filter(e => e.date < SPLIT_DATE && filterFn(e));
  const test = events.filter(e => e.date >= SPLIT_DATE && filterFn(e));
  const trainBase = rates(events.filter(e => e.date < SPLIT_DATE), horizon);
  const testBase = rates(events.filter(e => e.date >= SPLIT_DATE), horizon);
  const tr = rates(train, horizon);
  const te = rates(test, horizon);
  return {
    n_tr: tr.n, n_te: te.n,
    eb_tr: +((tr.bouncePct - trainBase.bouncePct) * 100).toFixed(1),
    eb_te: +((te.bouncePct - testBase.bouncePct) * 100).toFixed(1),
    ek_tr: +((tr.breakPct - trainBase.breakPct) * 100).toFixed(1),
    ek_te: +((te.breakPct - testBase.breakPct) * 100).toFixed(1),
  };
}

function main() {
  const all = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const withHiro = all.filter(e => e.hiro_available);

  console.log(`Total: ${all.length} | With HIRO: ${withHiro.length}`);

  let md = `# Discovery v3 — HIRO Features\n\n`;
  md += `**Events with HIRO data:** ${withHiro.length}/${all.length}\n`;
  md += `**Split:** train <${SPLIT_DATE}, test >=${SPLIT_DATE}\n\n`;

  for (const h of ["outcome1h", "outcome4h", "outcomeEod"]) {
    const { base, disc } = univariate(withHiro, h, HIRO_BUCKETS, MIN_N_UNI);
    md += `\n## Horizon: ${h}\n\n`;
    md += `Baseline: bounce ${(base.bouncePct*100).toFixed(1)}% / break ${(base.breakPct*100).toFixed(1)}% (N=${base.n})\n\n`;

    md += `### HIRO univariate top 20\n\n`;
    md += `| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS retention |\n`;
    md += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const d of disc.slice(0, 20)) {
      const def = HIRO_BUCKETS[d.feat];
      const oos = oosCheck(withHiro, h, (e) => bucketize(e[d.feat], def) === d.bucket);
      const dom = Math.abs(d.eb) > Math.abs(d.ek) ? "b" : "k";
      const edTr = dom === "b" ? oos.eb_tr : oos.ek_tr;
      const edTe = dom === "b" ? oos.eb_te : oos.ek_te;
      const sameSign = edTr * edTe > 0;
      const mag = edTr !== 0 ? +(edTe / edTr).toFixed(2) : 0;
      const ret = sameSign && Math.abs(edTe) >= 0.5 * Math.abs(edTr) ? `✓ ${mag}x (Ntr=${oos.n_tr}/Nte=${oos.n_te})` : `weak ${mag}x`;
      md += `| ${d.feat} | ${d.bucket} | ${d.n} | ${d.bouncePct} | ${d.breakPct} | ${d.eb>=0?'+':''}${d.eb}pp | ${d.ek>=0?'+':''}${d.ek}pp | ${d.signal} | ${ret} |\n`;
    }

    if (h === "outcome4h") {
      md += `\n### Bivariate HIRO × Context (top 30)\n\n`;
      const topHiro = [...new Set(disc.slice(0, 10).map(d => d.feat))];
      const ctxFeats = Object.keys(CTX_BUCKETS);
      const pairs = bivariate(withHiro, h, topHiro, ctxFeats, MIN_N_BI);
      md += `| F1 | B1 | F2 | B2 | N | b% | br% | eb | ek | OOS |\n`;
      md += `|---|---|---|---|---|---|---|---|---|---|\n`;
      for (const p of pairs.slice(0, 30)) {
        const d1 = HIRO_BUCKETS[p.f1], d2 = CTX_BUCKETS[p.f2];
        const oos = oosCheck(withHiro, h, (e) => bucketize(e[p.f1], d1) === p.b1 && bucketize(e[p.f2], d2) === p.b2);
        const dom = Math.abs(p.eb) > Math.abs(p.ek) ? "b" : "k";
        const edTr = dom === "b" ? oos.eb_tr : oos.ek_tr;
        const edTe = dom === "b" ? oos.eb_te : oos.ek_te;
        const sameSign = edTr * edTe > 0;
        const mag = edTr !== 0 ? +(edTe / edTr).toFixed(2) : 0;
        const ret = sameSign && Math.abs(edTe) >= 0.5 * Math.abs(edTr) ? `✓ ${mag}x Nte=${oos.n_te}` : `weak ${mag}x Nte=${oos.n_te}`;
        md += `| ${p.f1} | ${p.b1} | ${p.f2} | ${p.b2} | ${p.n} | ${p.bouncePct} | ${p.breakPct} | ${p.eb>=0?'+':''}${p.eb}pp | ${p.ek>=0?'+':''}${p.ek}pp | ${ret} |\n`;
      }
    }
  }

  fs.writeFileSync(OUT_FILE, md);
  console.log(`\nReport: ${OUT_FILE}`);
}

main();
