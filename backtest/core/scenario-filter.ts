/**
 * Scenario Filter — v3 hyperfocus layer
 *
 * Loads a whitelist/blacklist of scenario signatures.
 * Given a scenario, returns: 'whitelist' | 'blacklist' | 'neutral'
 *
 * Used to boost volume on proven winners, skip known losers, reduce volume on unknowns.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenarioTag } from "./decision-engine-v2.js";

const SCENARIOS_FILE = path.resolve(process.cwd(), "backtest/output/scenarios-whitelist.json");

interface Lists {
  whitelist: string[];
  blacklist: string[];
}

let lists: Lists | null = null;

function loadLists(): Lists {
  if (lists) return lists;
  if (!fs.existsSync(SCENARIOS_FILE)) {
    lists = { whitelist: [], blacklist: [] };
    return lists;
  }
  lists = JSON.parse(fs.readFileSync(SCENARIOS_FILE, "utf-8"));
  return lists;
}

export function scenarioSignature(cfd: string, tag: ScenarioTag): string {
  return [
    cfd, tag.direction, tag.mode,
    `regime=${tag.regime}`,
    `vrp=${tag.vrpSign}`,
    `vix=${tag.vixRegime}`,
    `dxy=${tag.dxyTrend}`,
    `struct=${tag.structure}`,
    `bar=${tag.barSizeBucket}`,
    `iv=${tag.ivRankBucket}`,
    `dow=${tag.dayOfWeek}`,
  ].join("|");
}

export type FilterResult = "whitelist" | "blacklist" | "neutral";

export function classifyScenario(cfd: string, tag: ScenarioTag): FilterResult {
  const l = loadLists();
  const sig = scenarioSignature(cfd, tag);
  if (l.whitelist.includes(sig)) return "whitelist";
  if (l.blacklist.includes(sig)) return "blacklist";
  return "neutral";
}

/** Volume multiplier — v4 AGGRESSIVE on whitelist.
 *  whitelist + high score (4+): 3x volume
 *  whitelist + mid score: 2.5x volume
 *  whitelist: 2x
 *  neutral + high score: 1x
 *  neutral + mid score: 0.7x
 *  neutral + low score: skip
 *  blacklist: 0x (skip)
 */
export function volumeMultiplier(cls: FilterResult, multiFactorScore: number): number {
  if (cls === "blacklist") return 0;
  if (cls === "whitelist") {
    if (multiFactorScore >= 5) return 4.0; // conviction extremo
    if (multiFactorScore >= 3) return 3.0;
    return 2.5;
  }
  // Neutral = allow with moderate size (user wants max profit)
  if (multiFactorScore >= 4) return 1.5;
  if (multiFactorScore >= 2) return 1.0;
  if (multiFactorScore >= 1) return 0.5;
  return 0;
}
