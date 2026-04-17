#!/usr/bin/env node
/**
 * Groq API Trader — Llama 4 Scout / 3.3 70B
 *
 * Calls Groq API directly with pre-fetched market data.
 * Llama 4 Scout: 131K ctx, 750 t/s, 30K tokens/min, 1K req/day (free).
 *
 * Usage:
 *   node scripts/groq-trader.cjs                # scout (default)
 *   node scripts/groq-trader.cjs --model 70b    # llama 3.3 70B
 *   node scripts/groq-trader.cjs --dry-run      # don't write files
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const ROOT = path.resolve(__dirname, "..");
const PROMPT_FILE = path.join(ROOT, "prompts", "trader-cycle-prompt.md");
const LOG_DIR = path.join(ROOT, "data", "groq-logs");
const DECISIONS_FILE = path.join(ROOT, "data", "groq-decisions.jsonl");
const ORDERS_FILE = path.join(ROOT, "data", "agent-orders.json");
const DASHBOARD = "http://localhost:3099";

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error("GROQ_API_KEY not found in .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

const MODEL_MAP = {
  "scout": "meta-llama/llama-4-scout-17b-16e-instruct",
  "70b": "llama-3.3-70b-versatile",
  "maverick": "meta-llama/llama-4-maverick-17b-128e-instruct",
  "gptoss": "openai/gpt-oss-120b",
  "qwen": "qwen/qwen3-32b",
  "kimi": "moonshotai/kimi-k2-instruct",
};
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : "scout";
const MODEL = MODEL_MAP[modelArg] || modelArg;
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
  return resp.json();
}

async function prefetchMarketData() {
  console.log("  Fetching market data...");
  const results = await Promise.allSettled([
    fetchJson(`${DASHBOARD}/api/trpc/market.getAgentView`),
    fetchJson(`${DASHBOARD}/api/trpc/market.getMT5Status`),
    fetchJson(`${DASHBOARD}/api/trpc/market.getExecutorState`),
  ]);
  return {
    agentView: results[0].status === "fulfilled" ? results[0].value : { error: results[0].reason?.message },
    mt5Status: results[1].status === "fulfilled" ? results[1].value : { error: results[1].reason?.message },
    executorState: results[2].status === "fulfilled" ? results[2].value : { error: results[2].reason?.message },
  };
}

function buildMessages(marketData, cycleId, now) {
  const basePrompt = fs.readFileSync(PROMPT_FILE, "utf-8");

  const system = `You are the Spotgamma autonomous trader. You run ONE trading cycle per invocation based on live market data and structured rules.

CRITICAL OUTPUT REQUIREMENT:
You MUST output EXACTLY these 3 JSON code blocks with these EXACT labels:
- AGENT_ORDERS_JSON
- DECISIONS_JSONL
- STATE_UPDATE_JSON

Rules:
- UNLIMITED orders: 8-15 across ALL 3 CFDs (L104 — equal coverage NAS/US30/XAU)
- Volumes MUST be broker minimums: NAS100=0.10, US30=0.10, XAUUSD=0.01
- R:R >= 1:1.5 on every order (L48)
- triggerSymbol MUST match ETF: NAS→SPX/QQQ/SPY, US30→DIA, XAU→GLD (L96)
- At least 1 order within 50pts of NAS price, 150pts US30, $5 XAU (L102)
- entryMode: "level" default during market hours, "confirm" ONLY for counter-trend
- Each order needs: id, cfd, direction, tradeMode (scalp/intraday/swing), exactLevel, entryMode, triggerSource, triggerSymbol, triggerLevel, structuralSL, tp1, volume, rationale, conviction, expiresAt`;

  const user = `${basePrompt}

---
RUNTIME CONTEXT:
- Cycle ID: ${cycleId}
- Started at: ${now}
- Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}

---
LIVE MARKET DATA:

### market.getAgentView
\`\`\`json
${JSON.stringify(marketData.agentView, null, 2).slice(0, 70000)}
\`\`\`

### market.getMT5Status
\`\`\`json
${JSON.stringify(marketData.mt5Status, null, 2).slice(0, 8000)}
\`\`\`

### market.getExecutorState
\`\`\`json
${JSON.stringify(marketData.executorState, null, 2).slice(0, 8000)}
\`\`\`

---
TASK: Do the FULL 14-point analysis using the data above, then output the 3 labeled JSON blocks.

Format EXACTLY like this:

**AGENT_ORDERS_JSON**
\`\`\`json
{
  "pendingOrders": [...],
  "managedPositions": [...],
  "lastPriceCheck": "..."
}
\`\`\`

**DECISIONS_JSONL**
\`\`\`json
{"ts":"...","cycle":"${cycleId}","action":"...","reasoning":"..."}
\`\`\`

**STATE_UPDATE_JSON**
\`\`\`json
{
  "thesis": {...},
  "marketStructure": {"NAS100":"...","US30":"...","XAUUSD":"..."},
  "recentCycleEntry": {...}
}
\`\`\`
`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function callGroqAPI(messages) {
  const body = {
    model: MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 8192,
  };

  console.log(`  Calling Groq API (${MODEL})...`);
  const startMs = Date.now();

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  const elapsedMs = Date.now() - startMs;
  console.log(`  API responded in ${(elapsedMs / 1000).toFixed(1)}s (status: ${resp.status})`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("No text in Groq response: " + JSON.stringify(data).slice(0, 500));

  return {
    text,
    elapsedMs,
    usage: data.usage,
    finishReason: data.choices?.[0]?.finish_reason,
  };
}

function extractJsonBlock(text, label) {
  const labelPattern = new RegExp(`\\*\\*${label}\\*\\*[\\s\\S]*?\`\`\`(?:json)?\\s*\\n([\\s\\S]*?)\`\`\``, "i");
  let match = text.match(labelPattern);
  if (match) return match[1].trim();

  if (label === "AGENT_ORDERS_JSON") {
    const pattern = /```(?:json)?\s*\n(\{[\s\S]*?"pendingOrders"[\s\S]*?\})\s*\n```/;
    match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function fixVolumes(ordersJson) {
  try {
    const data = JSON.parse(ordersJson);
    if (data.pendingOrders) {
      for (const order of data.pendingOrders) {
        if (order.cfd === "NAS100") order.volume = 0.10;
        else if (order.cfd === "US30") order.volume = 0.10;
        else if (order.cfd === "XAUUSD") order.volume = 0.01;
      }
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return ordersJson;
  }
}

async function runCycle() {
  ensureDir(LOG_DIR);
  const startedAt = new Date();
  const cycleId = `Q${Math.floor(startedAt.getTime() / 1000)}`;
  const logFile = path.join(LOG_DIR, `${cycleId}.log`);

  console.log(`\n[${startedAt.toISOString()}] Cycle ${cycleId} (model: ${MODEL}, dry-run: ${DRY_RUN})`);

  // Fetch data
  let marketData;
  try {
    marketData = await prefetchMarketData();
    console.log(`  Data: agentView=${!marketData.agentView.error ? "OK" : "FAIL"}, mt5=${!marketData.mt5Status.error ? "OK" : "FAIL"}, executor=${!marketData.executorState.error ? "OK" : "FAIL"}`);
  } catch (e) {
    console.error(`  Fetch failed: ${e.message}`);
    return 1;
  }

  // Build messages
  const messages = buildMessages(marketData, cycleId, startedAt.toISOString());
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  console.log(`  Prompt: ${(totalChars / 1024).toFixed(1)}KB (~${Math.round(totalChars / 4)} tokens)`);

  // Call API
  let result;
  try {
    result = await callGroqAPI(messages);
  } catch (e) {
    console.error(`  API failed: ${e.message}`);
    fs.writeFileSync(logFile, `ERROR: ${e.message}`);
    return 1;
  }

  fs.writeFileSync(logFile, result.text);
  console.log(`  Response: ${(result.text.length / 1024).toFixed(1)}KB, finish=${result.finishReason}`);
  if (result.usage) {
    console.log(`  Tokens: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`);
  }

  // Extract
  const ordersRaw = extractJsonBlock(result.text, "AGENT_ORDERS_JSON");
  console.log(`  Extracted orders: ${ordersRaw ? "YES" : "NO"}`);

  if (ordersRaw) {
    const fixedOrders = fixVolumes(ordersRaw);
    try {
      const parsed = JSON.parse(fixedOrders);
      const orderCount = parsed.pendingOrders?.length || 0;
      console.log(`  Orders: ${orderCount}`);
      console.log(`  By CFD: NAS=${parsed.pendingOrders?.filter(o=>o.cfd==="NAS100").length||0}, US30=${parsed.pendingOrders?.filter(o=>o.cfd==="US30").length||0}, XAU=${parsed.pendingOrders?.filter(o=>o.cfd==="XAUUSD").length||0}`);

      if (!DRY_RUN) {
        fs.writeFileSync(ORDERS_FILE, fixedOrders);
        console.log(`  Wrote to ${ORDERS_FILE}`);
      } else {
        console.log(`  [DRY-RUN] Would write ${orderCount} orders`);
      }
    } catch (e) {
      console.error(`  Invalid JSON: ${e.message}`);
    }
  }

  const finishedAt = new Date();
  const totalMs = finishedAt - startedAt;

  const meta = {
    ts: finishedAt.toISOString(),
    cycle: cycleId,
    model: MODEL,
    dryRun: DRY_RUN,
    elapsedMs: totalMs,
    apiMs: result.elapsedMs,
    tokens: result.usage,
    ordersExtracted: !!ordersRaw,
    logFile: path.relative(ROOT, logFile),
  };
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(meta) + "\n");

  console.log(`\n[${finishedAt.toISOString()}] Cycle ${cycleId} COMPLETE — ${(totalMs / 1000).toFixed(1)}s total`);
  return 0;
}

runCycle().then((code) => process.exit(code));
