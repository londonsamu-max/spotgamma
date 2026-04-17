/**
 * Download 1-min OHLC candles from SpotGamma twelve_series API.
 * Node port of scripts/download-1min-ohlc.py.
 * Iterates dates from data/historical/gamma-bars/ (covers all 8 symbols).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_DIR = path.resolve(__dirname, "..");
const GAMMA_BARS_DIR = path.join(BASE_DIR, "data", "historical", "gamma-bars");
const OHLC_DIR = path.join(BASE_DIR, "data", "historical", "ohlc-1min");
const TOKEN_FILE = path.join(BASE_DIR, ".sg_token");
const API_URL = "https://api.spotgamma.com/v1/twelve_series";

const SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA", "IWM", "UVIX"];
const RATE_LIMIT_DELAY = 200; // ms

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt() {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({}));
  const sig = crypto.createHmac("sha256", "secretKeyValue").update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

function loadToken() {
  return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
}

function headers() {
  return {
    "x-json-web-token": makeJwt(),
    Authorization: `Bearer ${loadToken()}`,
    Accept: "application/json",
  };
}

function loadDates() {
  if (!fs.existsSync(GAMMA_BARS_DIR)) return [];
  return fs
    .readdirSync(GAMMA_BARS_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

function outFile(symbol, date) {
  return path.join(OHLC_DIR, symbol, `${date}.json`);
}

function alreadyDownloaded(symbol, date) {
  const f = outFile(symbol, date);
  try {
    return fs.statSync(f).size > 10;
  } catch {
    return false;
  }
}

async function downloadDay(symbol, date) {
  const url = `${API_URL}?symbol=${symbol}&interval=1min&start_date=${date}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30000);
  try {
    let resp = await fetch(url, { headers: headers(), signal: controller.signal });
    if (resp.status === 429) {
      console.log("    Rate limited (429). Waiting 10s...");
      await new Promise((r) => setTimeout(r, 10000));
      resp = await fetch(url, { headers: headers(), signal: controller.signal });
    }
    clearTimeout(tid);
    if (resp.status !== 200) {
      const txt = await resp.text().catch(() => "");
      console.log(`    HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    let bars = [];
    if (data && typeof data === "object" && data[symbol]) {
      bars = data[symbol].values || [];
    } else if (data && data.values) {
      bars = data.values;
    } else if (Array.isArray(data)) {
      bars = data;
    } else {
      console.log(`    Unexpected structure: ${Object.keys(data || {}).join(",")}`);
      return null;
    }
    return bars.map((b) => ({
      t: b.datetime || b.t || b.timestamp,
      o: Number(b.open) || 0,
      h: Number(b.high) || 0,
      l: Number(b.low) || 0,
      c: Number(b.close) || 0,
      v: Number(b.volume) || 0,
    }));
  } catch (e) {
    clearTimeout(tid);
    console.log(`    Request error: ${e.message}`);
    return null;
  }
}

function saveBars(symbol, date, bars) {
  const dir = path.join(OHLC_DIR, symbol);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outFile(symbol, date), JSON.stringify(bars));
}

async function downloadSymbol(symbol, dates) {
  console.log(`\n${"=".repeat(60)}\n  ${symbol}\n${"=".repeat(60)}`);
  let downloaded = 0, skipped = 0, errors = 0;
  const total = dates.length;
  for (let i = 0; i < total; i++) {
    const date = dates[i];
    if (alreadyDownloaded(symbol, date)) {
      skipped++;
      continue;
    }
    const bars = await downloadDay(symbol, date);
    if (bars !== null) {
      saveBars(symbol, date, bars);
      downloaded++;
      console.log(`  ${symbol} ${date}: ${bars.length} bars (${i + 1}/${total})`);
    } else {
      errors++;
      console.log(`  ${symbol} ${date}: FAILED (${i + 1}/${total})`);
    }
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
  }
  console.log(`\n  ${symbol} summary: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors (of ${total})`);
}

async function main() {
  const args = process.argv.slice(2);
  let symbols = SYMBOLS;
  let maxDays = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols") {
      symbols = args[i + 1].split(",");
      i++;
    } else if (args[i] === "--max-days") {
      maxDays = parseInt(args[i + 1], 10);
      i++;
    }
  }
  let dates = loadDates();
  if (maxDays > 0) dates = dates.slice(-maxDays);
  console.log(`Starting OHLC download: ${symbols.join(",")}`);
  console.log(`Dates: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`Output: ${OHLC_DIR}`);
  for (const sym of symbols) {
    await downloadSymbol(sym, dates);
  }
  console.log("\nDone!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
