#!/usr/bin/env node
/**
 * Discovery v4 — tests spreads + dealer + intraday features
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "data", "backtest-v2", "events-enriched-v4.jsonl");
const OUT_FILE = path.join(ROOT, "data", "backtest-v2", "discoveries-v4-full.md");

const SPLIT_DATE = "2025-10-01";
const MIN_N_UNI = 80;
const MIN_N_BI = 50;
const MIN_EDGE = 5;

// NEW feature buckets (spreads + dealer + intraday)
const NEW_BUCKETS = {
  // Spreads
  spreads_inst_count: { type: "numeric", breaks: [1, 5, 15, 50] },
  spreads_straddle_count: { type: "numeric", breaks: [1, 5, 15] },
  spreads_bias: { type: "numeric", breaks: [-0.5, -0.2, 0.2, 0.5] },
  spreads_largest_prem: { type: "numeric", breaks: [100000, 500000, 2000000] },
  // Dealer positioning
  dealer_calls_net: { type: "numeric", breaks: [-500, -50, 50, 500] },
  dealer_puts_net: { type: "numeric", breaks: [-500, -50, 50, 500] },
  dealer_delta_exposure: { type: "numeric", breaks: [-5000, -500, 500, 5000] },
  dealer_gamma_exposure: { type: "numeric", breaks: [-50, -5, 5, 50] },
  dealer_pos_type: "cat",
  // Intraday
  intra_opening_bias: { type: "numeric", breaks: [-0.3, -0.1, 0.1, 0.3] },
  intra_closing_bias: { type: "numeric", breaks: [-0.3, -0.1, 0.1, 0.3] },
  intra_com_migration_pct: { type: "numeric", breaks: [-0.01, -0.003, 0.003, 0.01] },
  intra_entropy_at_touch: { type: "numeric", breaks: [0.3, 0.5, 0.7, 0.9] },
  intra_bullBear_bias_at_touch: { type: "numeric", breaks: [-0.5, -0.2, 0.2, 0.5] },
  intra_burst_count: { type: "numeric", breaks: [1, 3, 7] },
};

// Context features for bivariate
const CTX_BUCKETS = {
  vixBucket: "cat",
  sym: "cat",
  approach: "cat",
  minuteBucket: "cat",
  hiro_consensus: "cat",
  flow_strikeShareOfDay: { type: "numeric", breaks: [0.001, 0.01, 0.05] },
  priceRelToOpenPct: { type: "numeric", breaks: [-0.01, -0.003, 0.003, 0.01] },
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

function oosCheck(events, horizon, filterFn) {
  const trAll = events.filter(e => e.date < SPLIT_DATE);
  const teAll = events.filter(e => e.date >= SPLIT_DATE);
  const train = trAll.filter(filterFn);
  const test = teAll.filter(filterFn);
  const trB = rates(trAll, horizon);
  const teB = rates(teAll, horizon);
  const tr = rates(train, horizon);
  const te = rates(test, horizon);
  return {
    n_tr: tr.n, n_te: te.n,
    eb_tr: +((tr.bouncePct - trB.bouncePct) * 100).toFixed(1),
    eb_te: +((te.bouncePct - teB.bouncePct) * 100).toFixed(1),
    ek_tr: +((tr.breakPct - trB.breakPct) * 100).toFixed(1),
    ek_te: +((te.breakPct - teB.breakPct) * 100).toFixed(1),
  };
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

function bivariate(events, horizon, feats1, feats2, buckets, minN) {
  const base = rates(events, horizon);
  const pairs = [];
  for (const f1 of feats1) {
    for (const f2 of feats2) {
      if (f1 === f2) continue;
      const d1 = buckets[f1], d2 = buckets[f2];
      if (!d1 || !d2) continue;
      const byBkt = {};
      for (const e of events) {
        const k1 = bucketize(e[f1], d1), k2 = bucketize(e[f2], d2);
        if (k1 === "null" || k2 === "null") continue;
        (byBkt[`${k1}__${k2}`] ||= []).push(e);
      }
      for (const [k, evs] of Object.entries(byBkt)) {
        if (evs.length < minN) continue;
        const r = rates(evs, horizon);
        const eb = (r.bouncePct - base.bouncePct) * 100;
        const ek = (r.breakPct - base.breakPct) * 100;
        if (Math.max(Math.abs(eb), Math.abs(ek)) >= MIN_EDGE + 1) {
          const [b1, b2] = k.split("__");
          pairs.push({ f1, b1, f2, b2, n: r.n,
            bouncePct: (r.bouncePct * 100).toFixed(1),
            breakPct: (r.breakPct * 100).toFixed(1),
            eb: +eb.toFixed(1), ek: +ek.toFixed(1) });
        }
      }
    }
  }
  pairs.sort((a, b) => Math.max(Math.abs(b.eb), Math.abs(b.ek)) - Math.max(Math.abs(a.eb), Math.abs(a.ek)));
  return pairs;
}

function main() {
  const all = fs.readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  console.log(`Total: ${all.length}`);

  let md = `# Discovery v4 — Spreads + Dealer + Intraday features\n\n`;
  md += `**Events:** ${all.length}\n`;
  md += `**Min N univariate:** ${MIN_N_UNI} | **bivariate:** ${MIN_N_BI}\n\n`;

  for (const h of ["outcome1h", "outcome4h", "outcomeEod"]) {
    const { base, disc } = univariate(all, h, NEW_BUCKETS, MIN_N_UNI);
    md += `\n## Horizon: ${h}\n\n`;
    md += `Baseline: bounce ${(base.bouncePct*100).toFixed(1)}% / break ${(base.breakPct*100).toFixed(1)}% (N=${base.n})\n\n`;

    md += `### Univariate top 20 (spreads/dealer/intraday)\n\n`;
    md += `| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS |\n`;
    md += `|---|---|---|---|---|---|---|---|---|\n`;
    for (const d of disc.slice(0, 20)) {
      const def = NEW_BUCKETS[d.feat];
      const oos = oosCheck(all, h, (e) => bucketize(e[d.feat], def) === d.bucket);
      const dom = Math.abs(d.eb) > Math.abs(d.ek) ? "b" : "k";
      const tr = dom === "b" ? oos.eb_tr : oos.ek_tr;
      const te = dom === "b" ? oos.eb_te : oos.ek_te;
      const sameSign = tr * te > 0;
      const mag = tr !== 0 ? +(te / tr).toFixed(2) : 0;
      const ret = sameSign && Math.abs(te) >= 0.5 * Math.abs(tr) ? `✓ ${mag}x (Nte=${oos.n_te})` : `weak ${mag}x`;
      md += `| ${d.feat} | ${d.bucket} | ${d.n} | ${d.bouncePct} | ${d.breakPct} | ${d.eb>=0?'+':''}${d.eb}pp | ${d.ek>=0?'+':''}${d.ek}pp | ${d.signal} | ${ret} |\n`;
    }

    if (h === "outcome4h") {
      md += `\n### Bivariate NEW × Context (top 25)\n\n`;
      const topNew = [...new Set(disc.slice(0, 10).map(d => d.feat))];
      const mergedBuckets = { ...NEW_BUCKETS, ...CTX_BUCKETS };
      const pairs = bivariate(all, h, topNew, Object.keys(CTX_BUCKETS), mergedBuckets, MIN_N_BI);
      md += `| F1 | B1 | F2 | B2 | N | b% | br% | eb | ek | OOS |\n`;
      md += `|---|---|---|---|---|---|---|---|---|---|\n`;
      for (const p of pairs.slice(0, 25)) {
        const d1 = mergedBuckets[p.f1], d2 = mergedBuckets[p.f2];
        const oos = oosCheck(all, h, (e) => bucketize(e[p.f1], d1) === p.b1 && bucketize(e[p.f2], d2) === p.b2);
        const dom = Math.abs(p.eb) > Math.abs(p.ek) ? "b" : "k";
        const tr = dom === "b" ? oos.eb_tr : oos.ek_tr;
        const te = dom === "b" ? oos.eb_te : oos.ek_te;
        const sameSign = tr * te > 0;
        const mag = tr !== 0 ? +(te / tr).toFixed(2) : 0;
        const ret = sameSign && Math.abs(te) >= 0.5 * Math.abs(tr) ? `✓ ${mag}x Nte=${oos.n_te}` : `weak ${mag}x Nte=${oos.n_te}`;
        md += `| ${p.f1} | ${p.b1} | ${p.f2} | ${p.b2} | ${p.n} | ${p.bouncePct} | ${p.breakPct} | ${p.eb>=0?'+':''}${p.eb}pp | ${p.ek>=0?'+':''}${p.ek}pp | ${ret} |\n`;
      }
    }
  }

  fs.writeFileSync(OUT_FILE, md);
  console.log(`Report: ${OUT_FILE}`);
}

main();
