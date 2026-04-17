/**
 * ppo-inference-lstm.ts — Inferencia LSTM Multi-Head en TypeScript puro
 *
 * Arquitectura dual-input:
 *   1. Rama LSTM:    secuencia histórica (SEQ_LEN × STATE_SIZE) → lstm_out (LSTM_UNITS,)
 *   2. Rama actual:  estado de hoy (STATE_SIZE,)
 *   Combina ambas → 8 cabezas de decisión
 *
 * El estado LSTM (hidden + cell) persiste entre llamadas del mismo día.
 * Se reinicia con el nuevo buffer histórico cada día de trading.
 *
 * Carga pesos desde:
 *   data/ppo-multihead-model-lstm/actor-weights-lstm.json
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getEpisodeBank } from "./episode-bank.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR  = path.resolve(__dirname, "../data/ppo-multihead-model-lstm");
const WEIGHTS_PATH = path.join(MODEL_DIR, "actor-weights-lstm.json");

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type HeadName =
  | "direction" | "risk" | "entry" | "sizing"
  | "session"   | "overExtension" | "entryQuality" | "scoreThreshold";

export interface LSTMHeadResult {
  direction:       "SKIP" | "LONG" | "SHORT";
  risk:            "tight" | "normal" | "wide";
  entry:           "at_market" | "at_level" | "at_wall";
  sizing:          "small" | "medium" | "full";
  session:         "trade_now" | "wait";
  overExtension:   "TRADE" | "SKIP";
  entryQuality:    "ACCEPT_CAUTION" | "WAIT_OPTIMAL";
  scoreThreshold:  "LOW" | "MEDIUM" | "HIGH" | "EXTRA";
  confidence:      number;
  headProbs: Record<HeadName, number[]>;
  slMultiplier:    number;
  tp1Multiplier:   number;
  tp2Multiplier:   number;
  tp3Multiplier:   number;
}

interface LayerW {
  w: Float32Array; wRows: number; wCols: number;
  b: Float32Array;
}

interface LSTMWeights {
  lstm_units:    number;
  seq_len:       number;
  state_size:    number;
  // LSTM cell
  kernel:        Float32Array;  // (state_size, 4*lstm_units)
  rec_kernel:    Float32Array;  // (lstm_units, 4*lstm_units)
  bias:          Float32Array;  // (4*lstm_units,)
  // Projection layers
  lstm_proj:     LayerW;
  cur_proj:      LayerW;
  // Shared trunk
  shared1:       LayerW;
  shared2:       LayerW;
  trunk:         LayerW;
  // Heads
  heads: Record<HeadName, { h1: LayerW; h2: LayerW }>;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function relu(x: Float32Array): Float32Array {
  const r = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) r[i] = x[i] > 0 ? x[i] : 0;
  return r;
}

function dense(x: Float32Array, lw: LayerW): Float32Array {
  const out = new Float32Array(lw.wCols);
  for (let j = 0; j < lw.wCols; j++) {
    let s = lw.b[j];
    for (let i = 0; i < lw.wRows; i++) s += x[i] * lw.w[i * lw.wCols + j];
    out[j] = s;
  }
  return out;
}

function softmax(x: Float32Array): number[] {
  let mx = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > mx) mx = x[i];
  let sum = 0;
  const r: number[] = [];
  for (let i = 0; i < x.length; i++) { const v = Math.exp(x[i] - mx); r.push(v); sum += v; }
  return r.map(v => v / sum);
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(a.length + b.length);
  r.set(a); r.set(b, a.length);
  return r;
}

// ── LSTM cell ─────────────────────────────────────────────────────────────────
// Keras LSTM gate order: [i, f, c, o]
//   i = input gate  → sigmoid
//   f = forget gate → sigmoid
//   c = cell gate   → tanh
//   o = output gate → sigmoid

function lstmCell(
  x:         Float32Array,  // (input_size,)
  prevH:     Float32Array,  // (lstm_units,)
  prevC:     Float32Array,  // (lstm_units,)
  kernel:    Float32Array,  // (input_size, 4*lstm_units) — row-major
  recKernel: Float32Array,  // (lstm_units, 4*lstm_units)
  bias:      Float32Array,  // (4*lstm_units,)
  inputSize: number,
  units:     number,
): { h: Float32Array; c: Float32Array } {
  const g4 = new Float32Array(4 * units);

  // gates = x @ kernel + h @ recKernel + bias
  for (let j = 0; j < 4 * units; j++) {
    let s = bias[j];
    for (let i = 0; i < inputSize; i++) s += x[i] * kernel[i * 4 * units + j];
    for (let i = 0; i < units; i++)     s += prevH[i] * recKernel[i * 4 * units + j];
    g4[j] = s;
  }

  const newH = new Float32Array(units);
  const newC = new Float32Array(units);
  for (let j = 0; j < units; j++) {
    const ig = sigmoid(g4[j]);                // input gate
    const fg = sigmoid(g4[units + j]);        // forget gate
    const cg = Math.tanh(g4[2 * units + j]); // cell gate
    const og = sigmoid(g4[3 * units + j]);    // output gate
    newC[j] = fg * prevC[j] + ig * cg;
    newH[j] = og * Math.tanh(newC[j]);
  }
  return { h: newH, c: newC };
}

// Run LSTM over a full sequence → return final hidden state
function runLSTM(
  sequence:  number[][],   // (SEQ_LEN, STATE_SIZE)
  kernel:    Float32Array,
  recKernel: Float32Array,
  bias:      Float32Array,
  units:     number,
): Float32Array {
  const inputSize = sequence[0].length;
  let h: Float32Array = new Float32Array(units);
  let c: Float32Array = new Float32Array(units);
  for (const stateArr of sequence) {
    const x = new Float32Array(stateArr);
    const res = lstmCell(x, h, c, kernel, recKernel, bias, inputSize, units);
    h = res.h as Float32Array; c = res.c as Float32Array;
  }
  return h;
}

// ── Weight loading ────────────────────────────────────────────────────────────

let _weights: LSTMWeights | null = null;
let _weightsLoadedAt = 0;
const WEIGHTS_RELOAD_MS = 5 * 60 * 1000; // reload cada 5 min para detectar retrain

function toLayerW(wArr: number[][], bArr: number[]): LayerW {
  const wRows = wArr.length;
  const wCols = wArr[0].length;
  const w = new Float32Array(wRows * wCols);
  for (let i = 0; i < wRows; i++)
    for (let j = 0; j < wCols; j++)
      w[i * wCols + j] = wArr[i][j];
  return { w, b: new Float32Array(bArr), wRows, wCols };
}

function loadWeights(): LSTMWeights | null {
  if (!fs.existsSync(WEIGHTS_PATH)) return null;

  const now = Date.now();
  if (_weights && now - _weightsLoadedAt < WEIGHTS_RELOAD_MS) return _weights;

  try {
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf8"));
    const units = raw.lstm_units as number;

    const kernelFlat = (raw.lstm_kernel as number[][]).flat();
    const recFlat    = (raw.lstm_rec_kernel as number[][]).flat();

    _weights = {
      lstm_units:  units,
      seq_len:     raw.seq_len,
      state_size:  raw.state_size,
      kernel:      new Float32Array(kernelFlat),
      rec_kernel:  new Float32Array(recFlat),
      bias:        new Float32Array(raw.lstm_bias as number[]),
      lstm_proj:   toLayerW(raw.lstm_proj_w, raw.lstm_proj_b),
      cur_proj:    toLayerW(raw.cur_proj_w,  raw.cur_proj_b),
      shared1:     toLayerW(raw.shared1_w,   raw.shared1_b),
      shared2:     toLayerW(raw.shared2_w,   raw.shared2_b),
      trunk:       toLayerW(raw.trunk_w,     raw.trunk_b),
      heads:       {} as any,
    };

    const headNames: HeadName[] = [
      "direction","risk","entry","sizing","session",
      "overExtension","entryQuality","scoreThreshold",
    ];
    for (const hn of headNames) {
      const hd = raw.heads[hn];
      _weights.heads[hn] = {
        h1: toLayerW(hd.h1_w, hd.h1_b),
        h2: toLayerW(hd.h2_w, hd.h2_b),
      };
    }

    _weightsLoadedAt = now;
    console.log(`[LSTM] Pesos cargados — seqLen=${raw.seq_len} lstmUnits=${units}`);
    return _weights;
  } catch (e) {
    console.error("[LSTM] Error cargando pesos:", e);
    return null;
  }
}

export function isLSTMAvailable(): boolean {
  return fs.existsSync(WEIGHTS_PATH);
}

// ── Forward pass ──────────────────────────────────────────────────────────────

function forward(
  sequence:     number[][],   // (SEQ_LEN, STATE_SIZE) — contexto histórico
  currentState: Float32Array, // (STATE_SIZE,) — estado actual del día
  wts:          LSTMWeights,
): Record<HeadName, number[]> {
  // 1. LSTM sobre secuencia histórica
  const lstmOut  = runLSTM(sequence, wts.kernel, wts.rec_kernel, wts.bias, wts.lstm_units);

  // 2. Proyecciones
  const lstmVec = relu(dense(lstmOut,    wts.lstm_proj));
  const curVec  = relu(dense(currentState, wts.cur_proj));

  // 3. Fusión
  const combined = concat(lstmVec, curVec); // (256,)
  const s1 = relu(dense(combined, wts.shared1));
  const s2 = relu(dense(s1,       wts.shared2));
  const tk = relu(dense(s2,       wts.trunk));

  // 4. Cabezas
  const result = {} as Record<HeadName, number[]>;
  for (const hn of Object.keys(wts.heads) as HeadName[]) {
    const h1out = relu(dense(tk, wts.heads[hn].h1));
    const h2out = dense(h1out,   wts.heads[hn].h2);
    result[hn] = softmax(h2out);
  }
  return result;
}

// ── Head label maps ───────────────────────────────────────────────────────────

const DIR_LABELS  = ["SKIP", "LONG", "SHORT"] as const;
const RISK_LABELS = ["tight", "normal", "wide"] as const;
const ENT_LABELS  = ["at_market", "at_level", "at_wall"] as const;
const SIZ_LABELS  = ["small", "medium", "full"] as const;
const SES_LABELS  = ["trade_now", "wait"] as const;
const OE_LABELS   = ["TRADE", "SKIP"] as const;
const EQ_LABELS   = ["ACCEPT_CAUTION", "WAIT_OPTIMAL"] as const;
const ST_LABELS   = ["LOW", "MEDIUM", "HIGH", "EXTRA"] as const;

const SL_MAP  = { tight: 1.0, normal: 1.5, wide: 2.0 };
const TP1_MAP = { tight: 1.0, normal: 1.0, wide: 1.0 };
const TP2_MAP = { tight: 1.5, normal: 2.0, wide: 2.5 };
const TP3_MAP = { tight: 2.0, normal: 3.0, wide: 4.0 };

// ── Public predict ────────────────────────────────────────────────────────────

/**
 * Predicción LSTM.
 *
 * @param currentState    - Estado normalizado del día actual (49 features)
 * @param today           - Fecha actual "YYYY-MM-DD" (para buscar secuencia histórica)
 */
export function predictLSTM(
  currentState: Float32Array | number[],
  today: string,
): LSTMHeadResult | null {
  const wts = loadWeights();
  if (!wts) return null;

  // Obtener secuencia histórica del EpisodeBank
  const bank     = getEpisodeBank();
  const sequence = bank.getHistoricalSequence(today, wts.seq_len);

  const cur = currentState instanceof Float32Array
    ? currentState
    : new Float32Array(currentState);

  const probs = forward(sequence, cur, wts);

  // Argmax por cabeza
  function argmax(arr: number[]): number {
    return arr.indexOf(Math.max(...arr));
  }

  const dirIdx = argmax(probs.direction);
  const rkIdx  = argmax(probs.risk);
  const entIdx = argmax(probs.entry);
  const sizIdx = argmax(probs.sizing);
  const sesIdx = argmax(probs.session);
  const oeIdx  = argmax(probs.overExtension);
  const eqIdx  = argmax(probs.entryQuality);
  const stIdx  = argmax(probs.scoreThreshold);

  const risk = RISK_LABELS[rkIdx];
  const conf = probs.direction[dirIdx];

  return {
    direction:      DIR_LABELS[dirIdx],
    risk,
    entry:          ENT_LABELS[entIdx],
    sizing:         SIZ_LABELS[sizIdx],
    session:        SES_LABELS[sesIdx],
    overExtension:  OE_LABELS[oeIdx],
    entryQuality:   EQ_LABELS[eqIdx],
    scoreThreshold: ST_LABELS[stIdx],
    confidence:     conf,
    headProbs: {
      direction:      probs.direction,
      risk:           probs.risk,
      entry:          probs.entry,
      sizing:         probs.sizing,
      session:        probs.session,
      overExtension:  probs.overExtension,
      entryQuality:   probs.entryQuality,
      scoreThreshold: probs.scoreThreshold,
    },
    slMultiplier:  SL_MAP[risk],
    tp1Multiplier: TP1_MAP[risk],
    tp2Multiplier: TP2_MAP[risk],
    tp3Multiplier: TP3_MAP[risk],
  };
}
