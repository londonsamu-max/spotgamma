/**
 * Historical Flow Downloader
 * Downloads individual options trades from SpotGamma tns_feed
 * for each trading day, saves to data/historical/flow/{date}.json
 */

const fs = require("fs");
const path = require("path");
const { decode } = require("@msgpack/msgpack");

const FLOW_DIR = path.resolve(__dirname, "../data/historical/flow");
const TOKEN_FILE = path.resolve(__dirname, "../.sg_token");
const API = "https://api.stream.spotgamma.com";

const SYMBOLS = ["SPX", "QQQ", "SPY", "GLD", "DIA", "VIX"];
const BATCH_SIZE = 1000; // max per request
const DELAY_MS = 400; // between requests

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
    if (dow !== 0 && dow !== 6) {
      days.push(cur.toISOString().split("T")[0]);
    }
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
    price: price,
    bid: bid,
    ask: ask,
    iv: Number(item[15]) || 0,
    prevOI: Number(item[16]) || 0,
    premium: Number(item[19]) || 0,
    cp: isPut ? "P" : "C",
    exp: Number(item[7]) || 0,
  };
}

async function downloadDay(date, token) {
  const filePath = path.join(FLOW_DIR, date + ".json");
  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (existing.length > 100) return { date, status: "skip", count: existing.length };
  }

  // Market hours: 9:30 AM - 4:00 PM ET = 13:30 - 20:00 UTC
  // Include pre-market from 8:00 AM ET = 12:00 UTC and after-hours to 6:00 PM ET = 22:00 UTC
  const fromTs = new Date(date + "T12:00:00Z").getTime();
  const toTs = new Date(date + "T22:00:00Z").getTime();

  // Use sorting approach - more reliable than date filters
  const filters = JSON.stringify([
    { field: "underlying", operator: "isAnyOf", value: SYMBOLS },
    { field: "ts", operator: ">=", value: fromTs },
    { field: "ts", operator: "<", value: toTs },
  ]);
  const sorting = JSON.stringify([{ field: "ts", direction: "asc" }]);

  const allTrades = [];
  let offset = 0;
  let maxPages = 300; // safety limit ~300K trades per day
  let consecutiveEmpty = 0;

  while (maxPages-- > 0) {
    const url = `${API}/sg/tns_feed?filters=${encodeURIComponent(filters)}&sorting=${encodeURIComponent(sorting)}&limit=${BATCH_SIZE}&offset=${offset}`;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 120000); // 120s timeout (old data needs more time)
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/msgpack",
          Origin: "https://dashboard.spotgamma.com",
        },
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (resp.status !== 200) {
        console.log(`  ${date} offset=${offset}: HTTP ${resp.status}`);
        break;
      }

      const buf = await resp.arrayBuffer();
      const raw = decode(new Uint8Array(buf));

      if (!Array.isArray(raw) || raw.length === 0) break;

      for (const item of raw) {
        const trade = parseTrade(item);
        if (trade) allTrades.push(trade);
      }

      if (raw.length < BATCH_SIZE) break; // last page
      offset += BATCH_SIZE;

      await new Promise((r) => setTimeout(r, DELAY_MS));
    } catch (e) {
      console.log(`  ${date} offset=${offset}: ERROR ${e.message}`);
      break;
    }
  }

  if (allTrades.length > 0) {
    ensureDir(FLOW_DIR);
    fs.writeFileSync(filePath, JSON.stringify(allTrades));
    return { date, status: "ok", count: allTrades.length };
  }

  return { date, status: "empty", count: 0 };
}

async function main() {
  const startDate = process.argv[2] || "2024-01-02";
  const endDate = process.argv[3] || "2026-04-13";
  const token = getToken();

  const days = getTradingDays(startDate, endDate);
  console.log(`Downloading flow: ${days.length} trading days (${startDate} to ${endDate})`);

  let downloaded = 0, skipped = 0, empty = 0, failed = 0;

  for (let i = 0; i < days.length; i++) {
    const result = await downloadDay(days[i], token);

    if (result.status === "ok") {
      downloaded++;
      console.log(`[${i + 1}/${days.length}] ${result.date}: ${result.count} trades`);
    } else if (result.status === "skip") {
      skipped++;
    } else if (result.status === "empty") {
      empty++;
      console.log(`[${i + 1}/${days.length}] ${result.date}: empty`);
    } else {
      failed++;
    }

    // Small delay between days
    if (result.status !== "skip") await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone: ${downloaded} downloaded, ${skipped} skipped, ${empty} empty, ${failed} failed`);
}

main().catch(console.error);
