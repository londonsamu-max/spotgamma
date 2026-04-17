/**
 * Creates a Gemini-friendly zip of the Spotgamma project.
 * Excludes node_modules, data/historical (huge), .git, dist, logs.
 * Includes: source code, configs, CLAUDE.md, agent-state (trimmed), small datasets.
 *
 * Output: spotgamma-gemini.zip (~5-20 MB, <1000 files)
 *
 * Run: node scripts/make-gemini-zip.cjs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "spotgamma-gemini.zip");

// Patterns to EXCLUDE
const EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "logs",
  "data/historical",       // 6.9 GB of flow/gamma-bars/ohlc
  "data/market-snapshots", // old snapshots
  "data/claude-decisions.jsonl",  // can grow huge
  "data/daily-context.jsonl",     // can grow huge
  "*.log",
  "*.zip",
  "*.jsonl.gz",
  ".vscode",
  ".idea",
  "*.tmp",
  "*.cache",
  "agent/memory",          // personal lessons in text form
  "agent/scheduled-tasks", // runtime state
  "client/node_modules",
  "client/dist",
  "drizzle/meta",
];

// Files to ALWAYS include (even if matched by exclude)
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
  "data/auto-trading-config.json",
  "data/user-directives.json",
];

function shouldExclude(relPath) {
  if (MUST_INCLUDE.includes(relPath)) return false;
  const normalized = relPath.replace(/\\/g, "/");
  for (const pattern of EXCLUDES) {
    if (pattern.includes("*")) {
      const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      if (re.test(path.basename(normalized))) return true;
      if (re.test(normalized)) return true;
    } else {
      if (normalized === pattern) return true;
      if (normalized.startsWith(pattern + "/")) return true;
    }
  }
  return false;
}

function walk(dir, filelist = [], baseDir = ROOT) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(baseDir, abs).replace(/\\/g, "/");
    if (shouldExclude(rel)) continue;
    if (entry.isDirectory()) {
      walk(abs, filelist, baseDir);
    } else {
      filelist.push(rel);
    }
  }
  return filelist;
}

console.log("Scanning files (excluding node_modules, data/historical, etc.)...");
const files = walk(ROOT);
console.log(`Found ${files.length} files to include.`);

if (files.length > 2500) {
  console.log(`⚠️ File count exceeds Gemini's ~3000 limit margin. Review EXCLUDES.`);
}

// Total size
let totalBytes = 0;
for (const f of files) {
  try { totalBytes += fs.statSync(path.join(ROOT, f)).size; } catch {}
}
console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

// Trim huge individual files (warn)
const BIG_FILE_MB = 5;
for (const f of files) {
  try {
    const size = fs.statSync(path.join(ROOT, f)).size;
    if (size > BIG_FILE_MB * 1024 * 1024) {
      console.log(`  ⚠️ Big: ${f} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch {}
}

// Stage files in a temp dir, then zip that whole dir (works around Windows tar path issues)
const stageDir = path.join(ROOT, ".gemini-stage");
if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

console.log("\nStaging files to .gemini-stage/ ...");
for (const relPath of files) {
  const src = path.join(ROOT, relPath);
  const dst = path.join(stageDir, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Delete old zip
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

console.log("Creating zip with PowerShell Compress-Archive...");
try {
  const cmd = `powershell -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${OUT}' -CompressionLevel Optimal -Force"`;
  execSync(cmd, { stdio: "inherit" });
  const outSize = fs.statSync(OUT).size;
  console.log(`\n✅ Created ${OUT}`);
  console.log(`   Size: ${(outSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   Files: ${files.length}`);
} catch (e) {
  console.error("Zip failed:", e.message);
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
