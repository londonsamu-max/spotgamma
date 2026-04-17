/**
 * Historical Flow Downloader v2 — hourly chunking, no cap, JSONL streaming.
 *
 * Splits each trading day into hourly buckets (12:00-22:00 UTC) and paginates
 * each independently. Writes trades as JSONL (one per line) using a write stream
 * — this avoids Node's ~500MB string limit that breaks JSON.stringify on mega-days
 * (e.g. FOMC days with 4-5M trades).
 *
 * Output: data/historical/flow/{YYYY-MM-DD}.jsonl
 *   — one trade per line: {"sym":"SPX","ts":...,...}
 *   — last line is metadata: {"__meta":true,"count":N,"buckets":[...],"elapsedSec":...}
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { decode } = require("@msgpack/msgpack");

const FLOW_DIR = path.resolve(__dirname, "../data/historical/flow");
const TOKEN_FILE = path.resolve(__dirname, "../.sg_token");
const API = "https://api.stream.spotgamma.com";

const SYMBOLS = ["SPX", "QQQ", "SPY", "GLD", "DIA", "VIX"];
const BATCH_SIZE = 1000;
const DELAY_MS = 250;
const HOUR_START = 12; // 12:00 UTC = pre-market
const HOUR_END = 22;   // 22:00 UTC = after-hours
const REQUEST_TIMEOUT = 60000;
const MAX_RETRIES = 3;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getToken() {
  return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
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

function parseTrade(item) {
  if (!Array.isArray(item)) return null;
  const flags = Number(item[17]) || 0;
  const isPut = (flags & 1) === 1;
  const price = Number(item[12]) || 0;
  const bid = Number(item[13]) || 0;
  const ask = Number(item[14]) || 0;
  let buySell = "UNK";
  if (price >= ask) buySell = "BUY";
  else if (price <= bid) buySell = "SELL";
  else buySell = price > (bid + ask) / 2 ? "BUY" : "SELL";
  return {
    sym: String(item[0]),
    ts: Number(item[1]),
    delta: Number(item[2]) || 0,
    gamma: Number(item[3]) || 0,
    strike: Number(item[8]) || 0,
    size: Number(item[9]) || 0,
    side: buySell,
    price,
    bid,
    ask,
    iv: Number(item[15]) || 0,
    prevOI: Number(item[16]) || 0,
    premium: Number(item[19]) || 0,
    cp: isPut ? "P" : "C",
    exp: Number(item[7]) || 0,
  };
}

/**
 * Fetch one hour bucket with pagination.
 * Calls onTrade(trade) for each trade as it arrives (streaming — no array held).
 * Returns count.
 */
async function fetchBucket(date, hourStart, hourEnd, token, onTrade) {
  const fromTs = new Date(`${date}T${String(hourStart).padStart(2, "0")}:00:00Z`).getTime();
  const toTs = new Date(`${date}T${String(hourEnd).padStart(2, "0")}:00:00Z`).getTime();
  const filters = JSON.stringify([
    { field: "underlying", operator: "isAnyOf", value: SYMBOLS },
    { field: "ts", operator: ">=", value: fromTs },
    { field: "ts", operator: "<", value: toTs },
  ]);
  const sorting = JSON.stringify([{ field: "ts", direction: "asc" }]);

  let count = 0;
  let offset = 0;
  let retries = 0;

  while (true) {
    const url = `${API}/sg/tns_feed?filters=${encodeURIComponent(filters)}&sorting=${encodeURIComponent(sorting)}&limit=${BATCH_SIZE}&offset=${offset}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/msgpack",
          Origin: "https://dashboard.spotgamma.com",
        },
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (resp.status === 429) {
        console.log(`    ${date} ${hourStart}h offset=${offset}: 429, waiting 15s`);
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      if (resp.status !== 200) {
        if (retries < MAX_RETRIES) {
          retries++;
          console.log(`    ${date} ${hourStart}h offset=${offset}: HTTP ${resp.status}, retry ${retries}/${MAX_RETRIES}`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new Error(`HTTP ${resp.status} after ${MAX_RETRIES} retries`);
      }

      const buf = await resp.arrayBuffer();
      const raw = decode(new Uint8Array(buf));
      if (!Array.isArray(raw) || raw.length === 0) break;

      for (const item of raw) {
        const t = parseTrade(item);
        if (t) {
          onTrade(t);
          count++;
        }
      }

      if (raw.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
      retries = 0;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    } catch (e) {
      clearTimeout(tid);
      if (retries < MAX_RETRIES) {
        retries++;
        console.log(`    ${date} ${hourStart}h offset=${offset}: ${e.message}, retry ${retries}/${MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }

  return count;
}

function dayIsComplete(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 50) return false;
    const buf = fs.readFileSync(filePath);
    const decompressed = zlib.gunzipSync(buf).toString("utf-8");
    const lastLines = decompressed.trim().split("\n").slice(-3).join("\n");
    return lastLines.includes('"__meta":true');
  } catch {
    return false;
  }
}

function dayBeingWritten(filePath) {
  // Returns true if file exists, is incomplete, AND was modified in last 120s
  // (another parallel process is actively writing it).
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < 120000;
  } catch {
    return false;
  }
}

async function downloadDay(date, token) {
  ensureDir(FLOW_DIR);
  const filePath = path.join(FLOW_DIR, date + ".jsonl.gz");
  if (dayIsComplete(filePath)) {
    return { date, status: "skip" };
  }
  if (dayBeingWritten(filePath)) {
    return { date, status: "skip-concurrent" };
  }

  // Overwrite if partial. Pipe: gzip → file
  const fileStream = fs.createWriteStream(filePath, { flags: "w" });
  const gzipStream = zlib.createGzip({ level: 6 });
  gzipStream.pipe(fileStream);
  const writeLine = (obj) => gzipStream.write(JSON.stringify(obj) + "\n");

  const bucketCounts = [];
  const t0 = Date.now();
  let totalCount = 0;

  try {
    for (let h = HOUR_START; h < HOUR_END; h++) {
      const tBucket = Date.now();
      const n = await fetchBucket(date, h, h + 1, token, writeLine);
      totalCount += n;
      const secs = ((Date.now() - tBucket) / 1000).toFixed(1);
      bucketCounts.push(`${h}h:${n}`);
      process.stdout.write(`  ${date} ${h}h: ${n} (${secs}s, total ${totalCount})\n`);
    }
  } catch (e) {
    gzipStream.end();
    return { date, status: "fail", count: totalCount, error: e.message };
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  // Write metadata as last line
  writeLine({ __meta: true, count: totalCount, buckets: bucketCounts, elapsedSec });
  await new Promise((resolve) => {
    gzipStream.end(() => {
      fileStream.on("close", resolve);
    });
  });

  return { date, status: totalCount === 0 ? "empty" : "ok", count: totalCount, elapsedSec };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const startDate = args[0] || "2024-11-01";
  const endDate = args[1] || "2026-04-13";
  const reverse = flags.includes("--reverse");
  const token = getToken();
  let days = getTradingDays(startDate, endDate);
  if (reverse) days = days.reverse();
  console.log(`v2 Downloading flow: ${days.length} days (${startDate} → ${endDate})${reverse ? " [REVERSE]" : ""}`);
  console.log(`Hourly buckets ${HOUR_START}-${HOUR_END} UTC, no cap, JSONL stream.`);

  let downloaded = 0, skipped = 0, empty = 0, failed = 0, skipConcurrent = 0;
  for (let i = 0; i < days.length; i++) {
    const result = await downloadDay(days[i], token);
    const prefix = `[${i + 1}/${days.length}] ${result.date}`;
    if (result.status === "ok") {
      downloaded++;
      console.log(`${prefix}: ${result.count} trades in ${result.elapsedSec}s`);
    } else if (result.status === "skip") {
      skipped++;
    } else if (result.status === "skip-concurrent") {
      skipConcurrent++;
    } else if (result.status === "empty") {
      empty++;
      console.log(`${prefix}: empty`);
    } else {
      failed++;
      console.log(`${prefix}: FAILED after ${result.count}`);
    }
    if (result.status !== "skip" && result.status !== "skip-concurrent") {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.log(`\nDone: ${downloaded} ok, ${skipped} skip, ${skipConcurrent} skip-concurrent, ${empty} empty, ${failed} fail`);
}

main().catch((e) => { console.error(e); process.exit(1); });
