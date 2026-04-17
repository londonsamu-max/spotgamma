/**
 * Bounce Probability Model — Logistic Regression
 *
 * Instead of qualitative L60 scoring, uses a trained logistic regression
 * to predict P(bounce) at a gamma bar given measurable features.
 *
 * Training data: all bar-touch events from the 300-day backtest period.
 * Each event = ETF price touched a fat gamma bar → did it bounce or break?
 *
 * Features (X):
 *   1. vrp (continuous): IV30 - RV30
 *   2. gammaSign (+1/-1): positive = support, negative = resistance
 *   3. barSizeLog: log10(|netGamma|) — normalized bar size
 *   4. riskReversal (continuous): RR value for the symbol
 *   5. rrDelta5d (continuous): RR change over 5 days
 *   6. vixLevel (continuous): VIX closing price
 *   7. ivRank (0-1): implied vol percentile
 *   8. dayOfWeek (0-4): Mon=0 to Fri=4
 *
 * Target (Y): 1 = bounce (price reversed), 0 = break (price continued through)
 *
 * Model: logistic regression P(bounce) = sigmoid(w·x + b)
 * Training: gradient descent on cross-entropy loss
 */

import * as fs from "node:fs";
import * as path from "node:path";

const OUT_DIR = path.resolve(process.cwd(), "backtest/models");

export interface BounceFeatures {
  vrp: number;
  gammaSign: number;      // +1 or -1
  barSizeLog: number;     // log10(|netGamma|)
  riskReversal: number;   // RR value
  rrDelta5d: number;      // RR change
  vixLevel: number;
  ivRank: number;
  dayOfWeek: number;      // 0-4 (Mon-Fri)
}

export interface TrainingExample {
  features: BounceFeatures;
  bounced: boolean;        // true = bounced, false = broke through
  pnlIfBounce: number;    // what you'd make if you traded the bounce
}

interface LogisticModel {
  weights: number[];       // one per feature
  bias: number;
  featureNames: string[];
  trainingSamples: number;
  accuracy: number;
  featureImportance: Record<string, number>; // |weight| normalized
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function featuresToArray(f: BounceFeatures): number[] {
  return [
    f.vrp * 10,           // scale up (VRP is small ~0.01-0.05)
    f.gammaSign,
    f.barSizeLog / 10,    // normalize ~7-10 range
    f.riskReversal * 2,   // scale ~-0.5 to +0.2
    f.rrDelta5d * 20,     // scale small changes
    f.vixLevel / 30,      // normalize ~10-50 range
    f.ivRank,             // already 0-1
    f.dayOfWeek / 4,      // normalize 0-1
  ];
}

const FEATURE_NAMES = ["vrp", "gammaSign", "barSizeLog", "riskReversal", "rrDelta5d", "vixLevel", "ivRank", "dayOfWeek"];

/** Train logistic regression on bounce/break examples */
export function trainBounceModel(examples: TrainingExample[]): LogisticModel {
  const n = examples.length;
  const nFeatures = FEATURE_NAMES.length;
  console.log(`  Training bounce model on ${n} examples...`);

  // Initialize weights
  const weights = new Array(nFeatures).fill(0);
  let bias = 0;
  const lr = 0.01; // learning rate
  const epochs = 500;

  // Prepare data
  const X = examples.map(e => featuresToArray(e.features));
  const Y = examples.map(e => e.bounced ? 1 : 0);

  // Gradient descent
  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalLoss = 0;
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((sum, x, j) => sum + x * weights[j], 0) + bias;
      const pred = sigmoid(z);
      const error = pred - Y[i];

      for (let j = 0; j < nFeatures; j++) {
        gradW[j] += error * X[i][j];
      }
      gradB += error;

      // Cross-entropy loss
      totalLoss += -(Y[i] * Math.log(pred + 1e-10) + (1 - Y[i]) * Math.log(1 - pred + 1e-10));
    }

    // Update
    for (let j = 0; j < nFeatures; j++) {
      weights[j] -= lr * gradW[j] / n;
    }
    bias -= lr * gradB / n;

    if ((epoch + 1) % 100 === 0) {
      console.log(`    Epoch ${epoch + 1}: loss=${(totalLoss / n).toFixed(4)}`);
    }
  }

  // Compute accuracy
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const z = X[i].reduce((sum, x, j) => sum + x * weights[j], 0) + bias;
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === Y[i]) correct++;
  }
  const accuracy = correct / n;

  // Feature importance (normalized |weight|)
  const absSum = weights.reduce((s, w) => s + Math.abs(w), 0);
  const featureImportance: Record<string, number> = {};
  for (let j = 0; j < nFeatures; j++) {
    featureImportance[FEATURE_NAMES[j]] = Math.round((Math.abs(weights[j]) / absSum) * 1000) / 10;
  }

  console.log(`    Accuracy: ${(accuracy * 100).toFixed(1)}%`);
  console.log(`    Feature importance:`, featureImportance);
  console.log(`    Weights:`, weights.map(w => w.toFixed(4)));
  console.log(`    Bias: ${bias.toFixed(4)}`);

  const model: LogisticModel = {
    weights,
    bias,
    featureNames: FEATURE_NAMES,
    trainingSamples: n,
    accuracy,
    featureImportance,
  };

  // Save
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "bounce-model.json"), JSON.stringify(model, null, 2));

  return model;
}

// Cache
let cachedModel: LogisticModel | null = null;

export function loadBounceModel(): LogisticModel | null {
  if (cachedModel) return cachedModel;
  const file = path.join(OUT_DIR, "bounce-model.json");
  if (!fs.existsSync(file)) return null;
  cachedModel = JSON.parse(fs.readFileSync(file, "utf-8"));
  return cachedModel;
}

/** Predict P(bounce) for a given set of features */
export function predictBounce(features: BounceFeatures): { probability: number; prediction: "bounce" | "break"; confidence: number } {
  const model = loadBounceModel();
  if (!model) return { probability: 0.5, prediction: "bounce", confidence: 0 };

  const x = featuresToArray(features);
  const z = x.reduce((sum, xi, j) => sum + xi * model.weights[j], 0) + model.bias;
  const prob = sigmoid(z);

  return {
    probability: Math.round(prob * 1000) / 10, // % with 1 decimal
    prediction: prob >= 0.5 ? "bounce" : "break",
    confidence: Math.round(Math.abs(prob - 0.5) * 200), // 0-100 scale
  };
}
