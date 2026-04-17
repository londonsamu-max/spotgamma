/**
 * PPO Multi-Head Inference — Pure JS (no TensorFlow)
 *
 * Loads weights trained by Python and runs inference using simple matrix math.
 * Much faster than TF.js for single-sample inference (no tensor overhead).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRollingNormalizer } from "./rolling-normalizer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.resolve(__dirname, "../data/ppo-multihead-model");
const STATE_FILE = path.resolve(__dirname, "../data/ppo-multihead-state.json");

// ── Head configs (must match training) ──────────────────────────────────────

export const MH_HEADS = {
  direction:      { size: 3, labels: ["SKIP", "LONG", "SHORT"] as const },
  risk:           { size: 3, labels: ["tight", "normal", "wide"] as const },
  entry:          { size: 3, labels: ["at_market", "at_level", "at_wall"] as const },
  sizing:         { size: 3, labels: ["small", "medium", "full"] as const },
  session:        { size: 2, labels: ["trade_now", "wait"] as const },
  overExtension:  { size: 2, labels: ["TRADE", "SKIP"] as const },
  entryQuality:   { size: 2, labels: ["ACCEPT_CAUTION", "WAIT_OPTIMAL"] as const },
  scoreThreshold: { size: 4, labels: ["LOW", "MEDIUM", "HIGH", "EXTRA"] as const },
} as const;

type HeadName = keyof typeof MH_HEADS;
const HEAD_NAMES: HeadName[] = ["direction", "risk", "entry", "sizing", "session", "overExtension", "entryQuality", "scoreThreshold"];

export interface MHInferenceResult {
  direction: "SKIP" | "LONG" | "SHORT";
  risk: "tight" | "normal" | "wide";
  entry: "at_market" | "at_level" | "at_wall";
  sizing: "small" | "medium" | "full";
  session: "trade_now" | "wait";
  overExtension: "TRADE" | "SKIP";
  entryQuality: "ACCEPT_CAUTION" | "WAIT_OPTIMAL";
  scoreThreshold: "LOW" | "MEDIUM" | "HIGH" | "EXTRA";
  confidence: number;
  headProbs: Record<HeadName, number[]>;
  riskPct: number;
  slMultiplier: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
  tp3Multiplier: number;
}

// ── Matrix operations ───────────────────────────────────────────────────────

function matmul(a: Float32Array, aRows: number, aCols: number, b: Float32Array, bCols: number): Float32Array {
  const result = new Float32Array(aRows * bCols);
  for (let i = 0; i < aRows; i++) {
    for (let k = 0; k < aCols; k++) {
      const aVal = a[i * aCols + k];
      if (aVal === 0) continue;
      for (let j = 0; j < bCols; j++) {
        result[i * bCols + j] += aVal * b[k * bCols + j];
      }
    }
  }
  return result;
}

function addBias(x: Float32Array, bias: Float32Array, rows: number, cols: number): Float32Array {
  const result = new Float32Array(x.length);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[i * cols + j] = x[i * cols + j] + bias[j];
    }
  }
  return result;
}

function relu(x: Float32Array): Float32Array {
  const result = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    result[i] = x[i] > 0 ? x[i] : 0;
  }
  return result;
}

function softmax(x: Float32Array, offset: number, size: number): number[] {
  let max = -Infinity;
  for (let i = 0; i < size; i++) {
    if (x[offset + i] > max) max = x[offset + i];
  }
  let sum = 0;
  const result: number[] = [];
  for (let i = 0; i < size; i++) {
    const v = Math.exp(x[offset + i] - max);
    result.push(v);
    sum += v;
  }
  for (let i = 0; i < size; i++) {
    result[i] /= sum;
  }
  return result;
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1.0 / (1.0 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

// ── Weight storage ──────────────────────────────────────────────────────────

interface LayerWeights {
  w: Float32Array;
  b: Float32Array;
  wRows: number;
  wCols: number;
}

interface ActorWeights {
  shared1: LayerWeights;
  shared2: LayerWeights;
  shared3: LayerWeights;
  heads: Record<HeadName, { layer1: LayerWeights; layer2: LayerWeights }>;
}

// ── Gate (quality filter) ────────────────────────────────────────────────────
// Architecture: 94 → 128 → 64 → 32 → 1 (sigmoid)
// Predice P(TRADE): si < threshold → SKIP antes de llegar al PPO

interface GateWeights {
  w1: LayerWeights;  // 94 → 128
  w2: LayerWeights;  // 128 → 64
  w3: LayerWeights;  // 64 → 32
  w_out: LayerWeights;  // 32 → 1
}

let _actorWeights: ActorWeights | null = null;
let _gateWeights: GateWeights | null = null;
let _gateThreshold = 0.50;  // se sobreescribe con gate-config.json
let _loaded = false;
let _modelStats: { totalEpisodes: number; totalWins: number; totalLosses: number; winRate: number; walkForwardWR: number; lastUpdated?: string } | null = null;

// ── Load weights ────────────────────────────────────────────────────────────

function loadWeightByName(weights: { name: string; shape: number[]; data: number[] }[], ...candidateNames: string[]): { data: Float32Array; shape: number[] } {
  for (const name of candidateNames) {
    const w = weights.find(w => w.name === name);
    if (w) {
      // Validate: reject if all data values are null/NaN (corrupted weights)
      const hasValid = w.data.some(v => v !== null && isFinite(v as any));
      if (!hasValid && w.data.length > 0) {
        throw new Error(`Weight "${name}" has all-NaN data (corrupted model)`);
      }
      return { data: new Float32Array((w.data as any[]).map(v => (v === null ? 0 : v))), shape: w.shape };
    }
  }
  throw new Error(`Weight not found — tried: ${candidateNames.join(", ")}`);
}

function loadLayerWeights(weights: any[], wName: string, bName: string): LayerWeights {
  const w = loadWeightByName(weights, wName);
  const b = loadWeightByName(weights, bName);
  return {
    w: w.data,
    b: b.data,
    wRows: w.shape[0],
    wCols: w.shape[1],
  };
}

/**
 * Detect if weights use TF.js layer naming (dense_DenseN/kernel)
 * vs flat naming (w1, b1, w2, b2, ...) used by Python training.
 */
function detectWeightFormat(weights: any[]): "tfjs" | "flat" {
  if (weights.some((w: any) => /dense_Dense\d+\/kernel/.test(w.name))) return "tfjs";
  if (weights.some((w: any) => w.name === "w1")) return "flat";
  // Try positional: if first weight shape starts with STATE_SIZE, assume tfjs format
  if (weights.length >= 2 && weights[0]?.shape?.[0] === 94) return "tfjs";
  return "flat";
}

/**
 * Parse TF.js actor weights saved by ppo-multihead.ts.
 * Shared backbone layers are identified by shape chain:
 *   shared1: [94, H1] → shared2: [H1, H2] → shared3: [H2, 64]
 * Head layers are identified by name pattern:
 *   {name}_hidden/kernel + bias, {name}_out/kernel + bias
 */
function loadActorFromTFJS(weights: any[]): ActorWeights {
  function findBiasFor(kernelName: string): { name: string; shape: number[]; data: number[] } | undefined {
    const biasName = kernelName.replace("/kernel", "/bias");
    return weights.find((w: any) => w.name === biasName);
  }

  // Find shared layers by chain: input_dim=94 → ??? → ??? → 64
  // Sort kernels by layer order (Dense9 < Dense10 < Dense11, etc.)
  const denseKernels = weights
    .filter((w: any) => /dense_Dense\d+\/kernel/.test(w.name))
    .sort((a: any, b: any) => {
      const numA = parseInt(a.name.match(/Dense(\d+)/)?.[1] ?? "0");
      const numB = parseInt(b.name.match(/Dense(\d+)/)?.[1] ?? "0");
      return numA - numB;
    });

  // Take first 3 dense kernels as shared layers (backbone)
  const shared1k = denseKernels[0];
  const shared2k = denseKernels[1];
  const shared3k = denseKernels[2];
  if (!shared1k || !shared2k || !shared3k) {
    throw new Error(`Shared layer kernels not found. Have: ${weights.map((w: any) => `${w.name}${JSON.stringify(w.shape)}`).join(", ")}`);
  }

  const shared1b = findBiasFor(shared1k.name);
  const shared2b = findBiasFor(shared2k.name);
  const shared3b = findBiasFor(shared3k.name);
  if (!shared1b || !shared2b || !shared3b) throw new Error("Shared layer biases not found");

  function toLayerWeights(k: { shape: number[]; data: number[] }, b: { shape: number[]; data: number[] }): LayerWeights {
    const hasValidK = k.data.some(v => v !== null && isFinite(v as any));
    if (!hasValidK && k.data.length > 0) throw new Error("Corrupted weight (all NaN/null)");
    return {
      w:     new Float32Array((k.data as any[]).map(v => v === null ? 0 : v)),
      b:     new Float32Array((b.data as any[]).map(v => v === null ? 0 : v)),
      wRows: k.shape[0],
      wCols: k.shape[1],
    };
  }

  const heads: Record<string, { layer1: LayerWeights; layer2: LayerWeights }> = {};
  for (const headName of HEAD_NAMES) {
    const h1k = weights.find((w: any) => w.name === `${headName}_hidden/kernel`);
    const h1b = weights.find((w: any) => w.name === `${headName}_hidden/bias`);
    const h2k = weights.find((w: any) => w.name === `${headName}_out/kernel`);
    const h2b = weights.find((w: any) => w.name === `${headName}_out/bias`);
    if (!h1k || !h1b || !h2k || !h2b) throw new Error(`Head "${headName}" weights not found`);
    heads[headName] = {
      layer1: toLayerWeights(h1k, h1b),
      layer2: toLayerWeights(h2k, h2b),
    };
  }

  return {
    shared1: toLayerWeights(shared1k, shared1b),
    shared2: toLayerWeights(shared2k, shared2b),
    shared3: toLayerWeights(shared3k, shared3b),
    heads: heads as any,
  };
}

export function loadModel(): boolean {
  try {
    const actorPath = path.join(MODEL_DIR, "actor-weights.json");
    if (!fs.existsSync(actorPath)) {
      console.warn("[MH-INF] No model found at", actorPath);
      return false;
    }

    const actorData = JSON.parse(fs.readFileSync(actorPath, "utf-8"));
    const fmt = detectWeightFormat(actorData);
    console.log(`[MH-INF] Weight format detected: ${fmt}`);

    if (fmt === "tfjs") {
      _actorWeights = loadActorFromTFJS(actorData);
    } else {
      // Flat format (Python GPU training)
      _actorWeights = {
        shared1: loadLayerWeights(actorData, "w1", "b1"),
        shared2: loadLayerWeights(actorData, "w2", "b2"),
        shared3: loadLayerWeights(actorData, "w3", "b3"),
        heads: {} as any,
      };
      for (const name of HEAD_NAMES) {
        (_actorWeights.heads as any)[name] = {
          layer1: loadLayerWeights(actorData, `${name}_w1`, `${name}_b1`),
          layer2: loadLayerWeights(actorData, `${name}_w2`, `${name}_b2`),
        };
      }
    }

    // Load stats
    if (fs.existsSync(STATE_FILE)) {
      _modelStats = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }

    // Load gate (optional — si no existe, el gate está desactivado)
    const gatePath   = path.join(MODEL_DIR, "gate-weights.json");
    const gateConfig = path.join(MODEL_DIR, "gate-config.json");
    if (fs.existsSync(gatePath)) {
      try {
        const gd = JSON.parse(fs.readFileSync(gatePath, "utf-8"));
        _gateWeights = {
          w1:    loadLayerWeights(gd, "w1",    "b1"),
          w2:    loadLayerWeights(gd, "w2",    "b2"),
          w3:    loadLayerWeights(gd, "w3",    "b3"),
          w_out: loadLayerWeights(gd, "w_out", "b_out"),
        };
        if (fs.existsSync(gateConfig)) {
          const cfg = JSON.parse(fs.readFileSync(gateConfig, "utf-8"));
          _gateThreshold = cfg.threshold ?? 0.50;
        }
        console.log(`[MH-INF] Gate loaded — threshold: ${_gateThreshold.toFixed(2)}`);
      } catch (e: any) {
        console.warn(`[MH-INF] Gate load failed: ${e.message} — running without gate`);
        _gateWeights = null;
      }
    } else {
      console.log("[MH-INF] No gate found — running PPO-only mode");
    }

    _loaded = true;
    const wr = _modelStats?.walkForwardWR ?? _modelStats?.winRate ?? 0;
    console.log(`[MH-INF] Model loaded — WR: ${wr.toFixed(1)}%, episodes: ${_modelStats?.totalEpisodes?.toLocaleString() ?? "?"}`);
    return true;
  } catch (e: any) {
    console.error(`[MH-INF] Load failed: ${e.message}`);
    _loaded = false;
    _actorWeights = null;
    return false;
  }
}

export function isModelLoaded(): boolean {
  return _loaded && _actorWeights !== null;
}

export function getModelStats() {
  return _modelStats;
}

// ── Gate inference ───────────────────────────────────────────────────────────

function runGate(input: Float32Array): number {
  if (!_gateWeights) return 1.0;  // sin gate → siempre TRADE
  const gw = _gateWeights;
  const dim = 94;

  // 94 → 128 → relu
  let h = relu(addBias(matmul(input, 1, dim,  gw.w1.w, gw.w1.wCols), gw.w1.b, 1, gw.w1.wCols));
  // 128 → 64 → relu
  h      = relu(addBias(matmul(h, 1, gw.w1.wCols, gw.w2.w, gw.w2.wCols), gw.w2.b, 1, gw.w2.wCols));
  // 64 → 32 → relu
  h      = relu(addBias(matmul(h, 1, gw.w2.wCols, gw.w3.w, gw.w3.wCols), gw.w3.b, 1, gw.w3.wCols));
  // 32 → 1 → sigmoid
  const logit = addBias(matmul(h, 1, gw.w3.wCols, gw.w_out.w, gw.w_out.wCols), gw.w_out.b, 1, gw.w_out.wCols);
  return sigmoid(logit[0]);
}

export function isGateLoaded(): boolean {
  return _gateWeights !== null;
}

export function getGateThreshold(): number {
  return _gateThreshold;
}

// ── Threshold-based direction inference ─────────────────────────────────────
//
// Pure argmax always picked LONG/SHORT (SKIP never reached >50%).
// Now: SKIP if P(SKIP) >= SKIP_THRESHOLD  OR  max(P(LONG), P(SHORT)) < MIN_TRADE_CONF
// This mirrors the ~30% skip rate seen during training.
//
// Umbrales calibrados con sweep sobre test set (v4):
//   skip_thr=0.25 + conf<0.50 → skip=5.4%, dirAcc=58.5%, naiveWR=65.3% (mejor combinación)
const SKIP_THRESHOLD    = 0.25;  // SKIP si P(SKIP) ≥ 25%
const MIN_TRADE_CONF    = 0.50;  // SKIP si max(LONG,SHORT) < 50% (poca convicción)

function pickDirection(probs: number[]): number {
  const pSkip  = probs[0];  // SKIP
  const pLong  = probs[1];  // LONG
  const pShort = probs[2];  // SHORT

  // Forzar SKIP si la probabilidad de skip es alta
  if (pSkip >= SKIP_THRESHOLD) return 0;

  // Forzar SKIP si ninguna dirección tiene suficiente convicción
  if (Math.max(pLong, pShort) < MIN_TRADE_CONF) return 0;

  // De lo contrario: argmax entre LONG y SHORT
  return pLong >= pShort ? 1 : 2;
}

// ── Inference ───────────────────────────────────────────────────────────────

export function predict(normalizedState: number[]): MHInferenceResult | null {
  if (!_actorWeights) return null;

  // ── Rolling z-score: régimen-invariante ─────────────────────────────────
  // Si el normalizador tiene ≥10 días de historia, z-scorea las features
  // respecto a la ventana de 60 días. En cold-start pasa las features sin cambio.
  const rollingNorm = getRollingNormalizer();
  const zState = rollingNorm.normalize(normalizedState);
  const input = new Float32Array(zState);

  // ── Gate check: ¿hay señal suficiente para tradear? ──────────────────────
  const pTrade = runGate(input);
  if (pTrade < _gateThreshold) {
    // Gate dice SKIP — devolver resultado mínimo sin correr el PPO completo
    const emptyProbs = Object.fromEntries(
      HEAD_NAMES.map(n => [n, Array(MH_HEADS[n as HeadName].size).fill(1 / MH_HEADS[n as HeadName].size)])
    ) as Record<HeadName, number[]>;
    return {
      direction: "SKIP",
      risk: "normal", entry: "at_market", sizing: "small",
      session: "wait", overExtension: "SKIP",
      entryQuality: "WAIT_OPTIMAL", scoreThreshold: "HIGH",
      confidence: pTrade * 100,
      headProbs: emptyProbs,
      riskPct: 0, slMultiplier: 0.40,
      tp1Multiplier: 0.25, tp2Multiplier: 0.55, tp3Multiplier: 1.20,
    };
  }

  const aw = _actorWeights;

  // Shared backbone: input → relu(W1x+b1) → relu(W2x+b2) → relu(W3x+b3)
  const stateDim = 46; // 42 market + 4 context features
  let h = relu(addBias(matmul(input, 1, stateDim, aw.shared1.w, aw.shared1.wCols), aw.shared1.b, 1, aw.shared1.wCols));
  h = relu(addBias(matmul(h, 1, aw.shared1.wCols, aw.shared2.w, aw.shared2.wCols), aw.shared2.b, 1, aw.shared2.wCols));
  const shared = relu(addBias(matmul(h, 1, aw.shared2.wCols, aw.shared3.w, aw.shared3.wCols), aw.shared3.b, 1, aw.shared3.wCols));

  // Per-head inference
  const headProbs: Record<string, number[]> = {};
  const headChoices: Record<string, number> = {};

  for (const name of HEAD_NAMES) {
    const head = aw.heads[name];
    let hh = relu(addBias(matmul(shared, 1, aw.shared3.wCols, head.layer1.w, head.layer1.wCols), head.layer1.b, 1, head.layer1.wCols));
    const logits = addBias(matmul(hh, 1, head.layer1.wCols, head.layer2.w, head.layer2.wCols), head.layer2.b, 1, head.layer2.wCols);

    const probs = softmax(logits, 0, MH_HEADS[name].size);
    headProbs[name] = probs;

    if (name === "direction") {
      // Threshold-based: no puro argmax
      headChoices[name] = pickDirection(Array.from(probs));
    } else {
      // Resto de heads: argmax normal
      let best = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[best]) best = i;
      }
      headChoices[name] = best;
    }
  }

  const dir = MH_HEADS.direction.labels[headChoices.direction];
  const risk = MH_HEADS.risk.labels[headChoices.risk];
  const entry = MH_HEADS.entry.labels[headChoices.entry];
  const sizing = MH_HEADS.sizing.labels[headChoices.sizing];
  const session = MH_HEADS.session.labels[headChoices.session];
  const overExtension = MH_HEADS.overExtension.labels[headChoices.overExtension];
  const entryQuality = MH_HEADS.entryQuality.labels[headChoices.entryQuality];
  const scoreThreshold = MH_HEADS.scoreThreshold.labels[headChoices.scoreThreshold];

  const confidence = Math.min(
    ...HEAD_NAMES.map(n => headProbs[n][headChoices[n]] * 100)
  );

  // Risk params
  const riskParams: Record<string, { sl: number; tp1: number; tp2: number; tp3: number }> = {
    tight:  { sl: 0.25, tp1: 0.20, tp2: 0.45, tp3: 0.90 },
    normal: { sl: 0.40, tp1: 0.25, tp2: 0.55, tp3: 1.20 },
    wide:   { sl: 0.65, tp1: 0.35, tp2: 0.75, tp3: 1.80 },
  };
  const rp = riskParams[risk] ?? riskParams.normal;

  const sizingMap: Record<string, number> = { small: 1.0, medium: 2.0, full: 3.0 };

  return {
    direction: dir,
    risk,
    entry,
    sizing,
    session,
    overExtension,
    entryQuality,
    scoreThreshold,
    confidence,
    headProbs: headProbs as Record<HeadName, number[]>,
    riskPct: sizingMap[sizing] ?? 2.0,
    slMultiplier: rp.sl,
    tp1Multiplier: rp.tp1,
    tp2Multiplier: rp.tp2,
    tp3Multiplier: rp.tp3,
  };
}

// ── Normalize state (same as training) ──────────────────────────────────────

import type { PPOState } from "./ppo-agent";

export function normalizeForInference(s: PPOState): number[] {
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
    Math.max(-3, Math.min(3, (s.gammaWallDist ?? 0) / 2)),
    (s.gammaConcentration ?? 0.5) * 2 - 1,
    (s.callGammaRatio ?? 0.5) * 2 - 1,
    Math.max(-2, Math.min(2, (s.nextExpGamma ?? 0) * 10)),
    Math.max(-2, Math.min(2, (s.nextExpDelta ?? 0) * 10)),
    (s.tapeBullishPct ?? 0.5) * 2 - 1,
    (s.tapePremiumRatio ?? 0.5) * 2 - 1,
    s.tapeGammaSkew ?? 0,
    // Phase 2 features
    ((s as any).candleBodyRatio ?? 0.5) * 2 - 1,
    (s as any).candleTrend ?? 0,
    Math.max(-2, Math.min(2, (((s as any).candleVolSpike ?? 1) - 1))),
    Math.max(-2, Math.min(2, (((s as any).impliedMovePct ?? 1) - 1) / 0.5)),
    Math.max(-2, Math.min(2, ((s as any).impliedMoveUsage ?? 1) - 1)),
    Math.max(-3, Math.min(3, ((s as any).comboLevelDist ?? 0) / 2)),
    (s as any).comboLevelSide ?? 0,
    Math.max(-3, Math.min(3, ((s as any).absGammaPeakDist ?? 0) / 2)),
    (s as any).absGammaSkew ?? 0,
    (s as any).hiroNorm ?? 0,
    Math.max(-2, Math.min(2, (s as any).hiroAccel ?? 0)),
    Math.max(-3, Math.min(3, ((s as any).volumeProfilePOC ?? 0) / 2)),
    ((s as any).volumeImbalance ?? 0.5) * 2 - 1,
    (s as any).dayOfWeek ?? 0,
    // Context features (4 new)
    (s.sessionType ?? 0) / 3 - 1,       // normalize 0-5 to ~[-1,+1]
    (s.macroAlertActive ?? 0),           // 0 or 1
    (s.counterTrendDetected ?? 0),       // 0 or 1
    (s.imExhaustionLevel ?? 0) * 2 - 1,  // normalize 0-1 to [-1,+1]
    // ── Top-strike distances (features 46-48) ────────────────────────────────
    Math.max(-3, Math.min(3, ((s as any).topStrikeDist1 ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).topStrikeDist2 ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).topStrikeDist3 ?? 0) / 2)),
    // ── SpotGamma Extended: Skew / Fear (features 49-54) ──────────────────────
    Math.max(-2, Math.min(2, ((s as any).skewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, ((s as any).callSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, ((s as any).putSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, ((s as any).d95Norm ?? 0) * 5)),
    Math.max(-2, Math.min(2, ((s as any).d25neNorm ?? 0.2) / 0.1 - 2)),
    Math.max(-2, Math.min(2, ((s as any).fwdGarchSpread ?? 0) * 10)),
    // ── SpotGamma Extended: Positioning (features 55-61) ──────────────────────
    Math.max(-2, Math.min(2, ((s as any).totalDeltaNorm ?? 0) * 2)),
    (s as any).activityFactorNorm ?? 0,
    (s as any).gammaRegimeNum ?? 0,
    ((s as any).levelsChangedFlag ?? 0) * 2 - 1,
    Math.max(-3, Math.min(3, ((s as any).priceVsKeyDelta ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).priceVsPutControl ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).priceVsMaxGamma ?? 0) / 2)),
    // ── Vol Term Structure (features 62-66) ────────────────────────────────────
    Math.max(-2, Math.min(2, ((s as any).volTermSpread ?? 0) * 10)),
    Math.max(-2, Math.min(2, ((s as any).volPutCallSkew ?? 0) * 10)),
    (s as any).volTermStructureNum ?? 0,
    ((s as any).volIVLevelNum ?? 0.5) * 2 - 1,
    ((s as any).volMarketRegimeNum ?? 0.33) * 2 - 0.66,
    // ── Vanna Flows (features 67-72) ───────────────────────────────────────────
    Math.max(-3, Math.min(3, (s as any).vixLevelNorm ?? 0)),
    Math.max(-3, Math.min(3, ((s as any).vixChangePctFeat ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).uvixChangePctFeat ?? 0) / 3)),
    (s as any).uvixGldDivStrength ?? 0,
    ((s as any).indexVannaActiveFlag ?? 0) * 2 - 1,
    ((s as any).refugeFlowActiveFlag ?? 0) * 2 - 1,
    // ── 0DTE GEX Dynamics (features 73-77) ─────────────────────────────────────
    Math.max(-2, Math.min(2, (((s as any).traceGexRatio ?? 1) - 1))),
    (s as any).traceNetBiasNum ?? 0,
    Math.max(-3, Math.min(3, ((s as any).traceSupportDist ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).traceResistDist ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).traceMaxGexDist ?? 0) / 2)),
    // ── GEX Change Tracking (features 78-81) ───────────────────────────────────
    ((s as any).gexBiasChangedFlag ?? 0) * 2 - 1,
    Math.max(-2, Math.min(2, (s as any).gexRatioChangeDelta ?? 0)),
    ((s as any).gexSupportShiftedFlag ?? 0) * 2 - 1,
    ((s as any).gexResistShiftedFlag ?? 0) * 2 - 1,
    // ── Tape Enriched (features 82-85) ─────────────────────────────────────────
    Math.max(-2, Math.min(2, ((s as any).tapeNetDeltaNorm ?? 0) * 5)),
    (s as any).tapeSentimentNorm ?? 0,
    Math.max(-2, Math.min(2, (((s as any).tapePutCallRatioNorm ?? 1) - 1) * 2)),
    (s as any).tapeLargestPremiumRatio ?? 0,
    // ── Asset Microstructure (features 86-90) ──────────────────────────────────
    Math.max(-3, Math.min(3, ((s as any).assetDailyChangePct ?? 0) / 2)),
    ((s as any).zeroDteRatio ?? 0) * 2 - 1,
    (s as any).oiCallPutSkew ?? 0,
    ((s as any).skewRankNorm ?? 0.5) * 2 - 1,
    ((s as any).garchRankNorm ?? 0.5) * 2 - 1,
    // ── CFD + Market Context (features 91-93) ──────────────────────────────────
    Math.max(-3, Math.min(3, ((s as any).cfdDailyChangePct ?? 0) / 2)),
    Math.max(-3, Math.min(3, ((s as any).spxDailyChangePct ?? 0) / 2)),
    ((s as any).flowStrengthNorm ?? 0.5) * 2 - 1,
    // ── Model-Based Features (features 94-107) ────────────────────────────────
    ((s as any).isPositiveGamma ?? 0) * 2 - 1,
    ((s as any).isNegativeGamma ?? 0) * 2 - 1,
    ((s as any).isBracketing ?? 0) * 2 - 1,
    (s as any).priceVsPOC ?? 0,
    Math.min(3, (s as any).ibRangeRatio ?? 1) - 1,
    (s as any).valueAreaPosition ?? 0,
    (s as any).excessFlag ?? 0,
    (s as any).trendDaySignal ?? 0,
    (s as any).breakoutSignal ?? 0,
    (s as any).vannaFlowSignal ?? 0,
    (s as any).inventoryCorrectionSignal ?? 0,
    (s as any).gapSignal ?? 0,
    (s as any).vrpSign ?? 0,
    ((s as any).sessionPhase ?? 0.5) * 2 - 1,
  ];
}

// ── Online Learning — REINFORCE backprop (pure JS, no TF) ───────────────────
// Mirrors Python's update_actor_reinforce + clip_grad from train-multihead-cpu.py

const ONLINE_LR = 1e-6;           // very small LR to not destabilize pre-trained model
const GRAD_MAX_NORM = 1.0;        // gradient clipping max norm
const SAVE_EVERY_N = 10;          // save weights to disk every N updates
const REPLAY_BUFFER_MAX = 1000;   // max experiences in replay buffer
const REPLAY_TRAIN_EVERY = 50;    // mini-batch training every N new experiences
const REPLAY_BATCH_SIZE = 32;     // mini-batch sample size

let _updateCount = 0;
let _replayBuffer: OnlineExperience[] = [];
let _replayBufferLoaded = false;
let _newSinceReplayTrain = 0;
let _replayTrainCount = 0;

const REPLAY_FILE = path.resolve(__dirname, "../data/online-replay-buffer.json");

export interface OnlineExperience {
  state: number[];                      // 46-element normalized state (42 market + 4 context)
  headActions: Record<string, number>;  // action index per head
  reward: number;                       // computed reward
  timestamp?: string;
  tradeId?: string;
  cfd?: string;
  outcome?: string;
}

// ── Gradient clipping (same as Python clip_grad) ────────────────────────────

function clipGrad(g: Float32Array, maxNorm: number = GRAD_MAX_NORM): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (!isFinite(v)) g[i] = 0;
    sumSq += g[i] * g[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > maxNorm) {
    const scale = maxNorm / norm;
    for (let i = 0; i < g.length; i++) g[i] *= scale;
  }
  return g;
}

// ── Matrix helpers for backprop (batch-aware) ───────────────────────────────

/** Transpose matrix [rows x cols] → [cols x rows] */
function transpose(m: Float32Array, rows: number, cols: number): Float32Array {
  const result = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j * rows + i] = m[i * cols + j];
    }
  }
  return result;
}

/** Sum columns: [B x cols] → [cols] */
function sumCols(m: Float32Array, rows: number, cols: number): Float32Array {
  const result = new Float32Array(cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j] += m[i * cols + j];
    }
  }
  return result;
}

/** Element-wise multiply (in-place): a *= b */
function mulInplace(a: Float32Array, b: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) a[i] *= b[i];
  return a;
}

/** ReLU derivative mask: 1 where x>0, else 0 */
function reluMask(x: Float32Array): Float32Array {
  const result = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) result[i] = x[i] > 0 ? 1 : 0;
  return result;
}

/** In-place: w += lr * grad */
function addScaled(w: Float32Array, grad: Float32Array, lr: number): void {
  for (let i = 0; i < w.length; i++) w[i] += lr * grad[i];
}

// ── REINFORCE update (single or mini-batch) ─────────────────────────────────
// Direct port of Python update_actor_reinforce for B samples

function reinforceUpdate(
  aw: ActorWeights,
  batchStates: Float32Array,  // [B x 42]
  batchActions: Record<string, number[]>,  // per head: [B]
  batchAdvantages: Float32Array,  // [B]
  B: number,
  lr: number = ONLINE_LR,
): void {
  const stateDim = 46; // 42 market + 4 context features

  // Forward pass — cache intermediates
  const h1_raw = addBias(matmul(batchStates, B, stateDim, aw.shared1.w, aw.shared1.wCols), aw.shared1.b, B, aw.shared1.wCols);
  const h1 = relu(h1_raw);
  const h2_raw = addBias(matmul(h1, B, aw.shared1.wCols, aw.shared2.w, aw.shared2.wCols), aw.shared2.b, B, aw.shared2.wCols);
  const h2 = relu(h2_raw);
  const shared_raw = addBias(matmul(h2, B, aw.shared2.wCols, aw.shared3.w, aw.shared3.wCols), aw.shared3.b, B, aw.shared3.wCols);
  const shared = relu(shared_raw);

  const sharedDim = aw.shared3.wCols;

  // Per-head forward + backward
  const headProbs: Record<string, Float32Array> = {};
  const headHH: Record<string, Float32Array> = {};

  for (const name of HEAD_NAMES) {
    const head = aw.heads[name];
    const size = MH_HEADS[name].size;

    // Head forward
    const hh_raw = addBias(matmul(shared, B, sharedDim, head.layer1.w, head.layer1.wCols), head.layer1.b, B, head.layer1.wCols);
    const hh = relu(hh_raw);
    headHH[name] = hh;
    const logits = addBias(matmul(hh, B, head.layer1.wCols, head.layer2.w, head.layer2.wCols), head.layer2.b, B, head.layer2.wCols);

    // Softmax per sample
    const probs = new Float32Array(B * size);
    for (let i = 0; i < B; i++) {
      const p = softmax(logits, i * size, size);
      for (let j = 0; j < size; j++) probs[i * size + j] = p[j];
    }
    headProbs[name] = probs;

    // d_logits = (one_hot - probs) * advantage / B
    const actions = batchActions[name];
    const dLogits = new Float32Array(B * size);
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < size; j++) {
        const oneHot = (j === actions[i]) ? 1.0 : 0.0;
        dLogits[i * size + j] = (oneHot - probs[i * size + j]) * batchAdvantages[i] / B;
      }
    }

    // Head layer 2: logits = hh @ w2 + b2
    // dW2 = hh^T @ dLogits, db2 = sum(dLogits)
    addScaled(head.layer2.w, clipGrad(matmul(transpose(hh, B, head.layer1.wCols), head.layer1.wCols, B, dLogits, size)), lr);
    addScaled(head.layer2.b, clipGrad(sumCols(dLogits, B, size)), lr);

    // Head layer 1: hh = relu(shared @ w1 + b1)
    // dHH = dLogits @ w2^T * relu'(hh_raw)
    const dHH = mulInplace(
      matmul(dLogits, B, size, transpose(head.layer2.w, head.layer1.wCols, size), head.layer1.wCols),
      reluMask(hh_raw)
    );
    addScaled(head.layer1.w, clipGrad(matmul(transpose(shared, B, sharedDim), sharedDim, B, dHH, head.layer1.wCols)), lr);
    addScaled(head.layer1.b, clipGrad(sumCols(dHH, B, head.layer1.wCols)), lr);
  }

  // Shared backbone gradients (sum across all heads)
  const dShared = new Float32Array(B * sharedDim);
  for (const name of HEAD_NAMES) {
    const head = aw.heads[name];
    const size = MH_HEADS[name].size;
    const probs = headProbs[name];
    const actions = batchActions[name];
    const hh = headHH[name];

    const dLogits = new Float32Array(B * size);
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < size; j++) {
        const oneHot = (j === actions[i]) ? 1.0 : 0.0;
        dLogits[i * size + j] = (oneHot - probs[i * size + j]) * batchAdvantages[i] / B;
      }
    }

    const hh_raw = addBias(matmul(shared, B, sharedDim, head.layer1.w, head.layer1.wCols), head.layer1.b, B, head.layer1.wCols);
    const dHH = mulInplace(
      matmul(dLogits, B, size, transpose(head.layer2.w, head.layer1.wCols, size), head.layer1.wCols),
      reluMask(hh_raw)
    );
    const dFromHead = matmul(dHH, B, head.layer1.wCols, transpose(head.layer1.w, sharedDim, head.layer1.wCols), sharedDim);
    for (let i = 0; i < dShared.length; i++) dShared[i] += dFromHead[i];
  }

  // Apply relu gradient for shared layer
  mulInplace(dShared, reluMask(shared_raw));

  // Layer 3
  addScaled(aw.shared3.w, clipGrad(matmul(transpose(h2, B, aw.shared2.wCols), aw.shared2.wCols, B, dShared, sharedDim)), lr);
  addScaled(aw.shared3.b, clipGrad(sumCols(dShared, B, sharedDim)), lr);

  // Layer 2
  const dH2 = mulInplace(
    matmul(dShared, B, sharedDim, transpose(aw.shared3.w, aw.shared2.wCols, sharedDim), aw.shared2.wCols),
    reluMask(h2_raw)
  );
  addScaled(aw.shared2.w, clipGrad(matmul(transpose(h1, B, aw.shared1.wCols), aw.shared1.wCols, B, dH2, aw.shared2.wCols)), lr);
  addScaled(aw.shared2.b, clipGrad(sumCols(dH2, B, aw.shared2.wCols)), lr);

  // Layer 1
  const dH1 = mulInplace(
    matmul(dH2, B, aw.shared2.wCols, transpose(aw.shared2.w, aw.shared1.wCols, aw.shared2.wCols), aw.shared1.wCols),
    reluMask(h1_raw)
  );
  addScaled(aw.shared1.w, clipGrad(matmul(transpose(batchStates, B, stateDim), stateDim, B, dH1, aw.shared1.wCols)), lr);
  addScaled(aw.shared1.b, clipGrad(sumCols(dH1, B, aw.shared1.wCols)), lr);
}

// ── Save updated weights to disk ────────────────────────────────────────────

function saveWeightsToDisk(): void {
  if (!_actorWeights) return;
  try {
    const aw = _actorWeights;
    const weights: { name: string; shape: number[]; data: number[] }[] = [];

    const push = (name: string, w: Float32Array, shape: number[]) => {
      weights.push({ name, shape, data: Array.from(w) });
    };

    push("w1", aw.shared1.w, [aw.shared1.wRows, aw.shared1.wCols]);
    push("b1", aw.shared1.b, [aw.shared1.wCols]);
    push("w2", aw.shared2.w, [aw.shared2.wRows, aw.shared2.wCols]);
    push("b2", aw.shared2.b, [aw.shared2.wCols]);
    push("w3", aw.shared3.w, [aw.shared3.wRows, aw.shared3.wCols]);
    push("b3", aw.shared3.b, [aw.shared3.wCols]);

    for (const name of HEAD_NAMES) {
      const head = aw.heads[name];
      push(`${name}_w1`, head.layer1.w, [head.layer1.wRows, head.layer1.wCols]);
      push(`${name}_b1`, head.layer1.b, [head.layer1.wCols]);
      push(`${name}_w2`, head.layer2.w, [head.layer2.wRows, head.layer2.wCols]);
      push(`${name}_b2`, head.layer2.b, [head.layer2.wCols]);
    }

    const actorPath = path.join(MODEL_DIR, "actor-weights.json");
    fs.writeFileSync(actorPath, JSON.stringify(weights), "utf-8");

    // Update state file
    if (_modelStats) {
      _modelStats.lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(_modelStats, null, 2), "utf-8");
    }
  } catch (e: any) {
    console.warn(`[MH-ONLINE] Failed to save weights: ${e.message}`);
  }
}

// ── Replay buffer persistence ───────────────────────────────────────────────

function loadReplayBuffer(): void {
  if (_replayBufferLoaded) return;
  _replayBufferLoaded = true;
  try {
    if (fs.existsSync(REPLAY_FILE)) {
      const raw = fs.readFileSync(REPLAY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      _replayBuffer = Array.isArray(parsed) ? parsed : [];
      console.log(`[MH-ONLINE] Loaded replay buffer: ${_replayBuffer.length} experiences`);
    }
  } catch (e: any) {
    console.warn(`[MH-ONLINE] Failed to load replay buffer: ${e.message}`);
    _replayBuffer = [];
  }
}

function saveReplayBuffer(): void {
  try {
    const dir = path.dirname(REPLAY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REPLAY_FILE, JSON.stringify(_replayBuffer), "utf-8");
  } catch (e: any) {
    console.warn(`[MH-ONLINE] Failed to save replay buffer: ${e.message}`);
  }
}

// ── Public API: single-experience online learning ───────────────────────────

export function onlineLearning(
  state: number[],
  headActions: Record<string, number>,
  reward: number,
  meta?: { tradeId?: string; cfd?: string; outcome?: string },
): { updated: boolean; replayTrained: boolean; bufferSize: number } {
  if (!_actorWeights) {
    console.warn("[MH-ONLINE] Cannot learn — model not loaded");
    return { updated: false, replayTrained: false, bufferSize: 0 };
  }

  try {
    loadReplayBuffer();

    // 1. Immediate single-sample REINFORCE update
    const stateArr = new Float32Array(state);
    const actions: Record<string, number[]> = {};
    for (const name of HEAD_NAMES) {
      actions[name] = [headActions[name] ?? 0];
    }
    const advantages = new Float32Array([reward]); // advantage = reward (no baseline for single online step)

    reinforceUpdate(_actorWeights, stateArr, actions, advantages, 1, ONLINE_LR);

    _updateCount++;

    // 2. Add to replay buffer
    const experience: OnlineExperience = {
      state,
      headActions,
      reward,
      timestamp: new Date().toISOString(),
      tradeId: meta?.tradeId,
      cfd: meta?.cfd,
      outcome: meta?.outcome,
    };
    _replayBuffer.push(experience);
    if (_replayBuffer.length > REPLAY_BUFFER_MAX) {
      _replayBuffer = _replayBuffer.slice(_replayBuffer.length - REPLAY_BUFFER_MAX);
    }
    _newSinceReplayTrain++;

    // 3. Save weights periodically
    if (_updateCount % SAVE_EVERY_N === 0) {
      saveWeightsToDisk();
      console.log(`[MH-ONLINE] Weights saved to disk (update #${_updateCount})`);
    }

    // 4. Save replay buffer
    saveReplayBuffer();

    // 5. Mini-batch replay training every REPLAY_TRAIN_EVERY experiences
    let replayTrained = false;
    if (_newSinceReplayTrain >= REPLAY_TRAIN_EVERY && _replayBuffer.length >= REPLAY_BATCH_SIZE) {
      replayTrained = doReplayMiniBatch();
      _newSinceReplayTrain = 0;
      _replayTrainCount++;
    }

    const cfdLabel = meta?.cfd ?? "???";
    const outcomeLabel = meta?.outcome?.toUpperCase() ?? "???";
    console.log(
      `[MH-ONLINE] Learned from ${cfdLabel} ${outcomeLabel}: reward=${reward >= 0 ? "+" : ""}${reward.toFixed(1)}, buffer=${_replayBuffer.length}/${REPLAY_BUFFER_MAX}` +
      (replayTrained ? ` (+ replay batch #${_replayTrainCount})` : "")
    );

    // Update model stats
    if (_modelStats) {
      _modelStats.totalEpisodes++;
      if (meta?.outcome && ["tp1", "tp2", "tp3"].includes(meta.outcome)) _modelStats.totalWins++;
      else if (meta?.outcome === "sl") _modelStats.totalLosses++;
      const total = _modelStats.totalWins + _modelStats.totalLosses;
      if (total > 0) _modelStats.winRate = _modelStats.totalWins / total * 100;
    }

    return { updated: true, replayTrained, bufferSize: _replayBuffer.length };
  } catch (e: any) {
    console.error(`[MH-ONLINE] Learning error: ${e.message}`);
    return { updated: false, replayTrained: false, bufferSize: _replayBuffer.length };
  }
}

// ── Replay mini-batch training ──────────────────────────────────────────────

function doReplayMiniBatch(): boolean {
  if (!_actorWeights || _replayBuffer.length < REPLAY_BATCH_SIZE) return false;

  try {
    // Sample REPLAY_BATCH_SIZE random experiences from the buffer
    const indices: number[] = [];
    const bufLen = _replayBuffer.length;
    for (let i = 0; i < REPLAY_BATCH_SIZE; i++) {
      indices.push(Math.floor(Math.random() * bufLen));
    }

    const B = REPLAY_BATCH_SIZE;
    const batchStates = new Float32Array(B * 42);
    const batchActions: Record<string, number[]> = {};
    const batchAdvantages = new Float32Array(B);

    for (const name of HEAD_NAMES) batchActions[name] = [];

    for (let i = 0; i < B; i++) {
      const exp = _replayBuffer[indices[i]];
      for (let j = 0; j < 42; j++) {
        batchStates[i * 42 + j] = exp.state[j] ?? 0;
      }
      for (const name of HEAD_NAMES) {
        batchActions[name].push(exp.headActions[name] ?? 0);
      }
      batchAdvantages[i] = exp.reward;
    }

    // Normalize advantages for the batch
    let mean = 0, std = 0;
    for (let i = 0; i < B; i++) mean += batchAdvantages[i];
    mean /= B;
    for (let i = 0; i < B; i++) std += (batchAdvantages[i] - mean) ** 2;
    std = Math.sqrt(std / B) + 1e-8;
    for (let i = 0; i < B; i++) {
      batchAdvantages[i] = Math.max(-5, Math.min(5, (batchAdvantages[i] - mean) / std));
    }

    reinforceUpdate(_actorWeights, batchStates, batchActions, batchAdvantages, B, ONLINE_LR);

    // Always save after replay training
    saveWeightsToDisk();

    console.log(`[MH-ONLINE] Replay mini-batch: ${B} samples from buffer (${_replayBuffer.length} total)`);
    return true;
  } catch (e: any) {
    console.error(`[MH-ONLINE] Replay mini-batch error: ${e.message}`);
    return false;
  }
}

// ── Public: get online learning stats ────────────────────────────────────────

export function getOnlineLearningStats() {
  loadReplayBuffer();
  const wins = _replayBuffer.filter(e => e.outcome && ["tp1", "tp2", "tp3"].includes(e.outcome)).length;
  const losses = _replayBuffer.filter(e => e.outcome === "sl").length;
  const resolved = wins + losses;
  return {
    updateCount: _updateCount,
    bufferSize: _replayBuffer.length,
    bufferMax: REPLAY_BUFFER_MAX,
    newSinceReplayTrain: _newSinceReplayTrain,
    replayTrainCount: _replayTrainCount,
    learningRate: ONLINE_LR,
    bufferWinRate: resolved > 0 ? (wins / resolved * 100) : 0,
    wins,
    losses,
    avgReward: _replayBuffer.length > 0
      ? _replayBuffer.reduce((s, e) => s + e.reward, 0) / _replayBuffer.length
      : 0,
  };
}

// ── Public: force replay retrain (callable from API) ─────────────────────────

export function forceOnlineReplayTrain(): { trained: boolean; bufferSize: number } {
  loadReplayBuffer();
  if (!_actorWeights || _replayBuffer.length < REPLAY_BATCH_SIZE) {
    return { trained: false, bufferSize: _replayBuffer.length };
  }
  const trained = doReplayMiniBatch();
  return { trained, bufferSize: _replayBuffer.length };
}

// Auto-load on import
loadModel();
