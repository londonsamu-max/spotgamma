/**
 * Multi-Head PPO Agent — The network controls ALL trading decisions
 *
 * Instead of a single action output, uses 5 independent decision heads:
 *   Head 1: Direction     (SKIP / LONG / SHORT)                    → 3 outputs
 *   Head 2: Risk Level    (tight / normal / wide)                  → 3 outputs
 *   Head 3: Entry Type    (at_market / at_level / at_wall)         → 3 outputs
 *   Head 4: Position Size (small=1% / medium=2% / full=3%)        → 3 outputs
 *   Head 5: Session       (trade_now / wait_better_setup)          → 2 outputs
 *
 * Total: 14 outputs covering 162 unique combinations
 * Each head learns independently — much more efficient than 162 flat actions
 *
 * Critic: single value estimate (unchanged from standard PPO)
 */

// Import native backend first if available (5-10x faster for training)
try { require("@tensorflow/tfjs-node"); } catch {}
import * as tf from "@tensorflow/tfjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MH_MODEL_DIR = path.resolve(__dirname, "../data/ppo-multihead-model");
const MH_STATE_FILE = path.resolve(__dirname, "../data/ppo-multihead-state.json");

// ── Hyperparameters ──────────────────────────────────────────────────────────
const LEARNING_RATE = 2e-4;
const GAMMA = 0.99;
const LAMBDA = 0.95;
const CLIP_RATIO = 0.2;
const ENTROPY_COEFF = 0.04;  // higher entropy → more exploration, prevents collapse
const VALUE_COEFF = 0.5;
const EPOCHS_PER_UPDATE = 2;  // fewer epochs → less overfitting per pass
const BATCH_SIZE = 512;

// ── State (42 market features + 4 context features = 46 total) ─────────────────────────────
import type { PPOState } from "./ppo-agent";
export { type PPOState, buildPPOState, PPO_STATE_SIZE } from "./ppo-agent";
const STATE_SIZE = 108;

// ── Decision Heads ──────────────────────────────────────────────────────────

export const HEAD_CONFIGS = {
  direction:    { size: 3, labels: ["SKIP", "LONG", "SHORT"] as const },
  risk:         { size: 3, labels: ["tight", "normal", "wide"] as const },
  entry:        { size: 3, labels: ["at_market", "at_level", "at_wall"] as const },
  sizing:       { size: 3, labels: ["small", "medium", "full"] as const },
  session:      { size: 2, labels: ["trade_now", "wait"] as const },
  overExtension: { size: 2, labels: ["TRADE", "SKIP"] as const },       // ✨ NEW: decide if trading in exhaustion
  entryQuality: { size: 2, labels: ["ACCEPT_CAUTION", "WAIT_OPTIMAL"] as const }, // ✨ NEW: entry quality requirement
  scoreThreshold: { size: 4, labels: ["LOW", "MEDIUM", "HIGH", "EXTRA"] as const }, // ✨ NEW: dynamic strictness
} as const;

export type HeadName = keyof typeof HEAD_CONFIGS;
const HEAD_NAMES: HeadName[] = ["direction", "risk", "entry", "sizing", "session", "overExtension", "entryQuality", "scoreThreshold"];
const TOTAL_OUTPUTS = Object.values(HEAD_CONFIGS).reduce((s, h) => s + h.size, 0); // 23

export interface MultiHeadDecision {
  direction: "SKIP" | "LONG" | "SHORT";
  risk: "tight" | "normal" | "wide";
  entry: "at_market" | "at_level" | "at_wall";
  sizing: "small" | "medium" | "full";
  session: "trade_now" | "wait";
  overExtension: "TRADE" | "SKIP";           // ✨ NEW
  entryQuality: "ACCEPT_CAUTION" | "WAIT_OPTIMAL"; // ✨ NEW
  scoreThreshold: "LOW" | "MEDIUM" | "HIGH" | "EXTRA"; // ✨ NEW
  confidence: number;          // min confidence across heads
  headProbs: Record<HeadName, number[]>;  // raw probabilities per head
  // Derived from decisions
  riskPct: number;             // % of capital to risk
  slMultiplier: number;        // SL as ATR multiple
  tp1Multiplier: number;
  tp2Multiplier: number;
  tp3Multiplier: number;
}

/** Convert raw head choices into a full decision with derived values */
export function buildDecision(
  headChoices: Record<HeadName, number>,
  headProbs: Record<HeadName, number[]>,
): MultiHeadDecision {
  const dir = HEAD_CONFIGS.direction.labels[headChoices.direction];
  const risk = HEAD_CONFIGS.risk.labels[headChoices.risk];
  const entry = HEAD_CONFIGS.entry.labels[headChoices.entry];
  const sizing = HEAD_CONFIGS.sizing.labels[headChoices.sizing];
  const session = HEAD_CONFIGS.session.labels[headChoices.session];
  const overExtension = HEAD_CONFIGS.overExtension.labels[headChoices.overExtension];
  const entryQuality = HEAD_CONFIGS.entryQuality.labels[headChoices.entryQuality];
  const scoreThreshold = HEAD_CONFIGS.scoreThreshold.labels[headChoices.scoreThreshold];

  // Min confidence across all heads
  const confidence = Math.min(
    ...HEAD_NAMES.map(h => headProbs[h][headChoices[h]] * 100)
  );

  // Risk-dependent SL/TP multipliers (ATR-based)
  const riskParams: Record<string, { sl: number; tp1: number; tp2: number; tp3: number }> = {
    tight:  { sl: 0.25, tp1: 0.20, tp2: 0.45, tp3: 0.90 },
    normal: { sl: 0.40, tp1: 0.25, tp2: 0.55, tp3: 1.20 },
    wide:   { sl: 0.65, tp1: 0.35, tp2: 0.75, tp3: 1.80 },
  };
  const rp = riskParams[risk] ?? riskParams.normal;

  // Sizing → % of capital
  const sizingMap: Record<string, number> = { small: 1.0, medium: 2.0, full: 3.0 };
  const riskPct = sizingMap[sizing] ?? 2.0;

  return {
    direction: dir, risk, entry, sizing, session,
    overExtension, entryQuality, scoreThreshold,
    confidence,
    headProbs,
    riskPct,
    slMultiplier: rp.sl,
    tp1Multiplier: rp.tp1,
    tp2Multiplier: rp.tp2,
    tp3Multiplier: rp.tp3,
  };
}

// ── State Normalization (same as ppo-agent.ts) ──────────────────────────────

function normalizeState(s: PPOState): number[] {
  return [
    Math.max(-2, Math.min(2, s.gammaTilt * 10)),
    Math.max(-2, Math.min(2, s.deltaTilt * 10)),
    s.gammaRatioNorm * 2 - 1,
    s.deltaRatioNorm * 2 - 1,
    s.ivRank * 2 - 1,
    Math.max(-2, Math.min(2, s.neSkew * 10)),
    Math.max(-2, Math.min(2, s.vrp * 10)),
    Math.max(-3, Math.min(3, s.momentum5d / 2)),
    Math.max(-3, Math.min(3, s.momentum20d / 5)),
    (s.rsi14 - 50) / 50,
    (s.squeezeSig - 50) / 50,
    s.positionFactor,
    Math.max(-2, Math.min(2, (s.putCallRatio - 1) * 2)),
    Math.max(-2, Math.min(2, (s.volumeRatio - 1))),
    Math.max(-2, Math.min(2, (s.atrPct - 1) / 0.5)),
    Math.max(-2, Math.min(2, s.priceVsCallWall / 2)),
    Math.max(-2, Math.min(2, s.priceVsPutWall / 2)),
    s.timeNorm * 2 - 1,
    s.isOPEX * 2 - 1,
    (s.cfdIdx - 1),
    Math.max(-3, Math.min(3, s.gammaWallDist / 2)),
    s.gammaConcentration * 2 - 1,
    s.callGammaRatio * 2 - 1,
    Math.max(-2, Math.min(2, s.nextExpGamma * 10)),
    Math.max(-2, Math.min(2, s.nextExpDelta * 10)),
    s.tapeBullishPct * 2 - 1,
    s.tapePremiumRatio * 2 - 1,
    s.tapeGammaSkew,
    // ── Phase 2 features (14) ────────────────────────────────────────
    (s.candleBodyRatio ?? 0.5) * 2 - 1,
    s.candleTrend ?? 0,
    Math.max(-2, Math.min(2, ((s.candleVolSpike ?? 1) - 1))),
    Math.max(-2, Math.min(2, ((s.impliedMovePct ?? 1) - 1) / 0.5)),
    Math.max(-2, Math.min(2, (s.impliedMoveUsage ?? 1) - 1)),
    Math.max(-3, Math.min(3, (s.comboLevelDist ?? 0) / 2)),
    s.comboLevelSide ?? 0,
    Math.max(-3, Math.min(3, (s.absGammaPeakDist ?? 0) / 2)),
    s.absGammaSkew ?? 0,
    s.hiroNorm ?? 0,
    Math.max(-2, Math.min(2, s.hiroAccel ?? 0)),
    Math.max(-3, Math.min(3, (s.volumeProfilePOC ?? 0) / 2)),
    (s.volumeImbalance ?? 0.5) * 2 - 1,
    s.dayOfWeek ?? 0,
    // ── New context features (4) ─────────────────────────────────────────
    (s.sessionType ?? 0) / 3 - 1,
    (s.macroAlertActive ?? 0),
    (s.counterTrendDetected ?? 0),
    (s.imExhaustionLevel ?? 0) * 2 - 1,
    // ── Top-strike distances (features 46-48) ────────────────────────────────
    Math.max(-3, Math.min(3, (s.topStrikeDist1 ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.topStrikeDist2 ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.topStrikeDist3 ?? 0) / 2)),
    // ── SpotGamma Extended: Skew / Fear (features 49-54) ──────────────────────
    Math.max(-2, Math.min(2, (s.skewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.callSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.putSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.d95Norm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.d25neNorm ?? 0.2) / 0.1 - 2)),
    Math.max(-2, Math.min(2, (s.fwdGarchSpread ?? 0) * 10)),
    // ── SpotGamma Extended: Positioning (features 55-61) ──────────────────────
    Math.max(-2, Math.min(2, (s.totalDeltaNorm ?? 0) * 2)),
    s.activityFactorNorm ?? 0,
    s.gammaRegimeNum ?? 0,
    (s.levelsChangedFlag ?? 0) * 2 - 1,
    Math.max(-3, Math.min(3, (s.priceVsKeyDelta ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.priceVsPutControl ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.priceVsMaxGamma ?? 0) / 2)),
    // ── Vol Term Structure (features 62-66) ────────────────────────────────────
    Math.max(-2, Math.min(2, (s.volTermSpread ?? 0) * 10)),
    Math.max(-2, Math.min(2, (s.volPutCallSkew ?? 0) * 10)),
    s.volTermStructureNum ?? 0,
    (s.volIVLevelNum ?? 0.5) * 2 - 1,
    (s.volMarketRegimeNum ?? 0.33) * 2 - 0.66,
    // ── Vanna Flows (features 67-72) ───────────────────────────────────────────
    Math.max(-3, Math.min(3, s.vixLevelNorm ?? 0)),
    Math.max(-3, Math.min(3, (s.vixChangePctFeat ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.uvixChangePctFeat ?? 0) / 3)),
    s.uvixGldDivStrength ?? 0,
    (s.indexVannaActiveFlag ?? 0) * 2 - 1,
    (s.refugeFlowActiveFlag ?? 0) * 2 - 1,
    // ── 0DTE GEX Dynamics (features 73-77) ─────────────────────────────────────
    Math.max(-2, Math.min(2, ((s.traceGexRatio ?? 1) - 1))),
    s.traceNetBiasNum ?? 0,
    Math.max(-3, Math.min(3, (s.traceSupportDist ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.traceResistDist ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.traceMaxGexDist ?? 0) / 2)),
    // ── GEX Change Tracking (features 78-81) ───────────────────────────────────
    (s.gexBiasChangedFlag ?? 0) * 2 - 1,
    Math.max(-2, Math.min(2, s.gexRatioChangeDelta ?? 0)),
    (s.gexSupportShiftedFlag ?? 0) * 2 - 1,
    (s.gexResistShiftedFlag ?? 0) * 2 - 1,
    // ── Tape Enriched (features 82-85) ─────────────────────────────────────────
    Math.max(-2, Math.min(2, (s.tapeNetDeltaNorm ?? 0) * 5)),
    s.tapeSentimentNorm ?? 0,
    Math.max(-2, Math.min(2, ((s.tapePutCallRatioNorm ?? 1) - 1) * 2)),
    s.tapeLargestPremiumRatio ?? 0,
    // ── Asset Microstructure (features 86-90) ──────────────────────────────────
    Math.max(-3, Math.min(3, (s.assetDailyChangePct ?? 0) / 2)),
    (s.zeroDteRatio ?? 0) * 2 - 1,
    s.oiCallPutSkew ?? 0,
    (s.skewRankNorm ?? 0.5) * 2 - 1,
    (s.garchRankNorm ?? 0.5) * 2 - 1,
    // ── CFD + Market Context (features 91-93) ──────────────────────────────────
    Math.max(-3, Math.min(3, (s.cfdDailyChangePct ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.spxDailyChangePct ?? 0) / 2)),
    (s.flowStrengthNorm ?? 0.5) * 2 - 1,
    // ── Model-Based Features (features 94-107) ────────────────────────────────
    (s.isPositiveGamma ?? 0) * 2 - 1,
    (s.isNegativeGamma ?? 0) * 2 - 1,
    (s.isBracketing ?? 0) * 2 - 1,
    s.priceVsPOC ?? 0,
    Math.min(3, s.ibRangeRatio ?? 1) - 1,
    s.valueAreaPosition ?? 0,
    s.excessFlag ?? 0,
    s.trendDaySignal ?? 0,
    s.breakoutSignal ?? 0,
    s.vannaFlowSignal ?? 0,
    s.inventoryCorrectionSignal ?? 0,
    s.gapSignal ?? 0,
    s.vrpSign ?? 0,
    (s.sessionPhase ?? 0.5) * 2 - 1,
  ];
}

// ── Multi-Head Actor Network ────────────────────────────────────────────────
// Shared backbone → independent heads (one softmax per decision)
// Larger backbone for 42 features

function createMultiHeadActor(): tf.LayersModel {
  const input = tf.input({ shape: [STATE_SIZE] });

  // Shared backbone — 128→64→32 (SMALLER to prevent overfitting on 94 features)
  // L2 regularization on all dense layers to penalize large weights
  const l2Reg = tf.regularizers.l2({ l2: 1e-4 });
  let x = tf.layers.dense({ units: 128, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }).apply(input) as tf.SymbolicTensor;
  x = tf.layers.dropout({ rate: 0.15 }).apply(x) as tf.SymbolicTensor;
  x = tf.layers.dense({ units: 64, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }).apply(x) as tf.SymbolicTensor;
  x = tf.layers.dropout({ rate: 0.10 }).apply(x) as tf.SymbolicTensor;
  const shared = tf.layers.dense({ units: 32, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }).apply(x) as tf.SymbolicTensor;

  // Independent heads — smaller hidden layer (16) + softmax
  const outputs: tf.SymbolicTensor[] = [];
  for (const name of HEAD_NAMES) {
    const headSize = HEAD_CONFIGS[name].size;
    let h = tf.layers.dense({ units: 16, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg, name: `${name}_hidden` }).apply(shared) as tf.SymbolicTensor;
    const out = tf.layers.dense({ units: headSize, activation: "softmax", kernelInitializer: "glorotNormal", name: `${name}_out` }).apply(h) as tf.SymbolicTensor;
    outputs.push(out);
  }

  // Concatenate all head outputs → single output tensor [batch, 14]
  const concat = outputs.length > 1
    ? tf.layers.concatenate({ name: "all_heads" }).apply(outputs) as tf.SymbolicTensor
    : outputs[0];

  return tf.model({ inputs: input, outputs: concat });
}

function createCriticNetwork(): tf.Sequential {
  const l2Reg = tf.regularizers.l2({ l2: 1e-4 });
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [STATE_SIZE], units: 128, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }));
  model.add(tf.layers.dropout({ rate: 0.15 }));
  model.add(tf.layers.dense({ units: 64, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }));
  model.add(tf.layers.dense({ units: 32, activation: "relu", kernelInitializer: "heNormal", kernelRegularizer: l2Reg }));
  model.add(tf.layers.dense({ units: 1, kernelInitializer: "glorotNormal" }));
  return model;
}

// ── Split concatenated output into per-head probabilities ───────────────────

function splitHeadProbs(flatProbs: number[]): Record<HeadName, number[]> {
  const result: Partial<Record<HeadName, number[]>> = {};
  let offset = 0;
  for (const name of HEAD_NAMES) {
    const size = HEAD_CONFIGS[name].size;
    result[name] = flatProbs.slice(offset, offset + size);
    offset += size;
  }
  return result as Record<HeadName, number[]>;
}

// ── Multi-Head Experience ───────────────────────────────────────────────────

interface MHExperience {
  state: number[];
  headActions: Record<HeadName, number>;   // chosen action per head
  headLogProbs: Record<HeadName, number>;  // log prob per head
  reward: number;
  value: number;
  advantage: number;
  return_: number;
}

// ── Multi-Head PPO Agent ────────────────────────────────────────────────────

export class MultiHeadPPOAgent {
  actor: tf.LayersModel;
  critic: tf.Sequential;
  actorOptimizer: tf.AdamOptimizer;
  criticOptimizer: tf.AdamOptimizer;

  totalEpisodes = 0;
  totalWins = 0;
  totalLosses = 0;
  trainingLoss: number[] = [];

  constructor() {
    this.actor = createMultiHeadActor();
    this.critic = createCriticNetwork();
    this.actorOptimizer = tf.train.adam(LEARNING_RATE);
    this.criticOptimizer = tf.train.adam(LEARNING_RATE);
  }

  /** Forward pass → per-head probabilities + value */
  predict(state: PPOState): { headProbs: Record<HeadName, number[]>; value: number } {
    const normalized = normalizeState(state);
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([normalized]);
      const flatProbs = (this.actor.predict(stateTensor) as tf.Tensor).dataSync() as Float32Array;
      const value = (this.critic.predict(stateTensor) as tf.Tensor).dataSync()[0];
      return { headProbs: splitHeadProbs(Array.from(flatProbs)), value };
    });
  }

  /** Batch predict for training */
  batchPredict(states: number[][]): { allHeadProbs: Record<HeadName, number[]>[]; values: number[] } {
    return tf.tidy(() => {
      const statesTensor = tf.tensor2d(states);
      const flatProbsTensor = this.actor.predict(statesTensor) as tf.Tensor;
      const valuesTensor = this.critic.predict(statesTensor) as tf.Tensor;
      const flatProbsData = flatProbsTensor.arraySync() as number[][];
      const valuesData = (valuesTensor.squeeze() as tf.Tensor).arraySync() as number[] | number;
      return {
        allHeadProbs: flatProbsData.map(fp => splitHeadProbs(fp)),
        values: Array.isArray(valuesData) ? valuesData : [valuesData],
      };
    });
  }

  /** Sample actions from all heads (for training/exploration) */
  sampleActions(headProbs: Record<HeadName, number[]>): {
    headActions: Record<HeadName, number>;
    headLogProbs: Record<HeadName, number>;
  } {
    const headActions: Partial<Record<HeadName, number>> = {};
    const headLogProbs: Partial<Record<HeadName, number>> = {};
    for (const name of HEAD_NAMES) {
      const probs = headProbs[name];
      const r = Math.random();
      let cumProb = 0, action = probs.length - 1;
      for (let i = 0; i < probs.length; i++) {
        cumProb += probs[i];
        if (r < cumProb) { action = i; break; }
      }
      headActions[name] = action;
      headLogProbs[name] = Math.log(Math.max(probs[action], 1e-8));
    }
    return {
      headActions: headActions as Record<HeadName, number>,
      headLogProbs: headLogProbs as Record<HeadName, number>,
    };
  }

  /** Select best actions (greedy, for live inference) */
  selectBest(state: PPOState): MultiHeadDecision {
    const { headProbs } = this.predict(state);
    const headChoices: Partial<Record<HeadName, number>> = {};
    for (const name of HEAD_NAMES) {
      const probs = headProbs[name];
      let best = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[best]) best = i;
      }
      headChoices[name] = best;
    }
    return buildDecision(headChoices as Record<HeadName, number>, headProbs);
  }

  /** Compute GAE */
  computeGAE(rewards: number[], values: number[], dones: boolean[]): { advantages: number[]; returns: number[] } {
    const n = rewards.length;
    const advantages = new Array(n).fill(0);
    const returns = new Array(n).fill(0);
    let lastAdv = 0;
    for (let t = n - 1; t >= 0; t--) {
      const nextVal = t < n - 1 && !dones[t] ? values[t + 1] : 0;
      const delta = rewards[t] + GAMMA * nextVal - values[t];
      lastAdv = delta + GAMMA * LAMBDA * (dones[t] ? 0 : lastAdv);
      advantages[t] = lastAdv;
      returns[t] = advantages[t] + values[t];
    }
    return { advantages, returns };
  }

  /** Train on batch — multi-head PPO loss (pure tensor ops for gradient flow) */
  async trainOnBatch(experiences: MHExperience[]): Promise<{ actorLoss: number; criticLoss: number }> {
    if (experiences.length === 0) return { actorLoss: 0, criticLoss: 0 };

    let totalActorLoss = 0, totalCriticLoss = 0, numBatches = 0;

    // Pre-compute head offsets for slicing the concatenated output
    const headOffsets: { name: HeadName; offset: number; size: number }[] = [];
    let off = 0;
    for (const name of HEAD_NAMES) {
      const size = HEAD_CONFIGS[name].size;
      headOffsets.push({ name, offset: off, size });
      off += size;
    }

    for (let epoch = 0; epoch < EPOCHS_PER_UPDATE; epoch++) {
      const shuffled = [...experiences].sort(() => Math.random() - 0.5);

      for (let start = 0; start < shuffled.length; start += BATCH_SIZE) {
        // Filter out any experiences with NaN/Inf state values BEFORE tensor creation
        // (tf.where NaN guard leaks NaN gradients; filtering is the safe approach)
        const rawBatch = shuffled.slice(start, start + BATCH_SIZE);
        const batch = rawBatch.filter(e =>
          e.state.every(v => isFinite(v)) &&
          isFinite(e.advantage) &&
          isFinite(e.return_) &&
          Object.values(e.headLogProbs).every(v => isFinite(v))
        );
        if (batch.length < 16) continue;
        const B = batch.length;

        const statesTensor = tf.tensor2d(batch.map(e => e.state));

        // Normalize advantages to prevent gradient explosion
        const rawAdvantages = batch.map(e => e.advantage);
        const advMean = rawAdvantages.reduce((s, v) => s + v, 0) / rawAdvantages.length;
        const advStd = Math.sqrt(rawAdvantages.reduce((s, v) => s + (v - advMean) ** 2, 0) / rawAdvantages.length) || 1;
        const normAdvantages = rawAdvantages.map(a => Math.max(-5, Math.min(5, (a - advMean) / advStd)));
        const advantagesTensor = tf.tensor1d(normAdvantages);

        // Clip returns to prevent extreme values
        const rawReturns = batch.map(e => Math.max(-10, Math.min(10, e.return_)));
        const returnsTensor = tf.tensor1d(rawReturns);

        // Build one-hot action tensors and old log prob tensors per head
        const oldLogProbSums = tf.tensor1d(batch.map(e =>
          Object.values(e.headLogProbs).reduce((s, v) => s + v, 0)
        ));

        // Per-head action indices: [B] each
        const headActionTensors: Record<string, tf.Tensor1D> = {};
        for (const { name } of headOffsets) {
          headActionTensors[name] = tf.tensor1d(batch.map(e => e.headActions[name]), "int32");
        }

        // Actor update — all tensor operations for gradient flow
        const actorLoss = this.actorOptimizer.minimize(() => {
          const flatProbs = this.actor.apply(statesTensor, { training: true }) as tf.Tensor; // [B, 14]

          let newLogProbSum = tf.zeros([B]);
          let entropySum = tf.zeros([B]);

          for (const { name, offset, size } of headOffsets) {
            // Slice this head's probabilities: [B, size]
            const headProbs = flatProbs.slice([0, offset], [B, size]);

            // Get probability of chosen action via one-hot masking: [B]
            const actionIdx = headActionTensors[name];
            const oneHot = tf.oneHot(actionIdx, size); // [B, size]
            const chosenProb = headProbs.mul(oneHot).sum(1)
              .clipByValue(1e-8, 1.0) as tf.Tensor1D;

            // Log prob of chosen action
            const logProb = chosenProb.log();
            newLogProbSum = newLogProbSum.add(logProb);

            // Entropy: -sum(p * log(p))
            const safeProbs = headProbs.clipByValue(1e-8, 1.0);
            const headEntropy = safeProbs.mul(safeProbs.log()).sum(1).neg();
            entropySum = entropySum.add(headEntropy);
          }

          // PPO clipped objective — clip log ratio to prevent exp() overflow
          const logRatio = newLogProbSum.sub(oldLogProbSums).clipByValue(-10, 10);
          const ratio = logRatio.exp().clipByValue(0.01, 100);
          const surr1 = ratio.mul(advantagesTensor);
          const surr2 = ratio.clipByValue(1 - CLIP_RATIO, 1 + CLIP_RATIO).mul(advantagesTensor);
          const policyLoss = tf.minimum(surr1, surr2).neg().mean();
          const entropyBonus = entropySum.mean().mul(ENTROPY_COEFF).neg();

          // Clip loss to finite range — avoids NaN gradient corruption
          // (tf.where leaks NaN gradients through the false branch even when masked)
          const totalLoss = policyLoss.add(entropyBonus);
          return totalLoss.clipByValue(-10, 10) as tf.Scalar;
        }, true) as tf.Scalar;

        const aLoss = actorLoss?.dataSync()[0] ?? 0;
        actorLoss?.dispose();

        // Critic update — clipped to prevent NaN gradient corruption
        const criticLoss = this.criticOptimizer.minimize(() => {
          const vals = (this.critic.apply(statesTensor, { training: true }) as tf.Tensor).squeeze();
          const mse = vals.sub(returnsTensor).square().mean().mul(VALUE_COEFF);
          return mse.clipByValue(0, 50) as tf.Scalar;
        }, true) as tf.Scalar;
        const cLoss = criticLoss?.dataSync()[0] ?? 0;
        criticLoss?.dispose();

        totalActorLoss += aLoss;
        totalCriticLoss += cLoss;
        numBatches++;

        // Clean up
        statesTensor.dispose();
        advantagesTensor.dispose();
        returnsTensor.dispose();
        oldLogProbSums.dispose();
        for (const t of Object.values(headActionTensors)) t.dispose();
      }
    }

    return {
      actorLoss: totalActorLoss / Math.max(numBatches, 1),
      criticLoss: totalCriticLoss / Math.max(numBatches, 1),
    };
  }

  /** Save model weights + state to disk */
  async save(): Promise<void> {
    if (!fs.existsSync(MH_MODEL_DIR)) fs.mkdirSync(MH_MODEL_DIR, { recursive: true });

    const actorWeights = this.actor.getWeights().map(w => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));
    const criticWeights = this.critic.getWeights().map(w => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));

    fs.writeFileSync(path.join(MH_MODEL_DIR, "actor-weights.json"), JSON.stringify(actorWeights), "utf-8");
    fs.writeFileSync(path.join(MH_MODEL_DIR, "critic-weights.json"), JSON.stringify(criticWeights), "utf-8");

    const state = {
      totalEpisodes: this.totalEpisodes,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      trainingLoss: this.trainingLoss.slice(-100),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(MH_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Load model weights from disk */
  async load(): Promise<boolean> {
    try {
      const actorPath = path.join(MH_MODEL_DIR, "actor-weights.json");
      const criticPath = path.join(MH_MODEL_DIR, "critic-weights.json");
      if (!fs.existsSync(actorPath)) return false;

      const actorData: { name: string; shape: number[]; data: number[] }[] =
        JSON.parse(fs.readFileSync(actorPath, "utf-8"));
      const criticData: { name: string; shape: number[]; data: number[] }[] =
        JSON.parse(fs.readFileSync(criticPath, "utf-8"));

      const actorTensors = actorData.map(w => tf.tensor(w.data, w.shape as any));
      const criticTensors = criticData.map(w => tf.tensor(w.data, w.shape as any));

      this.actor.setWeights(actorTensors);
      this.critic.setWeights(criticTensors);

      actorTensors.forEach(t => t.dispose());
      criticTensors.forEach(t => t.dispose());

      if (fs.existsSync(MH_STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(MH_STATE_FILE, "utf-8"));
        this.totalEpisodes = state.totalEpisodes ?? 0;
        this.totalWins = state.totalWins ?? 0;
        this.totalLosses = state.totalLosses ?? 0;
        this.trainingLoss = state.trainingLoss ?? [];
      }

      console.log(`[MH-PPO] Loaded model (${this.totalEpisodes} episodes, WR=${this.winRate.toFixed(1)}%)`);
      return true;
    } catch (e: any) {
      console.warn(`[MH-PPO] Load failed: ${e.message}`);
      return false;
    }
  }

  get winRate(): number {
    const resolved = this.totalWins + this.totalLosses;
    return resolved > 0 ? (this.totalWins / resolved) * 100 : 0;
  }

  getStats() {
    return {
      totalEpisodes: this.totalEpisodes,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      winRate: this.winRate,
      recentLoss: this.trainingLoss.slice(-10),
      heads: HEAD_NAMES.map(name => ({
        name,
        options: HEAD_CONFIGS[name].labels,
      })),
      lastUpdated: fs.existsSync(MH_STATE_FILE)
        ? JSON.parse(fs.readFileSync(MH_STATE_FILE, "utf-8")).lastUpdated
        : null,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _mhAgent: MultiHeadPPOAgent | null = null;
let _mhLoadPromise: Promise<boolean> | null = null;

export function getMultiHeadAgent(): MultiHeadPPOAgent {
  if (!_mhAgent) {
    _mhAgent = new MultiHeadPPOAgent();
    _mhLoadPromise = _mhAgent.load().catch(() => false);
  }
  return _mhAgent;
}

export async function ensureMultiHeadLoaded(): Promise<MultiHeadPPOAgent> {
  const agent = getMultiHeadAgent();
  if (_mhLoadPromise) await _mhLoadPromise;
  return agent;
}

// ── Reward structure for multi-head ─────────────────────────────────────────

export const MH_REWARDS: Record<string, Record<string, number>> = {
  // Tight: best risk/reward (R:R 3:1 → 1.5:1) — agent should prefer this
  tight:  { tp3: 6.0, tp2: 3.5, tp1: 1.5, sl: -2.0, cancelled: -0.3 },
  // Normal: balanced (R:R 2:1 → 0.5:1)
  normal: { tp3: 5.0, tp2: 3.0, tp1: 1.2, sl: -2.5, cancelled: -0.3 },
  // Wide: punish heavily — wide SL should only be used on high-conviction setups
  wide:   { tp3: 4.0, tp2: 2.5, tp1: 1.0, sl: -3.5, cancelled: -0.3 },
};

// Bonus/penalty for sizing decisions
export function sizingRewardMultiplier(sizing: string, outcome: string): number {
  // Full position on a win = bonus, full position on a loss = penalty
  if (sizing === "full") return ["tp1", "tp2", "tp3"].includes(outcome) ? 1.2 : 1.3; // bigger penalty on loss
  if (sizing === "small") return ["tp1", "tp2", "tp3"].includes(outcome) ? 0.8 : 0.7; // smaller loss too
  return 1.0; // medium = neutral
}

// Bonus for correct session timing
export function sessionRewardMultiplier(session: string, bigMove: boolean): number {
  if (session === "wait" && !bigMove) return 0.1;  // waited when flat = small positive
  if (session === "wait" && bigMove) return -0.5;   // waited when big move = missed opportunity
  return 1.0; // trade_now = standard
}
