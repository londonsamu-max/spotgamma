/**
 * Intraday Episode Generator
 *
 * Creates training episodes from 1-minute OHLC data combined with daily GEX/tilt features.
 * Instead of 1 episode per day, generates ~26 episodes per day (every 15 min from 9:30-16:00).
 *
 * Each episode:
 *   State: daily GEX/tilt features + intraday price context (position within day's range)
 *   Outcome: what happened in the next 30-60 minutes
 *
 * This multiplies our training data from ~2,000 to ~250,000+ episodes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildPPOState, type PPOState } from "./ppo-agent";
import { computeExactOutcome, clearBarCache } from "./exact-outcome";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data/historical");
const INTRADAY_CACHE = path.resolve(__dirname, "../data/intraday-episodes.json");

// ── Symbol mapping ──────────────────────────────────────────────────────────

const SYM_TO_CFD: Record<string, string> = {
  SPX: "NAS100", SPY: "US30", QQQ: "NAS100", GLD: "XAUUSD",
  VIX: "NAS100", DIA: "US30", IWM: "US30", UVIX: "NAS100",
};

const ALL_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA", "IWM", "UVIX"];

// ── Interfaces ──────────────────────────────────────────────────────────────

interface OHLCBar {
  t: number;  // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

interface GEXHistoryRow {
  quote_date: string;
  sym: string;
  upx: number;
  gamma_ratio: string | number;
  delta_ratio: string | number;
  iv_rank: string | number;
  atm_iv30: number;
  rv30?: number;
  ne_skew?: number;
  skew?: number;
  options_implied_move?: number;
  squeeze_scanner?: number;
  vrp_scanner?: number;
  tca_score?: number;
  position_factor?: number;
  put_call_ratio?: number;
  stock_volume?: number;
  stock_volume_30d_avg?: number;
  // Additional fields from GEX history JSON
  largeCoi?: number;           // large call OI strike (combo-like level)
  largePoi?: number;           // large put OI strike (combo-like level)
  atmgc?: number;              // ATM gamma calls (notional)
  atmgp?: number;              // ATM gamma puts (notional)
  atm_gamma_not?: number;      // ATM gamma notional (net)
  atm_delta_not?: number;      // ATM delta notional (net)
  atmdc?: number;              // ATM delta calls
  atmdp?: number;              // ATM delta puts
  high_vol_point?: number;     // high vol point (gamma peak proxy)
  low_vol_point?: number;      // low vol point
  next_exp_g?: number;         // next expiry gamma fraction
  next_exp_d?: number;         // next expiry delta fraction
  callsum?: number;            // total call OI
  putsum?: number;             // total put OI
  cv?: number;                 // call volume
  pv?: number;                 // put volume
}

interface IntradayEpisode {
  // Identity
  date: string;
  sym: string;
  cfd: string;
  timeMinute: number;     // minutes since midnight ET (e.g., 570 = 9:30)
  timeNorm: number;       // 0-1 normalized within trading day

  // Price at this moment
  price: number;

  // What happened next (outcome)
  priceIn30min: number;   // price 30 minutes later
  priceIn60min: number;   // price 60 minutes later
  priceDeltaPct30: number; // % change in 30 min
  priceDeltaPct60: number; // % change in 60 min
  dayHigh30: number;      // max price in next 30 min
  dayLow30: number;       // min price in next 30 min

  // Exact outcome from 1-min candles (filled when available)
  has1MinData?: boolean;
  exactOutcomeLong?: "tp1" | "tp2" | "tp3" | "sl" | "cancelled";
  exactOutcomeShort?: "tp1" | "tp2" | "tp3" | "sl" | "cancelled";
  exactHitMinuteLong?: number;
  exactHitMinuteShort?: number;
  exactMFELong?: number;    // max favorable excursion LONG
  exactMAELong?: number;    // max adverse excursion LONG
  exactMFEShort?: number;
  exactMAEShort?: number;

  // Intraday context features
  priceVsDayOpen: number;  // % from day open
  priceVsDayHigh: number;  // % from running high
  priceVsDayLow: number;   // % from running low
  dayRangePct: number;     // current day range as % of price
  volumeVsAvg: number;     // recent volume vs day average

  // Daily GEX/tilt features (same for all episodes in a day)
  gammaTilt: number;
  deltaTilt: number;
  gammaRatioNorm: number;
  deltaRatioNorm: number;
  ivRank: number;
  neSkew: number;
  vrp: number;
  squeezeSig: number;
  positionFactor: number;
  putCallRatio: number;
  volumeRatio: number;
  atrPct: number;
  callWall: number;
  putWall: number;

  // Momentum (computed from daily OHLC)
  momentum5d: number;
  momentum20d: number;
  rsi14: number;

  // Phase 2 intraday features
  candleBodyRatio: number;     // |close-open| / (high-low) for recent candles
  candleTrend: number;         // trend direction from last 3 simulated candles
  candleVolSpike: number;      // current volume / avg volume
  impliedMovePct: number;      // options implied move as % of price
  impliedMoveUsage: number;    // actual day range / implied move
  comboLevelDist: number;      // % distance to nearest combo level
  comboLevelSide: number;      // +1 above, -1 below nearest combo level
  absGammaPeakDist: number;    // % distance to peak abs gamma strike
  absGammaSkew: number;        // call vs put gamma skew [-1,1]
  hiroNorm: number;            // HIRO proxy normalized [-1,1]
  hiroAccel: number;           // HIRO acceleration proxy
  volumeProfilePOC: number;    // % distance to volume POC
  volumeImbalance: number;     // volume above vs below price [0,1]

  // Phase 1 derived from GEX
  gammaWallDist: number;
  gammaConcentration: number;
  callGammaRatioVal: number;
  nextExpGamma: number;
  nextExpDelta: number;
  tapeBullishPct: number;
  tapePremiumRatio: number;
  tapeGammaSkewVal: number;

  // Quality
  isOPEXWeek: boolean;
  hasGEX: boolean;        // true = has full GEX data, false = tilt-only
  dayOfWeek: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadJSON<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch { return null; }
}

function isOPEXWeek(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z");
  const year = d.getUTCFullYear(), month = d.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1));
  let firstFriday = 1 + ((5 - firstDay.getUTCDay() + 7) % 7);
  const thirdFriday = firstFriday + 14;
  const weekStart = thirdFriday - 4;  // Monday of OPEX week
  const weekEnd = thirdFriday;
  const dayOfMonth = d.getUTCDate();
  return dayOfMonth >= weekStart && dayOfMonth <= weekEnd;
}

function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

// ── Main Generator ──────────────────────────────────────────────────────────

export function generateIntradayEpisodes(): IntradayEpisode[] {
  console.log("[INTRADAY] Generating intraday episodes from all sources...");
  const startMs = Date.now();

  const episodes: IntradayEpisode[] = [];

  for (const sym of ALL_SYMBOLS) {
    const cfd = SYM_TO_CFD[sym] ?? "NAS100";

    // Load data sources
    const gexHistory = loadJSON<GEXHistoryRow[]>(path.join(DATA_DIR, "gex-history", `${sym}.json`)) ?? [];
    const gammaTilt = loadJSON<{ date: string; value: number }[]>(path.join(DATA_DIR, "tilt-history", `${sym}_gamma.json`)) ?? [];
    const deltaTilt = loadJSON<{ date: string; value: number }[]>(path.join(DATA_DIR, "tilt-history", `${sym}_delta.json`)) ?? [];
    const dailyOHLC = loadJSON<OHLCBar[]>(path.join(DATA_DIR, "daily-ohlc", `${sym}.json`)) ?? [];

    if (dailyOHLC.length < 25) {
      console.log(`[INTRADAY] ${sym}: skipping — only ${dailyOHLC.length} daily bars`);
      continue;
    }

    // Build date-indexed maps
    const gexMap = new Map<string, GEXHistoryRow>();
    for (const row of gexHistory) {
      // GEX dates come as "2026-03-25T04:00:00.000Z", normalize to "2026-03-25"
      const normalizedDate = row.quote_date.slice(0, 10);
      gexMap.set(normalizedDate, row);
    }

    const gammaTiltMap = new Map<string, number>();
    for (const row of gammaTilt) gammaTiltMap.set(row.date, (row as any).gammaTilt ?? (row as any).value ?? 0);

    const deltaTiltMap = new Map<string, number>();
    for (const row of deltaTilt) deltaTiltMap.set(row.date, (row as any).deltaTilt ?? (row as any).value ?? 0);

    // Sort daily bars by date
    dailyOHLC.sort((a, b) => a.t - b.t);
    const dailyCloses: number[] = [];
    const dailyDates: string[] = [];

    for (const bar of dailyOHLC) {
      const d = new Date(bar.t * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      dailyDates.push(dateStr);
      dailyCloses.push(bar.c);
    }

    // For each day, generate 26 intraday episodes (every 15 min)
    for (let dayIdx = 25; dayIdx < dailyOHLC.length - 1; dayIdx++) {
      const date = dailyDates[dayIdx];
      const bar = dailyOHLC[dayIdx];
      const nextBar = dailyOHLC[dayIdx + 1];
      if (!bar || !nextBar || bar.c <= 0) continue;

      const price = bar.c;

      // Get GEX features for this day (if available)
      const gex = gexMap.get(date);
      const hasGEX = !!gex;

      const gt = gammaTiltMap.get(date) ?? 0;
      const dt = deltaTiltMap.get(date) ?? 0;

      // Compute momentum
      const momentum5d = dayIdx >= 5 ? (dailyCloses[dayIdx] - dailyCloses[dayIdx - 5]) / dailyCloses[dayIdx - 5] * 100 : 0;
      const momentum20d = dayIdx >= 20 ? (dailyCloses[dayIdx] - dailyCloses[dayIdx - 20]) / dailyCloses[dayIdx - 20] * 100 : 0;
      const rsi14 = computeRSI(dailyCloses.slice(0, dayIdx + 1));

      // ATR
      let atrSum = 0, atrCount = 0;
      for (let k = Math.max(1, dayIdx - 13); k <= dayIdx; k++) {
        const hk = dailyOHLC[k]?.h ?? 0, lk = dailyOHLC[k]?.l ?? 0, ck = dailyCloses[k - 1] ?? price;
        const tr = Math.max(hk - lk, Math.abs(hk - ck), Math.abs(lk - ck));
        atrSum += tr; atrCount++;
      }
      const atrPct = atrCount > 0 ? (atrSum / atrCount) / price * 100 : 1;

      // GEX-derived features
      const gammaRatio = gex ? (typeof gex.gamma_ratio === "number" ? gex.gamma_ratio : parseFloat(gex.gamma_ratio as string) || 1) : 1;
      const gammaRatioNorm = gammaRatio / (gammaRatio + 1);
      const deltaRatio = gex ? (typeof gex.delta_ratio === "number" ? gex.delta_ratio : parseFloat(gex.delta_ratio as string) || 0.5) : 0.5;
      const ivRank = gex ? (typeof gex.iv_rank === "number" ? gex.iv_rank : parseFloat(gex.iv_rank as string) || 50) / 100 : 0.5;
      const neSkew = gex?.ne_skew ?? 0;
      const vrp = gex ? ((gex.atm_iv30 ?? 0) - (gex.rv30 ?? gex.atm_iv30 ?? 0)) : 0;
      const squeezeSig = gex?.squeeze_scanner ?? 50;  // 50 = neutral (normalization: (val-50)/50)
      const positionFactor = gex?.position_factor ?? 0;
      const putCallRatio = gex?.put_call_ratio ?? 1;
      const stockVol = gex?.stock_volume ?? 0;
      const stockVol30d = gex?.stock_volume_30d_avg ?? (stockVol || 1);
      const volumeRatio = stockVol30d > 0 ? stockVol / stockVol30d : 1;

      // Approximate call/put walls from ATR
      const callWall = price * (1 + atrPct / 100 * 1.5);
      const putWall = price * (1 - atrPct / 100 * 1.5);

      const dayOfWeek = (() => {
        const d = new Date(date + "T12:00:00Z").getUTCDay();
        return d === 0 ? -1 : d === 6 ? 1 : (d - 3) / 2;
      })();

      // Generate 26 intraday episodes (every 15 min from 9:30 to 16:00)
      // Since we don't have actual 1-min data for most days, we SIMULATE
      // intraday price path using the day's OHLC range
      const dayOpen = bar.o;
      const dayHigh = bar.h;
      const dayLow = bar.l;
      const dayClose = bar.c;
      const dayRange = dayHigh - dayLow;

      // ── Phase 2 feature computations ─────────────────────────────────
      // candleBodyRatio: |close-open| / (high-low) from daily bar
      const candleBodyRatioDay = dayRange > 0 ? Math.abs(dayClose - dayOpen) / dayRange : 0.5;

      // impliedMovePct: options implied move as % of price
      const rawImpliedMove = gex?.options_implied_move ?? 0;
      const impliedMovePctDay = rawImpliedMove > 0 ? (rawImpliedMove / price) * 100 : atrPct;

      // comboLevel: use largeCoi/largePoi as combo-like levels
      const comboCallLevel = gex?.largeCoi ?? callWall;
      const comboPutLevel = gex?.largePoi ?? putWall;
      const distToCallCombo = Math.abs(price - comboCallLevel) / price * 100;
      const distToPutCombo = Math.abs(price - comboPutLevel) / price * 100;
      // (per-slot combo distance computed in the slot loop below)

      // absGammaPeakDist: distance to peak abs gamma (use high_vol_point as proxy)
      const gammaPeakStrike = gex?.high_vol_point ?? price;
      // (per-slot gamma peak distance computed in the slot loop below)

      // absGammaSkew: (call gamma - |put gamma|) / total at ATM
      const atmGammaCall = gex?.atmgc ?? 0;
      const atmGammaPut = gex?.atmgp ?? 0;
      const totalGamma = Math.abs(atmGammaCall) + Math.abs(atmGammaPut);
      const absGammaSkewDay = totalGamma > 0
        ? (Math.abs(atmGammaCall) - Math.abs(atmGammaPut)) / totalGamma
        : (gammaRatio > 1 ? 0.3 : gammaRatio < 0.5 ? -0.3 : 0);

      // hiroNorm: use delta_ratio as HIRO proxy, normalize to [-1,1]
      // delta_ratio near 0.5 = neutral, <0.5 = bearish flow, >0.5 = bullish
      const hiroNormDay = (typeof deltaRatio === "number" ? deltaRatio : 0.5) * 2 - 1;

      // hiroAccel: compare today's delta_ratio to yesterday's as acceleration
      const prevDate = dayIdx > 0 ? dailyDates[dayIdx - 1] : "";
      const prevGex = gexMap.get(prevDate);
      const prevDeltaRatio = prevGex
        ? (typeof prevGex.delta_ratio === "number" ? prevGex.delta_ratio : parseFloat(prevGex.delta_ratio as string) || 0.5)
        : (typeof deltaRatio === "number" ? deltaRatio : 0.5);
      const hiroAccelDay = ((typeof deltaRatio === "number" ? deltaRatio : 0.5) - prevDeltaRatio) * 5; // scale up

      // volumeProfilePOC: approximate POC as VWAP-like midpoint of day
      // POC ~ price level with highest volume; approximate as weighted avg of OHLC
      const pocEstimate = (dayOpen + dayHigh + dayLow + dayClose) / 4; // typical price
      // (per-slot POC distance and volume imbalance computed in the slot loop below)

      // candleVolSpike: use stock volume vs 30d avg from GEX data
      const candleVolSpikeDay = volumeRatio > 0 ? volumeRatio : 1;

      if (dayRange <= 0) continue;

      // Create 26 time slots (9:30 to 16:00, every 15 min)
      for (let slot = 0; slot < 26; slot++) {
        const minuteOfDay = 570 + slot * 15;  // 570 = 9:30 ET
        const timeNorm = slot / 25;  // 0 to 1

        // Simulate intraday price at this time slot
        // Using a parabolic interpolation: open → extreme → close
        // This is a simplification but captures the U-shaped intraday pattern
        let t = timeNorm;
        let simulatedPrice: number;

        if (dayClose > dayOpen) {
          // Bullish day: open, dip to low ~10:30, rally to high ~14:00, close near high
          const lowTime = 0.15;  // 10:30
          const highTime = 0.75; // 14:00
          if (t < lowTime) {
            simulatedPrice = dayOpen + (dayLow - dayOpen) * (t / lowTime);
          } else if (t < highTime) {
            simulatedPrice = dayLow + (dayHigh - dayLow) * ((t - lowTime) / (highTime - lowTime));
          } else {
            simulatedPrice = dayHigh + (dayClose - dayHigh) * ((t - highTime) / (1 - highTime));
          }
        } else {
          // Bearish day: open, rally to high ~10:30, sell to low ~14:00, close near low
          const highTime = 0.15;
          const lowTime = 0.75;
          if (t < highTime) {
            simulatedPrice = dayOpen + (dayHigh - dayOpen) * (t / highTime);
          } else if (t < lowTime) {
            simulatedPrice = dayHigh + (dayLow - dayHigh) * ((t - highTime) / (lowTime - highTime));
          } else {
            simulatedPrice = dayLow + (dayClose - dayLow) * ((t - lowTime) / (1 - lowTime));
          }
        }

        // Add small noise to avoid identical patterns
        simulatedPrice *= (1 + (Math.random() - 0.5) * 0.001);

        // Future prices (30min and 60min later)
        const futureSlot30 = Math.min(slot + 2, 25);
        const futureSlot60 = Math.min(slot + 4, 25);

        // If near end of day, use next day's open as future
        const futureT30 = futureSlot30 / 25;
        const futureT60 = futureSlot60 / 25;

        let futurePrice30: number, futurePrice60: number;
        if (futureSlot30 >= 25) {
          futurePrice30 = nextBar.o;  // next day open
        } else {
          // Same interpolation logic
          futurePrice30 = dayClose > dayOpen
            ? (futureT30 < 0.15 ? dayOpen + (dayLow - dayOpen) * (futureT30 / 0.15)
              : futureT30 < 0.75 ? dayLow + (dayHigh - dayLow) * ((futureT30 - 0.15) / 0.6)
              : dayHigh + (dayClose - dayHigh) * ((futureT30 - 0.75) / 0.25))
            : (futureT30 < 0.15 ? dayOpen + (dayHigh - dayOpen) * (futureT30 / 0.15)
              : futureT30 < 0.75 ? dayHigh + (dayLow - dayHigh) * ((futureT30 - 0.15) / 0.6)
              : dayLow + (dayClose - dayLow) * ((futureT30 - 0.75) / 0.25));
        }

        if (futureSlot60 >= 25) {
          futurePrice60 = nextBar.o;
        } else {
          futurePrice60 = dayClose > dayOpen
            ? (futureT60 < 0.15 ? dayOpen + (dayLow - dayOpen) * (futureT60 / 0.15)
              : futureT60 < 0.75 ? dayLow + (dayHigh - dayLow) * ((futureT60 - 0.15) / 0.6)
              : dayHigh + (dayClose - dayHigh) * ((futureT60 - 0.75) / 0.25))
            : (futureT60 < 0.15 ? dayOpen + (dayHigh - dayOpen) * (futureT60 / 0.15)
              : futureT60 < 0.75 ? dayHigh + (dayLow - dayHigh) * ((futureT60 - 0.15) / 0.6)
              : dayLow + (dayClose - dayLow) * ((futureT60 - 0.75) / 0.25));
        }

        // Running high/low up to this point
        const runningHigh = dayClose > dayOpen
          ? (t < 0.15 ? Math.max(dayOpen, simulatedPrice) : t < 0.75 ? dayHigh * t / 0.75 : dayHigh)
          : (t < 0.15 ? dayHigh : dayHigh);
        const runningLow = dayClose > dayOpen
          ? (t < 0.15 ? dayLow : dayLow)
          : (t < 0.15 ? Math.min(dayOpen, simulatedPrice) : t < 0.75 ? dayLow : dayLow);

        const priceDeltaPct30 = (futurePrice30 - simulatedPrice) / simulatedPrice * 100;
        const priceDeltaPct60 = (futurePrice60 - simulatedPrice) / simulatedPrice * 100;

        // Max/min in next 30 min (approximated)
        const maxNext30 = Math.max(simulatedPrice, futurePrice30) * (1 + Math.random() * 0.002);
        const minNext30 = Math.min(simulatedPrice, futurePrice30) * (1 - Math.random() * 0.002);

        // candleTrend: simulate from price movement direction over last 3 slots
        // Use simulated price path: check if trending up or down at this time
        let candleTrendSlot: number;
        if (slot < 3) {
          candleTrendSlot = dayClose > dayOpen ? 1 : -1;
        } else {
          // Check last 3 slot prices (simulated) to determine local trend
          const prevT1 = (slot - 1) / 25;
          const prevT2 = (slot - 2) / 25;
          const prevT3 = (slot - 3) / 25;
          const interpPrice = (tVal: number) => {
            if (dayClose > dayOpen) {
              return tVal < 0.15 ? dayOpen + (dayLow - dayOpen) * (tVal / 0.15)
                : tVal < 0.75 ? dayLow + (dayHigh - dayLow) * ((tVal - 0.15) / 0.6)
                : dayHigh + (dayClose - dayHigh) * ((tVal - 0.75) / 0.25);
            } else {
              return tVal < 0.15 ? dayOpen + (dayHigh - dayOpen) * (tVal / 0.15)
                : tVal < 0.75 ? dayHigh + (dayLow - dayHigh) * ((tVal - 0.15) / 0.6)
                : dayLow + (dayClose - dayLow) * ((tVal - 0.75) / 0.25);
            }
          };
          const p1 = interpPrice(prevT1);
          const p2 = interpPrice(prevT2);
          const p3 = interpPrice(prevT3);
          const ups = (simulatedPrice > p1 ? 1 : 0) + (p1 > p2 ? 1 : 0) + (p2 > p3 ? 1 : 0);
          candleTrendSlot = ups >= 2 ? 1 : ups <= 1 ? -1 : 0;
        }

        // candleBodyRatio varies slightly by slot: near open/close it's higher
        const slotBodyRatio = Math.min(1, candleBodyRatioDay * (0.7 + 0.6 * Math.abs(t - 0.5)));

        // comboLevelDist varies with simulated price
        const slotDistToCallCombo = Math.abs(simulatedPrice - comboCallLevel) / simulatedPrice * 100;
        const slotDistToPutCombo = Math.abs(simulatedPrice - comboPutLevel) / simulatedPrice * 100;
        const slotComboDist = Math.min(slotDistToCallCombo, slotDistToPutCombo);
        const slotComboSide = slotDistToCallCombo <= slotDistToPutCombo
          ? (simulatedPrice > comboCallLevel ? 1 : -1)
          : (simulatedPrice > comboPutLevel ? 1 : -1);

        // absGammaPeakDist varies with simulated price
        const slotGammaPeakDist = Math.abs(simulatedPrice - gammaPeakStrike) / simulatedPrice * 100;

        // volumeProfilePOC varies with simulated price
        const slotPOCDist = (simulatedPrice - pocEstimate) / simulatedPrice * 100;

        // volumeImbalance varies with simulated price
        const slotVolImbalance = dayRange > 0
          ? (simulatedPrice - dayLow) / dayRange
          : 0.5;

        // impliedMoveUsage varies as day progresses (more range consumed)
        const runningRange = Math.max(simulatedPrice - dayLow, dayHigh - simulatedPrice, dayRange * t);
        const slotImpliedUsage = rawImpliedMove > 0
          ? runningRange / rawImpliedMove
          : runningRange / (price * atrPct / 100);

        // hiroNorm evolves through the day: blend with price trend
        const slotHiroNorm = hiroNormDay * (1 - 0.3 * (t - 0.5)); // slight evolution

        episodes.push({
          date, sym, cfd,
          timeMinute: minuteOfDay,
          timeNorm,
          price: simulatedPrice,
          priceIn30min: futurePrice30,
          priceIn60min: futurePrice60,
          priceDeltaPct30,
          priceDeltaPct60,
          dayHigh30: maxNext30,
          dayLow30: minNext30,
          priceVsDayOpen: (simulatedPrice - dayOpen) / dayOpen * 100,
          priceVsDayHigh: (dayHigh - simulatedPrice) / simulatedPrice * 100,
          priceVsDayLow: (simulatedPrice - dayLow) / simulatedPrice * 100,
          dayRangePct: dayRange / simulatedPrice * 100,
          volumeVsAvg: candleVolSpikeDay,
          gammaTilt: gt,
          deltaTilt: dt,
          gammaRatioNorm,
          deltaRatioNorm: typeof deltaRatio === "number" ? deltaRatio : 0.5,
          ivRank,
          neSkew,
          vrp,
          squeezeSig,
          positionFactor,
          putCallRatio,
          volumeRatio,
          atrPct,
          callWall,
          putWall,
          momentum5d,
          momentum20d,
          rsi14,
          // Phase 2 features
          candleBodyRatio: slotBodyRatio,
          candleTrend: candleTrendSlot,
          candleVolSpike: candleVolSpikeDay * (0.8 + 0.4 * (t < 0.1 || t > 0.9 ? 1.5 : 1)), // volume higher at open/close
          impliedMovePct: impliedMovePctDay,
          impliedMoveUsage: slotImpliedUsage,
          comboLevelDist: slotComboDist,
          comboLevelSide: slotComboSide,
          absGammaPeakDist: slotGammaPeakDist,
          absGammaSkew: absGammaSkewDay,
          hiroNorm: Math.max(-1, Math.min(1, slotHiroNorm)),
          hiroAccel: Math.max(-2, Math.min(2, hiroAccelDay)),
          volumeProfilePOC: slotPOCDist,
          volumeImbalance: slotVolImbalance,
          // Phase 1 features derived from GEX
          gammaWallDist: gex?.high_vol_point ? ((gex.high_vol_point - simulatedPrice) / simulatedPrice) * 100 : 0,
          gammaConcentration: (() => {
            if (!gex?.atm_gamma_not) return 0;
            const tG = Math.abs(gex.atmgc ?? 0) + Math.abs(gex.atmgp ?? 0);
            return tG > 0 ? Math.abs(gex.atm_gamma_not) / tG : 0;
          })(),
          callGammaRatioVal: (() => {
            const cg = Math.abs(gex?.atmgc ?? 0);
            const pg = Math.abs(gex?.atmgp ?? 0);
            return (cg + pg) > 0 ? cg / (cg + pg) : 0.5;
          })(),
          nextExpGamma: gex?.next_exp_g ?? 0,
          nextExpDelta: gex?.next_exp_d ?? 0,
          tapeBullishPct: (() => {
            const cv = gex?.cv ?? 0;
            const pv = gex?.pv ?? 0;
            return (cv + pv) > 0 ? cv / (cv + pv) : 0.5;
          })(),
          tapePremiumRatio: (() => {
            const nc = gex?.ne_call_volume ?? 0;
            const np_ = gex?.ne_put_volume ?? 0;
            return (nc + np_) > 0 ? nc / (nc + np_) : 0.5;
          })(),
          tapeGammaSkewVal: absGammaSkewDay,
          isOPEXWeek: isOPEXWeek(date),
          hasGEX,
          dayOfWeek,
        });

        // Compute exact outcomes using 1-min candles if available
        const ep = episodes[episodes.length - 1];
        const minuteOffset = Math.floor((minuteOfDay - 570)); // minutes since 9:30 ET
        const exactLong = computeExactOutcome({
          symbol: sym, date, direction: "LONG",
          entryMinuteOffset: Math.max(0, minuteOffset),
          atrPct, slMult: 0.40, tp1Mult: 0.25, tp2Mult: 0.55, tp3Mult: 1.20,
        });
        const exactShort = computeExactOutcome({
          symbol: sym, date, direction: "SHORT",
          entryMinuteOffset: Math.max(0, minuteOffset),
          atrPct, slMult: 0.40, tp1Mult: 0.25, tp2Mult: 0.55, tp3Mult: 1.20,
        });

        if (exactLong) {
          ep.has1MinData = true;
          ep.exactOutcomeLong = exactLong.outcome;
          ep.exactHitMinuteLong = exactLong.hitMinute;
          ep.exactMFELong = exactLong.maxFavorable;
          ep.exactMAELong = exactLong.maxAdverse;
        }
        if (exactShort) {
          ep.has1MinData = true;
          ep.exactOutcomeShort = exactShort.outcome;
          ep.exactHitMinuteShort = exactShort.hitMinute;
          ep.exactMFEShort = exactShort.maxFavorable;
          ep.exactMAEShort = exactShort.maxAdverse;
        }
      }
    }

    // Free memory from 1-min bar cache after processing each symbol
    clearBarCache();
    console.log(`[INTRADAY] ${sym}: generated episodes from ${dailyOHLC.length} days`);
  }

  console.log(`[INTRADAY] Total: ${episodes.length.toLocaleString()} intraday episodes in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

  return episodes;
}

// ── Convert intraday episodes to PPOState-compatible EpisodeData ──────────

export function intradayToPPOEpisodes(intradayEps: IntradayEpisode[]): any[] {
  return intradayEps.map(ep => ({
    date: ep.date,
    nextDate: ep.date,
    sym: ep.sym,
    cfd: ep.cfd,
    price: ep.price,
    nextPrice: ep.priceIn30min,
    priceDeltaPct: ep.priceDeltaPct30,
    callWall: ep.callWall,
    putWall: ep.putWall,
    gammaRatioNorm: ep.gammaRatioNorm,
    deltaRatioNorm: ep.deltaRatioNorm,
    ivRank: ep.ivRank,
    atrPct: ep.atrPct,
    neSkew: ep.neSkew,
    vrp: ep.vrp,
    isOPEXWeek: ep.isOPEXWeek,
    gammaTilt: ep.gammaTilt,
    deltaTilt: ep.deltaTilt,
    squeezeSig: ep.squeezeSig,
    vrpScannerSig: 0,
    tcaScore: 0,
    positionFactor: ep.positionFactor,
    putCallRatio: ep.putCallRatio,
    volumeRatio: ep.volumeRatio,
    dayHigh: ep.dayHigh30,
    dayLow: ep.dayLow30,
    momentum5d: ep.momentum5d,
    momentum20d: ep.momentum20d,
    rsi14: ep.rsi14,
    signalQuality: 0,
    isTiltOnly: !ep.hasGEX,
    // Phase 1 features — from episode's pre-computed values
    gammaWallDist: ep.gammaWallDist ?? 0,
    gammaConcentration: ep.gammaConcentration ?? 0,
    callGammaRatio: ep.callGammaRatioVal ?? 0.5,
    nextExpGamma: ep.nextExpGamma ?? 0,
    nextExpDelta: ep.nextExpDelta ?? 0,
    tapeBullishPct: ep.tapeBullishPct ?? 0.5,
    tapePremiumRatio: ep.tapePremiumRatio ?? 0.5,
    tapeGammaSkew: ep.tapeGammaSkewVal ?? 0,
    // Phase 2 features — intraday context, computed from GEX history data
    candleBodyRatio: ep.candleBodyRatio,
    candleTrend: ep.candleTrend,
    candleVolSpike: ep.candleVolSpike,
    impliedMovePct: ep.impliedMovePct,
    impliedMoveUsage: ep.impliedMoveUsage,
    comboLevelDist: ep.comboLevelDist,
    comboLevelSide: ep.comboLevelSide,
    absGammaPeakDist: ep.absGammaPeakDist,
    absGammaSkew: ep.absGammaSkew,
    hiroNorm: ep.hiroNorm,
    hiroAccel: ep.hiroAccel,
    volumeProfilePOC: ep.volumeProfilePOC,
    volumeImbalance: ep.volumeImbalance,
    dayOfWeek: ep.dayOfWeek,
    // Exact outcomes from 1-min data
    has1MinData: ep.has1MinData ?? false,
    exactOutcomeLong: ep.exactOutcomeLong,
    exactOutcomeShort: ep.exactOutcomeShort,
    exactHitMinuteLong: ep.exactHitMinuteLong,
    exactHitMinuteShort: ep.exactHitMinuteShort,
    exactMFELong: ep.exactMFELong,
    exactMAELong: ep.exactMAELong,
    exactMFEShort: ep.exactMFEShort,
    exactMAEShort: ep.exactMAEShort,
  }));
}

// ── Save/Load cache ─────────────────────────────────────────────────────────

export function saveIntradayCache(episodes: IntradayEpisode[]): void {
  const dir = path.dirname(INTRADAY_CACHE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INTRADAY_CACHE, JSON.stringify(episodes), "utf-8");
  console.log(`[INTRADAY] Saved ${episodes.length.toLocaleString()} episodes to cache`);
}

export function loadIntradayCache(): IntradayEpisode[] | null {
  try {
    if (!fs.existsSync(INTRADAY_CACHE)) return null;
    const data = JSON.parse(fs.readFileSync(INTRADAY_CACHE, "utf-8"));
    return Array.isArray(data) ? data : null;
  } catch { return null; }
}
