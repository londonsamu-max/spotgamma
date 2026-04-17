/**
 * Fast Executor — Instant order execution from Claude's strategic decisions
 *
 * Claude writes setups to data/agent-orders.json every cycle.
 * This module reads them every 500ms and executes instantly when price hits levels.
 * No AI, no thinking — pure speed.
 *
 * Also handles position management: trailing SL, breakeven, partial close.
 */

import fs from "fs";
import path from "path";
import { placeOrder, modifySL, closePosition, getMT5Status, getBrokerPrices } from "./mt5-file-bridge";
import { loadAutoConfig, checkKillSwitch } from "./auto-trade-config.js";
import { loadHistory, saveHistory, logSetupIfNew } from "./trade-history";
import { getCachedData, fetchSpotGammaLivePrices } from "./spotgamma-scraper";

const ORDERS_FILE = path.resolve(process.cwd(), "data/agent-orders.json");
const LOG_FILE = path.resolve(process.cwd(), "data/executor-log.jsonl");

// ── Types ───────────────────────────────────────────────────────────────────

interface PendingOrder {
  id: string;
  cfd: "NAS100" | "US30" | "XAUUSD";
  direction: "LONG" | "SHORT";
  entryZone: [number, number]; // [low, high] — execute if price enters this range
  sl: number;
  tp1: number;
  tp2?: number;
  tp3?: number;
  volume: number;
  reasoning?: string;
  rationale?: string;
  createdAt: string;
  expiresAt?: string; // ISO timestamp — auto-cancel after this time
  status: "pending" | "filled" | "cancelled" | "expired";
  mt5Ticket?: number;
  // ── Precision entry fields ──
  entryMode?: "zone" | "level" | "confirm"; // zone=current, level=tight ±5pts, confirm=wait for rejection candle
  exactLevel?: number; // The exact structural level (gamma/topStrike/0DTE) for precision entry
  structuralSL?: number; // The structural level behind which SL sits (for reference)
  slBuffer?: number; // Buffer points beyond structuralSL (default: 15 NAS/US30, 5 XAU)
  // ── ETF/Index trigger (eliminates conversion ratio drift) ──
  triggerSource?: "mt5" | "spotgamma"; // mt5=use CFD price (default), spotgamma=use ETF/index price
  triggerSymbol?: string; // e.g. "SPX", "QQQ", "SPY", "GLD", "DIA" — the actual options symbol
  triggerLevel?: number; // The exact strike/level in ETF price (e.g. SPX 6595, GLD 425)
  // ── Trade mode ──
  tradeMode?: "scalp" | "intraday" | "swing"; // defaults to "intraday"
  pyramidOf?: string; // ID of parent position (if this is a pyramid add-on)
}

interface ManagedPosition {
  id: string;
  cfd: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentSL: number;
  currentTP: number;
  volume: number;
  mt5Ticket: number;
  breakeven: boolean; // already moved to breakeven?
  partialClosed: boolean; // already took partial?
  tp1: number;
  tp2?: number;
  tp3?: number;
  trailDistance?: number; // trail SL by this many points behind price
  manualSL?: boolean; // If true, executor will NOT touch the SL (Claude set it manually)
  note?: string;
  // ── Trade mode ──
  tradeMode?: "scalp" | "intraday" | "swing";
  lastTrailCheck?: string; // ISO timestamp — for SWING mode 4h throttle
  pyramidCount?: number; // how many adds have been done (0 = original)
  parentId?: string; // for tracking pyramid chain
}

interface ExecutorState {
  pendingOrders: PendingOrder[];
  managedPositions: ManagedPosition[];
  lastPriceCheck: string;
}

// ── Trade Mode Configuration ────────────────────────────────────────────────

const TRADE_MODE_CONFIG: Record<string, {
  breakevenR: number;
  breakevenBuffer: Record<string, number>;
  trailType: "fixed" | "gamma";
  trailFixed: Record<string, number>;
  gammaTrailBuffer: Record<string, number>;
  trailThrottleMs: number;
  defaultVolume: Record<string, number>;
  maxTPs: number;
  defaultExpireHours: number | null;
  pyramidAllowed: boolean;
  maxPyramids: number;
}> = {
  scalp: {
    breakevenR: 0.5,
    breakevenBuffer: { NAS100: 3, US30: 3, XAUUSD: 1 },
    trailType: "fixed",
    trailFixed: { NAS100: 8, US30: 8, XAUUSD: 3 },
    gammaTrailBuffer: { NAS100: 8, US30: 8, XAUUSD: 3 },
    trailThrottleMs: 0,
    defaultVolume: { NAS100: 0.10, US30: 0.10, XAUUSD: 0.01 },
    maxTPs: 1,
    defaultExpireHours: 2,
    pyramidAllowed: false,
    maxPyramids: 0,
  },
  intraday: {
    breakevenR: 1.0,
    breakevenBuffer: { NAS100: 5, US30: 5, XAUUSD: 2 },
    trailType: "gamma",
    trailFixed: { NAS100: 15, US30: 15, XAUUSD: 5 },
    gammaTrailBuffer: { NAS100: 15, US30: 15, XAUUSD: 5 },
    trailThrottleMs: 0,
    defaultVolume: { NAS100: 0.10, US30: 0.10, XAUUSD: 0.01 },
    maxTPs: 2,
    defaultExpireHours: null,
    pyramidAllowed: true,
    maxPyramids: 2,
  },
  swing: {
    breakevenR: 1.5,
    breakevenBuffer: { NAS100: 10, US30: 10, XAUUSD: 4 },
    trailType: "gamma",
    trailFixed: { NAS100: 25, US30: 25, XAUUSD: 10 },
    gammaTrailBuffer: { NAS100: 25, US30: 25, XAUUSD: 10 },
    trailThrottleMs: 4 * 60 * 60 * 1000, // 4 hours
    defaultVolume: { NAS100: 0.03, US30: 0.03, XAUUSD: 0.01 },
    maxTPs: 3,
    defaultExpireHours: null,
    pyramidAllowed: true,
    maxPyramids: 3,
  },
};

function getModeConfig(mode?: string) {
  return TRADE_MODE_CONFIG[mode || "intraday"] || TRADE_MODE_CONFIG.intraday;
}

// ── State ───────────────────────────────────────────────────────────────────

let _state: ExecutorState = { pendingOrders: [], managedPositions: [], lastPriceCheck: "" };
let _interval: ReturnType<typeof setInterval> | null = null;
let _priceCache: Record<string, number> = {};
let _executing = false; // Lock to prevent concurrent execution cycles
const _processingOrders = new Set<string>(); // Track orders being processed
// ── Failure cooldown: prevent retry spam after timeout ──
const _orderFailures: Record<string, { count: number; lastFailAt: number }> = {};
const FAIL_COOLDOWN_MS = 30_000; // Wait 30s before retrying a failed order
const MAX_FAIL_COUNT = 5; // After 5 failures, mark order as cancelled
// ── MT5 bridge serialization lock (with timeout safety) ──
let _bridgeBusy = false; // Prevent concurrent sendOrder calls
let _bridgeBusySince = 0; // Timestamp when lock was acquired
const BRIDGE_TIMEOUT_MS = 15_000; // Force-release lock after 15s (prevents permanent deadlock)
// ── Price history for candle confirmation ──
const _priceHistory: Record<string, { price: number; ts: number }[]> = {};
const PRICE_HISTORY_MAX = 120; // Keep last 60 seconds at 500ms = 120 entries

function log(msg: string) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), msg });
  try { fs.appendFileSync(LOG_FILE, entry + "\n"); } catch {}
  console.log(`[EXECUTOR] ${msg}`);
}

// ── SpotGamma ETF/Index LIVE price lookup (updates every 5s) ────────────────
let _sgLivePrices: Record<string, number> = {};
let _sgLivePriceInterval: ReturnType<typeof setInterval> | null = null;

async function refreshSGLivePrices() {
  try {
    const result = await fetchSpotGammaLivePrices();
    if (result?.prices) {
      for (const [sym, data] of Object.entries(result.prices)) {
        if (data.price > 0) _sgLivePrices[sym] = data.price;
      }
    }
  } catch (e: any) {
    console.warn(`[EXECUTOR] SG live price refresh failed: ${e.message}`);
  }
}

function startSGLivePriceLoop() {
  if (_sgLivePriceInterval) return;
  refreshSGLivePrices(); // immediate first fetch
  _sgLivePriceInterval = setInterval(refreshSGLivePrices, 5000); // every 5s
  console.log("[EXECUTOR] SpotGamma live price loop started (5s)");
}

function getSpotGammaPrice(symbol: string): number {
  // First check live prices (updated every 5s)
  if (_sgLivePrices[symbol] > 0) return _sgLivePrices[symbol];
  // Fallback to cached full data
  try {
    const md = getCachedData();
    if (!md) return 0;
    const assets = (md as any).assets || [];
    for (const a of assets) {
      if (a.symbol === symbol) return a.currentPrice || 0;
    }
  } catch {}
  return 0;
}

// ── Load/Save orders ────────────────────────────────────────────────────────

function loadOrders(): ExecutorState {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
    }
  } catch {}
  return { pendingOrders: [], managedPositions: [], lastPriceCheck: "" };
}

function saveOrders(state: ExecutorState) {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e: any) {
    console.warn(`[EXECUTOR] Save failed: ${e.message}`);
  }
}

// ── Price feed ──────────────────────────────────────────────────────────────

function updatePrices() {
  // Priority 1: Live broker prices from MT5 EA (most accurate, real Pepperstone quotes)
  try {
    const brokerPrices = getBrokerPrices();
    if (brokerPrices && Object.keys(brokerPrices).length > 0) {
      for (const [sym, data] of Object.entries(brokerPrices)) {
        if (data && data.bid > 0) {
          const key = sym.toLowerCase().replace(".", "");
          _priceCache[key] = (data.bid + data.ask) / 2; // mid price
        }
      }
      return; // broker prices are best, don't overwrite with TradingView
    }
  } catch {}

  // Priority 2: TradingView prices from server cache (fallback)
  try {
    const { getCachedData } = require("./spotgamma-scraper");
    const md = getCachedData();
    if (!md?.cfdPrices) return;
    for (const [key, val] of Object.entries(md.cfdPrices)) {
      if (val && typeof val === "object" && "price" in (val as any)) {
        _priceCache[key] = (val as any).price;
      }
    }
  } catch {}
}

function getPrice(cfd: string): number {
  const key = cfd === "NAS100" ? "nas100" : cfd === "US30" ? "us30" : "xauusd";
  return _priceCache[key] || 0;
}

// ── Core execution loop (runs every 500ms) ──────────────────────────────────

async function executionCycle() {
  // LOCK: prevent concurrent execution (fixes duplicate order bug)
  if (_executing) return;
  _executing = true;

  try {
  // Safety: force-release bridge lock if stuck (prevents permanent deadlock from uncaught errors)
  if (_bridgeBusy && _bridgeBusySince > 0 && Date.now() - _bridgeBusySince > BRIDGE_TIMEOUT_MS) {
    log(`BRIDGE_UNLOCK: Force-releasing bridge lock stuck for ${((Date.now() - _bridgeBusySince) / 1000).toFixed(0)}s`);
    _bridgeBusy = false;
    _bridgeBusySince = 0;
  }

  updatePrices();
  _state = loadOrders();

  const now = new Date();
  const atCfg = loadAutoConfig();
  if (!atCfg.enabled) { _executing = false; return; }

  const mt5 = getMT5Status();
  if (!mt5.connected) { _executing = false; return; }

  // Check kill switch
  const ks = checkKillSwitch(loadHistory());
  if (ks.triggered) { _executing = false; return; }

  // ── 1. Check pending orders ─────────────────────────────────────────────
  let changed = false;

  for (const order of _state.pendingOrders) {
    // Default missing fields (Claude agent may omit them)
    if (!order.status) order.status = "pending";
    if (order.status !== "pending") continue;

    if (!order.sl && order.structuralSL) order.sl = order.structuralSL;
    if (!order.createdAt) order.createdAt = now.toISOString();
    if (!order.entryZone && order.exactLevel) {
      const buf = order.cfd === "XAUUSD" ? 5 : 20;
      order.entryZone = [order.exactLevel - buf, order.exactLevel + buf];
    }
    // BUG FIX: skip orders with no entryZone AND no exactLevel (would crash on zone check)
    if (!order.entryZone && !order.exactLevel) {
      log(`SKIP_INVALID: ${order.cfd} ${order.direction} — no entryZone and no exactLevel`);
      order.status = "cancelled";
      changed = true;
      continue;
    }

    // Check expiry — explicit or mode-based
    if (order.expiresAt && new Date(order.expiresAt) < now) {
      order.status = "expired";
      log(`EXPIRED: ${order.cfd} ${order.direction} (was ${order.exactLevel || order.entryZone})`);
      changed = true;
      continue;
    }
    // SCALP auto-expire: 2 hours after creation
    if (order.tradeMode === "scalp" && !order.expiresAt && order.createdAt) {
      if (now.getTime() - new Date(order.createdAt).getTime() > 2 * 3600_000) {
        order.status = "expired";
        log(`MODE_EXPIRE: ${order.cfd} ${order.direction} scalp expired after 2h`);
        changed = true;
        continue;
      }
    }
    // INTRADAY auto-expire: at 20:00 UTC (market close)
    // Only expire if order was created DURING today's session (after 13:30 UTC open)
    if ((order.tradeMode === "intraday" || (!order.tradeMode && !order.expiresAt)) && order.createdAt) {
      const close = new Date(now); close.setUTCHours(20, 0, 0, 0);
      const openToday = new Date(now); openToday.setUTCHours(13, 30, 0, 0);
      const createdAt = new Date(order.createdAt);
      if (now > close && createdAt >= openToday && createdAt < close) {
        order.status = "expired";
        log(`MODE_EXPIRE: ${order.cfd} ${order.direction} intraday expired at market close`);
        changed = true;
        continue;
      }
    }

    const cfdPrice = getPrice(order.cfd); // MT5 price for execution
    if (cfdPrice <= 0) continue;

    // ── Determine trigger price: MT5 (default) or SpotGamma ETF/Index ──
    let triggerPrice = cfdPrice;
    let triggerLevel = order.exactLevel || (order.entryZone ? (order.entryZone[0] + order.entryZone[1]) / 2 : 0);

    if (order.triggerSource === "spotgamma" && order.triggerSymbol && order.triggerLevel) {
      // Use SpotGamma ETF/Index price directly — no conversion drift!
      const sgPrice = getSpotGammaPrice(order.triggerSymbol);
      if (sgPrice > 0) {
        triggerPrice = sgPrice;
        triggerLevel = order.triggerLevel;
      }
    }

    // ── Record price history for candle confirmation ──
    const histKey = order.triggerSource === "spotgamma" ? `${order.triggerSymbol}_sg` : order.cfd;
    if (!_priceHistory[histKey]) _priceHistory[histKey] = [];
    const hist = _priceHistory[histKey];
    const nowMs = now.getTime();
    if (!hist.length || nowMs - hist[hist.length - 1].ts >= 400) {
      hist.push({ price: triggerPrice, ts: nowMs });
      if (hist.length > PRICE_HISTORY_MAX) hist.shift();
    }

    // ── Entry mode logic ──
    const mode = order.entryMode || "zone";
    let shouldEnter = false;
    const price = triggerPrice; // Use trigger price for level checks

    if (mode === "zone") {
      // Original: execute if price is anywhere in the zone
      shouldEnter = price >= order.entryZone[0] && price <= order.entryZone[1];

    } else if (mode === "level") {
      // NEAR-EXACT: execute close to the exact level
      const level = triggerLevel;
      // Tighter tolerance for spotgamma triggers (exact strike, no conversion drift)
      const tolerance = order.triggerSource === "spotgamma"
        ? (order.triggerSymbol === "GLD" ? 0.5 : 2) // SPX ±2pts, GLD ±$0.50
        : (order.cfd === "XAUUSD" ? 3 : 5); // CFD: ±5pts NAS/US30, ±3pts XAU
      shouldEnter = Math.abs(price - level) <= tolerance;

    } else if (mode === "confirm") {
      // NEAR-EXACT + REJECTION: price must be near the level AND show rejection candle
      const level = triggerLevel;
      const tolerance = order.triggerSource === "spotgamma"
        ? (order.triggerSymbol === "GLD" ? 1 : 3) // SPX ±3pts, GLD ±$1
        : (order.cfd === "XAUUSD" ? 5 : 10); // CFD: ±10pts NAS/US30, ±5pts XAU
      const touched = Math.abs(price - level) <= tolerance;

      if (touched && hist.length >= 10) {
        // Build a micro-candle from last 10 seconds of price data (20 ticks at 500ms)
        const recent = hist.slice(-20);
        const microOpen = recent[0].price;
        const microClose = recent[recent.length - 1].price;
        const microHigh = Math.max(...recent.map(r => r.price));
        const microLow = Math.min(...recent.map(r => r.price));
        const body = Math.abs(microClose - microOpen);
        const totalRange = microHigh - microLow;

        if (totalRange > 0) {
          if (order.direction === "LONG") {
            // For LONG: price should touch/go below level, then close above (lower wick rejection)
            const lowerWick = Math.min(microOpen, microClose) - microLow;
            const wickRatio = lowerWick / totalRange;
            // Rejection: lower wick > 50% of range AND close above open (bullish)
            shouldEnter = wickRatio >= 0.4 && microClose > microOpen;
            if (shouldEnter) log(`CONFIRM_LONG: ${order.cfd} micro-candle rejection at $${level} wick=${(wickRatio*100).toFixed(0)}%`);
          } else {
            // For SHORT: price should touch/go above level, then close below (upper wick rejection)
            const upperWick = microHigh - Math.max(microOpen, microClose);
            const wickRatio = upperWick / totalRange;
            shouldEnter = wickRatio >= 0.4 && microClose < microOpen;
            if (shouldEnter) log(`CONFIRM_SHORT: ${order.cfd} micro-candle rejection at $${level} wick=${(wickRatio*100).toFixed(0)}%`);
          }
        }
      }
    }

    if (!shouldEnter) continue;

    // Guard 1: check if already have a managed position for same CFD+direction
    // EXCEPTION: pyramid orders (pyramidOf set) are allowed even if position exists
    const alreadyManaged = !order.pyramidOf && _state.managedPositions.some(
      m => m.cfd === order.cfd && m.direction === order.direction
    );
    // Guard 2: check if another order for same CFD+direction was JUST filled in this cycle
    // EXCEPTION: pyramid orders are allowed
    const justFilledSameDir = !order.pyramidOf && _state.pendingOrders.some(
      o => o.id !== order.id && o.cfd === order.cfd && o.direction === order.direction && o.status === "filled"
    );
    // Guard 3: check if MT5 already has an open position for same CFD+direction
    const mt5Status = getMT5Status();
    const mt5HasPosition = (mt5Status as any)?.openPositions?.some(
      (p: any) => p.symbol === order.cfd &&
        ((order.direction === "LONG" && p.type === "BUY") || (order.direction === "SHORT" && p.type === "SELL"))
    ) || false;

    if (alreadyManaged || justFilledSameDir || mt5HasPosition) {
      log(`SKIP_DUP: ${order.cfd} ${order.direction} — managed=${alreadyManaged} justFilled=${justFilledSameDir} mt5=${mt5HasPosition}`);
      order.status = "filled";
      saveOrders(_state);
      changed = true;
      continue;
    }

    // Guard: check if this order is already being processed
    if (_processingOrders.has(order.id)) {
      continue;
    }

    // Guard: cooldown after previous failures (prevent timeout retry spam)
    const failInfo = _orderFailures[order.id];
    if (failInfo) {
      if (failInfo.count >= MAX_FAIL_COUNT) {
        order.status = "cancelled";
        log(`CANCEL_FAIL: ${order.cfd} ${order.direction} — ${failInfo.count} consecutive timeouts, cancelling`);
        changed = true;
        continue;
      }
      if (now.getTime() - failInfo.lastFailAt < FAIL_COOLDOWN_MS) {
        continue; // Still in cooldown, skip silently
      }
    }

    // Guard: MT5 bridge busy with another order (prevent file contention)
    if (_bridgeBusy) {
      continue;
    }

    _processingOrders.add(order.id);

    // EXECUTE!
    const triggerInfo = order.triggerSource === "spotgamma"
      ? `${order.triggerSymbol} $${triggerPrice.toFixed(2)} → ${order.cfd}`
      : `${order.cfd} $${cfdPrice}`;
    log(`TRIGGER: ${triggerInfo} ${order.direction} (trigger=${order.triggerSource || "mt5"} level=${triggerLevel})`);

    try {
      _bridgeBusy = true;
      _bridgeBusySince = Date.now();
      const result = await placeOrder({
        cfd: order.cfd,
        direction: order.direction,
        volume: order.volume,
        sl: order.sl,
        tp1: order.tp1,
        tp2: order.tp2 || order.tp1,
        tp3: order.tp3 || order.tp1,
      });
      _bridgeBusy = false;
      _bridgeBusySince = 0;

      if (result.success && result.ticket) {
        // Clear failure history on success
        delete _orderFailures[order.id];
        order.status = "filled";
        order.mt5Ticket = result.ticket;
        // CRITICAL: Save immediately to prevent duplicate execution on next 500ms cycle
        saveOrders(_state);

        // Log to trade history
        const sessionDate = now.toISOString().slice(0, 10);
        logSetupIfNew({
          asset: order.cfd === "NAS100" ? "SPX" : order.cfd === "US30" ? "DIA" : "GLD",
          cfd: order.cfd,
          cfdLabel: order.cfd,
          tradeType: "fast_executor" as any,
          direction: order.direction,
          score: 80,
          entryPrice: price,
          cfdEntryPrice: price,
          entryZone: null,
          entryMode: "ENTRADA",
          entryQuality: "optimal",
          sessionLabel: `FastExec: ${(order.reasoning || order.rationale || "").slice(0, 60)}`,
          stopLoss: order.sl,
          stopLossPoints: Math.round(Math.abs(price - order.sl)),
          stopLossRiskUSD: 0,
          stopLossReason: "Claude strategic SL",
          takeProfit1: order.tp1,
          takeProfit1Points: Math.round(Math.abs(order.tp1 - price)),
          takeProfit2: order.tp2 || order.tp1,
          takeProfit2Points: 0,
          takeProfit3: order.tp3 || order.tp1,
          takeProfit3Points: 0,
          riskRewardRatio: 0,
          gexConfirmed: true, hiroConfirmed: true, tapeConfirmed: true,
          levelConfirmed: true, vannaConfirmed: true, regimeConfirmed: true,
          sgLevels: null,
          invalidation: { gammaFlipLevel: 0, gammaFlipCFD: 0, conditions: [] },
          timestamp: now.toISOString(),
          nearestLevels: [],
          confirmationDetails: [order.reasoning || order.rationale || ""],
        } as any, sessionDate);

        // Add to managed positions for trailing/management
        const fillMode = order.tradeMode || "intraday";
        _state.managedPositions.push({
          id: order.id,
          cfd: order.cfd,
          direction: order.direction,
          entryPrice: result.price || price,
          currentSL: order.sl,
          currentTP: order.tp1,
          volume: order.volume,
          mt5Ticket: result.ticket,
          breakeven: false,
          partialClosed: false,
          tp1: order.tp1,
          tp2: order.tp2,
          tp3: order.tp3,
          tradeMode: fillMode,
          manualSL: fillMode === "swing" ? true : undefined,
          lastTrailCheck: now.toISOString(),
          pyramidCount: order.pyramidOf ? 1 : 0,
          parentId: order.pyramidOf,
        });

        log(`FILLED[${fillMode}]: ${order.cfd} ${order.direction} @ $${result.price} ticket #${result.ticket}`);
      } else {
        // Track failure for cooldown
        if (!_orderFailures[order.id]) {
          _orderFailures[order.id] = { count: 0, lastFailAt: 0 };
        }
        _orderFailures[order.id].count++;
        _orderFailures[order.id].lastFailAt = now.getTime();
        const fc = _orderFailures[order.id].count;
        log(`FAILED: ${order.cfd} ${order.direction} — ${result.error} (attempt ${fc}/${MAX_FAIL_COUNT}, cooldown ${FAIL_COOLDOWN_MS/1000}s)`);
      }
    } catch (e: any) {
      _bridgeBusy = false;
      _bridgeBusySince = 0;
      if (!_orderFailures[order.id]) {
        _orderFailures[order.id] = { count: 0, lastFailAt: 0 };
      }
      _orderFailures[order.id].count++;
      _orderFailures[order.id].lastFailAt = now.getTime();
      log(`ERROR: ${order.cfd} — ${e.message} (attempt ${_orderFailures[order.id].count}/${MAX_FAIL_COUNT})`);
    } finally {
      _processingOrders.delete(order.id);
    }

    changed = true;
  }

  // ── 2. Manage open positions — Gamma-based trailing SL ─────────────────
  // Get gamma levels for intelligent trailing
  let gammaLevels: Record<string, number[]> = {};
  try {
    const { getCachedData } = require("./spotgamma-scraper");
    const md = getCachedData();
    if (md) {
      // Build sorted support/resistance levels per CFD from topStrikes + official levels
      for (const [cfd, optSym] of [["NAS100", "SPX"], ["US30", "DIA"], ["XAUUSD", "GLD"]] as const) {
        const levels: number[] = [];
        const cfdKey = cfd === "NAS100" ? "nas100" : cfd === "US30" ? "us30" : "xauusd";
        const cfdPrice = md.cfdPrices?.[cfdKey]?.price || 0;
        if (!cfdPrice) continue;

        // Official levels converted to CFD prices
        const ol = md.officialLevels?.[optSym];
        if (ol) {
          const ratio = cfdPrice / (md.assets?.find((a: any) => a.symbol === optSym)?.currentPrice || 1);
          for (const key of ["callWall", "putWall", "keyGamma", "maxGamma", "volTrigger", "zeroGamma"]) {
            const val = ol[key];
            if (val && val > 0) levels.push(Math.round(val * ratio));
          }
        }

        // Top strikes (already in CFD prices in getAgentView, but here we use raw)
        const asset = md.assets?.find((a: any) => a.symbol === optSym);
        if (asset?.topStrikes) {
          const ratio = cfdPrice / (asset.currentPrice || 1);
          for (const s of asset.topStrikes) {
            if (s.strike) levels.push(Math.round(s.strike * ratio));
          }
        }

        gammaLevels[cfd] = [...new Set(levels)].sort((a, b) => a - b);
      }
    }
  } catch {}

  for (const pos of _state.managedPositions) {
    const price = getPrice(pos.cfd);
    if (price <= 0) continue;

    // ── MANUAL SL: If Claude set the SL manually, do NOT touch it ──
    if (pos.manualSL) continue;

    const isLong = pos.direction === "LONG";
    const pnlPoints = isLong ? price - pos.entryPrice : pos.entryPrice - price;
    const riskPoints = Math.abs(pos.entryPrice - pos.currentSL);

    // ── UNIFIED SL MANAGEMENT: Calculate best SL, apply ONCE per cycle ──
    // This prevents breakeven and gamma-trail from fighting each other.
    let bestSL = pos.currentSL; // start with current
    let slReason = "";

    // ── MODE-AWARE SL MANAGEMENT ──
    const modeConfig = getModeConfig(pos.tradeMode);

    // Step 1: Breakeven — threshold and buffer depend on trade mode
    const beThreshold = riskPoints * modeConfig.breakevenR;
    if (!pos.breakeven && pnlPoints >= beThreshold && riskPoints > 0) {
      const beBuffer = modeConfig.breakevenBuffer[pos.cfd] || 5;
      const breakevenSL = isLong ? pos.entryPrice + beBuffer : pos.entryPrice - beBuffer;
      const isSafeMove = isLong ? breakevenSL > pos.currentSL : breakevenSL < pos.currentSL;
      if (isSafeMove) {
        bestSL = breakevenSL;
        slReason = `BREAKEVEN[${pos.tradeMode||"intraday"}] profit=${pnlPoints.toFixed(0)}pts >= ${modeConfig.breakevenR}R(${beThreshold.toFixed(0)}pts)`;
        pos.breakeven = true;
      }
    }

    // Step 2: Trail — type and throttle depend on trade mode
    if (pos.breakeven) {
      // SWING throttle: only trail every 4h
      let skipTrail = false;
      if (modeConfig.trailThrottleMs > 0 && pos.lastTrailCheck) {
        const elapsed = now.getTime() - new Date(pos.lastTrailCheck).getTime();
        if (elapsed < modeConfig.trailThrottleMs) skipTrail = true;
      }

      if (!skipTrail) {
        if (modeConfig.trailType === "fixed") {
          // SCALP: tight fixed trail behind price
          const dist = modeConfig.trailFixed[pos.cfd] || 8;
          const fixedSL = isLong ? price - dist : price + dist;
          const isMoreProtective = isLong ? fixedSL > bestSL : fixedSL < bestSL;
          const isAboveEntry = isLong ? fixedSL > pos.entryPrice : fixedSL < pos.entryPrice;
          if (isMoreProtective && isAboveEntry) {
            bestSL = fixedSL;
            slReason = `FIXED-TRAIL[scalp] dist=${dist}pts price=$${price}`;
          }
        } else {
          // INTRADAY/SWING: gamma-trail with mode-specific buffer
          const levels = gammaLevels[pos.cfd] || [];
          if (levels.length > 0) {
            let bestTrailLevel = 0;
            const buffer = modeConfig.gammaTrailBuffer[pos.cfd] || 15;

            if (isLong) {
              for (const level of levels) {
                if (level < price - buffer && level > pos.entryPrice) {
                  const candidate = level - buffer;
                  if (candidate > bestTrailLevel) bestTrailLevel = candidate;
                }
              }
            } else {
              for (const level of [...levels].reverse()) {
                if (level > price + buffer && level < pos.entryPrice) {
                  const candidate = level + buffer;
                  if (bestTrailLevel === 0 || candidate < bestTrailLevel) bestTrailLevel = candidate;
                }
              }
            }

            if (bestTrailLevel > 0) {
              const isMoreProtective = isLong ? bestTrailLevel > bestSL : bestTrailLevel < bestSL;
              const isProtective = isLong ? bestTrailLevel > pos.entryPrice : bestTrailLevel < pos.entryPrice;
              if (isMoreProtective && isProtective) {
                bestSL = bestTrailLevel;
                slReason = `GAMMA-TRAIL[${pos.tradeMode||"intraday"}] level=$${bestTrailLevel} price=$${price}`;
              }
            }
          }
        }
        pos.lastTrailCheck = now.toISOString();
      }
    }

    // Step 3: Apply the best SL if it changed (ONLY ONCE per cycle)
    if (bestSL !== pos.currentSL && !_bridgeBusy) {
      const shouldMove = isLong ? bestSL > pos.currentSL : bestSL < pos.currentSL;
      if (shouldMove) {
        try {
          _bridgeBusy = true;
          _bridgeBusySince = Date.now();
          await modifySL(pos.mt5Ticket, bestSL);
          _bridgeBusy = false;
          _bridgeBusySince = 0;
          log(`SL-UPDATE: ${pos.cfd} #${pos.mt5Ticket} SL $${pos.currentSL}→$${bestSL} (${slReason})`);
          pos.currentSL = bestSL;
          changed = true;
        } catch { _bridgeBusy = false; _bridgeBusySince = 0; }
      }
    }

    // Legacy gamma-trail block removed — unified above
    if (false) {
      const levels = gammaLevels[pos.cfd] || [];

      // Fallback: simple percentage trail if no gamma levels available
      if (levels.length === 0 && pos.trailDistance) {
        const trailSL = isLong ? price - pos.trailDistance : price + pos.trailDistance;
        const shouldTrail = isLong ? trailSL > pos.currentSL : trailSL < pos.currentSL;
        if (shouldTrail) {
          try {
            await modifySL(pos.mt5Ticket, trailSL);
            pos.currentSL = trailSL;
            changed = true;
          } catch {}
        }
      }
    }
  }

  // Clean up filled/expired orders older than 1 hour
  _state.pendingOrders = _state.pendingOrders.filter(o =>
    o.status === "pending" || (new Date().getTime() - new Date(o.createdAt).getTime() < 3600_000)
  );

  _state.lastPriceCheck = now.toISOString();
  // Save when orders changed, or every ~10s to update lastPriceCheck (proves executor is alive)
  if (changed || now.getSeconds() % 10 === 0) saveOrders(_state);

  } finally {
    _executing = false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function startFastExecutor() {
  if (_interval) return;
  log("Started — checking prices every 500ms");

  // Start SpotGamma live price loop (5s) for ETF trigger matching
  startSGLivePriceLoop();

  // Initialize orders file if missing
  if (!fs.existsSync(ORDERS_FILE)) {
    saveOrders({ pendingOrders: [], managedPositions: [], lastPriceCheck: "" });
  }

  _interval = setInterval(() => {
    executionCycle().catch(e => console.warn(`[EXECUTOR] Cycle error: ${e.message}`));
  }, 500);
}

export function stopFastExecutor() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  if (_sgLivePriceInterval) {
    clearInterval(_sgLivePriceInterval);
    _sgLivePriceInterval = null;
  }
  log("Stopped");
}

export function getExecutorStatus() {
  const state = loadOrders();
  const pending = state.pendingOrders.filter(o => o.status === "pending");
  return {
    running: _interval !== null,
    pendingOrders: pending.length,
    pendingDetails: pending.map(o => ({
      id: o.id, cfd: o.cfd, direction: o.direction,
      entryZone: o.entryZone, entryMode: o.entryMode || "zone",
      exactLevel: o.exactLevel, sl: o.sl, tp1: o.tp1,
      tradeMode: o.tradeMode || "intraday",
      triggerSymbol: o.triggerSymbol, triggerLevel: o.triggerLevel,
      rationale: o.rationale || o.reasoning,
      expiresAt: o.expiresAt, pyramidOf: o.pyramidOf,
    })),
    managedPositions: state.managedPositions.length,
    prices: { ..._priceCache, ..._sgLivePrices },
    lastCheck: state.lastPriceCheck,
  };
}
