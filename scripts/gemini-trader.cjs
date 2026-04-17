#!/usr/bin/env node
/**
 * Gemini Trader — 5-min cycle orchestrator
 *
 * Invokes Gemini CLI with the trader-cycle-prompt.md to run one trading cycle.
 * Gemini uses its built-in tools (read_file, web_fetch, write_file) to:
 *   1. Read agent-state.json (memory)
 *   2. Fetch live market data from localhost:3099
 *   3. Run 14-point checklist + decide orders
 *   4. Write agent-orders.json + update state
 *
 * Usage:
 *   node scripts/gemini-trader.cjs              # full cycle
 *   node scripts/gemini-trader.cjs --dry-run    # Gemini outputs decisions but does NOT write files
 *   node scripts/gemini-trader.cjs --model flash  # use Flash instead of Pro
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROMPT_FILE = path.join(ROOT, "prompts", "trader-cycle-prompt.md");
const LOG_DIR = path.join(ROOT, "data", "gemini-logs");
const DECISIONS_FILE = path.join(ROOT, "data", "gemini-decisions.jsonl");
const DASHBOARD = "http://localhost:3099";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const MODEL = args.includes("--model") ? args[args.indexOf("--model") + 1] : "gemini-2.5-pro";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
  return resp.json();
}

async function prefetchMarketData() {
  console.log("  Pre-fetching market data...");
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

async function runCycle() {
  ensureDir(LOG_DIR);

  const startedAt = new Date();
  const cycleId = `G${Math.floor(startedAt.getTime() / 1000)}`;
  const logFile = path.join(LOG_DIR, `${cycleId}.log`);

  console.log(`[${startedAt.toISOString()}] Cycle ${cycleId} starting (model: ${MODEL}, dry-run: ${DRY_RUN})`);

  // Pre-fetch market data here (faster + avoids tool availability issues across models)
  let marketData;
  try {
    marketData = await prefetchMarketData();
    console.log(`  Data fetched: agentView=${!marketData.agentView.error ? "OK" : "FAIL"}, mt5=${!marketData.mt5Status.error ? "OK" : "FAIL"}, executor=${!marketData.executorState.error ? "OK" : "FAIL"}`);
  } catch (e) {
    console.error(`  Prefetch failed: ${e.message}`);
    marketData = { error: e.message };
  }

  // Load base prompt
  const basePrompt = fs.readFileSync(PROMPT_FILE, "utf-8");

  // Inject runtime instructions + market data
  const runtimePrompt = `${basePrompt}

---
RUNTIME CONTEXT:
- Cycle ID: ${cycleId}
- Started at: ${startedAt.toISOString()}
- Workspace root: ${ROOT.replace(/\\/g, "/")}
- Mode: ${DRY_RUN ? "DRY-RUN (do NOT write agent-orders.json, only log decisions to stdout)" : "LIVE (write files as specified)"}
${DRY_RUN ? "\nIn dry-run: skip step 7 (writing agent-orders.json) and step 8 (updating agent-state.json). Instead, print the JSON you WOULD have written to stdout, prefixed with 'WOULD_WRITE:'." : ""}

---
LIVE MARKET DATA (already fetched for you — no need to call tools):

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
TASK: Skip step 2 (data fetch) — data is above. Proceed with steps 1 (read agent-state.json), 3-8.
`;

  // Write runtime prompt to log for debugging
  fs.writeFileSync(logFile.replace(".log", ".prompt.md"), runtimePrompt);

  // Spawn gemini
  const env = {
    ...process.env,
    GOOGLE_GENAI_USE_GCA: "true",
    PATH: `C:/Program Files/nodejs;${process.env.PATH || ""}`,
  };

  return new Promise((resolve) => {
    // Pipe the prompt via stdin to avoid shell-quoting issues with long prompts.
    // -p "." is a minimal prompt; stdin gets appended per gemini docs.
    const geminiArgs = [
      "-p", ".",
      "--model", MODEL,
      "--approval-mode", DRY_RUN ? "plan" : "auto_edit",
      "--output-format", "text",
    ];

    // Windows needs .cmd extension for npm globals
    const geminiBin = process.platform === "win32" ? "gemini.cmd" : "gemini";

    // Windows .cmd files require shell: true to spawn. Since args are simple flags (no user input), quoting is safe.
    const proc = spawn(geminiBin, geminiArgs, { env, cwd: ROOT, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });

    // Write the prompt via stdin
    proc.stdin.write(runtimePrompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      const txt = d.toString();
      stdout += txt;
      process.stdout.write(txt);
    });
    proc.stderr.on("data", (d) => {
      const txt = d.toString();
      stderr += txt;
      process.stderr.write(txt);
    });

    proc.on("close", (code) => {
      const finishedAt = new Date();
      const elapsedMs = finishedAt - startedAt;

      // Save full output log
      fs.writeFileSync(logFile, `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n\n=== META ===\ncode:${code}\nelapsedMs:${elapsedMs}\n`);

      // Append to decisions.jsonl
      const entry = {
        ts: finishedAt.toISOString(),
        cycle: cycleId,
        model: MODEL,
        dryRun: DRY_RUN,
        elapsedMs,
        exitCode: code,
        outputSnippet: stdout.slice(-2000),
        logFile: path.relative(ROOT, logFile),
      };
      fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + "\n");

      console.log(`\n[${finishedAt.toISOString()}] Cycle ${cycleId} finished — code=${code} elapsed=${(elapsedMs / 1000).toFixed(1)}s`);
      resolve(code);
    });
  });
}

runCycle().then((code) => process.exit(code));
