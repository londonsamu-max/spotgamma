/**
 * Consolidates the Spotgamma project into a SINGLE markdown file
 * that Gemini (or any LLM) can read to understand the entire project.
 *
 * Output: spotgamma-context.md (~200-500 KB)
 *
 * Usage: drop this file into Gemini chat as a single upload.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "spotgamma-context.md");

// Patterns to EXCLUDE
const EXCLUDES = [
  "node_modules", ".git", "dist", "logs",
  "data/historical", "data/market-snapshots",
  "data/claude-decisions.jsonl", "data/daily-context.jsonl",
  "client/node_modules", "client/dist", "drizzle/meta",
  "agent/memory", "agent/scheduled-tasks",
  ".vscode", ".idea",
];

// File extensions to include (code + configs + docs)
const INCLUDE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs",
  ".json", ".md", ".yml", ".yaml", ".toml",
  ".sql", ".py", ".sh", ".mq5", ".mqh",
]);

// Files to always include (by exact path)
const MUST_INCLUDE = [
  "CLAUDE.md",
  "BOOTSTRAP-WINDOWS.md",
  "package.json",
  "ecosystem.config.cjs",
  "tsconfig.json",
  "data/agent-state.json",
  "data/agent-orders.json",
  "data/agent-playbook.json",
  "data/agent-entry-models.json",
];

function shouldExclude(relPath) {
  if (MUST_INCLUDE.includes(relPath)) return false;
  const norm = relPath.replace(/\\/g, "/");
  for (const pat of EXCLUDES) {
    if (norm === pat || norm.startsWith(pat + "/")) return true;
  }
  return false;
}

function walk(dir, filelist = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (shouldExclude(rel)) continue;
    if (entry.isDirectory()) walk(abs, filelist);
    else filelist.push(rel);
  }
  return filelist;
}

console.log("Scanning files...");
let files = walk(ROOT);

// Filter by extension; drop binary/huge
files = files.filter((f) => {
  const ext = path.extname(f).toLowerCase();
  if (!INCLUDE_EXTS.has(ext) && !MUST_INCLUDE.includes(f)) return false;
  try {
    const size = fs.statSync(path.join(ROOT, f)).size;
    if (size > 500 * 1024) {
      console.log(`  skip big: ${f} (${(size/1024).toFixed(0)} KB)`);
      return false;
    }
    return true;
  } catch { return false; }
});

console.log(`Including ${files.length} files.`);

// Sort: docs first, then configs, then source
const ORDER_PRIORITY = [
  "CLAUDE.md", "BOOTSTRAP-WINDOWS.md", "README.md",
  "package.json", "tsconfig.json", "ecosystem.config.cjs",
];
files.sort((a, b) => {
  const ai = ORDER_PRIORITY.indexOf(a);
  const bi = ORDER_PRIORITY.indexOf(b);
  if (ai >= 0 && bi >= 0) return ai - bi;
  if (ai >= 0) return -1;
  if (bi >= 0) return 1;
  // Then by path depth (shallow first) then alpha
  const da = a.split("/").length, db = b.split("/").length;
  if (da !== db) return da - db;
  return a.localeCompare(b);
});

const extLang = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".cjs": "javascript", ".mjs": "javascript",
  ".json": "json", ".md": "markdown",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
  ".sql": "sql", ".py": "python", ".sh": "bash",
  ".mq5": "cpp", ".mqh": "cpp",
};

// Build the consolidated file
let out = "";
out += "# SpotGamma — Full Project Context\n\n";
out += "This document contains ALL source code, configuration, and state files of the Spotgamma autonomous trading project. ";
out += "It is intended for LLMs (Gemini/Claude/etc.) to understand the entire project at once.\n\n";
out += `Generated: ${new Date().toISOString()}\n`;
out += `Files included: ${files.length}\n\n`;
out += "## Project purpose (brief)\n\n";
out += "Autonomous CFD trading system for NAS100, US30, XAUUSD on MT5 (Pepperstone). Uses SpotGamma options data ";
out += "(gamma levels, HIRO institutional flow, options trades) to decide entries at gamma bars. ";
out += "Fast Executor fills orders in 500ms. Claude Code runs the 'brain' (5-min cycles) that reads data and writes orders. ";
out += "Full architecture and rules in CLAUDE.md.\n\n";
out += "---\n\n## Table of contents\n\n";
for (const f of files) out += `- ${f}\n`;
out += "\n---\n\n";

// File sections
for (const f of files) {
  const abs = path.join(ROOT, f);
  let content;
  try { content = fs.readFileSync(abs, "utf-8"); }
  catch { content = "(could not read)"; }
  const ext = path.extname(f).toLowerCase();
  const lang = extLang[ext] || "";
  out += `## \`${f}\`\n\n`;
  out += "```" + lang + "\n";
  out += content;
  if (!content.endsWith("\n")) out += "\n";
  out += "```\n\n";
}

fs.writeFileSync(OUT, out);
const size = fs.statSync(OUT).size;
console.log(`\n✅ Created ${OUT}`);
console.log(`   Size: ${(size / 1024).toFixed(0)} KB (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`   Files: ${files.length}`);
console.log(`\nSube este archivo .md a Gemini — es un archivo único con todo el código dentro.`);
