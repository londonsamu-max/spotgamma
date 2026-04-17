/**
 * Decode 0DTE TRACE parquet files into compact JSON.
 *
 * Reads .parquet files from data/historical/trace-0dte/.parquet-tmp/{date}_{lens}/
 * and produces one JSON per day: data/historical/trace-0dte/{date}_{lens}.json
 *
 * Each JSON contains:
 * {
 *   date, lens, timestamps: number,
 *   snapshots: [
 *     {
 *       ts: "ISO",
 *       spotPrice: number,
 *       maxGexStrike: number,     // strike with highest gamma (magnetic target)
 *       maxGexValue: number,      // gamma at that strike
 *       totalGamma: number,       // sum of all gamma
 *       callWallStrike: number,   // highest strike with significant gamma above spot
 *       putWallStrike: number,    // lowest strike with significant gamma below spot
 *       gammaFlip: number,        // strike where gamma crosses zero
 *       topStrikes: [             // top 10 by |gamma|
 *         { strike, gamma }
 *       ]
 *     }
 *   ]
 * }
 *
 * Usage: bun server/decode-trace-parquet.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 */

import { parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TRACE_DIR = resolve('data/historical/trace-0dte');
const TMP_DIR = join(TRACE_DIR, '.parquet-tmp');

function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--start') out.start = process.argv[++i];
    if (process.argv[i] === '--end') out.end = process.argv[++i];
  }
  return out;
}

async function decodeParquet(filePath) {
  const buf = readFileSync(filePath);
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];

  let result = null;
  await parquetRead({
    file: ab,
    compressors,
    onComplete: (data) => { result = data; },
  });
  return result;
}

async function processDay(dayDir, outFile) {
  if (existsSync(outFile) && statSync(outFile).size > 500) return 'skip';

  const metaFile = join(dayDir, '_meta.json');
  if (!existsSync(metaFile)) return 'no_meta';

  const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
  const parquetFiles = readdirSync(dayDir)
    .filter(f => f.endsWith('.parquet'))
    .sort((a, b) => parseInt(a) - parseInt(b));

  if (parquetFiles.length === 0) return 'empty';

  // Use actual timestamps from meta (the parquet internal timestamps are unreliable)
  const metaTimestamps = meta.timestamps || [];

  const snapshots = [];

  for (let fi = 0; fi < parquetFiles.length; fi++) {
    const pf = parquetFiles[fi];
    try {
      const filePath = join(dayDir, pf);
      let rows;
      try { rows = await decodeParquet(filePath); } catch(e) { continue; }
      if (!rows || rows.length === 0) { continue; }
      if (fi === 0) console.log('    DEBUG row[0]:', JSON.stringify(rows[0]).slice(0, 100), 'type:', typeof rows[0], Array.isArray(rows[0]) ? 'array' : 'obj');

      const strikes = [];
      const tsStr = metaTimestamps[fi] || null;

      for (const row of rows) {
        const strike = Number(row[1] ?? row?.strike);
        const gamma = Number(row[3] ?? row?.gamma);
        if (!isNaN(strike) && !isNaN(gamma)) strikes.push({ strike, gamma });
      }

      if (fi === 0) console.log('    DEBUG strikes:', strikes.length, 'tsStr:', tsStr);
      if (strikes.length === 0) continue;

      // Sort by strike
      strikes.sort((a, b) => a.strike - b.strike);

      // Compute aggregates
      const maxGex = strikes.reduce((best, s) =>
        Math.abs(s.gamma) > Math.abs(best.gamma) ? s : best
      );

      const totalGamma = strikes.reduce((sum, s) => sum + s.gamma, 0);

      // Top 10 by |gamma|
      const topStrikes = [...strikes]
        .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
        .slice(0, 10)
        .map(s => ({ strike: s.strike, gamma: Math.round(s.gamma) }));

      // Find gamma flip (zero crossing nearest to middle of range)
      let gammaFlip = null;
      for (let i = 1; i < strikes.length; i++) {
        if ((strikes[i - 1].gamma > 0 && strikes[i].gamma <= 0) ||
            (strikes[i - 1].gamma <= 0 && strikes[i].gamma > 0)) {
          gammaFlip = strikes[i].strike;
          break;
        }
      }

      // Spot price estimate: strike nearest to midpoint of positive gamma
      let spotPrice = null;
      const positiveGamma = strikes.filter(s => s.gamma > 0);
      if (positiveGamma.length > 0) {
        const weightedSum = positiveGamma.reduce((s, g) => s + g.strike * g.gamma, 0);
        const totalPos = positiveGamma.reduce((s, g) => s + g.gamma, 0);
        spotPrice = Math.round(weightedSum / totalPos);
      }

      // Call wall: highest strike with significant gamma above spot
      const aboveSpot = strikes.filter(s => spotPrice && s.strike > spotPrice && s.gamma > 0);
      const callWall = aboveSpot.length > 0
        ? aboveSpot.reduce((best, s) => s.gamma > best.gamma ? s : best).strike
        : null;

      // Put wall: lowest strike with significant gamma below spot
      const belowSpot = strikes.filter(s => spotPrice && s.strike < spotPrice && s.gamma > 0);
      const putWall = belowSpot.length > 0
        ? belowSpot.reduce((best, s) => s.gamma > best.gamma ? s : best).strike
        : null;

      snapshots.push({
        ts: tsStr,
        spotPrice,
        maxGexStrike: maxGex.strike,
        maxGexValue: Math.round(maxGex.gamma),
        totalGamma: Math.round(totalGamma),
        callWallStrike: callWall,
        putWallStrike: putWall,
        gammaFlip,
        topStrikes,
      });

    } catch (e) {
      if (fi === 0) console.log('    CATCH error:', e.message, e.stack?.split('\n')[1]);
      continue;
    }
  }

  if (snapshots.length === 0) {
    // Debug: try decode first parquet to check
    try {
      const testRows = await decodeParquet(join(dayDir, parquetFiles[0]));
      return 'decode_fail_0snap_' + parquetFiles.length + 'pq_testrows=' + (testRows?.length ?? 'null');
    } catch(e2) { return 'decode_fail_exception=' + e2.message; }
  }

  const output = {
    date: meta.date,
    lens: meta.lens,
    timestamps: snapshots.length,
    snapshots,
  };

  writeFileSync(outFile, JSON.stringify(output));
  return 'ok';
}

async function main() {
  const args = parseArgs();
  const dirs = readdirSync(TMP_DIR).filter(d => {
    if (!d.match(/^\d{4}-\d{2}-\d{2}_/)) return false;
    if (args.start && d.slice(0, 10) < args.start) return false;
    if (args.end && d.slice(0, 10) > args.end) return false;
    return true;
  }).sort();

  console.log(`Decoding ${dirs.length} day-lens directories...`);
  let ok = 0, skip = 0, empty = 0, fail = 0;

  for (let i = 0; i < dirs.length; i++) {
    const dayDir = join(TMP_DIR, dirs[i]);
    const outFile = join(TRACE_DIR, dirs[i] + '.json');
    const result = await processDay(dayDir, outFile);

    if (result === 'ok') {
      ok++;
      const size = (statSync(outFile).size / 1024).toFixed(0);
      if ((i + 1) % 10 === 0 || i === dirs.length - 1) {
        console.log(`  [${i + 1}/${dirs.length}] ${dirs[i]}: ${size}KB`);
      }
    } else if (result === 'skip') {
      skip++;
    } else {
      empty++;
      if (i < 3) console.log(`  [${i + 1}/${dirs.length}] ${dirs[i]}: ${result}`);
    }
  }

  console.log(`\nDone: ${ok} decoded, ${skip} skipped, ${empty} empty/failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
