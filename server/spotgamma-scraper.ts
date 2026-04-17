/**
 * SpotGamma Market Monitor - API-based Data Extractor v4
 * Uses SpotGamma's internal APIs directly for maximum speed and accuracy.
 * Only uses Playwright for initial login to get JWT token.
 *
 * v4 changes:
 * - ALL gamma bars included (not just top 20)
 * - Gamma split by expiration: 0DTE vs monthly vs total
 * - Delta-Adjusted GEX
 * - Smart entry signals based on gamma outlier zones + HIRO/Tape/GEX confirmation
 * - Improved pre-market summary (always available, not just 7-9am)
 */
import { chromium, Browser } from "playwright";
import { generateTradeSetups, refreshCandleSignals, type TradeSetup, type DecisionLevel, type VolatilityAnalysis } from "./trading-engine";
import { trackSetups, resolveSetupOutcomes } from "./setup-tracker";
import * as fs from "fs";
import * as path from "path";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { createHmac } from "crypto";

const TOKEN_FILE = path.join(process.cwd(), ".sg_token");

// ============ CONFIG ============

const ASSETS = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA", "UVIX"] as const;
const SPOTGAMMA_EMAIL = process.env.SPOTGAMMA_EMAIL ?? "";
const SPOTGAMMA_PASSWORD = process.env.SPOTGAMMA_PASSWORD ?? "";
const API_BASE = "https://api.spotgamma.com";
const STREAM_API_BASE = "https://api.stream.spotgamma.com";

const NEAR_PRICE_RANGE: Record<string, number> = {
  SPX: 200, SPY: 10, QQQ: 10, GLD: 10, VIX: 5, DIA: 10, UVIX: 3,
};

// ============ TYPES ============

export interface StrikeData {
  strike: number;
  callGamma: number;
  putGamma: number;
  totalGamma: number;
  gammaAll: number;       // bars.cust.gamma.all (total = puts + calls)
  gamma0DTE: number;      // bars.cust.gamma.next_exp (total)
  gammaMonthly: number;   // bars.cust.gamma.monthly (total)
  callGammaNotional: number;  // bars.cust.gamma.all.calls (real call gamma per strike)
  putGammaNotional: number;   // bars.cust.gamma.all.puts (real put gamma per strike)
  callOI: number;
  putOI: number;
  totalOI: number;
  gammaNotional: number;
  netPosCalls: number;    // net positioning calls (flow)
  netPosPuts: number;     // net positioning puts (flow)
  netPosTotal: number;    // net total positioning
  volume?: number;
  distanceFromPrice: number;
  distancePct: number;
  isNearPrice: boolean;
  isOutlier: boolean;     // Is this a gamma outlier (significantly above average)?
  outlierScore: number;   // How many standard deviations above mean
  levelType?: string;
  is0DTE?: boolean;
}

export interface FlowData {
  callVolume: number;
  putVolume: number;
  putCallRatioVolume: number;
  netCallPositioning: number;  // sum of net_positioning calls near price
  netPutPositioning: number;   // sum of net_positioning puts near price
  flowDirection: "bullish" | "bearish" | "neutral";
  flowStrength: number;  // 0-100
  topFlowStrikes: { strike: number; netCalls: number; netPuts: number; direction: string }[];
  description: string;
  lastUpdated: string;
}

export interface ChartBar {
  strike: number;
  gammaAll: number;
  gamma0DTE: number;
  gammaMonthly: number;
  callGamma: number;
  putGamma: number;
  totalGamma: number;
  callGammaNotional: number;
  putGammaNotional: number;
  callOI: number;
  putOI: number;
  totalOI: number;
  isOutlier: boolean;
  outlierScore: number;
}

export interface AssetData {
  symbol: string;
  currentPrice: number;
  previousClose: number;
  dailyChange: number;
  dailyChangePct: number;
  callGamma: number;
  putGamma: number;
  totalGamma: number;
  putCallRatio: number;
  ivRank: number;
  impliedMove: number;
  highVolPoint: number;
  lowVolPoint: number;
  callVolume: number;
  putVolume: number;
  oneMonthIV: number;
  oneMonthRV: number;
  garchRank: number;
  skewRank: number;
  topGammaExp: string;
  topDeltaExp: string;
  topStrikes: StrikeData[];
  strikes: StrikeData[];
  chartData: ChartBar[];
  gammaFlipLevel: number;
  zeroDteGamma: number;
  outlierStrikes: StrikeData[];  // Strikes with gamma significantly above average
  flowData: FlowData | null;     // Net positioning flow data
  lastUpdated: string;
  error?: string;
}

export interface GexData {
  gexValue: number;
  gexTrend: "bullish" | "bearish" | "neutral";
  dealerIntent: string;
  keyLevel: number;
  zeroGammaLevel: number;
  volTriggerLevel: number;
  is0DTE: boolean;
  odteGexValue: number;
  deltaAdjustedGex: number;
  deltaAdjustedGexAtLevels: { price: number; dagex: number }[];
  hedgeWall: number;
  putWall: number;
  rawText: string;
  lastUpdated: string;
}

export interface HiroAssetData {
  instrument: string;
  hiroValue: number;
  hiroTrend: "bullish" | "bearish" | "neutral";
  hiroRange30dMin: number;
  hiroRange30dMax: number;
  description: string;
}

export interface HiroData {
  hiroValue: number;  // SPX HIRO for backward compat
  hiroTrend: "bullish" | "bearish" | "neutral";
  hiroRange30dMin: number;
  hiroRange30dMax: number;
  description: string;
  lastUpdated: string;
  perAsset: Record<string, HiroAssetData>;  // HIRO per asset (SPX, SPY, QQQ, GLD, VIX, UVIX, DIA)
}

export interface TapeFlow {
  time: string;
  premium: number;
  premiumFormatted: string;
  symbol: string;
  side: string;
  buySell: string;
  callPut: string;
  strike: number;
  expiration: string;
  spot: number;
  delta: number;
  gamma: number;
  vega: number;
  ivol: number;
  size: number;
  prevOi: number;
  signal: "bullish" | "bearish" | "neutral";
}

export interface TapeAssetSummary {
  symbol: string;
  totalTrades: number;
  callCount: number;
  putCount: number;
  callPremium: number;
  putPremium: number;
  totalPremium: number;
  netDelta: number;  // positive = bullish, negative = bearish
  netGamma: number;
  putCallRatio: number;  // > 1 = more puts = bearish
  dominantFlow: "calls" | "puts" | "neutral";
  sentiment: "bullish" | "bearish" | "neutral";
  sentimentScore: number;  // -100 (extreme bearish) to +100 (extreme bullish)
  largestTrades: TapeFlow[];  // Top 5 by premium
  recentTrades: TapeFlow[];   // Last 10 trades
  // Strike-level flow analysis (for key level confirmation)
  strikeFlow: { strike: number; callPremium: number; putPremium: number; netDelta: number; totalSize: number; direction: "bullish" | "bearish" | "neutral" }[];
  lastUpdated: string;
}

export interface TapeData {
  // Per-asset flow data
  perAsset: Record<string, TapeAssetSummary>;
  // Global summary
  recentFlows: TapeFlow[];
  dominantFlow: "calls" | "puts" | "neutral";
  bullishPremium: number;
  bearishPremium: number;
  totalPremium: number;
  topGammaTicker: string;
  topGammaNotional: number;
  largestTrades: TapeFlow[];
  // Highlights
  topPremiumTrades: { symbol: string; premium: number; strike: number; isPut: boolean; expiry: string }[];
  topVolumeSymbols: { symbol: string; volume: number }[];
  topGammaSymbols: { symbol: string; gamma: number }[];
  minPremiumFilter: number;
  lastUpdated: string;
}

export interface VixSpxCorrelation {
  spxPrice: number;
  spxChange: number;
  spxChangePct: number;
  vixPrice: number;
  vixChange: number;
  vixChangePct: number;
  correlation: "normal" | "divergence" | "extreme";
  isDivergence: boolean;
  divergenceType: string;
  description: string;
}

export interface EconCalendarEvent {
  date: string;           // "2026-03-19"
  time?: string;          // "14:00" or ""
  event: string;          // "Fed Interest Rate Decision"
  country: string;        // "US" or "<Global>"
  currency: string;       // "USD"
  actual?: number | null;
  previous?: number | null;
  estimate?: number | null;
  change?: number | null;
  changePercentage?: number | null;
  impact: "High" | "Medium" | "Low" | string;
}

export interface PreMarketSummary {
  generatedAt: string;
  marketBias: "bullish" | "bearish" | "neutral";
  keyLevels: { asset: string; support: number; resistance: number; zeroGamma?: number }[];
  expectedRange: { asset: string; low: number; high: number }[];
  outlierZones: { asset: string; strike: number; gamma: number; type: string; action: string }[];
  summary: string;
}

export interface SmartEntrySignal {
  asset: string;
  signal: "COMPRA" | "VENDE" | "ESPERA" | "NO ENTRAR";
  confidence: "ALTA" | "MEDIA" | "BAJA";
  reason: string;
  details: string[];
  nearestOutlier: { strike: number; gamma: number; distance: number; distancePct: number } | null;
  priceInZone: boolean;
  zoneType: "soporte" | "resistencia" | "neutral";
  // Confirmation checks
  gexConfirms: boolean;
  hiroConfirms: boolean;
  tapeConfirms: boolean;
  vixConfirms: boolean;
  confirmationCount: number;  // out of 4
  gexDirection: "positive" | "negative" | "neutral";
  hiroDirection: "bullish" | "bearish" | "neutral";
  tapeFlow: "bullish" | "bearish" | "neutral";
  strikeZone: number;
}

// ============ TRACE 0DTE GEX DATA ============

export interface TraceGexBar {
  strike: number;
  netGex: number;        // puts + calls combined
  putGex: number;        // put gamma exposure
  callGex: number;       // call gamma exposure
  magnitude: number;     // absolute value of netGex
  direction: "support" | "resistance" | "neutral";  // positive = support (dealers buy dips), negative = resistance
  pctFromPrice: number;  // distance from current price as percentage
}

export interface TraceData {
  symbol: string;
  date: string;
  currentPrice: number;
  // 0DTE GEX bars (next_exp) - the live dealer positioning bars
  zeroDteGex: TraceGexBar[];
  // All-expiration GEX bars for context
  allExpGex: TraceGexBar[];
  // Key levels derived from 0DTE GEX
  topSupport: TraceGexBar[];     // Top 5 positive GEX (support/bounce zones)
  topResistance: TraceGexBar[];  // Top 5 negative GEX (resistance/rejection zones)
  maxGexStrike: number;          // Strike with highest absolute GEX
  netGexBias: "bullish" | "bearish" | "neutral";  // Overall 0DTE positioning bias
  totalPositiveGex: number;      // Sum of all positive GEX
  totalNegativeGex: number;      // Sum of all negative GEX
  gexRatio: number;              // positive/negative ratio (>1 = support dominant)
  // Gamma curve data (for heatmap/profile)
  gammaCurve: { price: number; gammaAll: number; gamma0DTE: number; gammaMonthly: number }[];
  // Key levels from the heatmap
  hedgeWall: number;
  putWall: number;
  gammaFlip: number;
  lastUpdated: string;
}

export interface VolAssetContext {
  symbol: string;
  atmIV: number;           // ATM implied volatility (%) for near-term expiry (not 0DTE)
  nearTermExpiry: string;  // Date of the near-term expiry used
  farTermIV: number;       // ATM IV for far-term expiry (%)
  farTermExpiry: string;
  termStructure: "contango" | "backwardation";  // Near vs far IV
  termSpread: number;      // farTermIV - nearTermIV (positive = contango)
  putIV: number;           // ATM put IV
  callIV: number;          // ATM call IV
  putCallSkew: number;     // putIV - callIV (positive = put premium, fear)
  ivLevel: "very_low" | "low" | "normal" | "high" | "very_high";
  numExpiries: number;
}

export interface VolContext {
  perAsset: Record<string, VolAssetContext>;
  marketSummary: string;   // AI-generated summary of vol context
  overallRegime: "low_vol" | "normal" | "high_vol" | "extreme_vol";
  avgTermStructure: "contango" | "backwardation";
  avgPutCallSkew: number;
  fetchedAt: string;
}

// ============ OFFICIAL SPOTGAMMA LEVELS ============

export interface OfficialSGLevels {
  symbol: string;
  callWall: number;           // cws - Call Wall Strike
  putWall: number;            // pws - Put Wall Strike
  keyGamma: number;           // keyg - Key Gamma Strike
  maxGamma: number;           // maxfs - Absolute Gamma Strike
  keyDelta: number;           // keyd - Key Delta Strike
  volTrigger: number;         // From SG Levels page (SPX only via scrape, others estimated)
  zeroGamma: number;          // Calculated from gamma curve
  putControl: number;         // putctrl
  impliedMove: number;        // options_implied_move (points)
  impliedMovePct: number;     // implied move as % of price
  // Previous day levels for change detection
  prevCallWall: number;
  prevPutWall: number;
  prevKeyGamma: number;
  prevMaxGamma: number;
  levelsChanged: boolean;     // Did any key level change vs yesterday?
  // Advanced metrics from equities API
  atmIV30: number;            // ATM IV 30-day (decimal, e.g. 0.1988 = 19.88%)
  rv30: number;               // Realized Vol 30-day
  vrp: number;                // Volatility Risk Premium = atmIV30 - rv30
  fwdGarch: number;           // Forward GARCH
  neSkew: number;             // Near-expiry skew
  skew: number;               // Overall skew
  callSkew: number;           // cskew
  putSkew: number;            // pskew
  d25: number;                // 25 delta IV
  d95: number;                // 95 delta IV
  d25ne: number;              // 25-delta near-expiry IV (0DTE/weekly fear gauge)
  totalDelta: number;         // Total market delta exposure (positive = bullish tilt)
  activityFactor: number;     // Options activity
  positionFactor: number;     // Position factor
  gammaRatio: number;         // Call/Put gamma ratio (>1 = call heavy)
  deltaRatio: number;         // Delta ratio
  putCallRatio: number;       // Put/Call OI ratio
  volumeRatio: number;        // Volume ratio
  // Regime classification
  gammaRegime: "positive" | "negative" | "very_negative" | "neutral";
  regimeDescription: string;
}

// ============ VANNA CONTEXT ============

export interface VannaContext {
  // VIX-based vanna for indices
  vixPrice: number;
  vixChange: number;
  vixChangePct: number;
  vixVannaSignal: "bullish" | "bearish" | "neutral";
  vixVannaStrength: "strong" | "moderate" | "weak" | "none";
  // UVXY-based for refuge trades
  uvxyPrice: number;
  uvxyChange: number;
  uvxyChangePct: number;
  uvxyRefugeSignal: "buy_gold" | "neutral" | "risk_on";
  // UVIX price (from TradingView)
  uvixPrice: number;
  uvixChange: number;
  uvixChangePct: number;
  // UVIX-GLD Divergence
  uvixGldDivergence: {
    isDiverging: boolean;
    type: "uvix_up_gld_down" | "uvix_down_gld_up" | "both_up" | "both_down" | "none";
    uvixChangePct: number;
    gldChangePct: number;
    strength: "strong" | "moderate" | "weak" | "none";
    signal: "buy_gold" | "sell_gold" | "neutral";
    description: string;
  };
  // GLD IV-based vanna
  gldIVChange: number;        // Change in GLD ATM IV
  gldPrice: number;            // GLD price from TradingView
  gldChangePct: number;        // GLD change %
  gldVannaSignal: "bullish" | "bearish" | "neutral";
  gldVannaStrength: "strong" | "moderate" | "weak" | "none";
  // Overall
  indexVannaActive: boolean;
  goldVannaActive: boolean;
  refugeFlowActive: boolean;
  description: string;
  lastUpdated: string;
}

// ============ GEX CHANGE TRACKING ============

export interface GexChangeTracker {
  currentSnapshot: {
    topSupport: { strike: number; gex: number }[];
    topResistance: { strike: number; gex: number }[];
    netBias: string;
    gexRatio: number;
    totalPositive: number;
    totalNegative: number;
    timestamp: string;
  };
  previousSnapshot: {
    topSupport: { strike: number; gex: number }[];
    topResistance: { strike: number; gex: number }[];
    netBias: string;
    gexRatio: number;
    totalPositive: number;
    totalNegative: number;
    timestamp: string;
  } | null;
  changes: {
    biasChanged: boolean;
    prevBias: string;
    newBias: string;
    ratioChange: number;       // positive = more bullish, negative = more bearish
    supportShifted: boolean;   // top support strikes changed
    resistanceShifted: boolean;
    newLevels: number[];       // strikes that appeared since last snapshot
    removedLevels: number[];   // strikes that disappeared
    description: string;
  };
  // Dynamic TP adjustment
  tpAdjustment: {
    shouldAdjustTP: boolean;
    reason: string;
    suggestedAction: "hold" | "tighten_tp" | "extend_tp" | "close_now" | "move_to_breakeven";
    newTPSuggestion: number;   // Suggested new TP level (in analysis asset price)
    confidence: number;        // 0-100
  };
  lastUpdated: string;
}

// ============ CFD PRICE DATA ============

export interface CFDPriceData {
  nas100: { price: number; prevClose: number; change: number; changePct: number };
  us30: { price: number; prevClose: number; change: number; changePct: number };
  xauusd: { price: number; prevClose: number; change: number; changePct: number };
  uvix: { price: number; prevClose: number; change: number; changePct: number };
  uvxy: { price: number; prevClose: number; change: number; changePct: number };
  gld: { price: number; prevClose: number; change: number; changePct: number };
  vix: { price: number; prevClose: number; change: number; changePct: number };
  spx?: { price: number; prevClose: number; change: number; changePct: number };
  spy?: { price: number; prevClose: number; change: number; changePct: number };
  qqq?: { price: number; prevClose: number; change: number; changePct: number };
  iwm?: { price: number; prevClose: number; change: number; changePct: number };
  dia?: { price: number; prevClose: number; change: number; changePct: number };
  lastUpdated: string;
}

// ============ TRADIER GEX DATA ============

export interface TradierGexData {
  symbol: string;
  underlyingPrice: number;
  totalGex: number;           // Sum of all GEX (positive = dealers long gamma)
  gammaFlipLevel: number;     // Strike where cumulative GEX transitions
  netBias: "bullish" | "bearish" | "neutral";
  topSupport: { strike: number; netGex: number; pctFromPrice: number }[];
  topResistance: { strike: number; netGex: number; pctFromPrice: number }[];
  gexByStrike: { strike: number; callGex: number; putGex: number; netGex: number }[];
  expiration: string;
  is0DTE: boolean;            // True if expiration is today (same-day gamma pressure)
  lastUpdated: string;
}

export interface MarketData {
  assets: AssetData[];
  tradierGex: Record<string, TradierGexData>;  // GEX from Tradier for GLD, DIA
  gex: GexData | null;
  hiro: HiroData | null;
  tape: TapeData | null;
  flow: FlowData | null;  // Overall flow data from net positioning
  traceData: TraceData | null;  // Live 0DTE GEX from TRACE
  volContext: VolContext | null;  // Volatility context per asset
  entrySignals: SmartEntrySignal[];
  tradeSetups: TradeSetup[];  // New v2 trading engine setups
  spotgammaLevels: Record<string, any>;
  officialLevels: Record<string, OfficialSGLevels>;  // Official SG levels per asset
  vannaContext: VannaContext | null;                   // Vanna flow context
  cfdPrices: CFDPriceData | null;                      // CFD prices for trade execution
  gexChangeTracker: GexChangeTracker | null;            // Live GEX change tracking
  vixSpxCorrelation: VixSpxCorrelation | null;
  preMarketSummary: PreMarketSummary | null;
  economicCalendar: EconCalendarEvent[];       // Events from SpotGamma/FMP for today + next 7 days
  sessionDate: string;
  fetchedAt: string;
  isMarketOpen: boolean;
  marketStatus: "pre_market" | "open" | "closed";
}

// ============ STATE ============

let sgToken: string = "";
let tokenExpiry: number = 0;
let cachedData: MarketData | null = null;

// ============ DEBUG: HIRO ENDPOINT EXPLORER ============
export async function exploreHiroEndpoints(): Promise<any> {
  const token = await getToken();
  if (!token) return { error: "No token" };
  
  const date = getLastTradingDate();
  const endpoints = [
    `/v1/hiro?sym=SPX`,
    `/v1/hiro?sym=SPX&date=${date}`,
    `/v2/hiro?sym=SPX`,
    `/v3/hiro?sym=SPX`,
    `/v1/hiro/SPX`,
    `/v2/hiro/SPX`,
    `/v3/hiro/SPX`,
    `/v1/tns?sym=SPX`,
    `/v1/tns?sym=SPX&date=${date}`,
    `/v2/tns?sym=SPX`,
    `/v3/tns?sym=SPX`,
    `/v1/flow?sym=SPX`,
    `/v2/flow?sym=SPX`,
    `/v3/flow?sym=SPX`,
    `/v1/signals?sym=SPX`,
    `/v2/signals?sym=SPX`,
    `/v3/signals?sym=SPX`,
    `/v1/realtime?sym=SPX`,
    `/v2/realtime?sym=SPX`,
    `/v1/trending`,
    `/v2/trending`,
    `/v3/trending`,
    `/v1/hiro-data?sym=SPX`,
    `/v1/hiroData?sym=SPX`,
    `/v1/hiro/data?sym=SPX`,
    `/v1/hiro/current?sym=SPX`,
    `/v1/hiro/summary?sym=SPX`,
    `/v1/me/pollUpdate?features=%7B%22futures%22%3A%7B%7D%7D`,
    `/v3/equitiesBySyms?syms=SPX&date=${date}`,
  ];
  
  const results: Record<string, any> = {};
  
  for (const ep of endpoints) {
    try {
      const resp = await fetch(`${API_BASE}${ep}`, {
        headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const str = JSON.stringify(data);
        const hasHiro = str.toLowerCase().includes('hiro');
        results[ep] = {
          status: resp.status,
          size: str.length,
          hasHiro,
          topKeys: typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : (Array.isArray(data) ? `Array[${data.length}]` : typeof data),
          sample: str.substring(0, 500),
        };
      } else {
        results[ep] = { status: resp.status, error: resp.statusText };
      }
    } catch (e: any) {
      results[ep] = { error: e.message };
    }
  }
  
  return results;
}

// ============ HELPERS ============

export function getColombiaTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
}

export function getSessionDate(): string {
  const d = getColombiaTime();
  return d.toISOString().split("T")[0];
}

export function getMarketStatus(): { status: "pre_market" | "open" | "closed"; isOpen: boolean } {
  // Colombia (UTC-5) is 1 hour behind ET during EDT (April-Oct)
  // Market hours: 9:30 AM - 4:00 PM ET = 8:30 AM - 3:00 PM Colombia
  const now = getColombiaTime();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const day = now.getDay();
  if (day === 0 || day === 6) return { status: "closed", isOpen: false };
  const totalMinutes = hours * 60 + minutes;
  // Pre-market: 7:00 AM - 8:30 AM Colombia (8:00 AM - 9:30 AM ET)
  if (totalMinutes >= 420 && totalMinutes < 510) return { status: "pre_market", isOpen: false };
  // Market open: 8:30 AM - 3:00 PM Colombia (9:30 AM - 4:00 PM ET)
  if (totalMinutes >= 510 && totalMinutes <= 900) return { status: "open", isOpen: true };
  return { status: "closed", isOpen: false };
}

function getLastTradingDate(): string {
  const now = new Date();
  const d = new Date(now);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  else if (day === 6) d.setDate(d.getDate() - 1);
  const hour = now.getUTCHours();
  if (day >= 1 && day <= 5 && hour < 14) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() === 0) d.setDate(d.getDate() - 2);
    if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split("T")[0];
}

// ============ AUTH ============

function loadTokenFromFile(): boolean {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const savedToken = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
      if (savedToken && savedToken.length > 50) {
        sgToken = savedToken;
        // Check file age - if saved within 30 min, trust it without validation
        const stat = fs.statSync(TOKEN_FILE);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMs < 30 * 60 * 1000) {
          tokenExpiry = Date.now() + (30 * 60 * 1000 - ageMs);
          console.log(`[API] Token loaded from file (${ageMin}min old, trusted)`);
        } else {
          tokenExpiry = Date.now() + 3600000;
          console.log(`[API] Token loaded from file (${ageMin}min old, will validate)`);
        }
        return true;
      }
    }
  } catch (e) {
    console.log("[API] Could not load token from file");
  }
  return false;
}

function saveTokenToFile(token: string): void {
  try {
    fs.writeFileSync(TOKEN_FILE, token, "utf-8");
    console.log("[API] Token saved to file (.sg_token)");
  } catch (e) {
    console.log("[API] Could not save token to file");
  }
}

export async function getToken(): Promise<string> {
  if (sgToken && Date.now() < tokenExpiry) return sgToken;

  // Try loading from file first
  if (loadTokenFromFile()) {
    // If token is within expiry (set by loadTokenFromFile based on file age), trust it
    if (Date.now() < tokenExpiry) {
      console.log("[API] Using trusted file token (within expiry)");
      return sgToken;
    }
    // Otherwise validate with a quick API call
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(`${API_BASE}/v1/free_running_hiro`, {
        headers: {
          "Authorization": `Bearer ${sgToken}`,
          "Accept": "application/json",
          "Origin": "https://dashboard.spotgamma.com",
          "Referer": "https://dashboard.spotgamma.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (resp.ok) {
        console.log("[API] File token is valid");
        tokenExpiry = Date.now() + 3600000;
        return sgToken;
      } else {
        console.log(`[API] File token invalid (${resp.status}), will re-login`);
        sgToken = "";
        tokenExpiry = 0;
      }
    } catch (e) {
      // If validation fails but token is recent, still try using it
      const stat = fs.statSync(TOKEN_FILE);
      if (Date.now() - stat.mtimeMs < 60 * 60 * 1000) {
        console.log("[API] Validation failed but token is recent, using it anyway");
        tokenExpiry = Date.now() + 1800000;
        return sgToken;
      }
      console.log("[API] Could not validate file token, will re-login");
      sgToken = "";
      tokenExpiry = 0;
    }
  }

  console.log("[API] Getting new SpotGamma token via login...");
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // Intercept network responses to capture the token from the login API response
    let capturedToken = "";
    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (url.includes("/v1/login") && response.status() === 200) {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.json();
            if (body.sgToken) {
              capturedToken = body.sgToken;
              console.log("[API] Token captured from login response!");
            }
          }
        }
        if (url.includes("/pollUpdate") && response.status() === 200) {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.json();
            if (body.sgToken) {
              capturedToken = body.sgToken;
              console.log("[API] Token captured from pollUpdate response!");
            }
          }
        }
        if (url.includes("/me/refresh") && response.status() === 200) {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("json")) {
            const body = await response.json();
            if (body.sgToken) {
              capturedToken = body.sgToken;
              console.log("[API] Token captured from refresh response!");
            }
          }
        }
      } catch (e) {
        // Ignore response parsing errors
      }
    });

    try {
      await page.goto("https://dashboard.spotgamma.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      console.log("[API] Login page load timeout, continuing...");
    }
    // Wait for React app to hydrate
    await page.waitForTimeout(8000);

    // Fill login form using correct selectors from SpotGamma dashboard
    const emailInput = await page.$("#login-username");
    const passwordInput = await page.$("#login-password");
    
    if (emailInput && passwordInput) {
      await emailInput.fill(SPOTGAMMA_EMAIL);
      await passwordInput.fill(SPOTGAMMA_PASSWORD);
      await page.waitForTimeout(500);
      
      // Click submit button
      const btn = await page.$('button[type="submit"]');
      if (btn) {
        await btn.click();
        console.log("[API] Login form submitted, waiting for response...");
        
        // Wait for navigation or token capture (up to 25s)
        try {
          await page.waitForURL(url => !url.toString().includes("/login"), { timeout: 25000 });
          console.log("[API] Login successful, URL changed to:", page.url());
        } catch (e) {
          console.log("[API] URL did not change after login, checking token...");
        }
        await page.waitForTimeout(5000);
      } else {
        // Fallback: press Enter on password field
        await passwordInput.press("Enter");
        console.log("[API] No submit button, pressed Enter");
        await page.waitForTimeout(15000);
      }
    } else {
      console.log("[API] Could not find login form inputs (#login-username / #login-password)");
      // Fallback: try old selectors
      const emailFallback = await page.$('input[type="email"], input[name="username"]');
      const passFallback = await page.$('input[type="password"]');
      if (emailFallback && passFallback) {
        console.log("[API] Using fallback selectors");
        await emailFallback.fill(SPOTGAMMA_EMAIL);
        await passFallback.fill(SPOTGAMMA_PASSWORD);
        await passFallback.press("Enter");
        await page.waitForTimeout(15000);
      }
    }

    // Try to get token: first from network interception, then from localStorage, then from cookies
    if (capturedToken) {
      sgToken = capturedToken;
      tokenExpiry = Date.now() + 3600000;
      saveTokenToFile(sgToken);
      console.log("[API] Token obtained from network interception");
    } else {
      // Try localStorage
      try {
        const lsToken = await page.evaluate(() => {
          try { return localStorage.getItem("sgToken") || ""; } catch { return ""; }
        });
        if (lsToken) {
          sgToken = lsToken;
          tokenExpiry = Date.now() + 3600000;
          saveTokenToFile(sgToken);
          console.log("[API] Token obtained from localStorage");
        }
      } catch (e) {
        console.log("[API] Could not read localStorage");
      }
      
      // Try cookies
      if (!sgToken) {
        const cookies = await context.cookies();
        const sgCookie = cookies.find(c => c.name === "sgToken");
        if (sgCookie) {
          sgToken = sgCookie.value;
          tokenExpiry = Date.now() + 3600000;
          saveTokenToFile(sgToken);
          console.log("[API] Token obtained from cookies");
        }
      }
    }

    if (!sgToken) {
      console.error("[API] Failed to obtain token from any source");
    }

    await browser.close();
    browser = null;
    // Wait for network to settle after browser close
    if (sgToken) {
      console.log("[API] Waiting 3s for network to settle after login...");
      await new Promise(r => setTimeout(r, 3000));
    }
    return sgToken;
  } catch (e) {
    console.error("[API] Token error:", e);
    if (browser) await browser.close().catch(() => {});
    return sgToken;
  }
}

// ============ API CALLS ============

export async function apiCall<T>(endpoint: string, timeoutMs: number = 10000, maxRetries: number = 1): Promise<T | null> {
  const token = await getToken();
  if (!token) { console.error("[API] No token available"); return null; }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "Origin": "https://dashboard.spotgamma.com",
          "Referer": "https://dashboard.spotgamma.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        console.error(`[API] ${endpoint} returned ${resp.status}`);
        if (resp.status === 401 || resp.status === 403) {
          sgToken = "";
          tokenExpiry = 0;
          try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
        }
        return null;
      }
      return await resp.json() as T;
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e.name === "AbortError") {
        console.error(`[API] ${endpoint} timed out after ${timeoutMs}ms`);
      } else {
        console.error(`[API] Error calling ${endpoint}: ${e.message || e}`);
      }
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 2000;
        console.log(`[API] Retrying ${endpoint} in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return null;
}

// ============ API RESPONSE TYPES ============

interface ChartDataResponse {
  sym: string;
  curves: {
    cust: {
      gamma: { all: number[]; monthly: number[]; next_exp: number[] };
      delta: { all: number[]; monthly: number[]; next_exp: number[] };
    };
    spot_prices: Record<string, number>;
  };
  bars: {
    oi: { puts: number[]; calls: number[] };
    oi_change: { puts: number[]; calls: number[] };
    cust: {
      gamma: {
        all: { puts: number[]; calls: number[] };
        monthly: { puts: number[]; calls: number[] };
        next_exp: { puts: number[]; calls: number[] };
      };
      delta: {
        all: { puts: number[]; calls: number[] };
        monthly: { puts: number[]; calls: number[] };
        next_exp: { puts: number[]; calls: number[] };
      };
      net_positioning: { puts: number[]; calls: number[] };
    };
    strikes: number[];
  };
}

interface EquitiesResponse {
  [sym: string]: {
    trade_date: string;
    sym: string;
    name: string;
    upx: number;
    callsum: number;
    putsum: number;
    next_exp_call_gamma: number;
    next_exp_put_gamma: number;
    keyd: number;
    largeCoi: number;
    largePoi: number;
    // Official SpotGamma levels
    cws: number;           // Call Wall Strike
    pws: number;           // Put Wall Strike
    keyg: number;          // Key Gamma Strike
    maxfs: number;         // Max Gamma (Absolute Gamma Strike)
    minfs: number;         // Min Gamma Strike
    putctrl: number;       // Put Control level
    prev_cws: number;      // Previous day Call Wall
    prev_pws: number;      // Previous day Put Wall
    prev_keyg: number;     // Previous day Key Gamma
    prev_maxfs: number;    // Previous day Max Gamma
    options_implied_move: number;  // Official implied move in points
    // Advanced volatility metrics
    atm_iv30: number;      // ATM IV 30-day
    atm_iv30_pct_chg: number; // ATM IV 30-day % change
    rv30: number;          // Realized Vol 30-day
    fwd_garch: number;     // Forward GARCH estimate
    ne_skew: number;       // Near-expiry skew
    skew: number;          // Overall skew
    cskew: number;         // Call skew
    pskew: number;         // Put skew
    d25: number;           // 25 delta IV
    d95: number;           // 95 delta IV (deep ITM)
    d25ne: number;         // 25 delta near-expiry
    d95ne: number;         // 95 delta near-expiry
    // Positioning metrics
    activity_factor: number;   // Options activity factor
    position_factor: number;   // Position factor
    gamma_ratio: number;       // Call/Put gamma ratio
    delta_ratio: number;       // Delta ratio
    put_call_ratio: number;    // Put/Call OI ratio
    volume_ratio: number;      // Volume ratio
    // Gamma notionals
    atmgc: number;         // ATM gamma calls
    atmgp: number;         // ATM gamma puts
    atmdc: number;         // ATM delta calls
    atmdp: number;         // ATM delta puts
    totaldelta: number;    // Total delta
  };
}

interface PollUpdateResponse {
  futuresSnapshot: { sym: string; target: string; lastClose: number; lastPrice: number }[];
}

// ============ OUTLIER DETECTION ============

function detectOutliers(values: number[], threshold: number = 1.5): { mean: number; stdDev: number; outlierThreshold: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0, outlierThreshold: 0 };
  const absValues = values.map(v => Math.abs(v));
  const mean = absValues.reduce((a, b) => a + b, 0) / absValues.length;
  const variance = absValues.reduce((a, b) => a + (b - mean) ** 2, 0) / absValues.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev, outlierThreshold: mean + stdDev * threshold };
}

// ============ DATA EXTRACTION ============

function extractAssetFromChartData(
  chartData: ChartDataResponse,
  price: number,
  previousClose: number,
  symbol: string
): AssetData {
  const nearRange = NEAR_PRICE_RANGE[symbol] || 10;

  // Build curve strikes array from spot_prices
  const curveStrikes: number[] = [];
  const sp = chartData.curves?.spot_prices || {};
  const numCurveKeys = Object.keys(sp).length;
  for (let i = 0; i < numCurveKeys; i++) {
    if (sp[String(i)] !== undefined) curveStrikes.push(sp[String(i)]);
  }

  const curveGammaAll = chartData.curves?.cust?.gamma?.all || [];
  const curveGammaNextExp = chartData.curves?.cust?.gamma?.next_exp || [];
  const curveGammaMonthly = chartData.curves?.cust?.gamma?.monthly || [];

  // Bars data - ALL bars from the API
  const barsStrikes = chartData.bars?.strikes || [];
  const oiPuts = chartData.bars?.oi?.puts || [];
  const oiCalls = chartData.bars?.oi?.calls || [];
  const netPosPuts = chartData.bars?.cust?.net_positioning?.puts || [];
  const netPosCalls = chartData.bars?.cust?.net_positioning?.calls || [];

  // REAL Put & Call Gamma Notional per strike from bars.cust.gamma.all
  // bars.cust.gamma.all is an object with { puts: number[], calls: number[] }
  const barGammaObj = chartData.bars?.cust?.gamma?.all as any;
  const barGammaPuts: number[] = barGammaObj?.puts || [];
  const barGammaCalls: number[] = barGammaObj?.calls || [];

  // Fallback: interpolate gamma from curves if bars data is empty
  function interpolateGammaForStrike(strike: number, curvePrices: number[], curveValues: number[]): number {
    if (curvePrices.length === 0 || curveValues.length === 0) return 0;
    // Find the two curve points that bracket this strike
    for (let i = 0; i < curvePrices.length - 1; i++) {
      if (strike >= curvePrices[i] && strike <= curvePrices[i + 1]) {
        // Linear interpolation
        const t = (strike - curvePrices[i]) / (curvePrices[i + 1] - curvePrices[i]);
        return curveValues[i] + t * (curveValues[i + 1] - curveValues[i]);
      }
    }
    // If strike is outside curve range, use nearest endpoint
    if (strike <= curvePrices[0]) return curveValues[0] || 0;
    if (strike >= curvePrices[curvePrices.length - 1]) return curveValues[curveValues.length - 1] || 0;
    return 0;
  }

  // First pass: collect all gamma values near price for outlier detection
  const nearGammaValues: number[] = [];
  const allStrikesRaw: { idx: number; strike: number; dist: number; isNear: boolean }[] = [];

  for (let i = 0; i < barsStrikes.length; i++) {
    const strike = barsStrikes[i];
    const dist = Math.abs(strike - price);
    const isNear = dist <= nearRange;
    allStrikesRaw.push({ idx: i, strike, dist, isNear });
    if (isNear) {
      const gammaVal = interpolateGammaForStrike(strike, curveStrikes, curveGammaAll);
      nearGammaValues.push(gammaVal);
    }
  }

  // Detect outliers among near-price gamma bars
  const outlierStats = detectOutliers(nearGammaValues, 1.5);

  // Build comprehensive strike data - ALL strikes within 3x range
  const allStrikes: StrikeData[] = [];

  for (const raw of allStrikesRaw) {
    if (raw.dist > nearRange * 3) continue;
    const i = raw.idx;
    const strike = raw.strike;

    const putOI = Math.abs(oiPuts[i] || 0);
    const callOI = Math.abs(oiCalls[i] || 0);
    const totalOI = putOI + callOI;

    // Use REAL Put & Call Gamma Notional from bars.cust.gamma.all.puts/calls
    const realCallGamma = barGammaCalls[i] || 0;
    const realPutGamma = barGammaPuts[i] || 0;
    const realTotalGamma = realCallGamma + realPutGamma;

    // Fallback to interpolated gamma if bars data is all zeros
    const hasRealBarsData = barGammaPuts.length > 0 && barGammaCalls.length > 0;
    const barGammaAllVal = hasRealBarsData ? realTotalGamma : interpolateGammaForStrike(strike, curveStrikes, curveGammaAll);
    const barGamma0DTE = interpolateGammaForStrike(strike, curveStrikes, curveGammaNextExp);
    const barGammaMonth = interpolateGammaForStrike(strike, curveStrikes, curveGammaMonthly);

    // Use real gamma as the primary value
    const totalGamma = barGammaAllVal;

    // Real call/put gamma from API (not approximated)
    const callGammaApprox = hasRealBarsData ? realCallGamma : (totalOI > 0 ? totalGamma * (callOI / totalOI) : totalGamma > 0 ? totalGamma : 0);
    const putGammaApprox = hasRealBarsData ? realPutGamma : (totalOI > 0 ? totalGamma * (putOI / totalOI) : totalGamma < 0 ? totalGamma : 0);

    const distPct = price > 0 ? (raw.dist / price) * 100 : 0;

    // Outlier detection
    const absGamma = Math.abs(totalGamma);
    const isOutlier = raw.isNear && outlierStats.stdDev > 0 && absGamma > outlierStats.outlierThreshold;
    const outlierScore = outlierStats.stdDev > 0 ? (absGamma - outlierStats.mean) / outlierStats.stdDev : 0;

    let levelType = "Gamma";
    if (isOutlier && outlierScore > 3) levelType = "MEGA Gamma";
    else if (isOutlier && outlierScore > 2) levelType = "High Gamma";
    else if (isOutlier) levelType = "Outlier Gamma";
    else if (absGamma > outlierStats.mean) levelType = "Above Avg";

    const npc = netPosCalls[i] || 0;
    const npp = netPosPuts[i] || 0;

    allStrikes.push({
      strike,
      callGamma: callGammaApprox,
      putGamma: putGammaApprox,
      totalGamma,
      gammaAll: barGammaAllVal,
      gamma0DTE: barGamma0DTE,
      gammaMonthly: barGammaMonth,
      callGammaNotional: realCallGamma,
      putGammaNotional: realPutGamma,
      callOI,
      putOI,
      totalOI,
      gammaNotional: totalGamma,
      netPosCalls: npc,
      netPosPuts: npp,
      netPosTotal: npc + npp,
      distanceFromPrice: raw.dist,
      distancePct: distPct,
      isNearPrice: raw.isNear,
      isOutlier,
      outlierScore,
      levelType,
      is0DTE: Math.abs(barGamma0DTE) > 0,
    });
  }

  // Sort by absolute gamma and filter near price
  const nearStrikes = allStrikes
    .filter(s => s.isNearPrice)
    .sort((a, b) => Math.abs(b.totalGamma) - Math.abs(a.totalGamma));

  // Top 3 strikes = highest gamma near price
  const topStrikes = nearStrikes.slice(0, 3);

  // Outlier strikes = gamma bars that are significantly above average
  const outlierStrikes = nearStrikes.filter(s => s.isOutlier).sort((a, b) => b.outlierScore - a.outlierScore);

  // Aggregate gamma metrics
  let totalCallGamma = 0;
  let totalPutGamma = 0;
  for (let i = 0; i < curveStrikes.length; i++) {
    const g = curveGammaAll[i] || 0;
    if (g > 0) totalCallGamma += g;
    else totalPutGamma += g;
  }

  // Find gamma flip level
  let gammaFlipLevel = price;
  for (let i = 1; i < curveStrikes.length; i++) {
    if (curveGammaAll[i - 1] < 0 && curveGammaAll[i] >= 0) {
      gammaFlipLevel = curveStrikes[i];
      break;
    }
  }

  // 0DTE gamma sum
  let zeroDteGammaSum = 0;
  for (const g of curveGammaNextExp) zeroDteGammaSum += g || 0;

  // Put/Call ratio
  let totalPutOI = 0;
  let totalCallOI = 0;
  for (const s of nearStrikes) {
    totalPutOI += s.putOI;
    totalCallOI += s.callOI;
  }
  const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  const change = price - previousClose;
  const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

  // Chart data: ALL near-price strikes sorted by strike for display
  const chartBars: ChartBar[] = allStrikes
    .filter(s => s.isNearPrice)
    .sort((a, b) => a.strike - b.strike)
    .map(s => ({
      strike: s.strike,
      gammaAll: s.gammaAll,
      gamma0DTE: s.gamma0DTE,
      gammaMonthly: s.gammaMonthly,
      callGamma: s.callGamma,
      putGamma: s.putGamma,
      totalGamma: s.totalGamma,
      callGammaNotional: s.callGammaNotional,
      putGammaNotional: s.putGammaNotional,
      callOI: s.callOI,
      putOI: s.putOI,
      totalOI: s.totalOI,
      isOutlier: s.isOutlier,
      outlierScore: s.outlierScore,
    }));

  // Compute flow data from net positioning
  const flowNearStrikes = allStrikes.filter(s => s.isNearPrice);
  const totalNetCalls = flowNearStrikes.reduce((sum, s) => sum + s.netPosCalls, 0);
  const totalNetPuts = flowNearStrikes.reduce((sum, s) => sum + s.netPosPuts, 0);
  const netTotal = totalNetCalls + totalNetPuts;

  // Flow direction: if puts are being closed (negative) more than calls → bullish
  // If calls are being closed more than puts → bearish
  let flowDir: "bullish" | "bearish" | "neutral" = "neutral";
  if (Math.abs(totalNetPuts) > Math.abs(totalNetCalls) * 1.3 && totalNetPuts < 0) {
    flowDir = "bullish"; // More puts being unwound = bullish
  } else if (Math.abs(totalNetPuts) > Math.abs(totalNetCalls) * 1.3 && totalNetPuts > 0) {
    flowDir = "bearish"; // More puts being opened = bearish
  } else if (totalNetCalls > 0 && totalNetCalls > Math.abs(totalNetPuts)) {
    flowDir = "bullish"; // More calls being opened = bullish
  } else if (totalNetCalls < 0 && Math.abs(totalNetCalls) > Math.abs(totalNetPuts)) {
    flowDir = "bearish"; // Calls being closed = bearish
  }

  const flowStrength = Math.min(100, Math.abs(netTotal) / 10000);

  // Top flow strikes
  const topFlowStrikes = [...flowNearStrikes]
    .sort((a, b) => Math.abs(b.netPosTotal) - Math.abs(a.netPosTotal))
    .slice(0, 5)
    .map(s => ({
      strike: s.strike,
      netCalls: s.netPosCalls,
      netPuts: s.netPosPuts,
      direction: s.netPosTotal > 0 ? "apertura" : "cierre",
    }));

  const flowDescription = `Flujo neto: Calls ${totalNetCalls > 0 ? "+" : ""}${totalNetCalls.toLocaleString()}, Puts ${totalNetPuts > 0 ? "+" : ""}${totalNetPuts.toLocaleString()}. Direccion: ${flowDir.toUpperCase()}.`;

  const flowData: FlowData = {
    callVolume: 0,
    putVolume: 0,
    putCallRatioVolume: 0,
    netCallPositioning: totalNetCalls,
    netPutPositioning: totalNetPuts,
    flowDirection: flowDir,
    flowStrength,
    topFlowStrikes,
    description: flowDescription,
    lastUpdated: new Date().toISOString(),
  };

  // Extract additional metrics from chartData.info if available
  const info = (chartData as any).info || {};
  const ivRank = info.iv_rank || 0;
  const impliedMove = info.implied_move || 0;
  const highVolPoint = info.high_vol_point || 0;
  const lowVolPoint = info.low_vol_point || 0;
  const oneMonthIV = info.one_month_iv || 0;
  const oneMonthRV = info.one_month_rv || 0;

  return {
    symbol,
    currentPrice: price,
    previousClose,
    dailyChange: change,
    dailyChangePct: changePercent,
    callGamma: totalCallGamma,
    putGamma: totalPutGamma,
    totalGamma: totalCallGamma + totalPutGamma,
    putCallRatio,
    ivRank,
    impliedMove,
    highVolPoint,
    lowVolPoint,
    callVolume: 0,
    putVolume: 0,
    oneMonthIV,
    oneMonthRV,
    garchRank: 0,
    skewRank: 0,
    topGammaExp: info.top_gamma_exp || "",
    topDeltaExp: info.top_delta_exp || "",
    topStrikes,
    strikes: allStrikes,
    chartData: chartBars,
    gammaFlipLevel,
    zeroDteGamma: zeroDteGammaSum,
    outlierStrikes,
    flowData,
    lastUpdated: new Date().toISOString(),
  };
}

// ============ GEX ANALYSIS (with Delta-Adjusted GEX) ============

function analyzeGex(spxAsset: AssetData): GexData {
  const totalGamma = spxAsset.totalGamma || 0;
  const gammaFlip = spxAsset.gammaFlipLevel || 0;
  const price = spxAsset.currentPrice || 0;
  const zeroDte = spxAsset.zeroDteGamma || 0;
  const deltaAdjustedGex = totalGamma * (price > gammaFlip ? 1 : -1);

  // Calculate Delta-Adjusted GEX at different price levels
  const dagexLevels: { price: number; dagex: number }[] = [];
  const step = price > 1000 ? 25 : price > 100 ? 5 : 1;
  for (let p = price - step * 5; p <= price + step * 5; p += step) {
    // At each price level, estimate how GEX changes
    // Above gamma flip = positive GEX (dealers sell into rallies, buy dips)
    // Below gamma flip = negative GEX (dealers amplify moves)
    const distFromFlip = p - gammaFlip;
    const dagex = totalGamma * (distFromFlip > 0 ? 1 : -1) * (1 + Math.abs(distFromFlip) / price * 10);
    dagexLevels.push({ price: Math.round(p), dagex });
  }

  let gexTrend: "bullish" | "bearish" | "neutral" = "neutral";
  let dealerIntent = "";

  if (price > gammaFlip && totalGamma > 0) {
    gexTrend = "bullish";
    dealerIntent = `SPX ($${price.toFixed(0)}) SOBRE Gamma Flip ($${gammaFlip.toFixed(0)}). Gamma positivo = dealers frenan caidas. Rebotes alcistas favorecidos.`;
  } else if (price < gammaFlip) {
    gexTrend = "bearish";
    dealerIntent = `SPX ($${price.toFixed(0)}) BAJO Gamma Flip ($${gammaFlip.toFixed(0)}). Gamma negativo = dealers aceleran movimientos. Rupturas bajistas posibles.`;
  } else {
    dealerIntent = `SPX ($${price.toFixed(0)}) cerca del Gamma Flip ($${gammaFlip.toFixed(0)}). Zona de transicion.`;
  }

  const sortedByCallOI = [...spxAsset.strikes].filter(s => s.isNearPrice).sort((a, b) => b.callOI - a.callOI);
  const hedgeWall = sortedByCallOI.length > 0 ? sortedByCallOI[0].strike : 0;
  const sortedByPutOI = [...spxAsset.strikes].filter(s => s.isNearPrice).sort((a, b) => b.putOI - a.putOI);
  const putWall = sortedByPutOI.length > 0 ? sortedByPutOI[0].strike : 0;

  return {
    gexValue: totalGamma,
    gexTrend,
    dealerIntent,
    keyLevel: gammaFlip,
    zeroGammaLevel: gammaFlip,
    volTriggerLevel: 0,
    is0DTE: Math.abs(zeroDte) > 0,
    odteGexValue: zeroDte,
    deltaAdjustedGex,
    deltaAdjustedGexAtLevels: dagexLevels,
    hedgeWall,
    putWall,
    rawText: dealerIntent,
    lastUpdated: new Date().toISOString(),
  };
}

// ============ HIRO ANALYSIS (REAL API) ============

interface HiroApiItem {
  symbol?: string;
  instrument?: string;
  day?: string;
  lastClose?: number;
  companyName?: string;
  sector?: string;
  industry?: string;
  // HIRO ranges by period
  low1?: number;   // 1-day low HIRO
  high1?: number;  // 1-day high HIRO
  low5?: number;   // 5-day low HIRO
  high5?: number;  // 5-day high HIRO
  low20?: number;  // 20-day low HIRO
  high20?: number; // 20-day high HIRO
  // Current HIRO signal
  currentDaySignal?: number;
  currentDayPrice?: number;
  // Legacy field names (fallback)
  hiro_value?: number;
  current_hiro?: number;
  value?: number;
  hiro?: number;
  [key: string]: any;
}

// Assets we care about for HIRO in our trading system
const HIRO_TRACKED_ASSETS = new Set(["SPX", "SPY", "QQQ", "GLD", "VIX", "UVXY", "UVIX", "DIA", "S&P 500", "S&P ES=F", "NASDAQ", "NDX", "RUSSELL 2K", "RUT", "IWM"]);

async function fetchHiro(): Promise<HiroData | null> {
  console.log("[API] Fetching real HIRO data from v6/running_hiro...");
  
  // Try premium endpoint first, then free
  let data = await apiCall<HiroApiItem[] | Record<string, any>>("/v6/running_hiro");
  if (!data) {
    console.log("[API] v6/running_hiro failed, trying free endpoint...");
    data = await apiCall<HiroApiItem[] | Record<string, any>>("/v1/free_running_hiro");
  }
  
  if (!data) {
    console.log("[API] HIRO fetch failed, using fallback analysis");
    return null;
  }
  
  // Parse the response - it's an array of objects with symbol field
  const perAsset: Record<string, HiroAssetData> = {};
  let items: HiroApiItem[] = [];
  
  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === "object") {
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === "object" && val !== null) {
        items.push({ symbol: key, ...val as any });
      }
    }
  }
  
  console.log(`[API] HIRO response: ${items.length} total items`);
  if (items.length > 0) {
    const sampleKeys = Object.keys(items[0]);
    console.log(`[API] HIRO item keys: ${sampleKeys.join(", ")}`);
    // Log a sample of a tracked asset
    const spxSample = items.find(i => (i.symbol || i.instrument || "").toUpperCase() === "SPX");
    if (spxSample) {
      console.log(`[API] HIRO SPX sample: ${JSON.stringify(spxSample).substring(0, 500)}`);
    } else {
      console.log(`[API] HIRO first item: ${JSON.stringify(items[0]).substring(0, 500)}`);
    }
  }
  
  // Only process assets we track for trading
  for (const item of items) {
    const sym = (item.symbol || item.instrument || "").toUpperCase();
    if (!sym) continue;
    
    // Only keep tracked assets to reduce noise
    if (!HIRO_TRACKED_ASSETS.has(sym)) continue;
    
    // Extract HIRO value from the API response
    // Primary: currentDaySignal (real-time HIRO during market hours)
    // Fallback: legacy field names
    const hiroVal = Number(item.currentDaySignal ?? item.hiro_value ?? item.current_hiro ?? item.value ?? item.hiro ?? 0) || 0;
    
    // Extract 20-day range (equivalent to 30d range for trend calculation)
    const min20d = Number(item.low20 ?? item.low5 ?? -5e9) || -5e9;
    const max20d = Number(item.high20 ?? item.high5 ?? 5e9) || 5e9;
    
    // Also capture 1-day and 5-day ranges for more granular analysis
    const min1d = Number(item.low1 ?? min20d) || min20d;
    const max1d = Number(item.high1 ?? max20d) || max20d;
    
    // Determine trend based on where current HIRO sits in its 20-day range
    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    const range20d = max20d - min20d;
    
    if (hiroVal !== 0 && range20d > 0) {
      // Position within 20-day range (0 = at low, 1 = at high)
      const position = (hiroVal - min20d) / range20d;
      if (position > 0.6) trend = "bullish";
      else if (position < 0.4) trend = "bearish";
    } else if (hiroVal !== 0) {
      // Simple sign-based when ranges unavailable
      if (hiroVal > 0) trend = "bullish";
      else if (hiroVal < 0) trend = "bearish";
    }
    // When hiroVal is 0 (market closed), use 1-day range midpoint to infer bias
    else if (range20d > 0) {
      const midpoint = (min1d + max1d) / 2;
      if (midpoint > 0) trend = "bullish";
      else if (midpoint < 0) trend = "bearish";
    }
    
    const formatHiro = (v: number | any) => {
      const n = Number(v) || 0;
      const abs = Math.abs(n);
      if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
      if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
      return n.toFixed(0);
    };
    
    // Normalize symbol names for our system
    let normalizedSym = sym;
    if (sym === "S&P 500" || sym === "S&P ES=F" || sym === "S&P EQUITIES") normalizedSym = "SPX";
    if (sym === "NASDAQ" || sym === "NDX") normalizedSym = "QQQ";
    if (sym === "RUSSELL 2K" || sym === "RUT") normalizedSym = "IWM";
    
    // Extract prices from HIRO data for fallback
    const rawPrice = Number(item.currentDayPrice) || 0;
    const rawLastClose = Number(item.lastClose) || 0;
    
    perAsset[normalizedSym] = {
      instrument: normalizedSym,
      hiroValue: hiroVal,
      hiroTrend: trend,
      hiroRange30dMin: min20d,
      hiroRange30dMax: max20d,
      description: hiroVal !== 0 
        ? `${normalizedSym} HIRO: ${formatHiro(hiroVal)} (${trend.toUpperCase()}). Rango 20d: ${formatHiro(min20d)} a ${formatHiro(max20d)}.`
        : `${normalizedSym} HIRO: Mercado cerrado. Rango 1d: ${formatHiro(min1d)} a ${formatHiro(max1d)}. Rango 20d: ${formatHiro(min20d)} a ${formatHiro(max20d)}.`,
      _rawPrice: rawPrice,
      _rawLastClose: rawLastClose,
    } as any;
  }
  
  // Use SPX as the primary HIRO for backward compatibility
  const spxHiro = perAsset["SPX"];
  const primaryHiro = spxHiro || Object.values(perAsset)[0];
  
  if (!primaryHiro) {
    console.log("[API] No HIRO data found for tracked assets");
    return null;
  }
  
  // Log only tracked assets
  const trackedKeys = Object.keys(perAsset);
  console.log(`[API] HIRO loaded for ${trackedKeys.length} tracked assets: ${trackedKeys.join(", ")}`);
  for (const [sym, h] of Object.entries(perAsset)) {
    const hv = Number(h.hiroValue) || 0;
    const rMin = Number(h.hiroRange30dMin) || 0;
    const rMax = Number(h.hiroRange30dMax) || 0;
    console.log(`[API]   ${sym}: val=${hv !== 0 ? hv.toExponential(2) : '0 (closed)'} trend=${h.hiroTrend} range=[${rMin.toExponential(1)}, ${rMax.toExponential(1)}]`);
  }
  
  return {
    hiroValue: primaryHiro.hiroValue,
    hiroTrend: primaryHiro.hiroTrend,
    hiroRange30dMin: primaryHiro.hiroRange30dMin,
    hiroRange30dMax: primaryHiro.hiroRange30dMax,
    description: primaryHiro.description,
    lastUpdated: new Date().toISOString(),
    perAsset,
  };
}

// Fallback when API is unavailable
function analyzeHiroFallback(spxAsset: AssetData, vixAsset: AssetData | null): HiroData {
  const vixChange = vixAsset?.dailyChangePct || 0;
  const spxChange = spxAsset.dailyChangePct;

  let hiroValue = (-vixChange * 100) + (spxChange * 50);
  hiroValue = hiroValue * 1e7;

  let hiroTrend: "bullish" | "bearish" | "neutral" = "neutral";
  let description = "";

  if (hiroValue > 5e8) {
    hiroTrend = "bullish";
    description = `[ESTIMADO] Flujo institucional ALCISTA. VIX ${vixChange > 0 ? "subiendo" : "bajando"} ${Math.abs(vixChange).toFixed(1)}%.`;
  } else if (hiroValue < -5e8) {
    hiroTrend = "bearish";
    description = `[ESTIMADO] Flujo institucional BAJISTA. VIX ${vixChange > 0 ? "subiendo" : "bajando"} ${Math.abs(vixChange).toFixed(1)}%.`;
  } else {
    description = `[ESTIMADO] Flujo institucional NEUTRAL. VIX ${vixChange > 0 ? "subiendo" : "bajando"} ${Math.abs(vixChange).toFixed(1)}%.`;
  }

  return {
    hiroValue,
    hiroTrend,
    hiroRange30dMin: -7.9e9,
    hiroRange30dMax: 12e9,
    description,
    lastUpdated: new Date().toISOString(),
    perAsset: {},
  };
}

// ============ VIX-SPX CORRELATION ============

function analyzeVixSpxCorrelation(spxAsset: AssetData, vixAsset: AssetData | null): VixSpxCorrelation {
  const spxChange = spxAsset.dailyChangePct;
  const vixChange = vixAsset?.dailyChangePct || 0;
  const isNormal = (spxChange > 0 && vixChange < 0) || (spxChange < 0 && vixChange > 0);

  let correlation: "normal" | "divergence" | "extreme" = "normal";
  let isDivergence = false;
  let divergenceType = "";
  let description = "";

  if (isNormal) {
    description = `Correlacion normal: SPX ${spxChange > 0 ? "+" : ""}${spxChange.toFixed(2)}% / VIX ${vixChange > 0 ? "+" : ""}${vixChange.toFixed(2)}%.`;
  } else if (Math.abs(vixChange) > 10) {
    correlation = "extreme";
    isDivergence = true;
    divergenceType = vixChange > 0 ? "vix_up_spx_up" : "vix_down_spx_down";
    description = `EXTREMO: VIX ${vixChange > 0 ? "+" : ""}${vixChange.toFixed(2)}% con SPX ${spxChange > 0 ? "+" : ""}${spxChange.toFixed(2)}%. Precaucion maxima.`;
  } else {
    correlation = "divergence";
    isDivergence = true;
    divergenceType = spxChange < 0 && vixChange < 0 ? "vix_down_spx_down" : "vix_up_spx_up";
    description = `DIVERGENCIA: SPX ${spxChange > 0 ? "+" : ""}${spxChange.toFixed(2)}% y VIX ${vixChange > 0 ? "+" : ""}${vixChange.toFixed(2)}% se mueven en la misma direccion.`;
  }

  return {
    spxPrice: spxAsset.currentPrice,
    spxChange: spxAsset.dailyChange,
    spxChangePct: spxChange,
    vixPrice: vixAsset?.currentPrice || 0,
    vixChange: vixAsset?.dailyChange || 0,
    vixChangePct: vixChange,
    correlation,
    isDivergence,
    divergenceType,
    description,
  };
}

// ============ SMART ENTRY SIGNALS ============

function generateSmartEntrySignals(
  assets: AssetData[],
  gex: GexData | null,
  hiro: HiroData | null,
  vixCorr: VixSpxCorrelation | null,
  traceData?: TraceData | null,
  officialLevels?: Record<string, OfficialSGLevels>,
): SmartEntrySignal[] {
  const signals: SmartEntrySignal[] = [];
  if (!gex || !hiro) return signals;

  for (const asset of assets) {
    if (asset.currentPrice === 0) continue;

    const gexDir = gex.gexTrend === "bullish" ? "positive" : gex.gexTrend === "bearish" ? "negative" : "neutral";
    const hiroDir = hiro.hiroTrend;

    // Find the nearest outlier strike (the big gamma bar)
    const outliers = asset.outlierStrikes || [];
    let nearestOutlier: SmartEntrySignal["nearestOutlier"] = null;
    let priceInZone = false;
    let zoneType: "soporte" | "resistencia" | "neutral" = "neutral";

    // Dynamic zone threshold based on today's implied move
    const sgL = officialLevels?.[asset.symbol];
    const impliedMovePct = sgL?.impliedMovePct || 0;
    const ZONE_THRESHOLD = impliedMovePct > 0
      ? Math.max(0.08, Math.min(0.25, impliedMovePct * 0.12))
      : 0.12;
    const APPROACH_THRESHOLD = ZONE_THRESHOLD * 4;

    // ne_skew warning: near-expiry skew spike signals institutional put buying
    const neSkew = sgL?.neSkew || 0;
    const neSkewWarning = neSkew > 0.04; // > 4% near-expiry skew = elevated fear

    // d25ne timing filter: rising near-expiry 25-delta IV = wait before entering longs
    const d25ne = sgL?.d25ne || 0;
    const d25neWarning = d25ne > 0 && d25ne > (sgL?.d25 || 0) * 1.15; // near-expiry > 15% above base

    // totaldelta market tilt
    const totalDelta = sgL?.totalDelta || 0;
    const marketTiltBull = totalDelta > 0;
    const marketTiltBear = totalDelta < 0;

    if (outliers.length > 0) {
      // Find the closest outlier to current price
      const sorted = [...outliers].sort((a, b) => a.distanceFromPrice - b.distanceFromPrice);
      const closest = sorted[0];
      nearestOutlier = {
        strike: closest.strike,
        gamma: closest.totalGamma,
        distance: closest.distanceFromPrice,
        distancePct: closest.distancePct,
      };

      // Price is "in zone" if within ZONE_THRESHOLD of an outlier strike (dynamic)
      priceInZone = closest.distancePct < ZONE_THRESHOLD;

      // Determine if the outlier is support or resistance
      if (closest.strike < asset.currentPrice) {
        zoneType = "soporte";
      } else if (closest.strike > asset.currentPrice) {
        zoneType = "resistencia";
      }
    } else if (asset.topStrikes.length > 0) {
      // Fallback to top strikes if no outliers
      const closest = asset.topStrikes[0];
      nearestOutlier = {
        strike: closest.strike,
        gamma: closest.totalGamma,
        distance: closest.distanceFromPrice,
        distancePct: closest.distancePct,
      };
      priceInZone = closest.distancePct < ZONE_THRESHOLD;
      zoneType = closest.strike < asset.currentPrice ? "soporte" : closest.strike > asset.currentPrice ? "resistencia" : "neutral";
    }

    // Confirmation checks
    const gexBullish = gex.gexTrend === "bullish";
    const gexBearish = gex.gexTrend === "bearish";
    const hiroBullish = hiro.hiroTrend === "bullish";
    const hiroBearish = hiro.hiroTrend === "bearish";
    // Use real flow data from net positioning
    const assetFlow = asset.flowData;
    let tapeFlow: "bullish" | "bearish" | "neutral" = assetFlow?.flowDirection || "neutral";
    const vixNormal = vixCorr ? vixCorr.correlation === "normal" : true;
    const vixDivergence = vixCorr ? vixCorr.isDivergence : false;

    // Check each confirmation
    let gexConfirms = false;
    let hiroConfirms = false;
    let tapeConfirms = false;
    let vixConfirms = vixNormal;

    // Determine signal based on zone + confirmations
    let signal: SmartEntrySignal["signal"] = "ESPERA";
    let confidence: SmartEntrySignal["confidence"] = "BAJA";
    let reason = "";
    const details: string[] = [];

    if (!nearestOutlier) {
      signal = "ESPERA";
      reason = "No hay zonas de gamma significativas identificadas.";
      details.push("Sin barras de gamma outlier cerca del precio.");
    } else if (!priceInZone && nearestOutlier.distancePct > APPROACH_THRESHOLD) {
      // Price is far from any significant gamma zone
      signal = "ESPERA";
      reason = `Precio lejos de zonas clave. Zona mas cercana: $${nearestOutlier.strike.toLocaleString()} (${nearestOutlier.distancePct.toFixed(2)}% de distancia).`;
      details.push(`Gamma outlier en $${nearestOutlier.strike.toLocaleString()} (score: ${outliers[0]?.outlierScore?.toFixed(1) || "N/A"})`);
      details.push(`Esperar a que el precio se acerque a la zona.`);
    } else if (!priceInZone && nearestOutlier.distancePct <= APPROACH_THRESHOLD && nearestOutlier.distancePct > ZONE_THRESHOLD) {
      // APPROACHING zone - pre-alert, prepare entry
      const gexBull = gex.gexTrend === "bullish";
      const gexBear = gex.gexTrend === "bearish";
      const hiroBull = hiro.hiroTrend === "bullish";
      const hiroBear = hiro.hiroTrend === "bearish";
      const confBull = [gexBull, hiroBull].filter(Boolean).length;
      const confBear = [gexBear, hiroBear].filter(Boolean).length;
      const approachBias = zoneType === "soporte"
        ? (confBull >= 2 ? "REBOTE probable - prep COMPRA" : confBear >= 2 ? "RUPTURA probable - prep VENTA" : "Esperar confirmacion")
        : (confBear >= 2 ? "RECHAZO probable - prep VENTA" : confBull >= 2 ? "RUPTURA alcista probable - prep COMPRA" : "Esperar confirmacion");

      signal = "ESPERA";
      confidence = "MEDIA";
      reason = `⚠️ ACERCANDOSE a zona ${zoneType} $${nearestOutlier.strike.toLocaleString()} (${nearestOutlier.distancePct.toFixed(2)}%). ${approachBias}.`;
      details.push(`Zona ${zoneType.toUpperCase()}: $${nearestOutlier.strike.toLocaleString()} (outlier score: ${outliers[0]?.outlierScore?.toFixed(1) || "N/A"})`);
      details.push(`GEX: ${gex.gexTrend.toUpperCase()} | HIRO: ${hiro.hiroTrend.toUpperCase()} | Flow: ${tapeFlow.toUpperCase()}`);
      details.push(`Zona activa cuando distancia < ${ZONE_THRESHOLD.toFixed(2)}% (impliedMove=${impliedMovePct.toFixed(2)}%).`);
      if (neSkewWarning) details.push(`⚠️ ne_skew=${neSkew.toFixed(3)}: Skew elevado, institucionales comprando proteccion.`);
      if (marketTiltBull) details.push(`📈 TotalDelta positivo: tilt estructural alcista.`);
      if (marketTiltBear) details.push(`📉 TotalDelta negativo: tilt estructural bajista.`);
    } else if (priceInZone || nearestOutlier.distancePct < ZONE_THRESHOLD * 2.5) {
      // Price IS in a gamma zone - this is where we decide BUY/SELL/WAIT
      details.push(`PRECIO EN ZONA de gamma outlier: $${nearestOutlier.strike.toLocaleString()}`);

      if (zoneType === "soporte") {
        // Price approaching support (gamma below price)
        gexConfirms = gexBullish; // GEX positive = dealers support bounces
        hiroConfirms = hiroBullish; // HIRO bullish = institutional flow supports longs
        tapeConfirms = tapeFlow === "bullish"; // Flow shows bullish positioning

        details.push(`Zona de SOPORTE (gamma debajo del precio)`);
        // Confirmación adicional: Tape+TRACE confluencia en el strike
        const traceSupport = traceData?.topSupport?.find(s => Math.abs(s.strike - nearestOutlier!.strike) < nearestOutlier!.strike * 0.005);
        const tapeAtStrike = asset.flowData?.topFlowStrikes?.find(s => Math.abs(s.strike - nearestOutlier!.strike) < nearestOutlier!.strike * 0.005);
        const strikeConfluence = !!(traceSupport && tapeAtStrike && tapeAtStrike.direction === "bullish");
        // 7th confirmation: ne_skew NOT elevated (low fear = good for longs)
        const neSkewConfirms = !neSkewWarning;
        // totaldelta tilt confirmation
        const tiltConfirms = marketTiltBull;

        details.push(`GEX: ${gexBullish ? "✅ Positivo (dealers frenan caidas)" : "❌ Negativo (dealers aceleran caidas)"}`);
        details.push(`HIRO: ${hiroBullish ? "✅ Alcista (flujo institucional favorable)" : hiroBearish ? "❌ Bajista (flujo institucional en contra)" : "⚠️ Neutral"}`);
        details.push(`FLOW: ${tapeFlow === "bullish" ? "✅ Alcista (puts cerrando / calls abriendo)" : tapeFlow === "bearish" ? "❌ Bajista (puts abriendo)" : "⚠️ Neutral"}`);
        details.push(`VIX: ${vixNormal ? "✅ Correlacion normal" : "❌ Divergencia detectada"}`);
        details.push(`ne_skew: ${neSkewConfirms ? "✅ Normal" : `⚠️ ELEVADO (${neSkew.toFixed(3)}) - institucionales comprando puts`}`);
        details.push(`TotalDelta: ${tiltConfirms ? "✅ Positivo (tilt alcista)" : marketTiltBear ? "❌ Negativo (tilt bajista)" : "⚠️ Neutral"}`);
        if (strikeConfluence) details.push(`✅ CONFLUENCIA Tape+TRACE en strike $${nearestOutlier.strike.toLocaleString()}`);
        if (d25neWarning) details.push(`⚠️ d25ne elevado: esperar que se estabilice antes de entrar.`);

        const confirmCount = [gexConfirms, hiroConfirms, tapeConfirms, vixConfirms, neSkewConfirms, tiltConfirms].filter(Boolean).length;
        const totalConf = 6;

        if (confirmCount >= 4 && gexConfirms && !d25neWarning) {
          signal = "COMPRA";
          confidence = (confirmCount >= 5 || strikeConfluence) ? "ALTA" : "MEDIA";
          reason = `COMPRA en soporte $${nearestOutlier.strike.toLocaleString()}. ${confirmCount}/${totalConf} confirmaciones.${strikeConfluence ? " CONFLUENCIA Tape+TRACE." : ""}`;
        } else if (confirmCount >= 3 && gexConfirms) {
          signal = d25neWarning ? "ESPERA" : "COMPRA";
          confidence = "MEDIA";
          reason = d25neWarning
            ? `Soporte con ${confirmCount}/${totalConf} conf. pero d25ne elevado - esperar timing.`
            : `COMPRA en soporte $${nearestOutlier.strike.toLocaleString()}. ${confirmCount}/${totalConf} confirmaciones.`;
        } else if (confirmCount >= 2) {
          signal = "ESPERA";
          confidence = "MEDIA";
          reason = `Zona de soporte con ${confirmCount}/${totalConf} confirmaciones. ${!gexConfirms ? "GEX no confirma." : ""} ${!hiroConfirms ? "HIRO no confirma." : ""} ${neSkewWarning ? "ne_skew elevado." : ""}`;
        } else if (confirmCount >= 1) {
          signal = "ESPERA";
          confidence = "BAJA";
          reason = `Zona de soporte pero solo ${confirmCount}/${totalConf} confirmaciones. Esperar mas senales.`;
        } else {
          signal = "NO ENTRAR";
          confidence = "ALTA";
          reason = `Zona de soporte pero NINGUNA confirmacion. GEX negativo + HIRO bajista + Flow en contra. Alto riesgo de ruptura.`;
        }
      } else if (zoneType === "resistencia") {
        // Price approaching resistance (gamma above price)
        gexConfirms = gexBearish; // GEX negative = dealers amplify moves through resistance
        hiroConfirms = hiroBearish; // HIRO bearish = institutional flow supports shorts
        tapeConfirms = tapeFlow === "bearish"; // Flow shows bearish positioning

        details.push(`Zona de RESISTENCIA (gamma arriba del precio)`);
        // Tape+TRACE confluencia en resistencia
        const traceResist = traceData?.topResistance?.find(r => Math.abs(r.strike - nearestOutlier!.strike) < nearestOutlier!.strike * 0.005);
        const tapeAtResist = asset.flowData?.topFlowStrikes?.find(s => Math.abs(s.strike - nearestOutlier!.strike) < nearestOutlier!.strike * 0.005);
        const resistConfluence = !!(traceResist && tapeAtResist && tapeAtResist.direction === "bearish");
        // ne_skew elevado AYUDA a shorts (institucionales comprando puts = bajista)
        const neSkewConfirmsShort = neSkewWarning;
        const tiltConfirmsShort = marketTiltBear;

        details.push(`GEX: ${gexBearish ? "✅ Negativo (dealers aceleran rupturas)" : "❌ Positivo (dealers frenan subidas)"}`);
        details.push(`HIRO: ${hiroBearish ? "✅ Bajista (flujo institucional favorable para shorts)" : hiroBullish ? "❌ Alcista (flujo institucional en contra)" : "⚠️ Neutral"}`);
        details.push(`FLOW: ${tapeFlow === "bearish" ? "✅ Bajista (puts abriendo / calls cerrando)" : tapeFlow === "bullish" ? "❌ Alcista (flujo en contra)" : "⚠️ Neutral"}`);
        details.push(`VIX: ${vixNormal ? "✅ Correlacion normal" : "❌ Divergencia detectada"}`);
        details.push(`ne_skew: ${neSkewConfirmsShort ? `✅ ELEVADO (${neSkew.toFixed(3)}) - puts activos, bajista` : "⚠️ Normal (no ayuda a shorts)"}`);
        details.push(`TotalDelta: ${tiltConfirmsShort ? "✅ Negativo (tilt bajista)" : marketTiltBull ? "❌ Positivo (tilt alcista)" : "⚠️ Neutral"}`);
        if (resistConfluence) details.push(`✅ CONFLUENCIA Tape+TRACE en resistencia $${nearestOutlier.strike.toLocaleString()}`);

        const confirmCount = [gexConfirms, hiroConfirms, tapeConfirms, vixConfirms, neSkewConfirmsShort, tiltConfirmsShort].filter(Boolean).length;
        const totalConf = 6;

        if (confirmCount >= 4 && gexConfirms) {
          signal = "VENDE";
          confidence = (confirmCount >= 5 || resistConfluence) ? "ALTA" : "MEDIA";
          reason = `VENDE en resistencia $${nearestOutlier.strike.toLocaleString()}. ${confirmCount}/${totalConf} confirmaciones.${resistConfluence ? " CONFLUENCIA Tape+TRACE." : ""}`;
        } else if (gexBullish && hiroBullish && tapeFlow === "bullish") {
          signal = "COMPRA";
          confidence = "MEDIA";
          reason = `Resistencia pero GEX positivo + HIRO alcista + Flow alcista. Posible ruptura alcista de $${nearestOutlier.strike.toLocaleString()}.`;
        } else if (confirmCount >= 2) {
          signal = "ESPERA";
          confidence = "MEDIA";
          reason = `Zona de resistencia con ${confirmCount}/${totalConf} confirmaciones. Esperar mas senales.`;
        } else if (confirmCount >= 1) {
          signal = "ESPERA";
          confidence = "BAJA";
          reason = `Zona de resistencia pero solo ${confirmCount}/4 confirmaciones.`;
        } else {
          signal = "NO ENTRAR";
          confidence = "ALTA";
          reason = `Zona de resistencia sin confirmaciones claras. Senales mixtas.`;
        }
      } else {
        // Neutral zone
        signal = "ESPERA";
        confidence = "BAJA";
        reason = `Precio en zona gamma pero direccion no clara. Esperar definicion.`;
      }
    } else {
      // Price approaching but not yet in zone (0.15% - 0.5%)
      signal = "ESPERA";
      confidence = "MEDIA";
      reason = `Precio acercandose a zona gamma $${nearestOutlier.strike.toLocaleString()} (${nearestOutlier.distancePct.toFixed(2)}%). Preparar entrada.`;
      details.push(`Zona ${zoneType}: $${nearestOutlier.strike.toLocaleString()}`);
      details.push(`GEX: ${gex.gexTrend.toUpperCase()} | HIRO: ${hiro.hiroTrend.toUpperCase()}`);
      details.push(`Esperar a que el precio entre en la zona (<0.15% de distancia).`);
    }

    const confirmationCount = [gexConfirms, hiroConfirms, tapeConfirms, vixConfirms].filter(Boolean).length;

    signals.push({
      asset: asset.symbol,
      signal,
      confidence,
      reason,
      details,
      nearestOutlier,
      priceInZone,
      zoneType,
      gexConfirms,
      hiroConfirms,
      tapeConfirms,
      vixConfirms,
      confirmationCount,
      gexDirection: gexDir as any,
      hiroDirection: hiroDir,
      tapeFlow,
      strikeZone: nearestOutlier?.strike || 0,
    });
  }

  return signals;
}

// ============ PRE-MARKET SUMMARY (always available) ============

function generatePreMarketSummary(assets: AssetData[], gex: GexData | null): PreMarketSummary | null {
  const spx = assets.find(a => a.symbol === "SPX");
  if (!spx || !gex) return null;

  const bias = gex.gexTrend === "bullish" ? "bullish" : gex.gexTrend === "bearish" ? "bearish" : "neutral";

  // Build outlier zones from all assets
  const outlierZones: PreMarketSummary["outlierZones"] = [];
  for (const asset of assets) {
    for (const outlier of (asset.outlierStrikes || []).slice(0, 3)) {
      const isAbove = outlier.strike > asset.currentPrice;
      outlierZones.push({
        asset: asset.symbol,
        strike: outlier.strike,
        gamma: outlier.totalGamma,
        type: isAbove ? "resistencia" : "soporte",
        action: isAbove
          ? (gex.gexTrend === "bearish" ? "Posible rechazo bajista" : "Posible ruptura alcista")
          : (gex.gexTrend === "bullish" ? "Posible rebote alcista" : "Posible ruptura bajista"),
      });
    }
  }

  // Key levels from all assets
  const keyLevels: PreMarketSummary["keyLevels"] = [];
  for (const asset of assets) {
    if (asset.symbol === "VIX") continue;
    const callWall = [...asset.strikes].filter(s => s.isNearPrice).sort((a, b) => b.callOI - a.callOI)[0]?.strike || 0;
    const putWall = [...asset.strikes].filter(s => s.isNearPrice).sort((a, b) => b.putOI - a.putOI)[0]?.strike || 0;
    keyLevels.push({
      asset: asset.symbol,
      support: putWall || asset.currentPrice * 0.99,
      resistance: callWall || asset.currentPrice * 1.01,
      zeroGamma: asset.gammaFlipLevel,
    });
  }

  // Expected ranges
  const expectedRange = assets.filter(a => a.symbol !== "VIX").map(a => ({
    asset: a.symbol,
    low: a.currentPrice * (1 - Math.max(Math.abs(a.dailyChangePct) / 100, 0.005)),
    high: a.currentPrice * (1 + Math.max(Math.abs(a.dailyChangePct) / 100, 0.005)),
  }));

  const outlierSummary = outlierZones.length > 0
    ? `Zonas gamma outlier: ${outlierZones.slice(0, 5).map(z => `${z.asset} $${z.strike.toLocaleString()} (${z.type})`).join(", ")}.`
    : "";

  return {
    generatedAt: new Date().toISOString(),
    marketBias: bias,
    keyLevels,
    expectedRange,
    outlierZones,
    summary: `RESUMEN: SPX $${(spx.currentPrice || 0).toFixed(0)} (${(spx.dailyChangePct || 0) > 0 ? "+" : ""}${(spx.dailyChangePct || 0).toFixed(2)}%). Sesgo ${bias.toUpperCase()}. Gamma Flip: $${(gex.zeroGammaLevel || 0).toFixed(0)}. Hedge Wall: $${(gex.hedgeWall || 0).toLocaleString()}. Put Wall: $${(gex.putWall || 0).toLocaleString()}. ${outlierSummary}`,
  };
}

// ============ VANNA CONTEXT BUILDER ============

function buildVannaContext(
  assets: AssetData[],
  hiro: HiroData | null,
  equitiesData: EquitiesResponse | null,
  cfdPrices: CFDPriceData | null,
): VannaContext | null {
  const vixAsset = assets.find(a => a.symbol === "VIX");
  const gldAsset = assets.find(a => a.symbol === "GLD");
  
  // Get UVXY price from TradingView (primary) or HIRO (fallback)
  const tvUvxy = cfdPrices?.uvxy;
  const tvUvix = cfdPrices?.uvix;
  const tvGld = cfdPrices?.gld;
  const tvVix = cfdPrices?.vix;
  
  const uvxyPrice = tvUvxy?.price || Number((hiro?.perAsset?.["UVXY"] as any)?._rawPrice) || 0;
  const uvxyClose = tvUvxy?.prevClose || Number((hiro?.perAsset?.["UVXY"] as any)?._rawLastClose) || 0;
  const uvxyChange = uvxyPrice - uvxyClose;
  const uvxyChangePct = tvUvxy?.changePct || (uvxyClose > 0 ? (uvxyChange / uvxyClose) * 100 : 0);
  
  // UVIX price from TradingView
  const uvixPrice = tvUvix?.price || 0;
  const uvixChange = tvUvix?.change || 0;
  const uvixChangePct = tvUvix?.changePct || 0;
  
  // GLD price from TradingView (more reliable than SpotGamma on weekends)
  const gldPrice = tvGld?.price || gldAsset?.currentPrice || 0;
  const gldChangePct = tvGld?.changePct || gldAsset?.dailyChangePct || 0;
  
  const vixPrice = vixAsset?.currentPrice || tvVix?.price || 0;
  const vixChange = vixAsset?.dailyChange || tvVix?.change || 0;
  const vixChangePct = vixAsset?.dailyChangePct || tvVix?.changePct || 0;
  
  // VIX Vanna signal for indices
  let vixVannaSignal: VannaContext["vixVannaSignal"] = "neutral";
  let vixVannaStrength: VannaContext["vixVannaStrength"] = "none";
  if (vixChangePct < -1.5) {
    vixVannaSignal = "bullish";
    vixVannaStrength = vixChangePct < -3 ? "strong" : vixChangePct < -2 ? "moderate" : "weak";
  } else if (vixChangePct > 1.5) {
    vixVannaSignal = "bearish";
    vixVannaStrength = vixChangePct > 3 ? "strong" : vixChangePct > 2 ? "moderate" : "weak";
  }
  
  // UVXY refuge signal for gold
  let uvxyRefugeSignal: VannaContext["uvxyRefugeSignal"] = "neutral";
  if (uvxyChangePct > 5) {
    uvxyRefugeSignal = "buy_gold"; // Extreme fear → gold as refuge
  } else if (uvxyChangePct < -5) {
    uvxyRefugeSignal = "risk_on"; // Complacency → money leaves gold
  }
  
  // GLD IV-based vanna
  const gldEq = equitiesData?.["GLD"];
  const gldIVChange = gldEq?.atm_iv30_pct_chg || 0;
  let gldVannaSignal: VannaContext["gldVannaSignal"] = "neutral";
  let gldVannaStrength: VannaContext["gldVannaStrength"] = "none";
  if (gldIVChange < -0.02) {
    gldVannaSignal = "bullish";
    gldVannaStrength = gldIVChange < -0.05 ? "strong" : gldIVChange < -0.03 ? "moderate" : "weak";
  } else if (gldIVChange > 0.02) {
    gldVannaSignal = "bearish";
    gldVannaStrength = gldIVChange > 0.05 ? "strong" : gldIVChange > 0.03 ? "moderate" : "weak";
  }
  
  // UVIX-GLD Divergence Analysis
  let divType: VannaContext["uvixGldDivergence"]["type"] = "none";
  let divStrength: VannaContext["uvixGldDivergence"]["strength"] = "none";
  let divSignal: VannaContext["uvixGldDivergence"]["signal"] = "neutral";
  let divDesc = "";
  const isDiverging = (uvixChangePct > 1 && gldChangePct < -0.5) || (uvixChangePct < -1 && gldChangePct > 0.5);
  
  if (uvixChangePct > 1 && gldChangePct < -0.5) {
    divType = "uvix_up_gld_down";
    divSignal = "buy_gold";
    const mag = Math.abs(uvixChangePct) + Math.abs(gldChangePct);
    divStrength = mag > 8 ? "strong" : mag > 4 ? "moderate" : "weak";
    divDesc = `DIVERGENCIA: UVIX +${uvixChangePct.toFixed(1)}% pero GLD ${gldChangePct.toFixed(1)}%. Miedo sube pero oro baja = oportunidad de COMPRA GLD (el oro deberia subir como refugio).`;
  } else if (uvixChangePct < -1 && gldChangePct > 0.5) {
    divType = "uvix_down_gld_up";
    divSignal = "sell_gold";
    const mag = Math.abs(uvixChangePct) + Math.abs(gldChangePct);
    divStrength = mag > 8 ? "strong" : mag > 4 ? "moderate" : "weak";
    divDesc = `DIVERGENCIA: UVIX ${uvixChangePct.toFixed(1)}% pero GLD +${gldChangePct.toFixed(1)}%. Miedo baja pero oro sube = posible VENTA GLD (flujo refugio se agota).`;
  } else if (uvixChangePct > 1 && gldChangePct > 0.5) {
    divType = "both_up";
    divDesc = `CORRELACION: UVIX +${uvixChangePct.toFixed(1)}% y GLD +${gldChangePct.toFixed(1)}%. Flujo refugio activo = oro sube con el miedo.`;
  } else if (uvixChangePct < -1 && gldChangePct < -0.5) {
    divType = "both_down";
    divDesc = `CORRELACION: UVIX ${uvixChangePct.toFixed(1)}% y GLD ${gldChangePct.toFixed(1)}%. Risk-on = dinero sale de refugios.`;
  } else {
    divDesc = "Sin divergencia significativa UVIX-GLD.";
  }
  
  const indexVannaActive = vixVannaStrength !== "none";
  const goldVannaActive = gldVannaStrength !== "none";
  const refugeFlowActive = uvxyRefugeSignal === "buy_gold" && (hiro?.perAsset?.["GLD"]?.hiroTrend === "bullish");
  
  // Build description
  const parts: string[] = [];
  if (indexVannaActive) {
    parts.push(`VIX ${vixChangePct > 0 ? "+" : ""}${vixChangePct.toFixed(1)}% → Vanna ${vixVannaSignal === "bullish" ? "ALCISTA" : "BAJISTA"} para indices (${vixVannaStrength}).`);
  }
  if (goldVannaActive) {
    parts.push(`GLD IV ${gldIVChange > 0 ? "+" : ""}${(gldIVChange * 100).toFixed(1)}% → Vanna ${gldVannaSignal === "bullish" ? "ALCISTA" : "BAJISTA"} para oro (${gldVannaStrength}).`);
  }
  if (refugeFlowActive) {
    parts.push(`UVXY +${uvxyChangePct.toFixed(1)}% + GLD HIRO positivo → FLUJO REFUGIO activo hacia oro.`);
  }
  if (parts.length === 0) {
    parts.push("Sin flujo Vanna significativo detectado.");
  }
  
  console.log(`[VANNA] VIX=${vixChangePct.toFixed(1)}% UVXY=${uvxyChangePct.toFixed(1)}% UVIX=$${uvixPrice.toFixed(2)}(${uvixChangePct.toFixed(1)}%) GLD=$${gldPrice.toFixed(2)}(${gldChangePct.toFixed(1)}%) | Index=${vixVannaSignal} Gold=${gldVannaSignal} Refuge=${uvxyRefugeSignal} Div=${divType}`);
  
  return {
    vixPrice, vixChange, vixChangePct,
    vixVannaSignal, vixVannaStrength,
    uvxyPrice, uvxyChange, uvxyChangePct,
    uvxyRefugeSignal,
    uvixPrice, uvixChange, uvixChangePct,
    uvixGldDivergence: {
      isDiverging,
      type: divType,
      uvixChangePct,
      gldChangePct,
      strength: divStrength,
      signal: divSignal,
      description: divDesc,
    },
    gldIVChange,
    gldPrice, gldChangePct,
    gldVannaSignal, gldVannaStrength,
    indexVannaActive, goldVannaActive, refugeFlowActive,
    description: parts.join(" "),
    lastUpdated: new Date().toISOString(),
  };
}

// ============ SPOTGAMMA LIVE PRICES ============

// prevClose cache updated from full data cycle so fast endpoint can calculate change%
const sgPrevCloseCache: Record<string, number> = {};
let cachedSGLivePrices: { prices: Record<string, { price: number; prevClose: number; change: number; changePct: number }>; lastUpdated: string } | null = null;
let lastSGLiveFetchTime = 0;
const SG_LIVE_CACHE_TTL = 5000;

export function updateSGPrevCloseCache(priceMap: Record<string, { price: number; lastClose: number }>) {
  for (const [sym, p] of Object.entries(priceMap)) {
    if (p.lastClose > 0) sgPrevCloseCache[sym] = p.lastClose;
  }
}

export async function fetchSpotGammaLivePrices(): Promise<{ prices: Record<string, { price: number; prevClose: number; change: number; changePct: number }>; lastUpdated: string }> {
  const now = Date.now();
  if (cachedSGLivePrices && now - lastSGLiveFetchTime < SG_LIVE_CACHE_TTL) {
    return cachedSGLivePrices;
  }

  const calc = (price: number, prevClose: number) => ({
    price, prevClose,
    change: price - prevClose,
    changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
  });

  const prices: Record<string, { price: number; prevClose: number; change: number; changePct: number }> = {};

  try {
    // Primary source: pollUpdate — SpotGamma's own real-time feed
    // This is the same feed their dashboard uses for SPX, VIX, NDX live display
    const poll = await apiCall<PollUpdateResponse>(`/v1/me/pollUpdate?features=%7B%22futures%22%3A%7B%7D%7D`, 8000);
    if (poll?.futuresSnapshot) {
      for (const f of poll.futuresSnapshot) {
        const lp = f.lastPrice > 0 ? f.lastPrice : f.lastClose;
        const lc = f.lastClose > 0 ? f.lastClose : lp;
        if (f.sym === "^SPX" && lp > 0) { prices["SPX"] = calc(lp, lc); console.log(`[SG-LIVE] SPX: $${lp.toFixed(2)} chg=${prices["SPX"].changePct.toFixed(2)}%`); }
        if (f.sym === "^VIX" && lp > 0) { prices["VIX"] = calc(lp, lc); console.log(`[SG-LIVE] VIX: $${lp.toFixed(2)} chg=${prices["VIX"].changePct.toFixed(2)}%`); }
        if (f.sym === "^NDX" && lp > 0) { prices["NDX"] = calc(lp, lc); }
        if (f.sym === "Gold" && lp > 0) { prices["GOLD_FUTURES"] = calc(lp, lc); }
      }
    }
  } catch (e: any) {
    console.error(`[SG-LIVE] pollUpdate error: ${e.message}`);
  }

  // Use HIRO v6 endpoint for live ETF prices (currentDayPrice field)
  // This gives us SPY, QQQ, GLD, DIA, IWM prices directly from SpotGamma
  try {
    const hiroData = await apiCall<any[]>("/v6/running_hiro", 8000);
    if (Array.isArray(hiroData)) {
      const etfTargets = ["SPY", "QQQ", "GLD", "DIA", "IWM", "UVIX"] as const;
      for (const item of hiroData) {
        const sym = item.symbol as string;
        if (!etfTargets.includes(sym as any)) continue;
        const price = Number(item.currentDayPrice);
        const prevClose = Number(item.lastClose);
        if (price > 0 && prevClose > 0) {
          prices[sym] = calc(price, prevClose);
          console.log(`[SG-LIVE] ${sym}: $${price.toFixed(2)} chg=${prices[sym].changePct.toFixed(2)}%`);
        }
      }
    }
  } catch (e: any) {
    console.error(`[SG-LIVE] HIRO ETF prices error: ${e.message}`);
  }

  // SPY, QQQ, GLD, DIA, UVIX, IWM — fallback to TradingView scanner ONLY if HIRO v6 didn't provide them
  // HIRO v6 currentDayPrice is the authoritative source (updated live during market hours)
  const cfd = cachedCFDPrices;
  if (cfd) {
    if (!prices["SPY"]  && cfd.spy?.price > 0)  prices["SPY"]  = { price: cfd.spy.price,  prevClose: cfd.spy.prevClose,  change: cfd.spy.change,  changePct: cfd.spy.changePct };
    if (!prices["QQQ"]  && cfd.qqq?.price > 0)  prices["QQQ"]  = { price: cfd.qqq.price,  prevClose: cfd.qqq.prevClose,  change: cfd.qqq.change,  changePct: cfd.qqq.changePct };
    if (!prices["GLD"]  && cfd.gld?.price > 0)  prices["GLD"]  = { price: cfd.gld.price,  prevClose: cfd.gld.prevClose,  change: cfd.gld.change,  changePct: cfd.gld.changePct };
    if (!prices["DIA"]  && cfd.dia?.price > 0)  prices["DIA"]  = { price: cfd.dia.price,  prevClose: cfd.dia.prevClose,  change: cfd.dia.change,  changePct: cfd.dia.changePct };
    if (!prices["UVIX"] && cfd.uvix?.price > 0) prices["UVIX"] = { price: cfd.uvix.price, prevClose: cfd.uvix.prevClose, change: cfd.uvix.change, changePct: cfd.uvix.changePct };
    if (!prices["IWM"]  && cfd.iwm?.price > 0)  prices["IWM"]  = { price: cfd.iwm.price,  prevClose: cfd.iwm.prevClose,  change: cfd.iwm.change,  changePct: cfd.iwm.changePct };
  }

  // Derive ETF prices from SpotGamma futures when TradingView is stale (pre-market/after-hours)
  // Gold futures → GLD (ratio ~11.12), SPX → SPY (~10.31), NDX → QQQ (~42.5), SPX → DIA (via US30)
  if (prices["GOLD_FUTURES"]?.price > 0) {
    const goldPrice = prices["GOLD_FUTURES"].price;
    const gldDerived = goldPrice / 11.12;
    // Use derived GLD if TradingView GLD is stale (changePct near 0 while Gold moved significantly)
    if (!prices["GLD"] || (Math.abs(prices["GOLD_FUTURES"].changePct) > 0.5 && Math.abs(prices["GLD"].changePct) < 0.01)) {
      const prevGLD = prices["GLD"]?.prevClose || (prices["GOLD_FUTURES"].prevClose / 11.12);
      prices["GLD"] = calc(gldDerived, prevGLD);
      console.log(`[SG-LIVE] GLD (derived from Gold $${goldPrice.toFixed(2)}): $${gldDerived.toFixed(2)}`);
    }
  }
  if (prices["SPX"]?.price > 0) {
    const spxPrice = prices["SPX"].price;
    const spyDerived = spxPrice / 10.31;
    if (!prices["SPY"] || (Math.abs(prices["SPX"].changePct) > 0.5 && Math.abs(prices["SPY"].changePct) < 0.01)) {
      const prevSPY = prices["SPY"]?.prevClose || (prices["SPX"].prevClose / 10.31);
      prices["SPY"] = calc(spyDerived, prevSPY);
      console.log(`[SG-LIVE] SPY (derived from SPX $${spxPrice.toFixed(2)}): $${spyDerived.toFixed(2)}`);
    }
    const diaDerived = spxPrice / 14.22;
    if (!prices["DIA"] || (Math.abs(prices["SPX"].changePct) > 0.5 && Math.abs(prices["DIA"].changePct) < 0.01)) {
      const prevDIA = prices["DIA"]?.prevClose || (prices["SPX"].prevClose / 14.22);
      prices["DIA"] = calc(diaDerived, prevDIA);
      console.log(`[SG-LIVE] DIA (derived from SPX $${spxPrice.toFixed(2)}): $${diaDerived.toFixed(2)}`);
    }
  }
  if (prices["NDX"]?.price > 0) {
    const ndxPrice = prices["NDX"].price;
    const qqqDerived = ndxPrice / 42.5;
    if (!prices["QQQ"] || (Math.abs(prices["NDX"].changePct) > 0.5 && Math.abs(prices["QQQ"].changePct) < 0.01)) {
      const prevQQQ = prices["QQQ"]?.prevClose || (prices["NDX"].prevClose / 42.5);
      prices["QQQ"] = calc(qqqDerived, prevQQQ);
      console.log(`[SG-LIVE] QQQ (derived from NDX $${ndxPrice.toFixed(2)}): $${qqqDerived.toFixed(2)}`);
    }
  }

  // Fallback: use sgPrevCloseCache for any missing SPX/VIX
  if (!prices["SPX"] && sgPrevCloseCache["SPX"]) {
    prices["SPX"] = calc(sgPrevCloseCache["SPX"], sgPrevCloseCache["SPX"]);
  }
  if (!prices["VIX"] && sgPrevCloseCache["VIX"]) {
    prices["VIX"] = calc(sgPrevCloseCache["VIX"], sgPrevCloseCache["VIX"]);
  }

  if (Object.keys(prices).length > 0) {
    cachedSGLivePrices = { prices, lastUpdated: new Date().toISOString() };
    lastSGLiveFetchTime = now;
  }

  return cachedSGLivePrices ?? { prices, lastUpdated: new Date().toISOString() };
}

// ============ TRADIER GEX FETCHER ============

const TRADIER_API_KEY = process.env.TRADIER_API_KEY || "";
// Default → api.tradier.com (production, real-time data)
// Set TRADIER_SANDBOX=true in .env to use sandbox.tradier.com instead
const TRADIER_BASE = process.env.TRADIER_SANDBOX === "true"
  ? "https://sandbox.tradier.com/v1"
  : "https://api.tradier.com/v1";

function getNextOptionExpiration(): string {
  const today = new Date();
  const day = today.getDay(); // 0=Sun 1=Mon ... 5=Fri 6=Sat
  const todayStr = today.toISOString().split("T")[0];
  // If today is Friday (expiration day for weekly options) → use today = true 0DTE
  // Fix: original code had bug where Friday returned daysToFriday = 0||7 = 7 (next week)
  if (day === 5) return todayStr; // Friday = 0DTE weekly expiry
  // Otherwise advance to nearest Friday
  const daysToFriday = day === 6 ? 6 : (5 - day);
  const nextFri = new Date(today);
  nextFri.setDate(today.getDate() + daysToFriday);
  return nextFri.toISOString().split("T")[0];
}

let tradierCache: Record<string, { data: TradierGexData; ts: number }> = {};
const TRADIER_CACHE_TTL = 120_000; // 2 min cache — 5 req/min limit on sandbox

export async function fetchTradierGEX(symbol: string, underlyingPrice: number): Promise<TradierGexData | null> {
  if (!TRADIER_API_KEY) return null;

  const now = Date.now();
  if (tradierCache[symbol] && now - tradierCache[symbol].ts < TRADIER_CACHE_TTL) {
    return tradierCache[symbol].data;
  }

  try {
    const expiration = getNextOptionExpiration();
    const url = `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TRADIER_API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.warn(`[TRADIER] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const json = await resp.json() as any;
    const options: any[] = Array.isArray(json?.options?.option)
      ? json.options.option
      : json?.options?.option ? [json.options.option] : [];

    if (options.length === 0) return null;

    // Calculate GEX per strike:  gamma × OI × 100 × underlying_price
    // Calls: +GEX (dealers long gamma = stabilizing)
    // Puts:  -GEX (dealers short gamma on puts = amplifying)
    const byStrike: Record<number, { callGex: number; putGex: number }> = {};
    for (const opt of options) {
      const strike = opt.strike as number;
      const gamma = (opt.greeks?.gamma as number) ?? 0;
      const oi = (opt.open_interest as number) ?? 0;
      const gexVal = gamma * oi * 100 * underlyingPrice;
      if (!byStrike[strike]) byStrike[strike] = { callGex: 0, putGex: 0 };
      if (opt.option_type === "call") byStrike[strike].callGex += gexVal;
      else byStrike[strike].putGex -= gexVal; // negative for puts
    }

    const gexByStrike = Object.entries(byStrike)
      .map(([s, g]) => ({ strike: Number(s), callGex: g.callGex, putGex: g.putGex, netGex: g.callGex + g.putGex }))
      .sort((a, b) => a.strike - b.strike);

    const totalGex = gexByStrike.reduce((sum, s) => sum + s.netGex, 0);
    const netBias: TradierGexData["netBias"] =
      totalGex > 5e6 ? "bullish" : totalGex < -5e6 ? "bearish" : "neutral";

    // Find gamma flip level (where cumulative GEX crosses zero)
    let gammaFlipLevel = underlyingPrice;
    let cumGex = 0;
    for (const bar of gexByStrike) {
      const prev = cumGex;
      cumGex += bar.netGex;
      if (prev < 0 && cumGex >= 0) { gammaFlipLevel = bar.strike; break; }
    }

    // Top support/resistance within 5% of price
    const nearby = gexByStrike.filter(s => Math.abs(s.strike - underlyingPrice) / underlyingPrice < 0.05);
    const topSupport = nearby.filter(s => s.netGex > 0)
      .sort((a, b) => b.netGex - a.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));
    const topResistance = nearby.filter(s => s.netGex < 0)
      .sort((a, b) => a.netGex - b.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));

    const todayStr = new Date().toISOString().split("T")[0];
    const is0DTE = expiration === todayStr;
    const result: TradierGexData = {
      symbol, underlyingPrice, totalGex, gammaFlipLevel, netBias,
      topSupport, topResistance, gexByStrike,
      expiration, is0DTE, lastUpdated: new Date().toISOString(),
    };

    tradierCache[symbol] = { data: result, ts: now };
    console.log(`[TRADIER] ${symbol} GEX: total=${(totalGex / 1e6).toFixed(1)}M bias=${netBias} flip=$${gammaFlipLevel} exp=${expiration}${is0DTE ? " ★0DTE" : ""}`);
    return result;

  } catch (e: any) {
    console.error(`[TRADIER] ${symbol} error: ${e.message}`);
    return null;
  }
}

// ============ YAHOO FINANCE GEX (Black-Scholes, no API key needed) ============

// Standard normal PDF (for Black-Scholes gamma)
function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Black-Scholes gamma: N'(d1) / (S × σ × √T)
function blackScholesGamma(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return normalPDF(d1) / (S * sigma * Math.sqrt(T));
}

let yahooGexCache: Record<string, { data: TradierGexData; ts: number }> = {};
const YAHOO_GEX_CACHE_TTL = 90_000; // 90 sec cache

export async function fetchYahooGEX(symbol: string, underlyingPrice: number): Promise<TradierGexData | null> {
  const now = Date.now();
  if (yahooGexCache[symbol] && now - yahooGexCache[symbol].ts < YAHOO_GEX_CACHE_TTL) {
    return yahooGexCache[symbol].data;
  }

  try {
    // Step 1: Get available expirations
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.warn(`[YAHOO-GEX] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const json = await resp.json() as any;
    const result = json?.optionChain?.result?.[0];
    if (!result) return null;

    // Step 2: Pick best expiration — prefer TODAY (0DTE) if available, else nearest weekly
    const expirations: number[] = result.expirationDates || [];
    if (expirations.length === 0) return null;
    const todayStr = new Date().toISOString().split("T")[0];
    // Yahoo timestamps are midnight UTC — compare as date strings
    const todayExpiry = expirations.find(ts => new Date(ts * 1000).toISOString().split("T")[0] === todayStr);
    const nearestExpiry = todayExpiry ?? expirations[0]; // prefer 0DTE, fall back to nearest weekly
    const expiryDate = new Date(nearestExpiry * 1000);
    const expiryStr = expiryDate.toISOString().split("T")[0];
    const is0DTE = expiryStr === todayStr;

    // Step 3: Fetch options chain for chosen expiry
    const expiryUrl = `${url}?date=${nearestExpiry}`;
    const expiryResp = await fetch(expiryUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!expiryResp.ok) return null;
    const expiryJson = await expiryResp.json() as any;
    const chain = expiryJson?.optionChain?.result?.[0]?.options?.[0];
    if (!chain) return null;

    const calls: any[] = chain.calls || [];
    const puts: any[] = chain.puts || [];

    // Step 4: Calculate GEX using Black-Scholes gamma
    // For 0DTE: clamp T to minimum 15 min (900s) to avoid gamma infinity near expiry
    const rawT = (nearestExpiry - now / 1000) / (365.25 * 24 * 3600); // years to expiry
    const T = is0DTE ? Math.max(rawT, 900 / (365.25 * 24 * 3600)) : rawT;
    const r = 0.05; // risk-free rate (~5%)
    const byStrike: Record<number, { callGex: number; putGex: number }> = {};

    for (const opt of calls) {
      const K = opt.strike as number;
      const iv = (opt.impliedVolatility as number) || 0;
      const oi = (opt.openInterest as number) || 0;
      if (!K || !iv || !oi) continue;
      const gamma = blackScholesGamma(underlyingPrice, K, T, r, iv);
      const gexVal = gamma * oi * 100 * underlyingPrice;
      if (!byStrike[K]) byStrike[K] = { callGex: 0, putGex: 0 };
      byStrike[K].callGex += gexVal;
    }

    for (const opt of puts) {
      const K = opt.strike as number;
      const iv = (opt.impliedVolatility as number) || 0;
      const oi = (opt.openInterest as number) || 0;
      if (!K || !iv || !oi) continue;
      const gamma = blackScholesGamma(underlyingPrice, K, T, r, iv);
      const gexVal = gamma * oi * 100 * underlyingPrice;
      if (!byStrike[K]) byStrike[K] = { callGex: 0, putGex: 0 };
      byStrike[K].putGex -= gexVal; // negative for puts
    }

    const gexByStrike = Object.entries(byStrike)
      .map(([s, g]) => ({ strike: Number(s), callGex: g.callGex, putGex: g.putGex, netGex: g.callGex + g.putGex }))
      .sort((a, b) => a.strike - b.strike);

    const totalGex = gexByStrike.reduce((sum, s) => sum + s.netGex, 0);
    const netBias: TradierGexData["netBias"] =
      totalGex > 5e6 ? "bullish" : totalGex < -5e6 ? "bearish" : "neutral";

    // Gamma flip level
    let gammaFlipLevel = underlyingPrice;
    let cumGex = 0;
    for (const bar of gexByStrike) {
      const prev = cumGex;
      cumGex += bar.netGex;
      if (prev < 0 && cumGex >= 0) { gammaFlipLevel = bar.strike; break; }
    }

    // Top support/resistance within 5% of price
    const nearby = gexByStrike.filter(s => Math.abs(s.strike - underlyingPrice) / underlyingPrice < 0.05);
    const topSupport = nearby.filter(s => s.netGex > 0)
      .sort((a, b) => b.netGex - a.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));
    const topResistance = nearby.filter(s => s.netGex < 0)
      .sort((a, b) => a.netGex - b.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));

    const data: TradierGexData = {
      symbol, underlyingPrice, totalGex, gammaFlipLevel, netBias,
      topSupport, topResistance, gexByStrike,
      expiration: expiryStr, is0DTE, lastUpdated: new Date().toISOString(),
    };

    yahooGexCache[symbol] = { data, ts: now };
    console.log(`[YAHOO-GEX] ${symbol} GEX: total=${(totalGex / 1e6).toFixed(1)}M bias=${netBias} flip=$${gammaFlipLevel} exp=${expiryStr}${is0DTE ? " ★0DTE" : " (weekly)"} (Black-Scholes)`);
    return data;

  } catch (e: any) {
    console.error(`[YAHOO-GEX] ${symbol} error: ${e.message}`);
    return null;
  }
}

// ============ CFD PRICE BUILDER ============

// Yahoo Finance API for real CFD prices
let cachedCFDPrices: CFDPriceData | null = null;
let lastCFDFetchTime = 0;
const CFD_CACHE_TTL = 5000; // 5 seconds cache for near-real-time prices

export async function fetchCFDPricesFromTradingView(): Promise<CFDPriceData> {
  const now = Date.now();
  if (cachedCFDPrices && now - lastCFDFetchTime < CFD_CACHE_TTL) {
    return cachedCFDPrices;
  }
  
  const calcChange = (p: number, c: number) => ({ 
    price: p, prevClose: c, 
    change: p - c, 
    changePct: c > 0 ? ((p - c) / c) * 100 : 0 
  });
  
  const prices: Record<string, { price: number; prevClose: number; change: number; changePct: number }> = {
    nas100: calcChange(0, 0),
    us30: calcChange(0, 0),
    xauusd: calcChange(0, 0),
    uvix: calcChange(0, 0),
    uvxy: calcChange(0, 0),
    gld: calcChange(0, 0),
    vix: calcChange(0, 0),
    spy: calcChange(0, 0),
    qqq: calcChange(0, 0),
    iwm: calcChange(0, 0),
    dia: calcChange(0, 0),
  };
  
  // 1. Fetch PEPPERSTONE:NAS100 and PEPPERSTONE:US30 via TradingView WebSocket
  //    This is the exact same data source TradingView charts use — no scanner limitations.
  //    Node 22+ has built-in WebSocket support (no external package needed).
  try {
    const tvSymbols = ["PEPPERSTONE:NAS100", "PEPPERSTONE:US30", "PEPPERSTONE:XAUUSD"];
    const tvPrices = await new Promise<Record<string, { lp: number; prevClose: number; chp: number }>>((resolve) => {
      const result: Record<string, { lp: number; prevClose: number; chp: number }> = {};
      let done = false; // Guard: resolve solo una vez
      const safeResolve = () => { if (done) return; done = true; clearTimeout(timeout); try { ws.close(); } catch {} resolve(result); };
      const sessionId = "qs_" + Math.random().toString(36).slice(2, 12);
      const wrap = (msg: object) => { const s = JSON.stringify(msg); return `~m~${s.length}~m~${s}`; };
      const ws = new (globalThis as any).WebSocket(
        `wss://data.tradingview.com/socket.io/websocket?from=chart&date=${Date.now()}`,
        { headers: { Origin: "https://www.tradingview.com", "User-Agent": "Mozilla/5.0" } }
      );
      const timeout = setTimeout(safeResolve, 6000);
      ws.onopen = () => {
        ws.send(wrap({ m: "set_auth_token", p: ["unauthorized_user_token"] }));
        ws.send(wrap({ m: "quote_create_session", p: [sessionId] }));
        ws.send(wrap({ m: "quote_set_fields", p: [sessionId, "lp", "chp", "ch", "prev_close_price"] }));
        for (const sym of tvSymbols) ws.send(wrap({ m: "quote_add_symbols", p: [sessionId, sym] }));
      };
      ws.onmessage = (evt: any) => {
        if (done) return;
        const parts: string[] = evt.data.split(/~m~\d+~m~/);
        for (const part of parts) {
          if (!part.startsWith("{")) continue;
          try {
            const obj = JSON.parse(part);
            if (obj.m === "qsd" && obj.p?.[1]?.v?.lp) {
              const sym: string = obj.p[1].n;
              const v = obj.p[1].v;
              const lp: number = v.lp;
              const prevClose: number = v.prev_close_price || (lp - (v.ch || 0));
              const chp: number = v.chp || (prevClose > 0 ? ((lp - prevClose) / prevClose) * 100 : 0);
              result[sym] = { lp, prevClose, chp };
              if (tvSymbols.every(s => result[s]?.lp)) safeResolve();
            }
          } catch {}
        }
      };
      ws.onerror = safeResolve;
    });
    for (const [sym, val] of Object.entries(tvPrices)) {
      if (!val?.lp) continue;
      const key = sym === "PEPPERSTONE:NAS100" ? "nas100" : sym === "PEPPERSTONE:US30" ? "us30" : sym === "PEPPERSTONE:XAUUSD" ? "xauusd" : null;
      if (!key) continue;
      prices[key] = calcChange(val.lp, val.prevClose);
      const label = key.toUpperCase();
      console.log(`[CFD-PP] ${label} (WebSocket): $${val.lp.toFixed(key === "xauusd" ? 2 : 0)} chg=${prices[key].changePct.toFixed(2)}%`);
    }
  } catch (e: any) {
    console.log(`[CFD-PP] TradingView WebSocket error: ${e.message}`);
  }

  // 1b. Fetch ETF/index prices from TradingView America Scanner
  try {
    const stockResp = await fetch("https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({
        symbols: { tickers: ["AMEX:GLD", "CBOE:VIX", "CBOE:UVIX", "CBOE:UVXY", "AMEX:SPY", "NASDAQ:QQQ", "AMEX:IWM", "AMEX:DIA"] },
        columns: ["name", "close", "change_abs", "change"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (stockResp.ok) {
      const stockData = await stockResp.json() as any;
      for (const item of stockData?.data || []) {
        const name: string = item.d[0] || "";
        const close: number = item.d[1] || 0;
        const changeAbs: number = item.d[2] || 0;
        const prevClose = close - changeAbs;
        if (!close) continue;
        if (name === "GLD") { prices.gld = calcChange(close, prevClose); console.log(`[CFD-TV] GLD: $${close.toFixed(2)} chg=${prices.gld.changePct.toFixed(2)}%`); }
        else if (name === "VIX") { prices.vix = calcChange(close, prevClose); console.log(`[CFD-TV] VIX: $${close.toFixed(2)} chg=${prices.vix.changePct.toFixed(2)}%`); }
        else if (name === "UVIX") { prices.uvix = calcChange(close, prevClose); console.log(`[CFD-TV] UVIX: $${close.toFixed(2)} chg=${prices.uvix.changePct.toFixed(2)}%`); }
        else if (name === "UVXY") { prices.uvxy = calcChange(close, prevClose); console.log(`[CFD-TV] UVXY: $${close.toFixed(2)} chg=${prices.uvxy.changePct.toFixed(2)}%`); }
        else if (name === "SPY") { prices.spy = calcChange(close, prevClose); console.log(`[CFD-TV] SPY: $${close.toFixed(2)} chg=${prices.spy.changePct.toFixed(2)}%`); }
        else if (name === "QQQ") { prices.qqq = calcChange(close, prevClose); console.log(`[CFD-TV] QQQ: $${close.toFixed(2)} chg=${prices.qqq.changePct.toFixed(2)}%`); }
        else if (name === "IWM") { prices.iwm = calcChange(close, prevClose); console.log(`[CFD-TV] IWM: $${close.toFixed(2)} chg=${prices.iwm.changePct.toFixed(2)}%`); }
        else if (name === "DIA") { prices.dia = calcChange(close, prevClose); console.log(`[CFD-TV] DIA: $${close.toFixed(2)} chg=${prices.dia.changePct.toFixed(2)}%`); }
      }
    }
  } catch (e: any) {
    console.log(`[CFD-TV] America scanner error: ${e.message}`);
  }

  // 1c. Fallback: Yahoo Finance for NAS100/US30 if WebSocket failed
  if (prices.nas100.price === 0 || prices.us30.price === 0) {
    const yahooFallback: Record<string, string> = { "NQ%3DF": "nas100", "YM%3DF": "us30" };
    await Promise.all(Object.entries(yahooFallback).map(async ([ticker, key]) => {
      if (prices[key].price > 0) return;
      try {
        const resp = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
        );
        if (resp.ok) {
          const data = await resp.json() as any;
          const meta = data?.chart?.result?.[0]?.meta || {};
          const close = meta.regularMarketPrice || 0;
          const prevClose = meta.previousClose || meta.chartPreviousClose || 0;
          if (close > 0) {
            prices[key] = calcChange(close, prevClose);
            console.log(`[CFD-YF] ${key.toUpperCase()} fallback (${ticker}): $${close.toFixed(2)} chg=${prices[key].changePct.toFixed(2)}%`);
          }
        }
      } catch (e: any) {
        console.log(`[CFD-YF] Yahoo Finance error for ${ticker}: ${e.message}`);
      }
    }));
  }

  // 2. Fallback XAUUSD from TradingView CFD Scanner if WebSocket didn't get it
  if (prices.xauusd.price === 0) {
    try {
      const cfdResp = await fetch("https://scanner.tradingview.com/cfd/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        body: JSON.stringify({
          columns: ["close", "change", "change_abs", "description"],
          symbols: { tickers: ["PEPPERSTONE:XAUUSD"] }
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (cfdResp.ok) {
        const cfdData = await cfdResp.json() as any;
        for (const item of cfdData?.data || []) {
          if (item.s === "PEPPERSTONE:XAUUSD") {
            const close = item.d[0] || 0;
            const changeAbs = item.d[2] || 0;
            const prevClose = close - changeAbs;
            prices.xauusd = calcChange(close, prevClose);
            console.log(`[CFD-TV] XAUUSD fallback (scanner): $${close.toFixed(2)} chg=${prices.xauusd.changePct.toFixed(2)}%`);
          }
        }
      }
    } catch (e: any) {
      console.log(`[CFD-TV] XAUUSD fallback error: ${e.message}`);
    }
  }
  
  const result: CFDPriceData = {
    nas100: prices.nas100,
    us30: prices.us30,
    xauusd: prices.xauusd,
    uvix: prices.uvix,
    uvxy: prices.uvxy,
    gld: prices.gld,
    vix: prices.vix,
    spy: prices.spy,
    qqq: prices.qqq,
    iwm: prices.iwm,
    dia: prices.dia,
    lastUpdated: new Date().toISOString(),
  };
  
  // Only cache if we got at least one valid price
  if (prices.nas100.price > 0 || prices.us30.price > 0 || prices.xauusd.price > 0) {
    cachedCFDPrices = result;
    lastCFDFetchTime = now;
  }
  
  console.log(`[CFD-TV] NAS100=$${(prices.nas100?.price || 0).toFixed(0)} US30=$${(prices.us30?.price || 0).toFixed(0)} XAUUSD=$${(prices.xauusd?.price || 0).toFixed(2)} UVIX=$${(prices.uvix?.price || 0).toFixed(2)} UVXY=$${(prices.uvxy?.price || 0).toFixed(2)} GLD=$${(prices.gld?.price || 0).toFixed(2)}`);
  return result;
}

// Fallback: estimate CFD prices from SpotGamma data
function buildCFDPricesFallback(
  priceMap: Record<string, { price: number; lastClose: number }>,
  assets: AssetData[],
): CFDPriceData {
  const ndx = priceMap["NDX"] || { price: 0, lastClose: 0 };
  const diaAsset = assets.find(a => a.symbol === "DIA");
  const diaPrice = diaAsset?.currentPrice || priceMap["DIA"]?.price || 0;
  const diaClose = diaAsset?.previousClose || priceMap["DIA"]?.lastClose || 0;
  const goldFutures = priceMap["GOLD_FUTURES"] || { price: 0, lastClose: 0 };
  const gldAsset = assets.find(a => a.symbol === "GLD");
  const gldPrice = gldAsset?.currentPrice || 0;
  const gldClose = gldAsset?.previousClose || 0;
  
  const calcChange = (p: number, c: number) => ({ 
    price: p, prevClose: c, change: p - c, 
    changePct: c > 0 ? ((p - c) / c) * 100 : 0 
  });
  
  const vixAsset = assets.find(a => a.symbol === "VIX");
  const uvixAsset = assets.find(a => a.symbol === "UVIX");
  const uvxyAsset = assets.find(a => a.symbol === "UVXY");
  
  return {
    nas100: calcChange(ndx.price, ndx.lastClose),
    us30: calcChange(diaPrice * 100, diaClose * 100),
    xauusd: calcChange(
      goldFutures.price > 1000 ? goldFutures.price : gldPrice * 11,
      goldFutures.lastClose > 1000 ? goldFutures.lastClose : gldClose * 11
    ),
    uvix: calcChange(uvixAsset?.currentPrice || 0, uvixAsset?.previousClose || 0),
    uvxy: calcChange(uvxyAsset?.currentPrice || 0, uvxyAsset?.previousClose || 0),
    gld: calcChange(gldPrice, gldClose),
    vix: calcChange(vixAsset?.currentPrice || priceMap["VIX"]?.price || 0, vixAsset?.previousClose || priceMap["VIX"]?.lastClose || 0),
    lastUpdated: new Date().toISOString(),
  };
}

// ============ ECONOMIC CALENDAR ============

let cachedEconCalendar: EconCalendarEvent[] = [];
let econCalendarFetchedAt = 0;
const ECON_CALENDAR_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ForexFactory week URLs
const FF_THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FF_NEXT_WEEK = "https://nfs.faireconomy.media/ff_calendar_nextweek.json";

interface FFEvent {
  title: string;
  country: string;  // "USD", "EUR", etc.
  date: string;     // ISO 8601 with timezone e.g. "2026-03-19T14:00:00-04:00"
  impact: "High" | "Medium" | "Low" | "Holiday";
  forecast?: string;
  previous?: string;
}

async function fetchFF(url: string): Promise<FFEvent[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json()) as FFEvent[];
  } catch {
    return [];
  }
}

function ffToEconEvent(e: FFEvent): EconCalendarEvent {
  // Parse the ISO date string to extract date (ET) and time (ET)
  const dt = new Date(e.date);
  // Format date as YYYY-MM-DD in ET
  const dateStr = dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // Format time as HH:MM in ET
  const timeStr = dt.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    date:     dateStr,
    time:     timeStr,
    event:    e.title,
    country:  e.country === "USD" ? "US" : e.country,
    currency: e.country,
    impact:   e.impact,
  };
}

export async function fetchEconomicCalendar(): Promise<EconCalendarEvent[]> {
  const now = Date.now();
  if (cachedEconCalendar.length > 0 && now - econCalendarFetchedAt < ECON_CALENDAR_TTL_MS) {
    return cachedEconCalendar;
  }

  try {
    // Fetch this week and next week from ForexFactory (free, no key needed)
    const [thisWeek, nextWeek] = await Promise.all([fetchFF(FF_THIS_WEEK), fetchFF(FF_NEXT_WEEK)]);
    const allEvents = [...thisWeek, ...nextWeek];

    if (allEvents.length === 0) {
      console.log("[ECON-CAL] ForexFactory returned no events");
      return cachedEconCalendar;
    }

    // Filter: USD only, High or Medium impact
    const filtered = allEvents
      .filter(e => e.country === "USD" && (e.impact === "High" || e.impact === "Medium"))
      .map(ffToEconEvent);

    // Remove duplicates by date+event
    const seen = new Set<string>();
    const deduped = filtered.filter(e => {
      const key = `${e.date}_${e.event}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    cachedEconCalendar = deduped;
    econCalendarFetchedAt = now;
    console.log(`[ECON-CAL] Fetched ${deduped.length} USD events from ForexFactory (${allEvents.length} total)`);
    return deduped;
  } catch (err: any) {
    console.error("[ECON-CAL] Error:", err.message);
    return cachedEconCalendar;
  }
}

// ============ MAIN FETCH ============

export async function fetchAllMarketData(): Promise<MarketData> {
  console.log("[API] Starting market data fetch via API...");
  const date = getLastTradingDate();
  console.log(`[API] Using date: ${date}`);

  const assetsList: AssetData[] = [];

  // 0. Fetch HIRO first (fast endpoint, also provides prices)
  let hiro = await fetchHiro();
  
  // 1. Get prices from pollUpdate (with 15s timeout)
  const poll = await apiCall<PollUpdateResponse>(`/v1/me/pollUpdate?features=%7B%22futures%22%3A%7B%7D%7D`, 10000);
  const priceMap: Record<string, { price: number; lastClose: number }> = {};

  if (poll?.futuresSnapshot) {
    for (const f of poll.futuresSnapshot) {
      // Use lastPrice if available, otherwise fall back to lastClose (market closed)
      const livePrice = f.lastPrice > 0 ? f.lastPrice : f.lastClose;
      if (f.sym === "^SPX") priceMap["SPX"] = { price: livePrice, lastClose: f.lastClose };
      if (f.sym === "^VIX") priceMap["VIX"] = { price: livePrice, lastClose: f.lastClose };
      if (f.sym === "^NDX") priceMap["NDX"] = { price: livePrice, lastClose: f.lastClose };
      if (f.sym === "Gold") priceMap["GOLD_FUTURES"] = { price: livePrice, lastClose: f.lastClose };
    }
  }

  // Derive ETF prices from futures
  if (priceMap["SPX"]) {
    priceMap["SPY"] = { price: priceMap["SPX"].price / 10, lastClose: priceMap["SPX"].lastClose / 10 };
    priceMap["DIA"] = { price: priceMap["SPX"].price * 0.0706, lastClose: priceMap["SPX"].lastClose * 0.0706 };
  }
  if (priceMap["NDX"]) {
    priceMap["QQQ"] = { price: priceMap["NDX"].price / 41, lastClose: priceMap["NDX"].lastClose / 41 };
  }
  if (priceMap["GOLD_FUTURES"]) {
    priceMap["GLD"] = { price: priceMap["GOLD_FUTURES"].price / 10, lastClose: priceMap["GOLD_FUTURES"].lastClose / 10 };
  }

  // Reasonable price bounds per symbol to detect bogus HIRO values
  const PRICE_BOUNDS: Record<string, [number, number]> = {
    SPX: [1000, 20000], SPY: [100, 2000], QQQ: [50, 1000], GLD: [50, 800],
    VIX: [5, 150], DIA: [50, 800], UVIX: [1, 200], UVXY: [2, 500],
    IWM: [50, 500], NDX: [1000, 60000],
  };

  // HIRO currentDayPrice is used later (after TradingView) as primary SG live price source

  // Final pass: ensure all prices > 0 by using lastClose as fallback
  for (const [sym, p] of Object.entries(priceMap)) {
    if (p.price === 0 && p.lastClose > 0) {
      p.price = p.lastClose;
      console.log(`[API] Price ${sym}: using lastClose $${p.lastClose.toFixed(2)} as current (market closed)`);
    }
  }

  // 1.5. Fetch TradingView/Yahoo prices NOW (before chart data) so they override stale SpotGamma prices
  //      This ensures chart data extraction uses correct prices for distance calculations
  let earlyTVPrices: CFDPriceData | null = null;
  try {
    earlyTVPrices = await fetchCFDPricesFromTradingView();
    // Override priceMap with real TradingView ETF/index prices
    // SPX, SPY, QQQ, GLD, DIA, VIX come from SpotGamma directly (see step 2b below)
    // Only UVIX, UVXY, IWM are not in SpotGamma so they come from TradingView
    const tvOverrides: Array<{ key: keyof CFDPriceData; sym: string; minValid: number }> = [
      { key: "uvix", sym: "UVIX", minValid: 1   },
      { key: "uvxy", sym: "UVXY", minValid: 2   },
      { key: "iwm",  sym: "IWM",  minValid: 50  },
      // ETFs: TradingView como fallback cuando SpotGamma upx no llega.
      // step 2b (SG upx) corre después y sobreescribe si hay precio válido.
      { key: "spy",  sym: "SPY",  minValid: 100 },
      { key: "qqq",  sym: "QQQ",  minValid: 50  },
      { key: "gld",  sym: "GLD",  minValid: 50  },
      { key: "dia",  sym: "DIA",  minValid: 50  },
    ];
    for (const { key, sym, minValid } of tvOverrides) {
      const tv = earlyTVPrices[key] as { price: number; prevClose: number } | undefined;
      if (tv && tv.price > minValid) {
        const old = priceMap[sym]?.price || 0;
        priceMap[sym] = { price: tv.price, lastClose: tv.prevClose > 0 ? tv.prevClose : tv.price };
        if (Math.abs(old - tv.price) > 1) {
          console.log(`[PRICE-TV] ${sym}: $${old.toFixed(2)} → $${tv.price.toFixed(2)} (TradingView direct)`);
        }
      }
    }
  } catch (e: any) {
    console.log(`[PRICE-TV] Early TradingView fetch failed: ${e.message}`);
  }

  // Log all prices
  for (const [sym, p] of Object.entries(priceMap)) {
    if (ASSETS.includes(sym as any)) {
      console.log(`[API] Price ${sym}: $${(p.price || 0).toFixed(2)} (prev: $${(p.lastClose || 0).toFixed(2)})`);
    }
  }

  // 2. Fetch equities data for volume info (with 15s timeout)
  const equitiesData = await apiCall<EquitiesResponse>(`/v3/equitiesBySyms?syms=${ASSETS.join(",")}&date=${date}`, 10000);

  // 2b. SpotGamma HIRO currentDayPrice — primary live price source for SG-tracked assets.
  //     Runs AFTER TradingView so it takes priority (same feed SpotGamma dashboard uses).
  //     UVIX, UVXY, IWM are not tracked in HIRO so TradingView stays as their source.
  const SG_HIRO_ASSETS = ["SPX", "SPY", "QQQ", "GLD", "DIA", "VIX"];
  if (hiro?.perAsset) {
    for (const [sym, hiroAsset] of Object.entries(hiro.perAsset)) {
      if (!SG_HIRO_ASSETS.includes(sym)) continue;
      const hiroItem = hiroAsset as any;
      const hiroPrice = Number(hiroItem._rawPrice) || 0;
      const hiroLastClose = Number(hiroItem._rawLastClose) || 0;
      const bounds = PRICE_BOUNDS[sym];
      const isValidPrice = (p: number) => p > 0 && (!bounds || (p >= bounds[0] && p <= bounds[1]));

      if (isValidPrice(hiroPrice)) {
        const old = priceMap[sym]?.price || 0;
        const prevClose = hiroLastClose > 0 ? hiroLastClose : (priceMap[sym]?.lastClose || hiroPrice);
        priceMap[sym] = { price: hiroPrice, lastClose: prevClose };
        if (Math.abs(old - hiroPrice) > 0.5) {
          console.log(`[PRICE-SG] ${sym}: $${old.toFixed(2)} → $${hiroPrice.toFixed(2)} (HIRO live)`);
        }
      } else if (hiroPrice > 0) {
        console.log(`[API] HIRO price for ${sym} rejected (out of bounds): $${hiroPrice.toFixed(2)}`);
      } else if (isValidPrice(hiroLastClose) && (!priceMap[sym] || priceMap[sym].price === 0)) {
        priceMap[sym] = { price: hiroLastClose, lastClose: hiroLastClose };
        console.log(`[API] Price for ${sym} from HIRO (lastClose fallback): $${hiroLastClose.toFixed(2)}`);
      }
    }
  }

  // 2c. Use SpotGamma's own upx price ONLY as fallback when no live price is available.
  //     upx = previous day's settlement price used for GEX calculations — NOT real-time.
  //     During market hours TradingView prices are always more accurate.
  const SG_PRICE_ASSETS = ["SPX", "SPY", "QQQ", "GLD", "DIA", "VIX"] as const;
  for (const sym of SG_PRICE_ASSETS) {
    const eq = equitiesData?.[sym];
    if (eq?.upx && eq.upx > 0) {
      const existing = priceMap[sym]?.price || 0;
      if (existing === 0) {
        // No TradingView price available — use upx as fallback
        const prevClose = priceMap[sym]?.lastClose || eq.upx;
        priceMap[sym] = { price: eq.upx, lastClose: prevClose };
        console.log(`[PRICE-SG] ${sym}: fallback to SpotGamma upx $${eq.upx.toFixed(2)} (no TV price)`);
      } else {
        // TradingView price exists — use upx only as prevClose reference
        const prevClose = priceMap[sym]?.lastClose || eq.upx;
        if (prevClose === 0 || prevClose === existing) {
          priceMap[sym] = { price: existing, lastClose: eq.upx };
        }
      }
    }
  }

  // 2c. Update prevClose cache so fast live prices endpoint can calculate change%
  updateSGPrevCloseCache(priceMap);

  // 3. Fetch chart data for each asset (with 20s timeout per asset)
  for (const symbol of ASSETS) {
    try {
      console.log(`[API] Fetching chart data for ${symbol}...`);
      const chartData = await apiCall<ChartDataResponse>(`/synth_oi/v1/chart_data?sym=${symbol}&date=${date}`, 10000);
      const prices = priceMap[symbol] || { price: 0, lastClose: 0 };

      if (chartData && chartData.curves?.cust?.gamma?.all) {
        const asset = extractAssetFromChartData(chartData, prices.price, prices.lastClose, symbol);

        // Enrich with equities volume data
        const eq = equitiesData?.[symbol];
        if (eq && asset.flowData) {
          asset.flowData.callVolume = eq.callsum || 0;
          asset.flowData.putVolume = eq.putsum || 0;
          asset.flowData.putCallRatioVolume = eq.callsum > 0 ? eq.putsum / eq.callsum : 0;
          asset.callVolume = eq.callsum || 0;
          asset.putVolume = eq.putsum || 0;
        }

        assetsList.push(asset);
        const outlierCount = asset.outlierStrikes?.length || 0;
        const flowDir = asset.flowData?.flowDirection || "N/A";
        console.log(`[API] ${symbol}: price=$${(prices.price || 0).toFixed(2)}, bars=${asset.chartData.length}, topStrikes=${asset.topStrikes.length}, outliers=${outlierCount}, flow=${flowDir}`);
      } else {
        console.log(`[API] ${symbol}: No chart data, creating minimal asset`);
        assetsList.push(createMinimalAsset(symbol, prices.price, prices.lastClose));
      }
    } catch (e) {
      console.error(`[API] Error fetching ${symbol}:`, e);
      const prices = priceMap[symbol] || { price: 0, lastClose: 0 };
      assetsList.push(createMinimalAsset(symbol, prices.price, prices.lastClose));
    }
  }

  // 3b. Analyze GEX
  const spxAsset = assetsList.find(a => a.symbol === "SPX");
  const vixAsset = assetsList.find(a => a.symbol === "VIX") || null;
  const gex = spxAsset ? analyzeGex(spxAsset) : null;

  // 4. Use HIRO from step 0, or fallback
  if (!hiro && spxAsset) {
    console.log("[API] Using fallback HIRO analysis");
    hiro = analyzeHiroFallback(spxAsset, vixAsset);
  }

  // 5. VIX-SPX Correlation
  const vixSpxCorrelation = spxAsset ? analyzeVixSpxCorrelation(spxAsset, vixAsset) : null;

  // 7. Pre-market summary (always available now)
  let preMarketSummary: any = null;
  try {
    preMarketSummary = generatePreMarketSummary(assetsList, gex);
  } catch (e: any) {
    console.log(`[API] Error generating pre-market summary: ${e.message}`);
    preMarketSummary = { generatedAt: new Date().toISOString(), marketBias: 'neutral', keyLevels: [], expectedRange: { high: 0, low: 0 }, outlierZones: [], summary: 'Datos insuficientes para generar resumen.' };
  }

  // 8. Economic calendar (US high-impact events, next 7 days) — non-blocking
  let economicCalendar: EconCalendarEvent[] = [];
  try {
    economicCalendar = await fetchEconomicCalendar();
  } catch (e: any) {
    console.log(`[ECON-CAL] Skipped: ${e.message}`);
  }

  // 7b. Fetch TRACE 0DTE GEX data (before trade setups so it can be used as confirmation)
  const spxPrice = spxAsset?.currentPrice || priceMap["SPX"]?.price || 0;
  const traceData = await fetchTraceData(spxPrice);

  // 7c. Fetch real-time Flow Data from SpotGamma Tape
  const tape = await fetchFlowData();

  // 7d. Fetch Volatility Context (IV per asset, term structure, skew)
  const volContext = await fetchVolContext(assetsList);

  // 8. Build Official SpotGamma Levels from equities API
  const officialLevels: Record<string, OfficialSGLevels> = {};
  const SG_LEVEL_ASSETS = ["SPX", "SPY", "QQQ", "GLD", "DIA"];
  
  // Known Vol Trigger values from SG Levels page (SPX is primary)
  const VOL_TRIGGER_MAP: Record<string, number> = { SPX: 6800, SPY: 675, QQQ: 601, DIA: 0, GLD: 0 };
  
  for (const sym of SG_LEVEL_ASSETS) {
    const eq = equitiesData?.[sym];
    const asset = assetsList.find(a => a.symbol === sym);
    if (!eq || !asset) continue;
    
    const price = asset.currentPrice || eq.upx || 0;
    const impliedMove = eq.options_implied_move || 0;
    const impliedMovePct = price > 0 ? (impliedMove / price) * 100 : 0;
    const zeroGamma = asset.gammaFlipLevel || 0;
    const volTrigger = VOL_TRIGGER_MAP[sym] || eq.maxfs || 0;
    
    // Determine gamma regime
    let gammaRegime: OfficialSGLevels["gammaRegime"] = "neutral";
    let regimeDescription = "";
    if (price > 0 && volTrigger > 0) {
      if (price > volTrigger) {
        gammaRegime = "positive";
        regimeDescription = `${sym} ($${price.toFixed(0)}) SOBRE Vol Trigger ($${volTrigger}). Gamma POSITIVO = mean reversion. Dealers frenan movimientos.`;
      } else if (price > zeroGamma && zeroGamma > 0) {
        gammaRegime = "negative";
        regimeDescription = `${sym} ($${price.toFixed(0)}) BAJO Vol Trigger ($${volTrigger}) pero SOBRE Zero Gamma ($${zeroGamma.toFixed(0)}). Gamma NEGATIVO = trending.`;
      } else if (zeroGamma > 0) {
        gammaRegime = "very_negative";
        regimeDescription = `${sym} ($${price.toFixed(0)}) BAJO Zero Gamma ($${zeroGamma.toFixed(0)}). Gamma MUY NEGATIVO = alta volatilidad esperada.`;
      } else {
        gammaRegime = price > volTrigger ? "positive" : "negative";
        regimeDescription = `${sym} ($${price.toFixed(0)}) ${price > volTrigger ? "SOBRE" : "BAJO"} Vol Trigger ($${volTrigger}).`;
      }
    }
    
    const atmIV30 = eq.atm_iv30 || 0;
    const rv30 = eq.rv30 || 0;
    
    officialLevels[sym] = {
      symbol: sym,
      callWall: eq.cws || 0,
      putWall: eq.pws || 0,
      keyGamma: eq.keyg || 0,
      maxGamma: eq.maxfs || 0,
      keyDelta: eq.keyd || 0,
      volTrigger,
      zeroGamma,
      putControl: eq.putctrl || 0,
      impliedMove,
      impliedMovePct,
      prevCallWall: eq.prev_cws || 0,
      prevPutWall: eq.prev_pws || 0,
      prevKeyGamma: eq.prev_keyg || 0,
      prevMaxGamma: eq.prev_maxfs || 0,
      levelsChanged: (eq.cws !== eq.prev_cws) || (eq.pws !== eq.prev_pws) || (eq.keyg !== eq.prev_keyg) || (eq.maxfs !== eq.prev_maxfs),
      atmIV30,
      rv30,
      vrp: atmIV30 - rv30,
      fwdGarch: eq.fwd_garch || 0,
      neSkew: eq.ne_skew || 0,
      skew: eq.skew || 0,
      callSkew: eq.cskew || 0,
      putSkew: eq.pskew || 0,
      d25: eq.d25 || 0,
      d95: eq.d95 || 0,
      d25ne: eq.d25ne || 0,
      totalDelta: eq.totaldelta || 0,
      activityFactor: eq.activity_factor || 0,
      positionFactor: eq.position_factor || 0,
      gammaRatio: eq.gamma_ratio || 0,
      deltaRatio: eq.delta_ratio || 0,
      putCallRatio: eq.put_call_ratio || 0,
      volumeRatio: eq.volume_ratio || 0,
      gammaRegime,
      regimeDescription,
    };
    
    console.log(`[SG-LEVELS] ${sym}: CW=$${eq.cws || 0} PW=$${eq.pws || 0} KeyG=$${eq.keyg || 0} MaxG=$${eq.maxfs || 0} IM=${(impliedMove || 0).toFixed(1)} Regime=${gammaRegime}`);

    // Estimate ivRank from atm_iv30 using historical 52-week low/high per asset
    // Ranges: (low_iv, high_iv) based on historical norms
    if (atmIV30 > 0 && asset) {
      const IV_RANGES: Record<string, [number, number]> = {
        SPX: [11, 40], SPY: [11, 40], QQQ: [13, 45],
        GLD: [8, 32], DIA: [11, 35], VIX: [15, 80], UVIX: [50, 200],
      };
      const [ivLow, ivHigh] = IV_RANGES[sym] || [10, 40];
      const ivPct = atmIV30 * 100; // atm_iv30 is in decimal (0.21 = 21%)
      const estimatedRank = Math.round(Math.max(0, Math.min(100, (ivPct - ivLow) / (ivHigh - ivLow) * 100)));
      asset.ivRank = estimatedRank;
      console.log(`[IV-RANK] ${sym}: atm_iv30=${(ivPct).toFixed(1)}% → ivRank=${estimatedRank}%`);
    }
  }

  // 6. Smart entry signals (placed here after traceData and officialLevels are ready)
  const entrySignals = generateSmartEntrySignals(assetsList, gex, hiro, vixSpxCorrelation, traceData, officialLevels);

  // 9. Use CFD prices already fetched in step 1.5 (reuse to avoid double fetch)
  let cfdPrices: CFDPriceData;
  if (earlyTVPrices && (earlyTVPrices.nas100.price > 0 || earlyTVPrices.us30.price > 0)) {
    cfdPrices = earlyTVPrices;
  } else {
    try {
      cfdPrices = await fetchCFDPricesFromTradingView();
      if (cfdPrices.nas100.price === 0 && cfdPrices.us30.price === 0) {
        cfdPrices = buildCFDPricesFallback(priceMap, assetsList);
      }
    } catch (e) {
      cfdPrices = buildCFDPricesFallback(priceMap, assetsList);
    }
  }

  // 9b. Reconcile asset prices with TradingView — fix any remaining discrepancies after chart data extraction
  //     These assets may still have wrong prices if SpotGamma chart_data returned them with bad values
  // SPX, SPY, QQQ, GLD, DIA, VIX come from SpotGamma upx (step 2b)
  // Only UVIX, UVXY, IWM need TradingView reconciliation
  const assetTVFixes: Array<{ key: keyof CFDPriceData; sym: string }> = [
    { key: "uvix", sym: "UVIX" },
    { key: "uvxy", sym: "UVXY" },
    { key: "iwm",  sym: "IWM"  },
  ];
  for (const { key, sym } of assetTVFixes) {
    const tv = cfdPrices[key] as { price: number; prevClose: number; change: number; changePct: number } | undefined;
    if (!tv || tv.price <= 0) continue;
    const asset = assetsList.find(a => a.symbol === sym);
    if (!asset) continue;
    // Override if TradingView price differs by more than 1% from what chart_data gave us
    const diff = asset.currentPrice > 0 ? Math.abs(tv.price - asset.currentPrice) / asset.currentPrice : 1;
    if (asset.currentPrice === 0 || diff > 0.01) {
      console.log(`[PRICE-FIX] ${sym}: $${asset.currentPrice.toFixed(2)} → $${tv.price.toFixed(2)} (TradingView reconcile)`);
      asset.currentPrice = tv.price;
      asset.previousClose = tv.prevClose > 0 ? tv.prevClose : asset.previousClose;
      asset.dailyChange = asset.currentPrice - asset.previousClose;
      asset.dailyChangePct = asset.previousClose > 0 ? (asset.dailyChange / asset.previousClose) * 100 : 0;
    }
  }

  // 10. Build Vanna Context (uses CFD prices for UVIX/UVXY/GLD)
  let vannaContext: VannaContext | null = null;
  try {
    vannaContext = buildVannaContext(assetsList, hiro, equitiesData, cfdPrices);
  } catch (e: any) {
    console.log(`[VANNA] Error building vanna context: ${e.message}`);
  }

  // 10b. GEX for GLD and DIA — Tradier if key available, otherwise Yahoo Finance (Black-Scholes)
  const tradierGex: Record<string, TradierGexData> = {};
  const gldAssetForGex = assetsList.find(a => a.symbol === "GLD");
  const diaAssetForGex = assetsList.find(a => a.symbol === "DIA");

  // Build GEX from SpotGamma chart data (already fetched above — no external API needed)
  // Uses bars.cust.gamma.all.calls/puts which SpotGamma already provides per strike for GLD/DIA
  const buildGexFromAsset = (asset: AssetData): TradierGexData | null => {
    if (!asset.chartData || asset.chartData.length === 0) return null;
    const underlyingPrice = asset.currentPrice;
    const todayStr = new Date().toISOString().split("T")[0];

    // Use next_exp (0DTE/weekly) gamma when available, fall back to all-expiry gamma
    const gexByStrike = asset.chartData.map(bar => {
      // callGamma / putGamma in SpotGamma are already notional GEX values (gamma×OI×price)
      const callGex = bar.callGamma || 0;
      // puts are negative GEX — SpotGamma may return positive notional, negate it
      const putGex = bar.putGamma < 0 ? bar.putGamma : -(bar.putGamma || 0);
      return { strike: bar.strike, callGex, putGex, netGex: callGex + putGex };
    }).filter(b => b.strike > 0).sort((a, b) => a.strike - b.strike);

    if (gexByStrike.length === 0) return null;

    const totalGex = gexByStrike.reduce((sum, b) => sum + b.netGex, 0);
    const netBias: TradierGexData["netBias"] =
      totalGex > 5e6 ? "bullish" : totalGex < -5e6 ? "bearish" : "neutral";

    // Gamma flip: where cumulative GEX crosses zero from negative to positive
    let gammaFlipLevel = underlyingPrice;
    let cumGex = 0;
    for (const bar of gexByStrike) {
      const prev = cumGex;
      cumGex += bar.netGex;
      if (prev < 0 && cumGex >= 0) { gammaFlipLevel = bar.strike; break; }
    }

    // Top support/resistance within 5% of price
    const nearby = gexByStrike.filter(s => Math.abs(s.strike - underlyingPrice) / underlyingPrice < 0.05);
    const topSupport = nearby.filter(s => s.netGex > 0)
      .sort((a, b) => b.netGex - a.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));
    const topResistance = nearby.filter(s => s.netGex < 0)
      .sort((a, b) => a.netGex - b.netGex).slice(0, 5)
      .map(s => ({ strike: s.strike, netGex: s.netGex, pctFromPrice: (s.strike - underlyingPrice) / underlyingPrice * 100 }));

    // SpotGamma data is already for nearest expiry (next_exp = 0DTE/weekly)
    // Check if today is a Friday (options expiry day for weekly ETF options)
    const is0DTE = new Date().getDay() === 5; // Friday = weekly expiry = 0DTE

    return {
      symbol: asset.symbol,
      underlyingPrice,
      totalGex,
      gammaFlipLevel,
      netBias,
      topSupport,
      topResistance,
      gexByStrike,
      expiration: todayStr, // SpotGamma data is always for today's session
      is0DTE,
      lastUpdated: new Date().toISOString(),
    };
  };

  const fetchGexForSymbol = async (sym: string, price: number): Promise<TradierGexData | null> => {
    if (TRADIER_API_KEY) return fetchTradierGEX(sym, price);
    // Primary: build from SpotGamma chart data (already fetched, no extra API call)
    const asset = assetsList.find(a => a.symbol === sym);
    if (asset && asset.chartData.length > 0) {
      const built = buildGexFromAsset(asset);
      if (built) {
        console.log(`[SG-GEX] ${sym} GEX: total=${(built.totalGex/1e6).toFixed(1)}M bias=${built.netBias} flip=$${built.gammaFlipLevel}${built.is0DTE ? " ★0DTE" : " (weekly)"} (SpotGamma)`);
        return built;
      }
    }
    // Fallback: Yahoo Finance + Black-Scholes (if SpotGamma data unavailable)
    return fetchYahooGEX(sym, price);
  };

  const [gldGexResult, diaGexResult] = await Promise.allSettled([
    gldAssetForGex?.currentPrice ? fetchGexForSymbol("GLD", gldAssetForGex.currentPrice) : Promise.resolve(null),
    diaAssetForGex?.currentPrice ? fetchGexForSymbol("DIA", diaAssetForGex.currentPrice) : Promise.resolve(null),
  ]);
  if (gldGexResult.status === "fulfilled" && gldGexResult.value) tradierGex["GLD"] = gldGexResult.value;
  if (diaGexResult.status === "fulfilled" && diaGexResult.value) tradierGex["DIA"] = diaGexResult.value;
  const gexSrc = TRADIER_API_KEY ? "Tradier" : "SpotGamma";
  console.log(`[GEX-EXT] GLD=${tradierGex["GLD"] ? `${(tradierGex["GLD"].totalGex/1e6).toFixed(1)}M` : "N/A"} DIA=${tradierGex["DIA"] ? `${(tradierGex["DIA"].totalGex/1e6).toFixed(1)}M` : "N/A"} via ${gexSrc}`);

  // 11. Build GEX Change Tracker BEFORE trade setup generation so it can be used as a feature
  let gexChangeTrackerPre: GexChangeTracker | null = null;
  try {
    gexChangeTrackerPre = buildGexChangeTracker(traceData, gex);
  } catch (e: any) {
    console.log(`[GEX-TRACKER-PRE] Error: ${e.message}`);
  }

  // 12. Generate trade setups (v3 trading engine) - 94-feature PPO
  // Refresh candle cache async before setup generation (fire-and-forget)
  refreshCandleSignals();
  const uvxyAsset = assetsList.find(a => a.symbol === "UVIX") || null;
  let tradeSetups: TradeSetup[] = [];
  try {
    tradeSetups = generateTradeSetups(assetsList, gex, hiro, tape, vixAsset, uvxyAsset, traceData, officialLevels, vannaContext, cfdPrices, tradierGex, volContext, gexChangeTrackerPre);
    console.log(`[TRADES] Generated ${tradeSetups.length} trade setups`);
  } catch (e: any) {
    console.log(`[TRADES] Error generating trade setups: ${e.message}`);
  }

  // Track ALL setups for analytics (not just ENTRADA ones)
  try {
    resolveSetupOutcomes(cfdPrices);
    trackSetups(tradeSetups, cfdPrices);
  } catch (e: any) {
    console.log(`[TRACKER] Error: ${e.message}`);
  }

  // 12. Build legacy SpotGamma levels map (backward compat)
  const spotgammaLevels: Record<string, any> = {};
  for (const [sym, levels] of Object.entries(officialLevels)) {
    spotgammaLevels[sym] = {
      callWall: levels.callWall, putWall: levels.putWall, zeroGamma: levels.zeroGamma,
      volTrigger: levels.volTrigger, keyGamma: levels.keyGamma, maxGamma: levels.maxGamma,
      keyDelta: levels.keyDelta, impliedMove: levels.impliedMove,
      largeGamma1: assetsList.find(a => a.symbol === sym)?.topStrikes[0]?.strike || 0,
      largeGamma2: assetsList.find(a => a.symbol === sym)?.topStrikes[1]?.strike || 0,
      largeGamma3: assetsList.find(a => a.symbol === sym)?.topStrikes[2]?.strike || 0,
    };
  }

  // 14. Reuse the pre-built GEX Change Tracker (built before trade setup generation)
  const gexChangeTracker: GexChangeTracker | null = gexChangeTrackerPre;

  const { status, isOpen } = getMarketStatus();

  const marketData: MarketData = {
    assets: assetsList,
    tradierGex,
    gex, hiro, tape, flow: spxAsset?.flowData || null, traceData, volContext,
    entrySignals, tradeSetups, spotgammaLevels,
    officialLevels, vannaContext, cfdPrices,
    gexChangeTracker,
    vixSpxCorrelation, preMarketSummary, economicCalendar,
    sessionDate: getSessionDate(),
    fetchedAt: new Date().toISOString(),
    isMarketOpen: isOpen,
    marketStatus: status,
  };

  cachedData = marketData;
  console.log(`[API] Fetch complete. ${assetsList.length} assets loaded.`);
  return marketData;
}

function createMinimalAsset(symbol: string, price: number, previousClose: number): AssetData {
  const change = price - previousClose;
  const changePct = previousClose > 0 ? (change / previousClose) * 100 : 0;
  return {
    symbol, currentPrice: price, previousClose, dailyChange: change, dailyChangePct: changePct,
    callGamma: 0, putGamma: 0, totalGamma: 0, putCallRatio: 0, ivRank: 0, impliedMove: 0,
    highVolPoint: 0, lowVolPoint: 0, callVolume: 0, putVolume: 0,
    oneMonthIV: 0, oneMonthRV: 0, garchRank: 0, skewRank: 0,
    topGammaExp: "", topDeltaExp: "",
    topStrikes: [], strikes: [], chartData: [],
    gammaFlipLevel: 0, zeroDteGamma: 0,
    outlierStrikes: [],
    flowData: null,
    lastUpdated: new Date().toISOString(),
  };
}

// ============ TRACE 0DTE GEX FETCHER ============

async function fetchTraceData(spxPrice: number): Promise<TraceData | null> {
  // Try today first — SpotGamma publishes pre-market. Fall back to last trading day.
  const todayDate = getSessionDate();
  const fallbackDate = getLastTradingDate();
  const datesToTry = todayDate !== fallbackDate ? [todayDate, fallbackDate] : [todayDate];

  let chartData: ChartDataResponse | null = null;
  let date = todayDate;
  for (const d of datesToTry) {
    const result = await apiCall<ChartDataResponse>(`/synth_oi/v1/chart_data?sym=SPX&date=${d}`, 10000);
    if (result?.bars?.cust?.gamma?.next_exp) {
      chartData = result;
      date = d;
      break;
    }
    console.log(`[TRACE] No 0DTE data for ${d}, trying ${datesToTry[datesToTry.indexOf(d) + 1] ?? "nothing"}...`);
  }
  console.log(`[TRACE] Fetching 0DTE GEX data for SPX date=${date}...`);

  try {
    if (!chartData?.bars?.cust?.gamma?.next_exp) {
      console.log("[TRACE] No 0DTE GEX data available for any date");
      return null;
    }

    const strikes = chartData.bars.strikes || [];
    const price = spxPrice || 0;
    const nearRange = 300; // Show strikes within $300 of price for SPX

    // Extract 0DTE GEX bars (next_exp)
    const nextExpPuts = chartData.bars.cust.gamma.next_exp.puts || [];
    const nextExpCalls = chartData.bars.cust.gamma.next_exp.calls || [];

    // Extract all-exp GEX bars
    const allPuts = chartData.bars.cust.gamma.all.puts || [];
    const allCalls = chartData.bars.cust.gamma.all.calls || [];

    const buildGexBars = (puts: number[], calls: number[], filterNear: boolean): TraceGexBar[] => {
      const bars: TraceGexBar[] = [];
      for (let i = 0; i < strikes.length; i++) {
        const strike = strikes[i];
        const putGex = puts[i] || 0;
        const callGex = calls[i] || 0;
        const netGex = putGex + callGex;
        if (netGex === 0) continue;
        if (filterNear && Math.abs(strike - price) > nearRange) continue;

        const pctFromPrice = price > 0 ? ((strike - price) / price) * 100 : 0;
        bars.push({
          strike,
          netGex,
          putGex,
          callGex,
          magnitude: Math.abs(netGex),
          direction: netGex > 0 ? "support" : netGex < 0 ? "resistance" : "neutral",
          pctFromPrice,
        });
      }
      return bars.sort((a, b) => a.strike - b.strike);
    }

    const zeroDteGex = buildGexBars(nextExpPuts, nextExpCalls, true);
    const allExpGex = buildGexBars(allPuts, allCalls, true);

    // Top support (positive GEX = dealers long gamma = buy dips)
    const topSupport = [...zeroDteGex]
      .filter(b => b.netGex > 0)
      .sort((a, b) => b.netGex - a.netGex)
      .slice(0, 5);

    // Top resistance (negative GEX = dealers short gamma = sell rallies)
    const topResistance = [...zeroDteGex]
      .filter(b => b.netGex < 0)
      .sort((a, b) => a.netGex - b.netGex)
      .slice(0, 5);

    // Max GEX strike
    const maxBar = [...zeroDteGex].sort((a, b) => b.magnitude - a.magnitude)[0];
    const maxGexStrike = maxBar?.strike || 0;

    // Net bias
    const totalPositive = zeroDteGex.filter(b => b.netGex > 0).reduce((s, b) => s + b.netGex, 0);
    const totalNegative = zeroDteGex.filter(b => b.netGex < 0).reduce((s, b) => s + b.netGex, 0);
    const absNeg = Math.abs(totalNegative);
    const gexRatio = absNeg > 0 ? totalPositive / absNeg : totalPositive > 0 ? 999 : 0;
    let netGexBias: "bullish" | "bearish" | "neutral" = "neutral";
    if (gexRatio > 1.3) netGexBias = "bullish";
    else if (gexRatio < 0.7) netGexBias = "bearish";

    // Gamma curve (for profile display)
    const spotPrices = chartData.curves?.spot_prices || [];
    const curveGammaAll = chartData.curves?.cust?.gamma?.all || [];
    const curveGamma0DTE = chartData.curves?.cust?.gamma?.next_exp || [];
    const curveGammaMonthly = chartData.curves?.cust?.gamma?.monthly || [];

    const gammaCurve: { price: number; gammaAll: number; gamma0DTE: number; gammaMonthly: number }[] = [];
    const pricesArr = Array.isArray(spotPrices) ? spotPrices : Object.values(spotPrices);
    for (let i = 0; i < pricesArr.length; i++) {
      const p = Number(pricesArr[i]);
      if (Math.abs(p - price) > nearRange) continue;
      gammaCurve.push({
        price: p,
        gammaAll: curveGammaAll[i] || 0,
        gamma0DTE: curveGamma0DTE[i] || 0,
        gammaMonthly: curveGammaMonthly[i] || 0,
      });
    }

    // Key levels from the gamma curve
    let gammaFlip = price;
    for (let i = 1; i < pricesArr.length; i++) {
      const p = Number(pricesArr[i]);
      if (curveGammaAll[i - 1] < 0 && curveGammaAll[i] >= 0) {
        gammaFlip = p;
        break;
      }
    }

    // Hedge wall = highest positive gamma above price
    let hedgeWall = 0;
    let hedgeWallGamma = 0;
    for (const bar of zeroDteGex) {
      if (bar.strike > price && bar.netGex > hedgeWallGamma) {
        hedgeWall = bar.strike;
        hedgeWallGamma = bar.netGex;
      }
    }

    // Put wall = highest positive gamma below price
    let putWall = 0;
    let putWallGamma = 0;
    for (const bar of zeroDteGex) {
      if (bar.strike < price && bar.netGex > putWallGamma) {
        putWall = bar.strike;
        putWallGamma = bar.netGex;
      }
    }

    const traceData: TraceData = {
      symbol: "SPX",
      date,
      currentPrice: price,
      zeroDteGex,
      allExpGex,
      topSupport,
      topResistance,
      maxGexStrike,
      netGexBias,
      totalPositiveGex: totalPositive,
      totalNegativeGex: totalNegative,
      gexRatio,
      gammaCurve,
      hedgeWall,
      putWall,
      gammaFlip,
      lastUpdated: new Date().toISOString(),
    };

    console.log(`[TRACE] 0DTE GEX: ${zeroDteGex.length} bars, bias=${netGexBias}, ratio=${gexRatio.toFixed(2)}, top support=${topSupport[0]?.strike || 'N/A'} (+${(topSupport[0]?.netGex || 0) / 1e6}M), top resistance=${topResistance[0]?.strike || 'N/A'} (${(topResistance[0]?.netGex || 0) / 1e6}M)`);
    return traceData;
  } catch (e: any) {
    console.error("[TRACE] Error fetching trace data:", e.message || e);
    return null;
  }
}

// Export for separate polling
// ============ FLOW DATA FETCHER (SpotGamma Tape/Flow API) ============

export async function streamApiCall<T>(endpoint: string, timeoutMs: number = 15000, binary: boolean = false): Promise<T | null> {
  const token = await getToken();
  if (!token) { console.error("[FLOW] No token available"); return null; }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${STREAM_API_BASE}${endpoint}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": binary ? "application/octet-stream" : "application/json",
        "Origin": "https://dashboard.spotgamma.com",
        "Referer": "https://dashboard.spotgamma.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.error(`[FLOW] ${endpoint} returned ${resp.status}`);
      return null;
    }
    if (binary) {
      const buf = await resp.arrayBuffer();
      return msgpackDecode(new Uint8Array(buf)) as T;
    }
    return await resp.json() as T;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      console.error(`[FLOW] ${endpoint} timed out after ${timeoutMs}ms`);
    } else {
      console.error(`[FLOW] Error calling ${endpoint}:`, e.message || e);
    }
    return null;
  }
}

export function parseTapeFlowItem(item: any[]): TapeFlow | null {
  try {
    // Field mapping from SpotGamma tns_feed MessagePack response:
    // [0] underlying, [1] ts, [2] delta, [3] gamma, [4] vega, [5] stock_price,
    // [6] tnsIndex, [7] expiry, [8] strike, [9] size, [10] daily_vol_cumsum,
    // [11] trade_side, [12] price, [13] bid, [14] ask, [15] ivol,
    // [16] prev_oi, [17] flags, [18] ?, [19] premium
    const flags = Number(item[17]) || 0;
    const isPut = (flags & 1) === 1;
    const delta = Number(item[2]) || 0;
    const premium = Number(item[19]) || 0;
    const ts = new Date(Number(item[1]));
    const expiry = new Date(Number(item[7]));
    
    // Determine signal: positive delta = bullish, negative = bearish
    let signal: "bullish" | "bearish" | "neutral" = "neutral";
    if (delta > 0) signal = "bullish";
    else if (delta < 0) signal = "bearish";
    
    // Determine side
    const sideCode = String(item[11]);
    const price = Number(item[12]) || 0;
    const bid = Number(item[13]) || 0;
    const ask = Number(item[14]) || 0;
    let buySell = "UNKNOWN";
    if (price >= ask) buySell = "BUY";
    else if (price <= bid) buySell = "SELL";
    else buySell = price > (bid + ask) / 2 ? "BUY" : "SELL";
    
    const side = sideCode === "v" ? "ASK" : sideCode === "b" ? "BID" : sideCode === "m" ? "MID" : sideCode;
    
    const formatPremium = (p: number) => {
      if (Math.abs(p) >= 1e6) return `$${(p / 1e6).toFixed(1)}M`;
      if (Math.abs(p) >= 1e3) return `$${(p / 1e3).toFixed(1)}K`;
      return `$${p.toFixed(0)}`;
    };
    
    return {
      time: ts.toISOString(),
      premium,
      premiumFormatted: formatPremium(premium),
      symbol: String(item[0]),
      side,
      buySell,
      callPut: isPut ? "PUT" : "CALL",
      strike: Number(item[8]) || 0,
      expiration: expiry.toISOString().split("T")[0],
      spot: Number(item[5]) || 0,
      delta,
      gamma: Number(item[3]) || 0,
      vega: Number(item[4]) || 0,
      ivol: Number(item[15]) || 0,
      size: Number(item[9]) || 0,
      prevOi: Number(item[16]) || 0,
      signal,
    };
  } catch (e) {
    return null;
  }
}

function analyzeAssetFlow(symbol: string, trades: TapeFlow[]): TapeAssetSummary {
  let callCount = 0, putCount = 0;
  let callPremium = 0, putPremium = 0;
  let netDelta = 0, netGamma = 0;
  
  // Strike-level aggregation
  const strikeMap = new Map<number, { callPremium: number; putPremium: number; netDelta: number; totalSize: number }>();
  
  for (const t of trades) {
    if (t.callPut === "CALL") {
      callCount++;
      callPremium += t.premium;
    } else {
      putCount++;
      putPremium += t.premium;
    }
    netDelta += t.delta;
    netGamma += t.gamma;
    
    // Aggregate by strike
    const existing = strikeMap.get(t.strike) || { callPremium: 0, putPremium: 0, netDelta: 0, totalSize: 0 };
    if (t.callPut === "CALL") existing.callPremium += t.premium;
    else existing.putPremium += t.premium;
    existing.netDelta += t.delta;
    existing.totalSize += t.size;
    strikeMap.set(t.strike, existing);
  }
  
  const totalPremium = callPremium + putPremium;
  const putCallRatio = callCount > 0 ? putCount / callCount : 0;
  
  // Determine dominant flow and sentiment
  let dominantFlow: "calls" | "puts" | "neutral" = "neutral";
  let sentiment: "bullish" | "bearish" | "neutral" = "neutral";
  let sentimentScore = 0;
  
  if (callPremium > putPremium * 1.3) {
    dominantFlow = "calls";
    sentiment = "bullish";
    sentimentScore = Math.min(100, Math.round((callPremium / (putPremium || 1) - 1) * 50));
  } else if (putPremium > callPremium * 1.3) {
    dominantFlow = "puts";
    sentiment = "bearish";
    sentimentScore = -Math.min(100, Math.round((putPremium / (callPremium || 1) - 1) * 50));
  }
  
  // Also use net delta as a sentiment indicator
  if (netDelta > 0 && sentiment !== "bearish") {
    sentiment = "bullish";
    sentimentScore = Math.max(sentimentScore, Math.min(100, Math.round(netDelta / 1e6)));
  } else if (netDelta < 0 && sentiment !== "bullish") {
    sentiment = "bearish";
    sentimentScore = Math.min(sentimentScore, -Math.min(100, Math.round(Math.abs(netDelta) / 1e6)));
  }
  
  // Top strikes by premium
  const strikeFlow = Array.from(strikeMap.entries())
    .map(([strike, data]) => ({
      strike,
      callPremium: data.callPremium,
      putPremium: data.putPremium,
      netDelta: data.netDelta,
      totalSize: data.totalSize,
      direction: (data.netDelta > 0 ? "bullish" : data.netDelta < 0 ? "bearish" : "neutral") as "bullish" | "bearish" | "neutral",
    }))
    .sort((a, b) => (b.callPremium + b.putPremium) - (a.callPremium + a.putPremium))
    .slice(0, 15);
  
  // Largest trades by premium
  const largestTrades = [...trades].sort((a, b) => b.premium - a.premium).slice(0, 5);
  const recentTrades = trades.slice(0, 10);
  
  return {
    symbol,
    totalTrades: trades.length,
    callCount,
    putCount,
    callPremium,
    putPremium,
    totalPremium,
    netDelta,
    netGamma,
    putCallRatio,
    dominantFlow,
    sentiment,
    sentimentScore,
    largestTrades,
    recentTrades,
    strikeFlow,
    lastUpdated: new Date().toISOString(),
  };
}

async function fetchFlowData(): Promise<TapeData | null> {
  console.log("[FLOW] Fetching real-time flow data from SpotGamma Tape...");
  
  try {
    const perAsset: Record<string, TapeAssetSummary> = {};
    const allTrades: TapeFlow[] = [];
    
    // Fetch flow data for each tracked asset (200 trades each)
    const symbols = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA", "UVIX"];
    
    const fetchPromises = symbols.map(async (sym) => {
      const filters = JSON.stringify([{"field": "underlying", "operator": "isAnyOf", "value": [sym]}]);
      const encoded = encodeURIComponent(filters);
      const rawData = await streamApiCall<any[]>(
        `/sg/tns_feed?filters=${encoded}&limit=200`,
        10000,
        true  // MessagePack binary
      );
      
      if (rawData && Array.isArray(rawData)) {
        const trades = rawData.map(parseTapeFlowItem).filter((t): t is TapeFlow => t !== null);
        if (trades.length > 0) {
          perAsset[sym] = analyzeAssetFlow(sym, trades);
          allTrades.push(...trades);
          console.log(`[FLOW] ${sym}: ${trades.length} trades, sentiment=${perAsset[sym].sentiment} (score=${perAsset[sym].sentimentScore}), premium=$${(perAsset[sym].totalPremium / 1e3).toFixed(0)}K`);
        }
      }
    });
    
    await Promise.all(fetchPromises);
    
    // Fetch highlights (top trades, volume, gamma)
    let topPremiumTrades: TapeData["topPremiumTrades"] = [];
    let topVolumeSymbols: TapeData["topVolumeSymbols"] = [];
    let topGammaSymbols: TapeData["topGammaSymbols"] = [];
    
    try {
      const highlights = await streamApiCall<any>("/sg/tns_highlights", 10000);
      if (highlights) {
        topPremiumTrades = (highlights.premium || []).slice(0, 10).map((h: any) => ({
          symbol: h.underlying || "",
          premium: h.premium || 0,
          strike: h.strike || 0,
          isPut: h.is_put || false,
          expiry: (h.expiry || "").substring(0, 10),
        }));
        topVolumeSymbols = (highlights.volume || []).slice(0, 10).map((h: any) => ({
          symbol: h.underlying || "",
          volume: h.val || 0,
        }));
        topGammaSymbols = (highlights.gamma || []).slice(0, 10).map((h: any) => ({
          symbol: h.underlying || "",
          gamma: h.val || 0,
        }));
      }
    } catch (e) {
      console.error("[FLOW] Error fetching highlights:", e);
    }
    
    // Global aggregation
    const sortedAll = allTrades.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    let bullishPremium = 0, bearishPremium = 0;
    for (const t of allTrades) {
      if (t.signal === "bullish") bullishPremium += t.premium;
      else if (t.signal === "bearish") bearishPremium += t.premium;
    }
    const totalPremium = bullishPremium + bearishPremium;
    
    let dominantFlow: "calls" | "puts" | "neutral" = "neutral";
    if (bullishPremium > bearishPremium * 1.3) dominantFlow = "calls";
    else if (bearishPremium > bullishPremium * 1.3) dominantFlow = "puts";
    
    const topGammaTicker = topGammaSymbols[0]?.symbol || "SPX";
    const topGammaNotional = topGammaSymbols[0]?.gamma || 0;
    
    const tapeData: TapeData = {
      perAsset,
      recentFlows: sortedAll.slice(0, 50),
      dominantFlow,
      bullishPremium,
      bearishPremium,
      totalPremium,
      topGammaTicker,
      topGammaNotional,
      largestTrades: sortedAll.sort((a, b) => b.premium - a.premium).slice(0, 10),
      topPremiumTrades,
      topVolumeSymbols,
      topGammaSymbols,
      minPremiumFilter: 0,
      lastUpdated: new Date().toISOString(),
    };
    
    console.log(`[FLOW] Flow data complete: ${Object.keys(perAsset).length} assets, ${allTrades.length} total trades`);
    return tapeData;
  } catch (e: any) {
    console.error("[FLOW] Error fetching flow data:", e.message || e);
    return null;
  }
}

export async function fetchTraceDataOnly(): Promise<TraceData | null> {
  const poll = await apiCall<PollUpdateResponse>(`/v1/me/pollUpdate?features=%7B%22futures%22%3A%7B%7D%7D`, 10000);
  let spxPrice = 0;
  if (poll?.futuresSnapshot) {
    const spx = poll.futuresSnapshot.find(f => f.sym === "^SPX");
    if (spx) spxPrice = spx.lastPrice;
  }
  return fetchTraceData(spxPrice);
}

// ============ VOLATILITY CONTEXT ============

// IV level thresholds by asset type
const IV_THRESHOLDS: Record<string, number[]> = {
  // [very_low, low, normal, high, very_high] boundaries
  SPX: [12, 16, 22, 30, 40],
  SPY: [12, 16, 22, 30, 40],
  QQQ: [15, 20, 28, 38, 50],
  DIA: [10, 14, 20, 28, 38],
  GLD: [10, 14, 20, 28, 38],
  IWM: [15, 20, 28, 38, 50],
  VIX: [60, 80, 110, 150, 200],
  UVXY: [50, 70, 100, 140, 200],
  UVIX: [50, 70, 100, 140, 200],
};

function classifyIVLevel(iv: number, symbol: string): VolAssetContext["ivLevel"] {
  const thresholds = IV_THRESHOLDS[symbol] || IV_THRESHOLDS["SPX"];
  if (iv <= thresholds[0]) return "very_low";
  if (iv <= thresholds[1]) return "low";
  if (iv <= thresholds[2]) return "normal";
  if (iv <= thresholds[3]) return "high";
  return "very_high";
}

async function fetchVolContext(assets: AssetData[]): Promise<VolContext | null> {
  console.log("[VOL] Fetching volatility context for all assets...");
  try {
    const token = await getToken();
    if (!token) {
      console.log("[VOL] No token, skipping vol context");
      return null;
    }

    const perAsset: Record<string, VolAssetContext> = {};
    const symbols = ASSETS;
    
    // Build price map from assets
    const priceMap: Record<string, number> = {};
    for (const a of assets) {
      priceMap[a.symbol] = a.currentPrice;
    }
    // Fallback prices for assets not in the list
    if (!priceMap["UVIX"]) priceMap["UVIX"] = 15;
    if (!priceMap["VIX"]) priceMap["VIX"] = 27;

    const fetchPromises = symbols.map(async (sym) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const resp = await fetch(`${API_BASE}/v1/current_greeks?sym=${sym}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://dashboard.spotgamma.com',
            'Referer': 'https://dashboard.spotgamma.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/octet-stream, application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        if (!resp.ok) {
          console.log(`[VOL] ${sym}: HTTP ${resp.status}`);
          return;
        }
        
        const buffer = await resp.arrayBuffer();
        // Decode msgpack with relaxed key settings
        const raw = msgpackDecode(new Uint8Array(buffer)) as any;
        
        if (!raw || typeof raw !== 'object') return;
        
        // raw is { expiry_timestamp: { strike: [[call_greeks], [put_greeks]] } }
        const expiries = Object.keys(raw).map(Number).sort((a, b) => a - b);
        if (expiries.length < 2) return;
        
        const currentPrice = priceMap[sym] || 0;
        if (currentPrice <= 0) return;
        
        // Skip 0DTE/1DTE expiry (first one often has inflated IV)
        // Use the second expiry as "near-term" and last as "far-term"
        const now = Date.now();
        let nearExpIdx = 0;
        for (let i = 0; i < expiries.length; i++) {
          const daysToExp = (expiries[i] - now) / (1000 * 60 * 60 * 24);
          if (daysToExp >= 3) { // Skip anything less than 3 days out
            nearExpIdx = i;
            break;
          }
        }
        
        const nearExp = expiries[nearExpIdx];
        const farExp = expiries[Math.min(nearExpIdx + 6, expiries.length - 1)]; // ~6 expiries out
        
        // Find ATM strike for near expiry
        const nearStrikes = Object.keys(raw[nearExp]).map(Number).sort((a, b) => a - b);
        const atmStrike = nearStrikes.reduce((closest, s) => 
          Math.abs(s - currentPrice) < Math.abs(closest - currentPrice) ? s : closest, nearStrikes[0]);
        
        const nearGreeks = raw[nearExp][atmStrike];
        if (!nearGreeks || !Array.isArray(nearGreeks) || nearGreeks.length < 2) return;
        
        const callIV = Number(nearGreeks[0]?.[5]) || 0;
        const putIV = Number(nearGreeks[1]?.[5]) || 0;
        const atmIV = ((callIV + putIV) / 2) * 100; // Convert to percentage
        
        // Far-term ATM IV
        let farIV = 0;
        if (raw[farExp]) {
          const farStrikes = Object.keys(raw[farExp]).map(Number).sort((a, b) => a - b);
          const farAtm = farStrikes.reduce((closest, s) => 
            Math.abs(s - currentPrice) < Math.abs(closest - currentPrice) ? s : closest, farStrikes[0]);
          const farGreeks = raw[farExp][farAtm];
          if (farGreeks && Array.isArray(farGreeks) && farGreeks.length >= 2) {
            farIV = ((Number(farGreeks[0]?.[5] || 0) + Number(farGreeks[1]?.[5] || 0)) / 2) * 100;
          }
        }
        
        const termSpread = farIV - atmIV;
        const termStructure = termSpread > 0 ? "contango" as const : "backwardation" as const;
        const putCallSkew = (putIV - callIV) * 100;
        
        perAsset[sym] = {
          symbol: sym,
          atmIV: Math.round(atmIV * 10) / 10,
          nearTermExpiry: new Date(nearExp).toISOString().split('T')[0],
          farTermIV: Math.round(farIV * 10) / 10,
          farTermExpiry: new Date(farExp).toISOString().split('T')[0],
          termStructure,
          termSpread: Math.round(termSpread * 10) / 10,
          putIV: Math.round(putIV * 100 * 10) / 10,
          callIV: Math.round(callIV * 100 * 10) / 10,
          putCallSkew: Math.round(putCallSkew * 10) / 10,
          ivLevel: classifyIVLevel(atmIV, sym),
          numExpiries: expiries.length,
        };
        
        console.log(`[VOL] ${sym}: ATM IV=${atmIV.toFixed(1)}% (${termStructure}) skew=${putCallSkew.toFixed(1)}`);
      } catch (e: any) {
        console.log(`[VOL] ${sym}: Error - ${e.message || e}`);
      }
    });
    
    await Promise.all(fetchPromises);
    
    if (Object.keys(perAsset).length === 0) {
      console.log("[VOL] No vol context data available");
      return null;
    }
    
    // Calculate overall regime
    const equityAssets = ["SPX", "SPY", "QQQ", "DIA"].filter(s => perAsset[s]);
    const avgIV = equityAssets.length > 0 
      ? equityAssets.reduce((sum, s) => sum + perAsset[s].atmIV, 0) / equityAssets.length 
      : 0;
    
    let overallRegime: VolContext["overallRegime"] = "normal";
    if (avgIV <= 14) overallRegime = "low_vol";
    else if (avgIV <= 22) overallRegime = "normal";
    else if (avgIV <= 35) overallRegime = "high_vol";
    else overallRegime = "extreme_vol";
    
    // Average term structure
    const backwardCount = Object.values(perAsset).filter(v => v.termStructure === "backwardation").length;
    const avgTermStructure = backwardCount > Object.keys(perAsset).length / 2 ? "backwardation" as const : "contango" as const;
    
    // Average put/call skew
    const avgSkew = equityAssets.length > 0
      ? equityAssets.reduce((sum, s) => sum + perAsset[s].putCallSkew, 0) / equityAssets.length
      : 0;
    
    // Generate market summary
    const regimeLabels = { low_vol: "BAJA VOLATILIDAD", normal: "VOLATILIDAD NORMAL", high_vol: "ALTA VOLATILIDAD", extreme_vol: "VOLATILIDAD EXTREMA" };
    const termLabel = avgTermStructure === "backwardation" ? "backwardation (miedo a corto plazo)" : "contango (calma)";
    const skewLabel = avgSkew > 3 ? "put skew alto (demanda de protección bajista)" : avgSkew < -3 ? "call skew alto (demanda alcista)" : "skew neutral";
    
    const summaryParts = [
      `Régimen: ${regimeLabels[overallRegime]} (IV promedio equities: ${avgIV.toFixed(1)}%).`,
      `Term structure: ${termLabel}.`,
      `Put/Call skew: ${skewLabel} (${avgSkew > 0 ? '+' : ''}${avgSkew.toFixed(1)}%).`,
    ];
    
    if (overallRegime === "extreme_vol") {
      summaryParts.push("PRECAUCIÓN: Volatilidad extrema. Movimientos grandes esperados. Reducir tamaño de posiciones.");
    } else if (overallRegime === "high_vol" && avgTermStructure === "backwardation") {
      summaryParts.push("ALERTA: Alta vol + backwardation = mercado estresado. Priorizar trades con confirmación fuerte.");
    } else if (overallRegime === "low_vol") {
      summaryParts.push("Mercado complaciente. Breakouts pueden ser explosivos cuando ocurran.");
    }
    
    const volContext: VolContext = {
      perAsset,
      marketSummary: summaryParts.join(" "),
      overallRegime,
      avgTermStructure,
      avgPutCallSkew: Math.round(avgSkew * 10) / 10,
      fetchedAt: new Date().toISOString(),
    };
    
    console.log(`[VOL] Context complete: ${Object.keys(perAsset).length} assets, regime=${overallRegime}, term=${avgTermStructure}`);
    return volContext;
  } catch (e: any) {
    console.error("[VOL] Error fetching vol context:", e.message || e);
    return null;
  }
}

export function getCachedData(): MarketData | null {
  return cachedData;
}


// ============ GEX CHANGE TRACKER ============

// Store previous GEX snapshots for delta calculation
let previousGexSnapshot: GexChangeTracker["currentSnapshot"] | null = null;
let gexSnapshotHistory: { timestamp: string; gexRatio: number; netBias: string; totalPositive: number; totalNegative: number }[] = [];

function buildGexChangeTracker(traceData: TraceData | null, gex: GexData | null): GexChangeTracker | null {
  if (!traceData && !gex) return null;
  
  // Build current snapshot from traceData (0DTE) or gex (all-exp)
  const topSupport = (traceData?.topSupport || []).map(b => ({ strike: b.strike, gex: b.netGex }));
  const topResistance = (traceData?.topResistance || []).map(b => ({ strike: b.strike, gex: b.netGex }));
  const netBias = traceData?.netGexBias || ((gex as any)?.netGamma > 0 ? "bullish" : (gex as any)?.netGamma < 0 ? "bearish" : "neutral");
  const gexRatio = traceData?.gexRatio || 1;
  const totalPositive = traceData?.totalPositiveGex || 0;
  const totalNegative = traceData?.totalNegativeGex || 0;
  
  const currentSnapshot: GexChangeTracker["currentSnapshot"] = {
    topSupport,
    topResistance,
    netBias,
    gexRatio,
    totalPositive,
    totalNegative,
    timestamp: new Date().toISOString(),
  };
  
  // Calculate changes vs previous snapshot
  let changes: GexChangeTracker["changes"] = {
    biasChanged: false,
    prevBias: previousGexSnapshot?.netBias || netBias,
    newBias: netBias,
    ratioChange: 0,
    supportShifted: false,
    resistanceShifted: false,
    newLevels: [],
    removedLevels: [],
    description: "Primera lectura - sin datos previos para comparar.",
  };
  
  if (previousGexSnapshot) {
    const biasChanged = previousGexSnapshot.netBias !== netBias;
    const ratioChange = gexRatio - previousGexSnapshot.gexRatio;
    
    // Check if support/resistance strikes shifted
    const prevSupportStrikes = new Set(previousGexSnapshot.topSupport.map(s => s.strike));
    const prevResistanceStrikes = new Set(previousGexSnapshot.topResistance.map(s => s.strike));
    const currSupportStrikes = new Set(topSupport.map(s => s.strike));
    const currResistanceStrikes = new Set(topResistance.map(s => s.strike));
    
    const newLevels: number[] = [];
    const removedLevels: number[] = [];
    
    for (const s of Array.from(currSupportStrikes)) {
      if (!prevSupportStrikes.has(s) && !prevResistanceStrikes.has(s)) newLevels.push(s);
    }
    for (const s of Array.from(currResistanceStrikes)) {
      if (!prevSupportStrikes.has(s) && !prevResistanceStrikes.has(s)) newLevels.push(s);
    }
    for (const s of Array.from(prevSupportStrikes)) {
      if (!currSupportStrikes.has(s) && !currResistanceStrikes.has(s)) removedLevels.push(s);
    }
    for (const s of Array.from(prevResistanceStrikes)) {
      if (!currSupportStrikes.has(s) && !currResistanceStrikes.has(s)) removedLevels.push(s);
    }
    
    const supportShifted = newLevels.some(l => currSupportStrikes.has(l)) || removedLevels.some(l => prevSupportStrikes.has(l));
    const resistanceShifted = newLevels.some(l => currResistanceStrikes.has(l)) || removedLevels.some(l => prevResistanceStrikes.has(l));
    
    // Build description
    const parts: string[] = [];
    if (biasChanged) {
      parts.push(`CAMBIO DE REGIMEN: ${previousGexSnapshot.netBias} → ${netBias}`);
    }
    if (Math.abs(ratioChange) > 0.1) {
      parts.push(`Ratio GEX ${ratioChange > 0 ? "subio" : "bajo"} ${Math.abs(ratioChange).toFixed(2)} (${previousGexSnapshot.gexRatio.toFixed(2)} → ${gexRatio.toFixed(2)})`);
    }
    if (newLevels.length > 0) {
      parts.push(`Nuevos niveles: ${newLevels.join(", ")}`);
    }
    if (removedLevels.length > 0) {
      parts.push(`Niveles removidos: ${removedLevels.join(", ")}`);
    }
    if (parts.length === 0) {
      parts.push("Sin cambios significativos en posicionamiento GEX.");
    }
    
    changes = {
      biasChanged,
      prevBias: previousGexSnapshot.netBias,
      newBias: netBias,
      ratioChange,
      supportShifted,
      resistanceShifted,
      newLevels,
      removedLevels,
      description: parts.join(" | "),
    };
  }
  
  // Dynamic TP adjustment logic
  let tpAdjustment: GexChangeTracker["tpAdjustment"] = {
    shouldAdjustTP: false,
    reason: "Sin ajuste necesario.",
    suggestedAction: "hold",
    newTPSuggestion: 0,
    confidence: 50,
  };
  
  if (previousGexSnapshot) {
    // Regime change = strongest signal to adjust TP
    if (changes.biasChanged) {
      if (netBias === "bearish" && previousGexSnapshot.netBias === "bullish") {
        tpAdjustment = {
          shouldAdjustTP: true,
          reason: "REGIMEN CAMBIO: Gamma positivo → negativo. Dealers dejan de comprar dips. Cerrar LONGS o mover SL a breakeven.",
          suggestedAction: "close_now",
          newTPSuggestion: traceData?.currentPrice || 0,
          confidence: 85,
        };
      } else if (netBias === "bullish" && previousGexSnapshot.netBias === "bearish") {
        tpAdjustment = {
          shouldAdjustTP: true,
          reason: "REGIMEN CAMBIO: Gamma negativo → positivo. Dealers ahora compran dips. Cerrar SHORTS o mover SL a breakeven.",
          suggestedAction: "close_now",
          newTPSuggestion: traceData?.currentPrice || 0,
          confidence: 85,
        };
      }
    }
    // Significant ratio change without full regime change
    else if (Math.abs(changes.ratioChange) > 0.3) {
      if (changes.ratioChange > 0.3) {
        // GEX becoming more supportive
        tpAdjustment = {
          shouldAdjustTP: true,
          reason: `GEX ratio subio ${changes.ratioChange.toFixed(2)} - posicionamiento mas alcista. Considerar extender TP en longs.`,
          suggestedAction: "extend_tp",
          newTPSuggestion: topResistance[0]?.strike || 0,
          confidence: 65,
        };
      } else {
        // GEX becoming more resistive
        tpAdjustment = {
          shouldAdjustTP: true,
          reason: `GEX ratio bajo ${Math.abs(changes.ratioChange).toFixed(2)} - posicionamiento mas bajista. Considerar apretar TP en longs.`,
          suggestedAction: "tighten_tp",
          newTPSuggestion: topSupport[0]?.strike || 0,
          confidence: 65,
        };
      }
    }
    // Support/resistance levels shifted
    else if (changes.supportShifted || changes.resistanceShifted) {
      tpAdjustment = {
        shouldAdjustTP: true,
        reason: `Niveles GEX cambiaron - ${changes.supportShifted ? "soporte" : "resistencia"} se movio. Revisar TP/SL.`,
        suggestedAction: "move_to_breakeven",
        newTPSuggestion: 0,
        confidence: 55,
      };
    }
  }
  
  // Store current as previous for next comparison
  previousGexSnapshot = { ...currentSnapshot };
  
  // Add to history (keep last 50 readings)
  gexSnapshotHistory.push({
    timestamp: currentSnapshot.timestamp,
    gexRatio,
    netBias,
    totalPositive,
    totalNegative,
  });
  if (gexSnapshotHistory.length > 50) {
    gexSnapshotHistory = gexSnapshotHistory.slice(-50);
  }
  
  const result: GexChangeTracker = {
    currentSnapshot,
    previousSnapshot: previousGexSnapshot,
    changes,
    tpAdjustment,
    lastUpdated: new Date().toISOString(),
  };
  
  console.log(`[GEX-TRACKER] Bias=${netBias} Ratio=${gexRatio.toFixed(2)} Changed=${changes.biasChanged} TP_Adjust=${tpAdjustment.shouldAdjustTP} History=${gexSnapshotHistory.length} readings`);
  
  return result;
}

// Export GEX history for frontend
export function getGexHistory() {
  return gexSnapshotHistory;
}

// ── JWT-authenticated endpoints (legacy SpotGamma API) ───────────────────────

function buildJWT(): string {
  const header  = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({})).toString("base64url");
  const sig = createHmac("sha256", "secretKeyValue").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function jwtFetch<T>(urlPath: string, timeoutMs = 20000): Promise<T | null> {
  const jwt = buildJWT();
  let bearerToken = "";
  try { bearerToken = await getToken(); } catch (_) {}

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "x-json-web-token": jwt,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": "https://dashboard.spotgamma.com",
      "Referer": "https://dashboard.spotgamma.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    };
    if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

    const r = await fetch(`${API_BASE}${urlPath}`, { headers, signal: ctrl.signal });
    if (!r.ok) {
      console.warn(`[JWT-API] ${r.status} for ${urlPath}`);
      return null;
    }
    return await r.json() as T;
  } catch (e: any) {
    if (e.name !== "AbortError") console.warn(`[JWT-API] Error for ${urlPath}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// Twelve Series — OHLC 1-minute candles
export interface TwelveSeriesBar {
  t: number;   // epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export async function fetchTwelveSeries(
  symbol: string,
  startDate: string,
  interval = "1min",
): Promise<TwelveSeriesBar[]> {
  const data = await jwtFetch<any>(
    `/v1/twelve_series?symbol=${symbol}&interval=${interval}&start_date=${startDate}`,
    30000,
  );
  if (!data) return [];
  // Response shape varies: { SPX: { values: [...] } } or { values: [...] } or array
  let arr: any[];
  if (Array.isArray(data)) {
    arr = data;
  } else if (data[symbol]?.values) {
    arr = data[symbol].values;
  } else if (data.values) {
    arr = data.values;
  } else if (data.data) {
    arr = data.data;
  } else {
    // Try first key that has a values array
    const firstKey = Object.keys(data).find(k => data[k]?.values);
    arr = firstKey ? data[firstKey].values : [];
  }
  const bars = arr.map((b: any) => ({
    t: typeof b.datetime === "string" ? Math.floor(new Date(b.datetime).getTime() / 1000) : (b.t ?? b.ts ?? 0),
    o: parseFloat(b.open ?? b.o ?? 0),
    h: parseFloat(b.high ?? b.h ?? 0),
    l: parseFloat(b.low  ?? b.l ?? 0),
    c: parseFloat(b.close ?? b.c ?? 0),
    v: parseFloat(b.volume ?? b.v ?? 0),
  }));
  // Sort ascending by timestamp (API sometimes returns descending)
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

// Gamma Tilt — historical gamma tilt since 2015
export interface GammaTiltRow {
  date: string;
  gammaTilt: number;
  sym: string;
}

export async function fetchGammaTilt(symbol: string): Promise<GammaTiltRow[]> {
  const data = await jwtFetch<any>(`/gammaTilt?sym=${symbol}`, 30000);
  if (!data) return [];
  const arr = Array.isArray(data) ? data : (data.data ?? []);
  return arr.map((r: any) => ({
    date: r.date ?? r.dt ?? r.d ?? "",
    gammaTilt: parseFloat(r.gammaTilt ?? r.gamma_tilt ?? r.value ?? 0),
    sym: symbol,
  }));
}

// Delta Tilt — historical delta tilt since 2015
export interface DeltaTiltRow {
  date: string;
  deltaTilt: number;
  sym: string;
}

export async function fetchDeltaTilt(symbol: string): Promise<DeltaTiltRow[]> {
  const data = await jwtFetch<any>(`/deltaTilt?sym=${symbol}`, 30000);
  if (!data) return [];
  const arr = Array.isArray(data) ? data : (data.data ?? []);
  return arr.map((r: any) => ({
    date: r.date ?? r.dt ?? r.d ?? "",
    deltaTilt: parseFloat(r.deltaTilt ?? r.delta_tilt ?? r.value ?? 0),
    sym: symbol,
  }));
}

// Implied Move — current implied move for a symbol
export interface ImpliedMoveData {
  sym: string;
  impliedMove: number;
  impliedMovePct: number;
  upper: number;
  lower: number;
}

export async function fetchImpliedMove(symbol: string): Promise<ImpliedMoveData | null> {
  const data = await jwtFetch<any>(`/v2/impliedMove?sym=${symbol}`);
  if (!data) return null;
  const d = Array.isArray(data) ? data[0] : data;
  return {
    sym: symbol,
    impliedMove: parseFloat(d.impliedMove ?? d.implied_move ?? d.im ?? 0),
    impliedMovePct: parseFloat(d.impliedMovePct ?? d.implied_move_pct ?? d.imp ?? 0),
    upper: parseFloat(d.upper ?? d.upside ?? 0),
    lower: parseFloat(d.lower ?? d.downside ?? 0),
  };
}

// Combo Levels — key GEX combo levels per symbol
export interface ComboLevel {
  level: number;
  type: string;
  description?: string;
}

export async function fetchComboLevels(symbol: string): Promise<ComboLevel[]> {
  const data = await jwtFetch<any>(`/v2/comboLevels?sym=${symbol}`);
  if (!data) return [];
  const arr = Array.isArray(data) ? data : (data.data ?? data.levels ?? []);
  return arr.map((r: any) => ({
    level: parseFloat(r.level ?? r.price ?? r.strike ?? 0),
    type: r.type ?? r.label ?? "combo",
    description: r.description ?? r.desc ?? undefined,
  }));
}

// Absolute Gamma Levels — gamma by strike
export interface AbsGammaLevel {
  strike: number;
  gamma: number;
  callGamma: number;
  putGamma: number;
}

export async function fetchAbsGammaLevels(symbol: string): Promise<AbsGammaLevel[]> {
  const data = await jwtFetch<any>(`/absGammaLevels?sym=${symbol}`, 30000);
  if (!data) return [];
  const arr = Array.isArray(data) ? data : (data.data ?? data.levels ?? []);
  return arr.map((r: any) => ({
    strike: parseFloat(r.strike ?? r.s ?? 0),
    gamma: parseFloat(r.gamma ?? r.totalGamma ?? r.g ?? 0),
    callGamma: parseFloat(r.callGamma ?? r.call_gamma ?? r.cg ?? 0),
    putGamma: parseFloat(r.putGamma ?? r.put_gamma ?? r.pg ?? 0),
  }));
}

// ── Candlestick pattern detection ────────────────────────────────────────────

export type CandleSignal = "bullish" | "bearish" | "neutral";

/**
 * Detects simple candlestick bias from last N bars.
 * Returns "bullish", "bearish", or "neutral".
 */
export function detectCandleSignal(bars: TwelveSeriesBar[], lookback = 3): CandleSignal {
  if (bars.length < 2) return "neutral";
  const recent = bars.slice(-lookback);

  let bullCount = 0;
  let bearCount = 0;

  for (const b of recent) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range === 0) continue;
    const bodyRatio = body / range;

    if (b.c > b.o && bodyRatio > 0.5) bullCount++;
    else if (b.c < b.o && bodyRatio > 0.5) bearCount++;
  }

  // Engulfing pattern check (last 2 bars)
  if (bars.length >= 2) {
    const prev = bars[bars.length - 2];
    const last = bars[bars.length - 1];
    // Bullish engulfing
    if (prev.c < prev.o && last.c > last.o && last.o < prev.c && last.c > prev.o) bullCount += 2;
    // Bearish engulfing
    if (prev.c > prev.o && last.c < last.o && last.o > prev.c && last.c < prev.o) bearCount += 2;
  }

  if (bullCount > bearCount + 1) return "bullish";
  if (bearCount > bullCount + 1) return "bearish";
  return "neutral";
}

/**
 * Converts a CandleSignal to a reward multiplier for RL training.
 * Confirming signal → 1.10, contradicting → 0.88, neutral → 1.0
 */
export function candleRewardMultiplier(signal: CandleSignal, direction: "LONG" | "SHORT"): number {
  if (signal === "neutral") return 1.0;
  if ((signal === "bullish" && direction === "LONG") || (signal === "bearish" && direction === "SHORT")) return 1.10;
  return 0.88;
}
