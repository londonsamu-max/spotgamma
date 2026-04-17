#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROMPT_FILE = path.join(ROOT, 'prompts', 'trader-cycle-prompt.md');

async function go() {
  const [av, mt5, exec] = await Promise.all([
    fetch('http://localhost:3099/api/trpc/market.getAgentView').then(r => r.json()),
    fetch('http://localhost:3099/api/trpc/market.getMT5Status').then(r => r.json()),
    fetch('http://localhost:3099/api/trpc/market.getExecutorState').then(r => r.json()),
  ]);

  const basePrompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  const cycleId = 'G' + Math.floor(Date.now() / 1000);
  const now = new Date().toISOString();

  const fullPrompt = `${basePrompt}

---
RUNTIME CONTEXT:
- Cycle ID: ${cycleId}
- Started at: ${now}
- Workspace root: ${ROOT.replace(/\\/g, '/')}
- Mode: LIVE (write files as specified)

---
LIVE MARKET DATA (already fetched — no need to call tools):

### market.getAgentView (25 categories)
\`\`\`json
${JSON.stringify(av, null, 2).slice(0, 80000)}
\`\`\`

### market.getMT5Status (broker + positions)
\`\`\`json
${JSON.stringify(mt5, null, 2).slice(0, 10000)}
\`\`\`

### market.getExecutorState (pending orders + managed positions)
\`\`\`json
${JSON.stringify(exec, null, 2).slice(0, 10000)}
\`\`\`

---
TASK: Skip step 2 (data fetch) — data is above. Proceed with steps 1 (read agent-state.json from the data provided), 3-8.

IMPORTANT:
- Do the FULL 14-point analysis
- Output the final JSONs in clearly labeled code blocks:
  1. \`agent-orders.json\` — pendingOrders + managedPositions
  2. \`claude-decisions.jsonl\` entry
  3. \`agent-state.json\` updates (thesis, marketStructure, recentCycles new entry, ALL snapshots)
- Be AGGRESSIVE with orders — 8-15 active across all 3 CFDs
- ALL 3 CFDs must have orders (L104)
`;

  const outFile = path.join(ROOT, 'data', 'gemini-logs', `${cycleId}.prompt.md`);
  fs.writeFileSync(outFile, fullPrompt);

  console.log(`Prompt saved: ${outFile}`);
  console.log(`Size: ${(fullPrompt.length / 1024).toFixed(1)}KB`);
  console.log(`Lines: ${fullPrompt.split('\n').length}`);
  console.log(`CycleID: ${cycleId}`);
}

go().catch(e => console.error(e));
