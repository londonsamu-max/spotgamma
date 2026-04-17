/**
 * Download 0DTE TRACE historical data from SpotGamma.
 *
 * Endpoints:
 *   /v2/open_interest/intraday_timestamps?symbol=SPX&greek=gamma&date=YYYY-MM-DD&mkt_actor=mm
 *   /v2/open_interest/intraday_gamma?symbol=SPX&date=YYYY-MM-DD&ts=ISO&mkt_actor=mm
 *
 * Data format: Parquet (ZSTD compressed)
 * Schema: [time, strike, timestamp, gamma] — ~10K rows per timestamp
 *
 * Strategy:
 *   1. For each date, get list of timestamps (508 per day, every ~2min)
 *   2. Sample every 5th timestamp (~100 per day) to keep download manageable
 *   3. For each sampled timestamp, download the parquet file
 *   4. Decode and save as compact JSON per day
 *
 * Lenses: mm (market makers), cust (customers), procust, firm, bd (broker-dealers)
 *
 * Output: data/historical/trace-0dte/{date}_{lens}.json
 *
 * Usage: node server/download-0dte-trace.cjs [startDate] [endDate] [--lens mm]
 */

const fs = require("fs");
const path = require("path");

const API = "https://api.stream.spotgamma.com";
const TOKEN_FILE = path.resolve(__dirname, "../.sg_token");
const OUT_DIR = path.resolve(__dirname, "../data/historical/trace-0dte");
const DELAY_MS = 300;
const SAMPLE_EVERY = 5; // take every 5th timestamp (~100/day instead of 508)

function getToken() {
  return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTradingDays(startDate, endDate) {
  const days = [];
  const cur = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

async function getTimestamps(date, lens, token) {
  const url = `${API}/v2/open_interest/intraday_timestamps?symbol=SPX&greek=gamma&date=${date}&mkt_actor=${lens}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Origin: "https://dashboard.spotgamma.com" },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status !== 200) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function getGammaParquet(date, ts, lens, token) {
  const url = `${API}/v2/open_interest/intraday_gamma?symbol=SPX&date=${date}&ts=${encodeURIComponent(ts)}&mkt_actor=${lens}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Origin: "https://dashboard.spotgamma.com" },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status !== 200) return null;
  return Buffer.from(await r.arrayBuffer());
}

// Minimal parquet reader for this specific schema (time, strike, timestamp, gamma)
// Uses the raw column data without full parquet library dependency
// The data is ZSTD compressed — we'll save raw parquet and decode with bun later
// OR: save the raw bytes per timestamp for batch processing

async function downloadDay(date, lens, token) {
  const outFile = path.join(OUT_DIR, `${date}_${lens}.json`);
  if (fs.existsSync(outFile)) {
    const size = fs.statSync(outFile).size;
    if (size > 1000) return { date, status: "skip" };
  }

  // Get timestamps
  const timestamps = await getTimestamps(date, lens, token);
  if (timestamps.length === 0) return { date, status: "empty" };

  // Sample every Nth
  const sampled = timestamps.filter((_, i) => i % SAMPLE_EVERY === 0);

  // Save raw parquet files to temp for batch decoding
  const parquetDir = path.join(OUT_DIR, ".parquet-tmp", date + "_" + lens);
  ensureDir(parquetDir);

  let downloaded = 0;
  for (let i = 0; i < sampled.length; i++) {
    const ts = sampled[i];
    const tsFile = path.join(parquetDir, `${i}.parquet`);
    if (fs.existsSync(tsFile)) { downloaded++; continue; }

    const buf = await getGammaParquet(date, ts, lens, token);
    if (buf) {
      fs.writeFileSync(tsFile, buf);
      downloaded++;
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Write metadata
  fs.writeFileSync(
    path.join(parquetDir, "_meta.json"),
    JSON.stringify({ date, lens, totalTs: timestamps.length, sampled: sampled.length, downloaded, timestamps: sampled })
  );

  return { date, status: "ok", timestamps: timestamps.length, sampled: sampled.length, downloaded };
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter(a => a.startsWith("--"));
  const startDate = args[0] || "2024-05-01";
  const endDate = args[1] || "2026-04-15";
  const lens = flags.find(f => f.startsWith("--lens="))?.split("=")[1] || "mm";
  const token = getToken();

  const days = getTradingDays(startDate, endDate);
  console.log(`Downloading 0DTE TRACE: ${days.length} days, lens=${lens}`);
  console.log(`Sampling every ${SAMPLE_EVERY}th timestamp (~100/day)`);
  ensureDir(OUT_DIR);

  let ok = 0, skip = 0, empty = 0, fail = 0;
  for (let i = 0; i < days.length; i++) {
    const result = await downloadDay(days[i], lens, token);
    const prefix = `[${i + 1}/${days.length}] ${result.date}`;
    if (result.status === "ok") {
      ok++;
      console.log(`${prefix}: ${result.sampled} parquets (of ${result.timestamps} timestamps)`);
    } else if (result.status === "skip") {
      skip++;
    } else if (result.status === "empty") {
      empty++;
    } else {
      fail++;
      console.log(`${prefix}: FAILED`);
    }
    if (result.status !== "skip") await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone: ${ok} ok, ${skip} skip, ${empty} empty, ${fail} fail`);
  console.log(`Parquet files saved to ${OUT_DIR}/.parquet-tmp/`);
  console.log(`Next step: run decode-trace-parquet.mjs to convert parquets to JSON`);
}

main().catch(e => { console.error(e); process.exit(1); });
