/**
 * Online Learning + Experience Replay Buffer — Pure JS (no TensorFlow)
 *
 * FASE 3 PPO PURO: Multi-dimensional reward shaping
 *
 * When a live trade resolves (TP/SL), we:
 *  1. Compute a shaped reward based on outcome + risk level + context multipliers
 *  2. Do an immediate REINFORCE gradient update on the actor weights
 *  3. Store the experience in a replay buffer (last 1000)
 *  4. Every 50 new experiences, do a mini-batch update (sample 32 from buffer)
 *
 * Context multipliers internalize what the old hardcoded rules did:
 *  - Session context: penalizes lunch/power-hour trades
 *  - Exhaustion: rewards skipping overextended markets, penalizes trading into them
 *  - Entry quality: rewards patience (waiting for optimal), penalizes caution entries
 *  - Macro events: rewards wins during macro events extra, penalizes losses more
 *
 * All neural network math runs through ppo-inference.ts (pure JS matrix ops).
 */

import {
  onlineLearning,
  getOnlineLearningStats,
  forceOnlineReplayTrain,
} from "./ppo-inference";
import { getEpisodeBank } from "./episode-bank.js";

// ── Base Reward structure (must match ppo-multihead.ts MH_REWARDS) ───────────

const MH_REWARDS: Record<string, Record<string, number>> = {
  tight:  { tp3: 5.0, tp2: 3.0, tp1: 1.5, sl: -1.5, cancelled: 0.0 },
  normal: { tp3: 4.0, tp2: 2.5, tp1: 1.0, sl: -2.0, cancelled: 0.0 },
  wide:   { tp3: 3.5, tp2: 2.0, tp1: 0.8, sl: -2.5, cancelled: 0.0 },
};

// ── Sizing multiplier ────────────────────────────────────────────────────────

function sizingRewardMultiplier(sizing: string, outcome: string): number {
  if (sizing === "full") return ["tp1", "tp2", "tp3"].includes(outcome) ? 1.2 : 1.3;
  if (sizing === "small") return ["tp1", "tp2", "tp3"].includes(outcome) ? 0.8 : 0.7;
  return 1.0;
}

// ── Context Multipliers (internalize old hardcoded rules) ────────────────────

/** Session context: harder sessions get penalized outcomes */
const SESSION_MULTIPLIER: Record<number, number> = {
  0: 1.0,  // open: normal
  1: 1.0,  // am_trend: normal
  2: 0.7,  // lunch: penalize (low volume, wider spreads)
  3: 1.0,  // retoma: normal
  4: 0.8,  // power_hour: slightly penalize
  5: 0.9,  // off_hours: slightly penalize
};

/** Exhaustion: reward PPO for correctly using overExtension head */
function exhaustionMultiplier(
  overExtensionDecision: string | undefined,
  imLevel: number,
  outcome: string,
): number {
  const isWin = ["tp1", "tp2", "tp3"].includes(outcome);
  const isHighExhaustion = imLevel > 0.75;

  if (!isHighExhaustion) return 1.0;

  // PPO decided to SKIP in exhausted market → reward that wisdom
  if (overExtensionDecision === "SKIP") return 1.3;

  // PPO decided to TRADE in exhausted market
  if (isWin) return 1.1;   // Won in tough conditions → slight bonus
  return 0.5;              // Lost in exhaustion → heavy penalty (should've skipped)
}

/** Entry quality: reward patience, penalize rushing */
function qualityMultiplier(
  entryQualityDecision: string | undefined,
  actualQuality: string | undefined,
  outcome: string,
): number {
  const isWin = ["tp1", "tp2", "tp3"].includes(outcome);

  if (entryQualityDecision === "WAIT_OPTIMAL" && actualQuality === "optimal") {
    return isWin ? 1.2 : 0.9;  // Patience rewarded on win, mild penalty on loss
  }
  if (entryQualityDecision === "ACCEPT_CAUTION" && actualQuality === "caution") {
    return isWin ? 0.9 : 0.7;  // Rushing penalized more on loss
  }
  return 1.0;
}

/** Macro events: high-risk environment */
function macroMultiplier(
  macroActive: boolean,
  outcome: string,
): number {
  if (!macroActive) return 1.0;

  // Trading during macro events is high-risk/high-reward
  if (outcome === "tp3") return 1.4;  // Big win in macro → rare, big reward
  if (outcome === "tp2") return 1.2;
  if (outcome === "tp1") return 1.1;
  if (outcome === "sl") return 0.5;   // Loss in macro → heavy penalty
  return 1.0;
}

/** Counter-trend: penalize losses more */
function counterTrendMultiplier(
  isCounterTrend: boolean,
  outcome: string,
): number {
  if (!isCounterTrend) return 1.0;
  if (["tp2", "tp3"].includes(outcome)) return 1.3;  // Counter-trend win is impressive
  if (outcome === "sl") return 0.6;                    // Counter-trend loss is expected
  return 1.0;
}

// ── Trade context passed from trading-engine ────────────────────────────────

export interface TradeContext {
  sessionType?: number;           // 0-5
  macroAlertActive?: boolean;
  counterTrendDetected?: boolean;
  imExhaustionLevel?: number;     // 0.0-1.0
  overExtensionDecision?: string; // "TRADE" | "SKIP"
  entryQualityDecision?: string;  // "ACCEPT_CAUTION" | "WAIT_OPTIMAL"
  actualEntryQuality?: string;    // "optimal" | "valid" | "caution" | "watch"
  sizing?: string;                // "small" | "medium" | "full"
}

// ── Core: Learn from a resolved live trade ──────────────────────────────────

export async function learnFromLiveTrade(
  tradeId: string,
  cfd: string,
  direction: string,
  outcome: string,   // tp1/tp2/tp3/sl
  pnlPoints: number | undefined,
  stateAtEntry: number[] | undefined,
  headActionsAtEntry: Record<string, number> | undefined,
  headLogProbsAtEntry: Record<string, number> | undefined,
  riskAtEntry: string | undefined,
  context?: TradeContext,
): Promise<{ learned: boolean; miniTrained: boolean; bufferSize: number; reward: number }> {
  // If we don't have PPO state, we can't learn
  if (!stateAtEntry || !headActionsAtEntry) {
    console.log(`[MH-ONLINE] Skip learning for ${tradeId} — no PPO state stored at entry`);
    return { learned: false, miniTrained: false, bufferSize: 0, reward: 0 };
  }

  const risk = riskAtEntry ?? "normal";
  const ctx = context ?? {};

  // ── Step 1: Base reward from outcome + risk ────────────────────────────
  const baseReward = (MH_REWARDS[risk] ?? MH_REWARDS.normal)[outcome] ?? 0;

  // ── Step 2: Apply all context multipliers ──────────────────────────────
  const sessionMult     = SESSION_MULTIPLIER[ctx.sessionType ?? 0] ?? 1.0;
  const exhaustionMult  = exhaustionMultiplier(ctx.overExtensionDecision, ctx.imExhaustionLevel ?? 0, outcome);
  const qualityMult     = qualityMultiplier(ctx.entryQualityDecision, ctx.actualEntryQuality, outcome);
  const macroMult       = macroMultiplier(ctx.macroAlertActive ?? false, outcome);
  const counterMult     = counterTrendMultiplier(ctx.counterTrendDetected ?? false, outcome);
  const sizingMult      = sizingRewardMultiplier(ctx.sizing ?? "medium", outcome);

  // ── Step 3: Final shaped reward ────────────────────────────────────────
  const reward = baseReward * sessionMult * exhaustionMult * qualityMult * macroMult * counterMult * sizingMult;

  // Log reward breakdown for debugging
  console.log(
    `[MH-ONLINE] ${tradeId} ${cfd} ${direction} ${outcome}: ` +
    `base=${baseReward.toFixed(2)} × session=${sessionMult.toFixed(2)} × exhaust=${exhaustionMult.toFixed(2)} ` +
    `× quality=${qualityMult.toFixed(2)} × macro=${macroMult.toFixed(2)} × counter=${counterMult.toFixed(2)} ` +
    `× sizing=${sizingMult.toFixed(2)} → reward=${reward.toFixed(3)}`
  );

  // ── Step 4: Run the pure-JS online learning ────────────────────────────
  const result = onlineLearning(
    stateAtEntry,
    headActionsAtEntry,
    reward,
    { tradeId, cfd, outcome },
  );

  // ── Step 5: Persistir en el Episode Bank (memoria permanente) ──────────
  try {
    const bank = getEpisodeBank();
    const epOutcome = (outcome === "tp1" || outcome === "tp2" || outcome === "tp3" || outcome === "sl" || outcome === "cancelled")
      ? outcome as "tp1" | "tp2" | "tp3" | "sl" | "cancelled"
      : "cancelled";
    bank.closeEpisode(tradeId, epOutcome, reward);
  } catch (err) {
    console.warn(`[EpisodeBank] Error cerrando episodio ${tradeId}:`, err);
  }

  return {
    learned: result.updated,
    miniTrained: result.replayTrained,
    bufferSize: result.bufferSize,
    reward,
  };
}

// ── Stats + force retrain (for API endpoints) ───────────────────────────────

export function getBufferStats() {
  return getOnlineLearningStats();
}

export async function forceReplayRetrain(): Promise<{
  bufferSize: number;
  durationMs: number;
  winRate: number;
}> {
  const startMs = Date.now();
  const result = forceOnlineReplayTrain();
  const stats = getOnlineLearningStats();
  return {
    bufferSize: result.bufferSize,
    durationMs: Date.now() - startMs,
    winRate: stats.bufferWinRate,
  };
}
