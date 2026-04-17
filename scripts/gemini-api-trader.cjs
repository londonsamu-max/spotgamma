#!/usr/bin/env node
/**
 * Gemini API Trader — Direct API call (no CLI needed)
 *
 * Calls Google's generativelanguage API directly with pre-fetched market data.
 * Much faster than CLI (~20-30s) and no rate limit issues.
 *
 * Usage:
 *   node scripts/gemini-api-trader.cjs              # full cycle with Flash
 *   node scripts/gemini-api-trader.cjs --model pro   # use 2.5 Pro
 *   node scripts/gemini-api-trader.cjs --dry-run     # don't write files
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const ROOT = path.resolve(__dirname, "..");
const PROMPT_FILE = path.join(ROOT, "prompts", "trader-cycle-prompt.md");
const LOG_DIR = path.join(ROOT, "data", "gemini-logs");
const DECISIONS_FILE = path.join(ROOT, "data", "gemini-decisions.jsonl");
const ORDERS_FILE = path.join(ROOT, "data", "agent-orders.json");
const STATE_FILE = path.join(ROOT, "data", "agent-state.json");
const DASHBOARD = "http://localhost:3099";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not found in .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USE_PRO = args.includes("--model") && args[args.indexOf("--model") + 1] === "pro";
const MODEL_MAP = { "pro": "gemini-2.5-pro", "flash": "gemini-2.5-flash", "flash2": "gemini-2.0-flash" };
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : "flash";
const MODEL = MODEL_MAP[modelArg] || modelArg;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

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

function buildPrompt(marketData, cycleId, now) {
  const basePrompt = fs.readFileSync(PROMPT_FILE, "utf-8");

  return `${basePrompt}

---
RUNTIME CONTEXT:
- Cycle ID: ${cycleId}
- Started at: ${now}
- Workspace root: ${ROOT.replace(/\\/g, "/")}
- Mode: ${DRY_RUN ? "DRY-RUN (output JSON but do NOT write files)" : "LIVE"}

---
LIVE MARKET DATA (already fetched):

### market.getAgentView (25 categories)
\`\`\`json
${JSON.stringify(marketData.agentView, null, 2).slice(0, 80000)}
\`\`\`

### market.getMT5Status (broker + positions)
\`\`\`json
${JSON.stringify(marketData.mt5Status, null, 2).slice(0, 10000)}
\`\`\`

### market.getExecutorState (pending orders + managed positions)
\`\`\`json
${JSON.stringify(marketData.executorState, null, 2).slice(0, 10000)}
\`\`\`

---
TASK: Data is above. Do the FULL 14-point analysis, then output EXACTLY these 3 JSON code blocks labeled clearly:

1. **AGENT_ORDERS_JSON** — the complete agent-orders.json (pendingOrders + managedPositions + lastPriceCheck)
2. **DECISIONS_JSONL** — one decision entry for claude-decisions.jsonl
3. **STATE_UPDATE_JSON** — agent-state.json updates: { thesis, marketStructure, recentCycleEntry, gammaBarsSnapshot, flowSnapshot }

Rules:
- Be AGGRESSIVE: 8-15 orders across ALL 3 CFDs (L104)
- ALL volumes must be: NAS100=0.10, US30=0.10, XAUUSD=0.01 (broker minimums)
- R:R >= 1:1.5 on every order (L48)
- triggerSymbol must match ETF: NAS→SPX/QQQ/SPY, US30→DIA, XAU→GLD (L96)
- At least 1 order within 50pts of NAS, 150pts US30, $5 XAU (L102)
- entryMode: "level" default, "confirm" only for counter-trend (L83)
`;
}

async function callGeminiAPI(prompt) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 16384,
    },
  };

  console.log(`  Calling Gemini API (${MODEL})...`);
  const startMs = Date.now();

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

  const elapsedMs = Date.now() - startMs;
  console.log(`  API responded in ${(elapsedMs / 1000).toFixed(1)}s (status: ${resp.status})`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text in Gemini response");

  return { text, elapsedMs, usage: data.usageMetadata };
}

function extractJsonBlock(text, label) {
  // Try to find labeled block first
  const labelPattern = new RegExp(`\\*\\*${label}\\*\\*[\\s\\S]*?\`\`\`(?:json)?\\s*\\n([\\s\\S]*?)\`\`\``, "i");
  let match = text.match(labelPattern);
  if (match) return match[1].trim();

  // Fallback: find by content pattern
  if (label === "AGENT_ORDERS_JSON") {
    const pattern = /```(?:json)?\s*\n(\{[\s\S]*?"pendingOrders"[\s\S]*?\})\s*\n```/;
    match = text.match(pattern);
    if (match) return match[1].trim();
  }
  if (label === "DECISIONS_JSONL") {
    const pattern = /```(?:json)?\s*\n(\{[\s\S]*?"action"[\s\S]*?"lessonsApplied"[\s\S]*?\})\s*\n```/;
    match = text.match(pattern);
    if (match) return match[1].trim();
  }
  if (label === "STATE_UPDATE_JSON") {
    const pattern = /```(?:json)?\s*\n(\{[\s\S]*?"thesis"[\s\S]*?"marketStructure"[\s\S]*?\})\s*\n```/;
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
  const cycleId = `G${Math.floor(startedAt.getTime() / 1000)}`;
  const logFile = path.join(LOG_DIR, `${cycleId}.api.log`);

  console.log(`\n[${startedAt.toISOString()}] Cycle ${cycleId} (model: ${MODEL}, dry-run: ${DRY_RUN})`);

  // Step 1: Fetch market data
  let marketData;
  try {
    marketData = await prefetchMarketData();
    const avOk = !marketData.agentView.error;
    const mt5Ok = !marketData.mt5Status.error;
    const exOk = !marketData.executorState.error;
    console.log(`  Data: agentView=${avOk ? "OK" : "FAIL"}, mt5=${mt5Ok ? "OK" : "FAIL"}, executor=${exOk ? "OK" : "FAIL"}`);
    if (!avOk) throw new Error("AgentView fetch failed");
  } catch (e) {
    console.error(`  Data fetch failed: ${e.message}`);
    const entry = { ts: new Date().toISOString(), cycle: cycleId, action: "SKIP", reasoning: e.message };
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + "\n");
    return 1;
  }

  // Step 2: Build prompt
  const prompt = buildPrompt(marketData, cycleId, startedAt.toISOString());
  fs.writeFileSync(logFile.replace(".log", ".prompt.md"), prompt);
  console.log(`  Prompt: ${(prompt.length / 1024).toFixed(1)}KB`);

  // Step 3: Call Gemini API
  let result;
  try {
    result = await callGeminiAPI(prompt);
  } catch (e) {
    console.error(`  API call failed: ${e.message}`);
    fs.writeFileSync(logFile, `ERROR: ${e.message}`);
    const entry = { ts: new Date().toISOString(), cycle: cycleId, action: "SKIP", reasoning: `API error: ${e.message}` };
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + "\n");
    return 1;
  }

  // Save full response
  fs.writeFileSync(logFile, result.text);
  console.log(`  Response: ${(result.text.length / 1024).toFixed(1)}KB, ${result.elapsedMs}ms`);
  if (result.usage) {
    console.log(`  Tokens: prompt=${result.usage.promptTokenCount}, output=${result.usage.candidatesTokenCount}, total=${result.usage.totalTokenCount}`);
  }

  // Step 4: Extract JSON blocks
  const ordersRaw = extractJsonBlock(result.text, "AGENT_ORDERS_JSON");
  const decisionRaw = extractJsonBlock(result.text, "DECISIONS_JSONL");
  const stateRaw = extractJsonBlock(result.text, "STATE_UPDATE_JSON");

  console.log(`  Extracted: orders=${ordersRaw ? "YES" : "NO"}, decision=${decisionRaw ? "YES" : "NO"}, state=${stateRaw ? "YES" : "NO"}`);

  // Step 5: Write files (unless dry-run)
  if (ordersRaw && !DRY_RUN) {
    const fixedOrders = fixVolumes(ordersRaw);
    try {
      JSON.parse(fixedOrders); // validate
      fs.writeFileSync(ORDERS_FILE, fixedOrders);
      const parsed = JSON.parse(fixedOrders);
      console.log(`  Wrote agent-orders.json: ${parsed.pendingOrders?.length || 0} orders`);
    } catch (e) {
      console.error(`  Invalid orders JSON: ${e.message}`);
    }
  } else if (ordersRaw) {
    const parsed = JSON.parse(fixVolumes(ordersRaw));
    console.log(`  [DRY-RUN] Would write ${parsed.pendingOrders?.length || 0} orders`);
  }

  if (decisionRaw) {
    try {
      JSON.parse(decisionRaw); // validate
      fs.appendFileSync(DECISIONS_FILE, decisionRaw.replace(/\n/g, "") + "\n");
      console.log(`  Appended to gemini-decisions.jsonl`);
    } catch (e) {
      console.error(`  Invalid decision JSON: ${e.message}`);
    }
  }

  // Step 6: Log summary
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
