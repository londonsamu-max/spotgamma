/**
 * Historical Flow Downloader v3 — hourly chunking with CONCURRENT buckets per day.
 *
 * v2 = sequential 10 buckets per day.
 * v3 = 3 concurrent buckets per day. Mega-days (4M trades) drop from ~25 min → ~7 min.
 *
 * Strategy: each bucket writes to its own temp gzip file. After all buckets complete,
 * concat them in hour order (gzip supports multi-member streams) and append __meta.
 * Delete temp files.
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
const DELAY_MS = 75;
const HOUR_START = 12;
const HOUR_END = 22;
const REQUEST_TIMEOUT = 90000;
const MAX_RETRIES = 3;
const BUCKETS_CONCURRENT = 4;

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
 * Fetch one bucket and stream-write to a temp gzip file. Returns count written.
 */
async function fetchBucketToFile(date, hourStart, hourEnd, token, tmpPath) {
  const fromTs = new Date(`${date}T${String(hourStart).padStart(2, "0")}:00:00Z`).getTime();
  const toTs = new Date(`${date}T${String(hourEnd).padStart(2, "0")}:00:00Z`).getTime();
  const filters = JSON.stringify([
    { field: "underlying", operator: "isAnyOf", value: SYMBOLS },
    { field: "ts", operator: ">=", value: fromTs },
    { field: "ts", operator: "<", value: toTs },
  ]);
  const sorting = JSON.stringify([{ field: "ts", direction: "asc" }]);

  const fileStream = fs.createWriteStream(tmpPath, { flags: "w" });
  const gzipStream = zlib.createGzip({ level: 6 });
  gzipStream.pipe(fileStream);

  let count = 0;
  let offset = 0;
  let retries = 0;

  try {
    while (true) {
      const url = `${API}/sg/tns_feed?filters=${encodeURIComponent(filters)}&sorting=${encodeURIComponent(sorting)}&limit=${BATCH_SIZE}&offset=${offset}`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      try {
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${getToken()}`,  // re-read in case file rotated
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
        if (resp.status === 401) {
          // Token likely expired — wait and retry once to let user refresh
          console.log(`    ${date} ${hourStart}h offset=${offset}: 401, waiting 30s for token refresh`);
          await new Promise((r) => setTimeout(r, 30000));
          if (retries < MAX_RETRIES) {
            retries++;
            continue;
          }
          throw new Error(`HTTP 401 — token invalid`);
        }
        if (resp.status !== 200) {
          if (retries < MAX_RETRIES) {
            retries++;
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw new Error(`HTTP ${resp.status}`);
        }

        const buf = await resp.arrayBuffer();
        const raw = decode(new Uint8Array(buf));
        if (!Array.isArray(raw) || raw.length === 0) break;

        for (const item of raw) {
          const t = parseTrade(item);
          if (t) {
            gzipStream.write(JSON.stringify(t) + "\n");
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
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw e;
      }
    }
  } finally {
    await new Promise((resolve) => {
      gzipStream.end(() => fileStream.on("close", resolve));
    });
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
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < 120000;
  } catch {
    return false;
  }
}

/**
 * Run up to `concurrency` fetchers in parallel, return results in original order.
 */
async function runConcurrent(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIdx = 0;
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= tasks.length) break;
        results[idx] = await tasks[idx]();
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function downloadDay(date, token) {
  ensureDir(FLOW_DIR);
  const finalPath = path.join(FLOW_DIR, date + ".jsonl.gz");
  if (dayIsComplete(finalPath)) return { date, status: "skip" };
  if (dayBeingWritten(finalPath)) return { date, status: "skip-concurrent" };

  const tmpDir = path.join(FLOW_DIR, `.tmp-${date}-${process.pid}`);
  ensureDir(tmpDir);

  const hours = [];
  for (let h = HOUR_START; h < HOUR_END; h++) hours.push(h);

  const t0 = Date.now();
  const tmpPaths = hours.map((h) => path.join(tmpDir, `h${String(h).padStart(2, "0")}.jsonl.gz`));

  const tasks = hours.map((h, i) => async () => {
    const tBucket = Date.now();
    const n = await fetchBucketToFile(date, h, h + 1, token, tmpPaths[i]);
    const secs = ((Date.now() - tBucket) / 1000).toFixed(1);
    process.stdout.write(`  ${date} ${h}h: ${n} (${secs}s)\n`);
    return { h, n };
  });

  let counts;
  try {
    counts = await runConcurrent(tasks, BUCKETS_CONCURRENT);
  } catch (e) {
    // Cleanup tmp dir on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { date, status: "fail", error: e.message };
  }

  const totalCount = counts.reduce((s, c) => s + c.n, 0);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  const bucketCounts = counts.map((c) => `${c.h}h:${c.n}`);

  // Concat temp gzip files in hour order + append __meta as separate gzip member
  const finalStream = fs.createWriteStream(finalPath, { flags: "w" });
  try {
    for (const tmpPath of tmpPaths) {
      if (fs.existsSync(tmpPath)) {
        await new Promise((resolve, reject) => {
          const src = fs.createReadStream(tmpPath);
          src.on("end", resolve);
          src.on("error", reject);
          src.pipe(finalStream, { end: false });
        });
      }
    }
    // Append metadata as its own gzip member
    const metaGz = zlib.gzipSync(JSON.stringify({ __meta: true, count: totalCount, buckets: bucketCounts, elapsedSec }) + "\n");
    finalStream.write(metaGz);
    await new Promise((resolve) => finalStream.end(resolve));
  } catch (e) {
    try { fs.unlinkSync(finalPath); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { date, status: "fail", error: "concat: " + e.message };
  }

  // Cleanup temp
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

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
  console.log(`v3 Downloading flow: ${days.length} days (${startDate} → ${endDate})${reverse ? " [REVERSE]" : ""}`);
  console.log(`Concurrent buckets per day: ${BUCKETS_CONCURRENT}, delay ${DELAY_MS}ms.`);

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
      console.log(`${prefix}: FAILED ${result.error || ""}`);
    }
    if (result.status !== "skip" && result.status !== "skip-concurrent") {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.log(`\nDone: ${downloaded} ok, ${skipped} skip, ${skipConcurrent} concurrent-skip, ${empty} empty, ${failed} fail`);
}

main().catch((e) => { console.error(e); process.exit(1); });
