/**
 * PPO (Proximal Policy Optimization) Agent for Trading
 *
 * Replaces Q-tables with neural networks for continuous state space.
 * Actor-Critic architecture:
 *   Actor:  state → action probabilities (LONG/SHORT/SKIP)
 *   Critic: state → value estimate (expected return)
 *
 * Advantages over Q-tables:
 *   - Handles continuous features (exact values, not buckets)
 *   - Generalizes to unseen states
 *   - Stable training with clipped objective
 *   - Natural position sizing via action probabilities
 */

import * as tf from "@tensorflow/tfjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PPO_MODEL_DIR = path.resolve(__dirname, "../data/ppo-model");
const PPO_STATE_FILE = path.resolve(__dirname, "../data/ppo-state.json");

// ── Hyperparameters ──────────────────────────────────────────────────────────
const LEARNING_RATE = 1e-3;
const GAMMA = 0.99;        // Discount factor
const LAMBDA = 0.95;       // GAE lambda
const CLIP_RATIO = 0.2;    // PPO clip
const ENTROPY_COEFF = 0.02; // Encourage exploration (higher for faster learning)
const VALUE_COEFF = 0.5;   // Value loss weight
const EPOCHS_PER_UPDATE = 2; // Reduced from 4 — faster training with pure JS
const BATCH_SIZE = 256;     // Larger batches — fewer gradient updates per pass

// ── State Space (20 continuous features) ─────────────────────────────────────

export interface PPOState {
  gammaTilt: number;        // raw gamma tilt value
  deltaTilt: number;        // raw delta tilt value
  gammaRatioNorm: number;   // 0-1, gamma call/put ratio
  deltaRatioNorm: number;   // 0-1, delta ratio
  ivRank: number;           // 0-1, IV percentile
  neSkew: number;           // raw near-expiry skew
  vrp: number;              // raw volatility risk premium
  momentum5d: number;       // 5-day price change %
  momentum20d: number;      // 20-day price change %
  rsi14: number;            // 0-100, relative strength index
  squeezeSig: number;       // 0-100, squeeze scanner
  positionFactor: number;   // -1 to 1, overall positioning
  putCallRatio: number;     // raw put/call ratio
  volumeRatio: number;      // volume / 30d avg
  atrPct: number;           // ATR as % of price
  priceVsCallWall: number;  // % distance to call wall
  priceVsPutWall: number;   // % distance to put wall
  timeNorm: number;         // 0-1, normalized time of day
  isOPEX: number;           // 0 or 1
  cfdIdx: number;           // 0=NAS100, 1=US30, 2=XAUUSD
  // ── New features from additional data sources ──────────────────────
  gammaWallDist: number;    // % distance to max gamma strike (from chart-data)
  gammaConcentration: number; // 0-1, how peaked gamma is (chart-data Herfindahl)
  callGammaRatio: number;   // call/total gamma at ATM (chart-data)
  nextExpGamma: number;     // near-term expiry gamma (equity-gex)
  nextExpDelta: number;     // near-term expiry delta (equity-gex)
  tapeBullishPct: number;   // 0-1, fraction of bullish tape signals (tape-flow)
  tapePremiumRatio: number; // call premium / total premium (tape-flow)
  tapeGammaSkew: number;    // (call-put gamma) / total from tape-summary [-1,1]
  // ── Phase 2: twelve_series, impliedMove, comboLevels, absGamma, HIRO ──
  candleBodyRatio: number;  // avg candle body / range (0-1, 1=no wicks)
  candleTrend: number;      // last 5 candles trend: +1 bullish, -1 bearish
  candleVolSpike: number;   // current volume / avg volume (>1 = spike)
  impliedMovePct: number;   // expected daily range as % of price
  impliedMoveUsage: number; // actual move / implied move (>1 = exceeded)
  comboLevelDist: number;   // % distance to nearest combo level
  comboLevelSide: number;   // -1=below nearest, +1=above nearest
  absGammaPeakDist: number; // % distance to peak absolute gamma strike
  absGammaSkew: number;     // (call-put abs gamma) / total at peak [-1,1]
  hiroNorm: number;         // HIRO value normalized to 30d range [-1,1]
  hiroAccel: number;        // HIRO change rate (acceleration)
  volumeProfilePOC: number; // % distance to Point of Control (max volume strike)
  volumeImbalance: number;  // volume above price / total volume (0-1)
  dayOfWeek: number;        // 0=Mon, 4=Fri, normalized to [-1,1]
  // ── Context features for PPO to learn session/macro dynamics ──────────────
  sessionType: number;      // 0=open, 1=am_trend, 2=lunch, 3=retoma, 4=power, 5=off_hours
  macroAlertActive: number; // 0 or 1 boolean
  counterTrendDetected: number; // 0 or 1 boolean
  imExhaustionLevel: number;    // 0.0-1.0, % of daily IM consumed
  // ── Top-strike distances (3 new features → STATE_SIZE 49) ─────────────────
  topStrikeDist1?: number;  // % dist al top-1 gamma strike (negativo = arriba del precio)
  topStrikeDist2?: number;  // % dist al top-2 gamma strike
  topStrikeDist3?: number;  // % dist al top-3 gamma strike
  // ── SpotGamma Extended: Skew / Fear Gauges (features 49-54) ───────────────
  skewNorm?: number;         // overall IV skew (raw, tanh-clamped)
  callSkewNorm?: number;     // call-side skew (cskew)
  putSkewNorm?: number;      // put-side skew (pskew)
  d95Norm?: number;          // 95-delta IV vs atmIV30 spread (deep OTM fear)
  d25neNorm?: number;        // 25-delta near-expiry IV (weekly fear gauge, decimal)
  fwdGarchSpread?: number;   // fwdGarch - atmIV30 (forward vol premium/discount)
  // ── SpotGamma Extended: Positioning (features 55-61) ─────────────────────
  totalDeltaNorm?: number;   // total market delta exposure (tanh-clamped)
  activityFactorNorm?: number; // options activity factor (already 0-1 normalized)
  gammaRegimeNum?: number;   // positive=1, neutral=0, negative=-0.5, very_negative=-1
  levelsChangedFlag?: number; // did any key SG level change vs yesterday (0/1)
  priceVsKeyDelta?: number;  // % dist to Key Delta level (negative=above level)
  priceVsPutControl?: number;// % dist to Put Control level
  priceVsMaxGamma?: number;  // % dist to absolute max gamma strike (maxfs)
  // ── Volatility Term Structure (features 62-66, from VolContext) ───────────
  volTermSpread?: number;    // farTermIV - nearTermIV for primary asset (spread %)
  volPutCallSkew?: number;   // putIV - callIV (positive = put premium = fear)
  volTermStructureNum?: number; // contango=1, backwardation=-1
  volIVLevelNum?: number;    // very_low=0, low=0.25, normal=0.5, high=0.75, very_high=1
  volMarketRegimeNum?: number; // low_vol=0, normal=0.33, high_vol=0.67, extreme_vol=1
  // ── Vanna Flows (features 67-72, from VannaContext) ───────────────────────
  vixLevelNorm?: number;     // (vixPrice - 20) / 20, centered at VIX=20
  vixChangePctFeat?: number; // VIX daily change % (fear acceleration)
  uvixChangePctFeat?: number;// UVIX daily change %
  uvixGldDivStrength?: number; // divergence strength × sign [-1,1] (+ = buy gold signal)
  indexVannaActiveFlag?: number; // dealer vanna headwind for indices (0/1)
  refugeFlowActiveFlag?: number; // refuge flow into gold/VIX active (0/1)
  // ── 0DTE GEX Dynamics (features 73-77, from TraceData) ──────────────────
  traceGexRatio?: number;    // 0DTE positive/negative GEX ratio (1 = balanced)
  traceNetBiasNum?: number;  // bullish=1, neutral=0, bearish=-1
  traceSupportDist?: number; // % dist to nearest 0DTE support level from price
  traceResistDist?: number;  // % dist to nearest 0DTE resistance level from price
  traceMaxGexDist?: number;  // % dist to max absolute GEX strike from price
  // ── GEX Change Tracking (features 78-81, from GexChangeTracker) ──────────
  gexBiasChangedFlag?: number;    // dealer bias flipped since last snapshot (0/1)
  gexRatioChangeDelta?: number;   // support/resist ratio change (normalized)
  gexSupportShiftedFlag?: number; // top support strikes moved (0/1)
  gexResistShiftedFlag?: number;  // top resistance strikes moved (0/1)
  // ── Tape Enriched (features 82-85, from TapeAssetSummary) ────────────────
  tapeNetDeltaNorm?: number;      // net option delta from tape (tanh-clamped)
  tapeSentimentNorm?: number;     // sentimentScore / 100 [-1,1]
  tapePutCallRatioNorm?: number;  // tape put/call ratio centered at 1
  tapeLargestPremiumRatio?: number; // largest trade premium / total (0-1)
  // ── Asset Microstructure (features 86-90, from AssetData) ────────────────
  assetDailyChangePct?: number;  // today's price change %
  zeroDteRatio?: number;         // zeroDteGamma / |totalGamma| (0DTE dominance, 0-1)
  oiCallPutSkew?: number;        // callOI/(callOI+putOI) near ATM → [-1,1]
  skewRankNorm?: number;         // skewRank / 100 (0-1 from AssetData)
  garchRankNorm?: number;        // garchRank / 100 (0-1 from AssetData)
  // ── CFD + Market Context (features 91-93) ─────────────────────────────────
  cfdDailyChangePct?: number;    // CFD's own daily change % (momentum intraday)
  spxDailyChangePct?: number;    // SPX daily change % (index market context)
  flowStrengthNorm?: number;     // FlowData.flowStrength / 100 (0-1)
  // ── Model-Based Features (features 94-107, from Markets in Profile) ──────
  // Market Structure
  isPositiveGamma?: number;      // 1 if positive gamma regime (mean reversion)
  isNegativeGamma?: number;      // 1 if negative/very_negative gamma (momentum)
  isBracketing?: number;         // 1 if price within 2% of both walls (range-bound)
  // Auction/Profile Signals
  priceVsPOC?: number;           // price vs max gamma strike (Point of Control proxy), [-1,1]
  ibRangeRatio?: number;         // Initial Balance range / avg daily range (0-3)
  valueAreaPosition?: number;    // -1=at put wall, 0=at POC, +1=at call wall
  excessFlag?: number;           // -1=excess low (bounce), 0=none, +1=excess high (reject)
  // Model Signals
  trendDaySignal?: number;       // -1=trend down, 0=no trend, +1=trend up
  breakoutSignal?: number;       // -1=breakout down, 0=none, +1=breakout up
  vannaFlowSignal?: number;      // -1=bearish vanna, 0=neutral, +1=bullish vanna
  inventoryCorrectionSignal?: number; // -1=long liquidation, 0=none, +1=short covering
  gapSignal?: number;            // -1=gap down, 0=no gap, +1=gap up
  // Risk Context
  vrpSign?: number;              // -1=negative VRP (breakout), 0=neutral, +1=positive (mean-revert)
  sessionPhase?: number;         // 0-1: 0=pre, 0.25=open, 0.5=midday, 0.75=power hour, 1=close
}

export const PPO_STATE_SIZE = 108;

// ── Expanded Action Space ──────────────────────────────────────────────────
// The PPO decides EVERYTHING: direction + entry style + risk level.
// No hardcoded rules — the network learns what works from data.
//
// Actions:
//   0: SKIP           — don't trade (uncertain conditions)
//   1: LONG_TIGHT     — long entry, tight SL (scalp/momentum play)
//   2: LONG_NORMAL    — long entry, normal SL (standard swing)
//   3: LONG_WIDE      — long entry, wide SL (high conviction, bigger target)
//   4: SHORT_TIGHT    — short entry, tight SL
//   5: SHORT_NORMAL   — short entry, normal SL
//   6: SHORT_WIDE     — short entry, wide SL
export const PPO_ACTION_SIZE = 7;
export const PPO_ACTION_LABELS = [
  "SKIP",
  "LONG_TIGHT", "LONG_NORMAL", "LONG_WIDE",
  "SHORT_TIGHT", "SHORT_NORMAL", "SHORT_WIDE",
] as const;

// Helper to extract direction and risk from action
export function parseAction(action: number): {
  direction: "SKIP" | "LONG" | "SHORT";
  risk: "tight" | "normal" | "wide";
  slMultiplier: number;   // SL as multiple of ATR
  tp1Multiplier: number;  // TP1 as multiple of ATR
  tp2Multiplier: number;
  tp3Multiplier: number;
} {
  switch (action) {
    case 0: return { direction: "SKIP", risk: "normal", slMultiplier: 0, tp1Multiplier: 0, tp2Multiplier: 0, tp3Multiplier: 0 };
    case 1: return { direction: "LONG", risk: "tight",  slMultiplier: 0.25, tp1Multiplier: 0.20, tp2Multiplier: 0.45, tp3Multiplier: 0.90 };
    case 2: return { direction: "LONG", risk: "normal", slMultiplier: 0.40, tp1Multiplier: 0.25, tp2Multiplier: 0.55, tp3Multiplier: 1.20 };
    case 3: return { direction: "LONG", risk: "wide",   slMultiplier: 0.65, tp1Multiplier: 0.35, tp2Multiplier: 0.75, tp3Multiplier: 1.80 };
    case 4: return { direction: "SHORT", risk: "tight",  slMultiplier: 0.25, tp1Multiplier: 0.20, tp2Multiplier: 0.45, tp3Multiplier: 0.90 };
    case 5: return { direction: "SHORT", risk: "normal", slMultiplier: 0.40, tp1Multiplier: 0.25, tp2Multiplier: 0.55, tp3Multiplier: 1.20 };
    case 6: return { direction: "SHORT", risk: "wide",   slMultiplier: 0.65, tp1Multiplier: 0.35, tp2Multiplier: 0.75, tp3Multiplier: 1.80 };
    default: return { direction: "SKIP", risk: "normal", slMultiplier: 0, tp1Multiplier: 0, tp2Multiplier: 0, tp3Multiplier: 0 };
  }
}

// ── Reward Map ───────────────────────────────────────────────────────────────
// Rewards now scale by risk level — tight risk gets bonus for capital efficiency
const REWARDS: Record<string, Record<string, number>> = {
  tight:  { tp3: 5.0, tp2: 3.0, tp1: 1.5, sl: -1.5, cancelled: 0.0 },
  normal: { tp3: 4.0, tp2: 2.5, tp1: 1.0, sl: -2.0, cancelled: 0.0 },
  wide:   { tp3: 3.5, tp2: 2.0, tp1: 0.8, sl: -2.5, cancelled: 0.0 },
};
// Tight SL = smaller loss but harder to hit TP → bonus when it works
// Wide SL = bigger loss but easier TP → penalty for risk taken

// ── State Normalization ──────────────────────────────────────────────────────

export function normalizeState(s: PPOState): number[] {
  return [
    Math.max(-2, Math.min(2, s.gammaTilt * 10)),       // scale tilt to ~[-2,2]
    Math.max(-2, Math.min(2, s.deltaTilt * 10)),
    s.gammaRatioNorm * 2 - 1,                           // [0,1] → [-1,1]
    s.deltaRatioNorm * 2 - 1,
    s.ivRank * 2 - 1,
    Math.max(-2, Math.min(2, s.neSkew * 10)),
    Math.max(-2, Math.min(2, s.vrp * 10)),
    Math.max(-3, Math.min(3, s.momentum5d / 2)),        // % / 2
    Math.max(-3, Math.min(3, s.momentum20d / 5)),       // % / 5
    (s.rsi14 - 50) / 50,                                // [0,100] → [-1,1]
    (s.squeezeSig - 50) / 50,
    s.positionFactor,                                    // already [-1,1]
    Math.max(-2, Math.min(2, (s.putCallRatio - 1) * 2)), // centered at 1
    Math.max(-2, Math.min(2, (s.volumeRatio - 1))),     // centered at 1
    Math.max(-2, Math.min(2, (s.atrPct - 1) / 0.5)),   // centered at 1%
    Math.max(-2, Math.min(2, s.priceVsCallWall / 2)),   // % distance / 2
    Math.max(-2, Math.min(2, s.priceVsPutWall / 2)),
    s.timeNorm * 2 - 1,                                 // [0,1] → [-1,1]
    s.isOPEX * 2 - 1,                                   // 0/1 → [-1,1]
    (s.cfdIdx - 1),                                      // 0,1,2 → -1,0,1
    // ── New features (8) ──────────────────────────────────────────────
    Math.max(-3, Math.min(3, s.gammaWallDist / 2)),     // % distance / 2
    s.gammaConcentration * 2 - 1,                        // [0,1] → [-1,1]
    s.callGammaRatio * 2 - 1,                            // [0,1] → [-1,1]
    Math.max(-2, Math.min(2, s.nextExpGamma * 10)),     // small values, scale up
    Math.max(-2, Math.min(2, s.nextExpDelta * 10)),
    s.tapeBullishPct * 2 - 1,                            // [0,1] → [-1,1]
    s.tapePremiumRatio * 2 - 1,                          // [0,1] → [-1,1]
    s.tapeGammaSkew,                                     // already [-1,1]
    // ── Phase 2 features (14) ────────────────────────────────────────
    (s.candleBodyRatio ?? 0.5) * 2 - 1,                    // [0,1] → [-1,1]
    s.candleTrend ?? 0,                                     // already [-1,1]
    Math.max(-2, Math.min(2, ((s.candleVolSpike ?? 1) - 1))), // centered at 1
    Math.max(-2, Math.min(2, ((s.impliedMovePct ?? 1) - 1) / 0.5)), // centered at 1%
    Math.max(-2, Math.min(2, (s.impliedMoveUsage ?? 1) - 1)), // centered at 1
    Math.max(-3, Math.min(3, (s.comboLevelDist ?? 0) / 2)), // % distance / 2
    s.comboLevelSide ?? 0,                                   // -1 or +1
    Math.max(-3, Math.min(3, (s.absGammaPeakDist ?? 0) / 2)), // % distance / 2
    s.absGammaSkew ?? 0,                                     // [-1,1]
    s.hiroNorm ?? 0,                                         // [-1,1]
    Math.max(-2, Math.min(2, s.hiroAccel ?? 0)),             // bounded
    Math.max(-3, Math.min(3, (s.volumeProfilePOC ?? 0) / 2)), // % distance / 2
    (s.volumeImbalance ?? 0.5) * 2 - 1,                     // [0,1] → [-1,1]
    s.dayOfWeek ?? 0,                                        // [-1,1]
    // ── Context features (features 42-45) — session, macro, exhaustion ──────────
    (s.sessionType ?? 0) / 3 - 1,       // normalize 0-5 to ~[-1,+1]
    (s.macroAlertActive ?? 0),           // 0 or 1
    (s.counterTrendDetected ?? 0),       // 0 or 1
    (s.imExhaustionLevel ?? 0) * 2 - 1, // [0,1] → [-1,1]
    // ── Top-strike distances (features 46-48) ────────────────────────────────
    Math.max(-3, Math.min(3, (s.topStrikeDist1 ?? 0) / 2)), // % dist / 2, clip ±3
    Math.max(-3, Math.min(3, (s.topStrikeDist2 ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.topStrikeDist3 ?? 0) / 2)),
    // ── SpotGamma Extended: Skew / Fear (features 49-54) ─────────────────────
    Math.max(-2, Math.min(2, (s.skewNorm ?? 0) * 5)),           // small raw values
    Math.max(-2, Math.min(2, (s.callSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.putSkewNorm ?? 0) * 5)),
    Math.max(-2, Math.min(2, (s.d95Norm ?? 0) * 5)),            // vs atmIV30
    Math.max(-2, Math.min(2, (s.d25neNorm ?? 0.2) / 0.1 - 2)), // centered at 0.2 (20% IV)
    Math.max(-2, Math.min(2, (s.fwdGarchSpread ?? 0) * 10)),    // small spread
    // ── SpotGamma Extended: Positioning (features 55-61) ──────────────────────
    Math.max(-2, Math.min(2, (s.totalDeltaNorm ?? 0) * 2)),     // tanh-clamped
    s.activityFactorNorm ?? 0,                                   // already 0-1
    s.gammaRegimeNum ?? 0,                                       // [-1,1]
    (s.levelsChangedFlag ?? 0) * 2 - 1,                         // 0/1 → [-1,1]
    Math.max(-3, Math.min(3, (s.priceVsKeyDelta ?? 0) / 2)),    // % dist / 2
    Math.max(-3, Math.min(3, (s.priceVsPutControl ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.priceVsMaxGamma ?? 0) / 2)),
    // ── Vol Term Structure (features 62-66) ───────────────────────────────────
    Math.max(-2, Math.min(2, (s.volTermSpread ?? 0) * 10)),     // spread × 10
    Math.max(-2, Math.min(2, (s.volPutCallSkew ?? 0) * 10)),    // spread × 10
    s.volTermStructureNum ?? 0,                                   // -1 or 1
    (s.volIVLevelNum ?? 0.5) * 2 - 1,                           // [0,1] → [-1,1]
    (s.volMarketRegimeNum ?? 0.33) * 2 - 0.66,                  // centered at normal
    // ── Vanna Flows (features 67-72) ──────────────────────────────────────────
    Math.max(-3, Math.min(3, s.vixLevelNorm ?? 0)),              // (VIX-20)/20
    Math.max(-3, Math.min(3, (s.vixChangePctFeat ?? 0) / 2)),   // % change / 2
    Math.max(-3, Math.min(3, (s.uvixChangePctFeat ?? 0) / 3)),  // % change / 3
    s.uvixGldDivStrength ?? 0,                                   // [-1,1]
    (s.indexVannaActiveFlag ?? 0) * 2 - 1,                      // 0/1 → [-1,1]
    (s.refugeFlowActiveFlag ?? 0) * 2 - 1,                      // 0/1 → [-1,1]
    // ── 0DTE GEX Dynamics (features 73-77) ───────────────────────────────────
    Math.max(-2, Math.min(2, ((s.traceGexRatio ?? 1) - 1))),    // centered at 1
    s.traceNetBiasNum ?? 0,                                      // -1/0/1
    Math.max(-3, Math.min(3, (s.traceSupportDist ?? 0) / 2)),   // % dist / 2
    Math.max(-3, Math.min(3, (s.traceResistDist ?? 0) / 2)),
    Math.max(-3, Math.min(3, (s.traceMaxGexDist ?? 0) / 2)),
    // ── GEX Change Tracking (features 78-81) ─────────────────────────────────
    (s.gexBiasChangedFlag ?? 0) * 2 - 1,                        // 0/1 → [-1,1]
    Math.max(-2, Math.min(2, (s.gexRatioChangeDelta ?? 0))),     // already normalized
    (s.gexSupportShiftedFlag ?? 0) * 2 - 1,
    (s.gexResistShiftedFlag ?? 0) * 2 - 1,
    // ── Tape Enriched (features 82-85) ────────────────────────────────────────
    Math.max(-2, Math.min(2, (s.tapeNetDeltaNorm ?? 0) * 5)),   // scale up small values
    s.tapeSentimentNorm ?? 0,                                    // [-1,1]
    Math.max(-2, Math.min(2, ((s.tapePutCallRatioNorm ?? 1) - 1) * 2)), // centered at 1
    s.tapeLargestPremiumRatio ?? 0,                              // [0,1]
    // ── Asset Microstructure (features 86-90) ────────────────────────────────
    Math.max(-3, Math.min(3, (s.assetDailyChangePct ?? 0) / 2)),// % change / 2
    (s.zeroDteRatio ?? 0) * 2 - 1,                              // [0,1] → [-1,1]
    (s.oiCallPutSkew ?? 0),                                      // already [-1,1]
    (s.skewRankNorm ?? 0.5) * 2 - 1,                            // [0,1] → [-1,1]
    (s.garchRankNorm ?? 0.5) * 2 - 1,                           // [0,1] → [-1,1]
    // ── CFD + Market Context (features 91-93) ────────────────────────────────
    Math.max(-3, Math.min(3, (s.cfdDailyChangePct ?? 0) / 2)),  // % change / 2
    Math.max(-3, Math.min(3, (s.spxDailyChangePct ?? 0) / 2)),
    (s.flowStrengthNorm ?? 0.5) * 2 - 1,                        // [0,1] → [-1,1]
    // ── Model-Based Features (features 94-107) ────────────────────────────────
    // Market Structure (3)
    (s.isPositiveGamma ?? 0) * 2 - 1,                            // 0/1 → [-1,1]
    (s.isNegativeGamma ?? 0) * 2 - 1,                            // 0/1 → [-1,1]
    (s.isBracketing ?? 0) * 2 - 1,                               // 0/1 → [-1,1]
    // Auction/Profile Signals (4)
    s.priceVsPOC ?? 0,                                           // already [-1,1]
    Math.min(3, s.ibRangeRatio ?? 1) - 1,                        // [0,3] → [-1,2]
    s.valueAreaPosition ?? 0,                                    // already [-1,1]
    s.excessFlag ?? 0,                                           // -1/0/1
    // Model Signals (5)
    s.trendDaySignal ?? 0,                                       // -1/0/1
    s.breakoutSignal ?? 0,                                       // -1/0/1
    s.vannaFlowSignal ?? 0,                                      // -1/0/1
    s.inventoryCorrectionSignal ?? 0,                             // -1/0/1
    s.gapSignal ?? 0,                                            // -1/0/1
    // Risk Context (2)
    s.vrpSign ?? 0,                                              // -1/0/1
    (s.sessionPhase ?? 0.5) * 2 - 1,                             // [0,1] → [-1,1]
  ];
}

// ── Neural Networks ──────────────────────────────────────────────────────────

function createActorNetwork(): tf.Sequential {
  const model = tf.sequential();
  model.add(tf.layers.dense({
    inputShape: [PPO_STATE_SIZE],
    units: 128,
    activation: "relu",
    kernelInitializer: "heNormal",
  }));
  model.add(tf.layers.dense({ units: 64, activation: "relu", kernelInitializer: "heNormal" }));
  model.add(tf.layers.dense({ units: 32, activation: "relu", kernelInitializer: "heNormal" }));
  model.add(tf.layers.dense({
    units: PPO_ACTION_SIZE,
    activation: "softmax",
    kernelInitializer: "glorotNormal",
  }));
  return model;
}

function createCriticNetwork(): tf.Sequential {
  const model = tf.sequential();
  model.add(tf.layers.dense({
    inputShape: [PPO_STATE_SIZE],
    units: 128,
    activation: "relu",
    kernelInitializer: "heNormal",
  }));
  model.add(tf.layers.dense({ units: 64, activation: "relu", kernelInitializer: "heNormal" }));
  model.add(tf.layers.dense({ units: 32, activation: "relu", kernelInitializer: "heNormal" }));
  model.add(tf.layers.dense({ units: 1, kernelInitializer: "glorotNormal" }));
  return model;
}

// ── Experience Buffer ────────────────────────────────────────────────────────

interface Experience {
  state: number[];
  action: number;
  reward: number;
  logProb: number;
  value: number;
  advantage: number;
  return_: number;
}

// ── PPO Agent Class ──────────────────────────────────────────────────────────

export class PPOAgent {
  actor: tf.Sequential;
  critic: tf.Sequential;
  actorOptimizer: tf.AdamOptimizer;
  criticOptimizer: tf.AdamOptimizer;

  // Stats
  totalEpisodes = 0;
  totalWins = 0;
  totalLosses = 0;
  trainingLoss: number[] = [];

  constructor() {
    this.actor = createActorNetwork();
    this.critic = createCriticNetwork();
    this.actorOptimizer = tf.train.adam(LEARNING_RATE);
    this.criticOptimizer = tf.train.adam(LEARNING_RATE);
  }

  /** Get action probabilities for a state */
  getActionProbs(state: PPOState): { probs: number[]; value: number } {
    const normalized = normalizeState(state);
    return tf.tidy(() => {
      const stateTensor = tf.tensor2d([normalized]);
      const probs = (this.actor.predict(stateTensor) as tf.Tensor).dataSync() as Float32Array;
      const value = (this.critic.predict(stateTensor) as tf.Tensor).dataSync()[0];
      return { probs: Array.from(probs), value };
    });
  }

  /** Batch predict: get action probs + values for many states at once */
  batchPredict(states: number[][]): { probs: number[][]; values: number[] } {
    return tf.tidy(() => {
      const statesTensor = tf.tensor2d(states);
      const probsTensor = this.actor.predict(statesTensor) as tf.Tensor;
      const valuesTensor = this.critic.predict(statesTensor) as tf.Tensor;
      const probsData = probsTensor.arraySync() as number[][];
      const valuesData = (valuesTensor.squeeze() as tf.Tensor).arraySync() as number[] | number;
      return {
        probs: probsData,
        values: Array.isArray(valuesData) ? valuesData : [valuesData],
      };
    });
  }

  /** Select action using the policy (with exploration via sampling) */
  selectAction(state: PPOState): { action: number; logProb: number; value: number; probs: number[] } {
    const { probs, value } = this.getActionProbs(state);

    // Sample from probability distribution
    const r = Math.random();
    let cumProb = 0;
    let action = PPO_ACTION_SIZE - 1;
    for (let i = 0; i < PPO_ACTION_SIZE; i++) {
      cumProb += probs[i];
      if (r < cumProb) { action = i; break; }
    }

    const logProb = Math.log(Math.max(probs[action], 1e-8));
    return { action, logProb, value, probs };
  }

  /** Select best action (greedy, for inference) */
  selectBestAction(state: PPOState): { action: number; confidence: number; probs: number[] } {
    const { probs, value } = this.getActionProbs(state);
    let bestAction = 0;
    let bestProb = probs[0];
    for (let i = 1; i < PPO_ACTION_SIZE; i++) {
      if (probs[i] > bestProb) { bestProb = probs[i]; bestAction = i; }
    }
    return {
      action: bestAction,
      confidence: bestProb * 100,
      probs,
    };
  }

  /** Compute GAE (Generalized Advantage Estimation) */
  computeGAE(
    rewards: number[],
    values: number[],
    dones: boolean[],
  ): { advantages: number[]; returns: number[] } {
    const n = rewards.length;
    const advantages = new Array(n).fill(0);
    const returns = new Array(n).fill(0);
    let lastAdv = 0;

    for (let t = n - 1; t >= 0; t--) {
      const nextValue = t < n - 1 && !dones[t] ? values[t + 1] : 0;
      const delta = rewards[t] + GAMMA * nextValue - values[t];
      lastAdv = delta + GAMMA * LAMBDA * (dones[t] ? 0 : lastAdv);
      advantages[t] = lastAdv;
      returns[t] = advantages[t] + values[t];
    }

    // Normalize advantages
    const mean = advantages.reduce((s, a) => s + a, 0) / n;
    const std = Math.sqrt(advantages.reduce((s, a) => s + (a - mean) ** 2, 0) / n) + 1e-8;
    for (let i = 0; i < n; i++) advantages[i] = (advantages[i] - mean) / std;

    return { advantages, returns };
  }

  /** PPO update step — train actor and critic on a batch of experiences */
  async trainOnBatch(experiences: Experience[]): Promise<{ actorLoss: number; criticLoss: number }> {
    const n = experiences.length;
    if (n < BATCH_SIZE) return { actorLoss: 0, criticLoss: 0 };

    let totalActorLoss = 0;
    let totalCriticLoss = 0;
    let numBatches = 0;

    for (let epoch = 0; epoch < EPOCHS_PER_UPDATE; epoch++) {
      // Shuffle indices
      const indices = Array.from({ length: n }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      // Mini-batch updates — all tensor ops inside tf.tidy()
      for (let start = 0; start < n - BATCH_SIZE + 1; start += BATCH_SIZE) {
        const batchIdx = indices.slice(start, start + BATCH_SIZE);
        const batchStates = batchIdx.map(i => experiences[i].state);
        const batchActions = batchIdx.map(i => experiences[i].action);
        const batchOldLogProbs = batchIdx.map(i => experiences[i].logProb);
        const batchAdvantages = batchIdx.map(i => experiences[i].advantage);
        const batchReturns = batchIdx.map(i => experiences[i].return_);

        // Pre-create all input tensors outside minimize
        const statesTensor = tf.tensor2d(batchStates);
        const advantagesTensor = tf.tensor1d(batchAdvantages);
        const returnsTensor = tf.tensor1d(batchReturns);
        const oldLogProbsTensor = tf.tensor1d(batchOldLogProbs);

        // Actor update
        const actorLoss = this.actorOptimizer.minimize(() => {
          const probs = this.actor.predict(statesTensor) as tf.Tensor;
          const actionMask = tf.oneHot(batchActions, PPO_ACTION_SIZE);
          const selectedProbs = probs.mul(actionMask).sum(1);
          const newLogProbs = selectedProbs.add(1e-8).log();
          const ratio = newLogProbs.sub(oldLogProbsTensor).exp();
          const clipped = ratio.clipByValue(1 - CLIP_RATIO, 1 + CLIP_RATIO);
          const surr1 = ratio.mul(advantagesTensor);
          const surr2 = clipped.mul(advantagesTensor);
          const policyLoss = tf.minimum(surr1, surr2).mean().neg();
          const entropy = probs.mul(probs.add(1e-8).log()).sum(1).mean().neg();
          return policyLoss.sub(entropy.mul(ENTROPY_COEFF)) as tf.Scalar;
        }, true) as tf.Scalar;
        const aLoss = actorLoss?.dataSync()[0] ?? 0;
        actorLoss?.dispose();

        // Critic update
        const criticLoss = this.criticOptimizer.minimize(() => {
          const vals = (this.critic.predict(statesTensor) as tf.Tensor).squeeze();
          return vals.sub(returnsTensor).square().mean().mul(VALUE_COEFF) as tf.Scalar;
        }, true) as tf.Scalar;
        const cLoss = criticLoss?.dataSync()[0] ?? 0;
        criticLoss?.dispose();

        totalActorLoss += aLoss;
        totalCriticLoss += cLoss;
        numBatches++;

        // Dispose input tensors
        statesTensor.dispose();
        advantagesTensor.dispose();
        returnsTensor.dispose();
        oldLogProbsTensor.dispose();
      }
    }

    return {
      actorLoss: totalActorLoss / Math.max(numBatches, 1),
      criticLoss: totalCriticLoss / Math.max(numBatches, 1),
    };
  }

  /** Save model weights + state to disk as JSON */
  async save(): Promise<void> {
    if (!fs.existsSync(PPO_MODEL_DIR)) fs.mkdirSync(PPO_MODEL_DIR, { recursive: true });

    // Save weights as JSON arrays (works without tfjs-node file handler)
    const actorWeights = this.actor.getWeights().map(w => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));
    const criticWeights = this.critic.getWeights().map(w => ({
      name: w.name, shape: w.shape, data: Array.from(w.dataSync()),
    }));

    fs.writeFileSync(
      path.join(PPO_MODEL_DIR, "actor-weights.json"),
      JSON.stringify(actorWeights),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(PPO_MODEL_DIR, "critic-weights.json"),
      JSON.stringify(criticWeights),
      "utf-8",
    );

    const state = {
      totalEpisodes: this.totalEpisodes,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      trainingLoss: this.trainingLoss.slice(-100),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(PPO_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Load model weights from disk */
  async load(): Promise<boolean> {
    try {
      const actorPath = path.join(PPO_MODEL_DIR, "actor-weights.json");
      const criticPath = path.join(PPO_MODEL_DIR, "critic-weights.json");

      if (!fs.existsSync(actorPath)) return false;

      const actorData: { name: string; shape: number[]; data: number[] }[] =
        JSON.parse(fs.readFileSync(actorPath, "utf-8"));
      const criticData: { name: string; shape: number[]; data: number[] }[] =
        JSON.parse(fs.readFileSync(criticPath, "utf-8"));

      const actorTensors = actorData.map(w => tf.tensor(w.data, w.shape as any));
      const criticTensors = criticData.map(w => tf.tensor(w.data, w.shape as any));

      this.actor.setWeights(actorTensors);
      this.critic.setWeights(criticTensors);

      // Dispose temp tensors
      actorTensors.forEach(t => t.dispose());
      criticTensors.forEach(t => t.dispose());

      if (fs.existsSync(PPO_STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(PPO_STATE_FILE, "utf-8"));
        this.totalEpisodes = state.totalEpisodes ?? 0;
        this.totalWins = state.totalWins ?? 0;
        this.totalLosses = state.totalLosses ?? 0;
        this.trainingLoss = state.trainingLoss ?? [];
      }

      console.log(`[PPO] Loaded model (${this.totalEpisodes} episodes, WR=${this.winRate.toFixed(1)}%)`);
      return true;
    } catch (e: any) {
      console.warn(`[PPO] Load failed: ${e.message}`);
      return false;
    }
  }

  get winRate(): number {
    const resolved = this.totalWins + this.totalLosses;
    return resolved > 0 ? (this.totalWins / resolved) * 100 : 0;
  }

  /** Get stats for API */
  getStats() {
    return {
      totalEpisodes: this.totalEpisodes,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      winRate: this.winRate,
      recentLoss: this.trainingLoss.slice(-10),
      lastUpdated: fs.existsSync(PPO_STATE_FILE)
        ? JSON.parse(fs.readFileSync(PPO_STATE_FILE, "utf-8")).lastUpdated
        : null,
    };
  }
}

// ── Kelly Criterion Position Sizing ──────────────────────────────────────────

export interface KellyResult {
  kellyFraction: number;     // optimal fraction (0-1)
  fractionalKelly: number;   // 25% of Kelly (conservative)
  suggestedRiskPct: number;  // % of capital to risk
  edge: number;              // expected edge per trade
}

/**
 * Calculate Kelly criterion for position sizing.
 * Uses half-Kelly for safety (reduces variance while keeping 75% of growth).
 */
export function kellySize(
  winRate: number,           // 0-1
  avgWinAmount: number,      // average gain on wins
  avgLossAmount: number,     // average loss on losses (positive number)
  confidence: number = 1.0,  // 0-1, scale down when uncertain
): KellyResult {
  if (avgLossAmount <= 0 || winRate <= 0 || winRate >= 1) {
    return { kellyFraction: 0, fractionalKelly: 0, suggestedRiskPct: 1, edge: 0 };
  }

  const R = avgWinAmount / avgLossAmount; // win/loss ratio
  const W = winRate;
  const Q = 1 - W;

  // Kelly formula: f* = W - Q/R = W - (1-W)/R
  const kelly = W - (Q / R);

  // If kelly <= 0, there's no edge — don't trade
  if (kelly <= 0) {
    return { kellyFraction: 0, fractionalKelly: 0, suggestedRiskPct: 0, edge: kelly };
  }

  // Fractional Kelly (25% = very conservative, recommended for quant trading)
  const fractional = kelly * 0.25 * confidence;

  // Clamp to max 5% of capital
  const suggestedRiskPct = Math.min(5, Math.max(0.5, fractional * 100));

  return {
    kellyFraction: kelly,
    fractionalKelly: fractional,
    suggestedRiskPct,
    edge: kelly,
  };
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _ppoAgent: PPOAgent | null = null;
let _ppoLoadPromise: Promise<boolean> | null = null;

export function getPPOAgent(): PPOAgent {
  if (!_ppoAgent) {
    _ppoAgent = new PPOAgent();
    // Try loading saved model (async, sets totalEpisodes on success)
    _ppoLoadPromise = _ppoAgent.load().catch(() => false);
  }
  return _ppoAgent;
}

/** Ensure PPO model is loaded before using it */
export async function ensurePPOLoaded(): Promise<PPOAgent> {
  const agent = getPPOAgent();
  if (_ppoLoadPromise) await _ppoLoadPromise;
  return agent;
}

// ── Build PPOState from episode data ─────────────────────────────────────────

export function buildPPOState(ep: {
  gammaTilt: number;
  deltaTilt: number;
  gammaRatioNorm: number;
  deltaRatioNorm: number;
  ivRank: number;
  neSkew: number;
  vrp: number;
  momentum5d: number;
  momentum20d: number;
  rsi14: number;
  squeezeSig: number;
  positionFactor: number;
  putCallRatio: number;
  volumeRatio: number;
  atrPct: number;
  callWall: number;
  putWall: number;
  price: number;
  isOPEXWeek: boolean;
  cfd: string;
  // New fields (optional for backward compat)
  gammaWallDist?: number;
  gammaConcentration?: number;
  callGammaRatio?: number;
  nextExpGamma?: number;
  nextExpDelta?: number;
  tapeBullishPct?: number;
  tapePremiumRatio?: number;
  tapeGammaSkew?: number;
  // Phase 2 fields
  candleBodyRatio?: number;
  candleTrend?: number;
  candleVolSpike?: number;
  impliedMovePct?: number;
  impliedMoveUsage?: number;
  comboLevelDist?: number;
  comboLevelSide?: number;
  absGammaPeakDist?: number;
  absGammaSkew?: number;
  hiroNorm?: number;
  hiroAccel?: number;
  volumeProfilePOC?: number;
  volumeImbalance?: number;
  dayOfWeek?: number;
  // Context features
  sessionType?: number;      // 0=open, 1=am_trend, 2=lunch, 3=retoma, 4=power, 5=off_hours
  macroAlertActive?: boolean;
  counterTrendDetected?: boolean;
  imExhaustionLevel?: number; // 0.0-1.0
  // SpotGamma Extended: Skew / Fear
  skewNorm?: number;
  callSkewNorm?: number;
  putSkewNorm?: number;
  d95Norm?: number;
  d25neNorm?: number;
  fwdGarchSpread?: number;
  // SpotGamma Extended: Positioning
  totalDeltaNorm?: number;
  activityFactorNorm?: number;
  gammaRegimeNum?: number;
  levelsChangedFlag?: number;
  priceVsKeyDelta?: number;
  priceVsPutControl?: number;
  priceVsMaxGamma?: number;
  // Vol Term Structure
  volTermSpread?: number;
  volPutCallSkew?: number;
  volTermStructureNum?: number;
  volIVLevelNum?: number;
  volMarketRegimeNum?: number;
  // Vanna Flows
  vixLevelNorm?: number;
  vixChangePctFeat?: number;
  uvixChangePctFeat?: number;
  uvixGldDivStrength?: number;
  indexVannaActiveFlag?: number;
  refugeFlowActiveFlag?: number;
  // 0DTE GEX Dynamics
  traceGexRatio?: number;
  traceNetBiasNum?: number;
  traceSupportDist?: number;
  traceResistDist?: number;
  traceMaxGexDist?: number;
  // GEX Change Tracking
  gexBiasChangedFlag?: number;
  gexRatioChangeDelta?: number;
  gexSupportShiftedFlag?: number;
  gexResistShiftedFlag?: number;
  // Tape Enriched
  tapeNetDeltaNorm?: number;
  tapeSentimentNorm?: number;
  tapePutCallRatioNorm?: number;
  tapeLargestPremiumRatio?: number;
  // Asset Microstructure
  assetDailyChangePct?: number;
  zeroDteRatio?: number;
  oiCallPutSkew?: number;
  skewRankNorm?: number;
  garchRankNorm?: number;
  // CFD + Market Context
  cfdDailyChangePct?: number;
  spxDailyChangePct?: number;
  flowStrengthNorm?: number;
}, timeNorm = 0.5): PPOState {
  const price = ep.price || 1;
  return {
    gammaTilt: ep.gammaTilt,
    deltaTilt: ep.deltaTilt,
    gammaRatioNorm: ep.gammaRatioNorm,
    deltaRatioNorm: ep.deltaRatioNorm,
    ivRank: ep.ivRank,
    neSkew: ep.neSkew,
    vrp: ep.vrp,
    momentum5d: ep.momentum5d,
    momentum20d: ep.momentum20d,
    rsi14: ep.rsi14,
    squeezeSig: ep.squeezeSig,
    positionFactor: ep.positionFactor,
    putCallRatio: ep.putCallRatio,
    volumeRatio: ep.volumeRatio,
    atrPct: ep.atrPct,
    priceVsCallWall: ep.callWall > 0 ? ((ep.callWall - price) / price) * 100 : 0,
    priceVsPutWall: ep.putWall > 0 ? ((price - ep.putWall) / price) * 100 : 0,
    timeNorm,
    isOPEX: ep.isOPEXWeek ? 1 : 0,
    cfdIdx: ep.cfd === "NAS100" ? 0 : ep.cfd === "US30" ? 1 : 2,
    // Phase 1 features
    gammaWallDist: ep.gammaWallDist ?? 0,
    gammaConcentration: ep.gammaConcentration ?? 0,
    callGammaRatio: ep.callGammaRatio ?? 0.5,
    nextExpGamma: ep.nextExpGamma ?? 0,
    nextExpDelta: ep.nextExpDelta ?? 0,
    tapeBullishPct: ep.tapeBullishPct ?? 0.5,
    tapePremiumRatio: ep.tapePremiumRatio ?? 0.5,
    tapeGammaSkew: ep.tapeGammaSkew ?? 0,
    // Phase 2 features
    candleBodyRatio: ep.candleBodyRatio ?? 0.5,
    candleTrend: ep.candleTrend ?? 0,
    candleVolSpike: ep.candleVolSpike ?? 1,
    impliedMovePct: ep.impliedMovePct ?? 1,
    impliedMoveUsage: ep.impliedMoveUsage ?? 1,
    comboLevelDist: ep.comboLevelDist ?? 0,
    comboLevelSide: ep.comboLevelSide ?? 0,
    absGammaPeakDist: ep.absGammaPeakDist ?? 0,
    absGammaSkew: ep.absGammaSkew ?? 0,
    hiroNorm: ep.hiroNorm ?? 0,
    hiroAccel: ep.hiroAccel ?? 0,
    volumeProfilePOC: ep.volumeProfilePOC ?? 0,
    volumeImbalance: ep.volumeImbalance ?? 0.5,
    dayOfWeek: ep.dayOfWeek ?? 0,
    // Context features
    sessionType: ep.sessionType ?? 0,
    macroAlertActive: ep.macroAlertActive ? 1 : 0,
    counterTrendDetected: ep.counterTrendDetected ? 1 : 0,
    imExhaustionLevel: ep.imExhaustionLevel ?? 0,
    // SpotGamma Extended: Skew / Fear
    skewNorm: ep.skewNorm ?? 0,
    callSkewNorm: ep.callSkewNorm ?? 0,
    putSkewNorm: ep.putSkewNorm ?? 0,
    d95Norm: ep.d95Norm ?? 0,
    d25neNorm: ep.d25neNorm ?? 0.2,
    fwdGarchSpread: ep.fwdGarchSpread ?? 0,
    // SpotGamma Extended: Positioning
    totalDeltaNorm: ep.totalDeltaNorm ?? 0,
    activityFactorNorm: ep.activityFactorNorm ?? 0.5,
    gammaRegimeNum: ep.gammaRegimeNum ?? 0,
    levelsChangedFlag: ep.levelsChangedFlag ?? 0,
    priceVsKeyDelta: ep.priceVsKeyDelta ?? 0,
    priceVsPutControl: ep.priceVsPutControl ?? 0,
    priceVsMaxGamma: ep.priceVsMaxGamma ?? 0,
    // Vol Term Structure
    volTermSpread: ep.volTermSpread ?? 0,
    volPutCallSkew: ep.volPutCallSkew ?? 0,
    volTermStructureNum: ep.volTermStructureNum ?? 1,
    volIVLevelNum: ep.volIVLevelNum ?? 0.5,
    volMarketRegimeNum: ep.volMarketRegimeNum ?? 0.33,
    // Vanna Flows
    vixLevelNorm: ep.vixLevelNorm ?? 0,
    vixChangePctFeat: ep.vixChangePctFeat ?? 0,
    uvixChangePctFeat: ep.uvixChangePctFeat ?? 0,
    uvixGldDivStrength: ep.uvixGldDivStrength ?? 0,
    indexVannaActiveFlag: ep.indexVannaActiveFlag ?? 0,
    refugeFlowActiveFlag: ep.refugeFlowActiveFlag ?? 0,
    // 0DTE GEX Dynamics
    traceGexRatio: ep.traceGexRatio ?? 1,
    traceNetBiasNum: ep.traceNetBiasNum ?? 0,
    traceSupportDist: ep.traceSupportDist ?? 0,
    traceResistDist: ep.traceResistDist ?? 0,
    traceMaxGexDist: ep.traceMaxGexDist ?? 0,
    // GEX Change Tracking
    gexBiasChangedFlag: ep.gexBiasChangedFlag ?? 0,
    gexRatioChangeDelta: ep.gexRatioChangeDelta ?? 0,
    gexSupportShiftedFlag: ep.gexSupportShiftedFlag ?? 0,
    gexResistShiftedFlag: ep.gexResistShiftedFlag ?? 0,
    // Tape Enriched
    tapeNetDeltaNorm: ep.tapeNetDeltaNorm ?? 0,
    tapeSentimentNorm: ep.tapeSentimentNorm ?? 0,
    tapePutCallRatioNorm: ep.tapePutCallRatioNorm ?? 1,
    tapeLargestPremiumRatio: ep.tapeLargestPremiumRatio ?? 0,
    // Asset Microstructure
    assetDailyChangePct: ep.assetDailyChangePct ?? 0,
    zeroDteRatio: ep.zeroDteRatio ?? 0,
    oiCallPutSkew: ep.oiCallPutSkew ?? 0,
    skewRankNorm: ep.skewRankNorm ?? 0.5,
    garchRankNorm: ep.garchRankNorm ?? 0.5,
    // CFD + Market Context
    cfdDailyChangePct: ep.cfdDailyChangePct ?? 0,
    spxDailyChangePct: ep.spxDailyChangePct ?? 0,
    flowStrengthNorm: ep.flowStrengthNorm ?? 0.5,
    // Model-Based Features
    isPositiveGamma: ep.isPositiveGamma ?? 0,
    isNegativeGamma: ep.isNegativeGamma ?? 0,
    isBracketing: ep.isBracketing ?? 0,
    priceVsPOC: ep.priceVsPOC ?? 0,
    ibRangeRatio: ep.ibRangeRatio ?? 1,
    valueAreaPosition: ep.valueAreaPosition ?? 0,
    excessFlag: ep.excessFlag ?? 0,
    trendDaySignal: ep.trendDaySignal ?? 0,
    breakoutSignal: ep.breakoutSignal ?? 0,
    vannaFlowSignal: ep.vannaFlowSignal ?? 0,
    inventoryCorrectionSignal: ep.inventoryCorrectionSignal ?? 0,
    gapSignal: ep.gapSignal ?? 0,
    vrpSign: ep.vrpSign ?? 0,
    sessionPhase: ep.sessionPhase ?? 0.5,
  };
}
