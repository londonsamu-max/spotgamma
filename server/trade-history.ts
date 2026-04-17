/**
 * Trade History — persistent JSON-based trade log for backtesting
 * Stores every setup generated (score >= 75) with outcome tracking
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { modifySL as mt5ModifySL, closePosition as mt5ClosePosition } from "./mt5-file-bridge";
import { learnFromLiveTrade } from "./online-learning";

// ── Reward shaping helpers (mirrors historical-simulator logic) ───────────────
function computeSkewMult(neSkew: number, direction: "LONG" | "SHORT"): number {
  if (neSkew < -0.05 && direction === "SHORT") return 1.15;
  if (neSkew > 0.05  && direction === "LONG")  return 1.15;
  if (neSkew < -0.05 && direction === "LONG")  return 0.85;
  if (neSkew > 0.05  && direction === "SHORT") return 0.85;
  return 1.0;
}
function computeVRPMult(vrp: number): number {
  if (vrp > 0.08) return 0.90;
  if (vrp > 0.04) return 0.95;
  if (vrp < -0.02) return 1.05;
  return 1.0;
}
function computeCandleMult(signal: string | undefined, direction: "LONG" | "SHORT"): number {
  if (!signal || signal === "neutral") return 1.0;
  if ((signal === "bullish" && direction === "LONG") || (signal === "bearish" && direction === "SHORT")) return 1.10;
  return 0.88;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(__dirname, "../data/trade-history.json");

// ============ INTERFACES ============

export interface TradeRecord {
  id: string;                    // "{sessionDate}_{cfd}_{direction}"
  sessionDate: string;           // "2026-03-19"
  generatedAt: string;           // ISO timestamp when setup was logged
  resolvedAt?: string;           // ISO timestamp when outcome was set
  cfd: string;                   // NAS100 / US30 / XAUUSD
  direction: "LONG" | "SHORT";
  score: number;                 // 0-100
  confirmations: number;         // 0-6
  confirmationDetails: string[]; // ["gex","hiro","level","tape","vanna","regime"]
  cfdEntryPrice: number;
  stopLoss: number;
  stopLossPoints: number;
  takeProfit1: number;
  takeProfit1Points: number;
  takeProfit2: number;
  takeProfit2Points: number;
  takeProfit3: number;
  takeProfit3Points: number;
  riskRewardRatio: number;
  ivRank: number;
  ivRegime: string;
  skewBias: string;
  vrp: number;
  gexDetail: string;
  invalidationLevel: number;
  outcome: "open" | "tp1" | "tp2" | "tp3" | "sl" | "cancelled" | "session_close";
  exitPrice?: number;
  pnlPoints?: number;            // positive = profit, negative = loss
  notes?: string;
  // Trailing SL state (auto-managed after partial TP hits)
  trailingStop?: number;         // current effective SL (moves to BE after TP1, to TP1 after TP2)
  tp1HitAt?: string;             // ISO timestamp — TP1 was crossed, SL moved to breakeven
  midTP1TP2HitAt?: string;       // ISO timestamp — midpoint TP1-TP2 crossed, SL moved to TP1
  tp2HitAt?: string;             // ISO timestamp — TP2 was crossed, SL moved to TP1
  // MT5 execution fields
  mt5Ticket?: number;            // MT5 order ticket (set when executed via bridge)
  mt5Volume?: number;            // Lot size used in MT5
  mt5ExecutedAt?: string;        // ISO timestamp when the order was sent to MT5
  mt5ExecutedPrice?: number;     // Actual fill price returned by MT5
  // Market session tracking (for out-of-hours analysis)
  marketSession?: string;        // "pre_market" | "market_open" | "after_hours" | "overnight"
  etHourAtEntry?: number;        // ET hour when trade was generated (0-23)
  nyseOpen?: boolean;            // true if NYSE was open when trade was generated
  // PPO agent fields (set when trade is logged)
  rlState?: any;      // legacy compat
  rlAction?: any;     // legacy compat
  rlMultiplier?: number;
  policyActions?: any;
  // Direction Q-table (5th table)
  rlMarketStateKey?: string;    // 6-dim market state key for direction table
  rlDirectionAction?: number;   // 0=LONG, 1=SHORT, 2=SKIP
  // Full unified RL decision (getFullRLDecision) — for live learning loop
  rlUnifiedState?: any;   // legacy compat (PPO Puro)
  rlFullActions?: {                                      // what the agent decided
    directionAction: number;   // 0=LONG, 1=SHORT, 2=SKIP
    entryLevelAction: number;  // 0=dominant, 1=reaction, 2=key
    riskAction: number;        // 0=tight, 1=normal, 2=wide
  };
  rlNeSkewAtEntry?: number;    // ne_skew at entry (for reward shaping on resolution)
  rlVRPAtEntry?: number;       // VRP at entry (atm_iv30 - rv30)
  rlCandleSignalAtEntry?: string; // candlestick signal at entry ("bullish"|"bearish"|"neutral")
  // PPO/Multi-head online learning fields
  ppoStateAtEntry?: number[];   // normalized 46-feature state vector at entry
  ppoHeadActions?: Record<string, number>; // head choices at entry (8 heads)
  ppoHeadLogProbs?: Record<string, number>; // log probs at entry
  ppoRisk?: string;             // risk level chosen by PPO
  // Context for reward shaping (Fase 3 PPO Puro)
  ppoContext?: {
    sessionType?: number;
    macroAlertActive?: boolean;
    counterTrendDetected?: boolean;
    imExhaustionLevel?: number;
    overExtensionDecision?: string;
    entryQualityDecision?: string;
    actualEntryQuality?: string;
    sizing?: string;
  };
}

export interface TradeStats {
  total: number;
  open: number;
  resolved: number;
  wins: number;                  // tp1 + tp2 + tp3
  losses: number;                // sl
  cancelled: number;
  winRate: number;               // wins / (wins + losses) * 100
  avgRR: number;                 // average RR of resolved trades
  avgPnlPoints: number;
  bestStreak: number;
  currentStreak: number;         // positive = win streak, negative = loss streak
  byCfd: Record<string, { total: number; wins: number; losses: number; winRate: number }>;
  byScore: { high: { total: number; wins: number }; med: { total: number; wins: number }; low: { total: number; wins: number } };
}

// ============ FILE I/O ============

export function loadHistory(): TradeRecord[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw) as TradeRecord[];
  } catch {
    return [];
  }
}

export function saveHistory(records: TradeRecord[]): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2), "utf-8");
  } catch (e: any) {
    console.error("[HISTORY] Save error:", e.message);
  }
}

// ============ CRUD ============

// Lookback window: block re-entry if same level was already logged within this window
// Extended to 12h because 24/7 monitoring creates setups at 1am that fall outside 4h window by 7am
const SAME_LEVEL_LOOKBACK_MS = 12 * 60 * 60 * 1000;  // 12 hours

// After a SL, enforce a mandatory cooldown before re-entering same direction
const MIN_POST_SL_GAP_MS = 3 * 60 * 60 * 1000;  // 3 hours after a SL hit (was 90 min)

// Minimum entry-level movement to qualify as a "new" setup (different level)
const MIN_LEVEL_CHANGE_PTS: Record<string, number> = {
  NAS100: 80,   // ~80 NAS100 points
  US30:   400,  // ~400 US30 points
  XAUUSD: 20,   // ~$20 gold
};

/**
 * Log a new setup. Deduplication rules:
 *   1. Within 4h window: if ANY open/sl record at same level (< MIN_LEVEL_CHANGE_PTS) → skip.
 *   2. Within 90m post-SL: block re-entry even if level moved (avoid revenge trades).
 *   3. Direction change (SHORT→LONG) always allowed immediately.
 */
export function logSetupIfNew(setup: any, sessionDate: string): TradeRecord | null {
  const records = loadHistory();
  const now     = Date.now();

  // All records for this CFD+direction (any outcome except cancelled) within the lookback window
  const windowStart = now - SAME_LEVEL_LOOKBACK_MS;
  const recent = records
    .filter(r =>
      r.cfd === setup.cfd &&
      r.direction === setup.direction &&
      r.outcome !== "cancelled" &&
      new Date(r.generatedAt).getTime() >= windowStart,
    )
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

  for (const r of recent) {
    const ageSinceMs   = now - new Date(r.generatedAt).getTime();
    const levelDelta   = Math.abs((setup.cfdEntryPrice || 0) - r.cfdEntryPrice);
    const minLvlChange = MIN_LEVEL_CHANGE_PTS[setup.cfd] ?? 50;
    const sameLevel    = levelDelta < minLvlChange;

    // Post-SL cooldown: block any re-entry for 90 min after a stop-out
    if (r.outcome === "sl" && ageSinceMs < MIN_POST_SL_GAP_MS) {
      return null;
    }

    // Same level within 4h lookback — skip (already tracking this setup)
    if (sameLevel) return null;
  }

  // Unique ID: date + cfd + direction + unix seconds (allows multiple per day)
  const id = `${sessionDate}_${setup.cfd}_${setup.direction}_${Math.floor(now / 1000)}`;

  const confKeys   = ["gexConfirmed","hiroConfirmed","tapeConfirmed","levelConfirmed","vannaConfirmed","regimeConfirmed"];
  const confLabels = ["gex","hiro","tape","level","vanna","regime"];
  const confirmationDetails = confLabels.filter((_, i) => setup[confKeys[i]]);

  // ── Market session at entry ───────────────────────────────────────
  const etNow    = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etHour   = etNow.getHours();
  const etMin    = etNow.getMinutes();
  const etMins   = etHour * 60 + etMin;
  const nyseOpen = etMins >= 570 && etMins < 960; // 9:30 AM - 4:00 PM ET
  const marketSession =
    etMins < 270  ? "overnight"   :  // before 4:30 AM ET
    etMins < 570  ? "pre_market"  :  // 4:30 AM - 9:30 AM ET
    etMins < 960  ? "market_open" :  // 9:30 AM - 4:00 PM ET
                    "after_hours";   // after 4:00 PM ET

  const record: TradeRecord = {
    id,
    sessionDate,
    generatedAt: new Date().toISOString(),
    cfd: setup.cfd,
    direction: setup.direction,
    score: setup.score || 0,
    confirmations: confirmationDetails.length,
    confirmationDetails,
    cfdEntryPrice: setup.cfdEntryPrice || 0,
    stopLoss: setup.stopLoss || 0,
    stopLossPoints: setup.stopLossPoints || 0,
    takeProfit1: setup.takeProfit1 || 0,
    takeProfit1Points: setup.takeProfit1Points || 0,
    takeProfit2: setup.takeProfit2 || 0,
    takeProfit2Points: setup.takeProfit2Points || 0,
    takeProfit3: setup.takeProfit3 || 0,
    takeProfit3Points: setup.takeProfit3Points || 0,
    riskRewardRatio: setup.riskRewardRatio || 0,
    ivRank: setup.ivRank || 0,
    ivRegime: setup.ivRegime || "normal_iv",
    skewBias: setup.skewBias || "neutral",
    vrp: setup.vrp || 0,
    gexDetail: setup.gexDetail || "",
    invalidationLevel: setup.invalidation?.gammaFlipLevel || 0,
    outcome: "open",
    marketSession,
    etHourAtEntry: etHour,
    nyseOpen,
    // RL direction table fields
    rlMarketStateKey: setup.adaptivePolicy?.rlMarketStateKey,
    rlDirectionAction: setup.adaptivePolicy?.rlDirectionAction,
  };

  records.push(record);
  saveHistory(records);
  console.log(`[HISTORY] Logged ${record.cfd} ${record.direction} score=${record.score} id=${id}`);
  return record;
}

/** Auto-resolve open trades based on current CFD price. Implements trailing SL. */
export function autoResolveOpen(cfdPrices: Record<string, number>): void {
  const records = loadHistory();
  let changed = false;

  for (const r of records) {
    if (r.outcome !== "open") continue;
    const price = cfdPrices[r.cfd];
    if (!price || price <= 0) continue;

    const isSHORT = r.direction === "SHORT";
    const now     = new Date().toISOString();

    // Effective SL: use trailing stop if set, else original SL
    const effectiveSL = r.trailingStop ?? r.stopLoss;

    // Price comparisons
    const slHit  = isSHORT ? price >= effectiveSL     : price <= effectiveSL;
    const tp1Hit = isSHORT ? price <= r.takeProfit1   : price >= r.takeProfit1;
    const tp2Hit = isSHORT ? price <= r.takeProfit2   : price >= r.takeProfit2;
    const tp3Hit = isSHORT ? price <= r.takeProfit3   : price >= r.takeProfit3;

    // Midpoint between TP1 and TP2 (for intermediate trailing stop)
    const midTP1TP2 = isSHORT
      ? r.cfdEntryPrice - (r.takeProfit1Points + (r.takeProfit2Points - r.takeProfit1Points) * 0.5)
      : r.cfdEntryPrice + (r.takeProfit1Points + (r.takeProfit2Points - r.takeProfit1Points) * 0.5);
    const midHit = isSHORT ? price <= midTP1TP2 : price >= midTP1TP2;

    if (tp3Hit) {
      // TP3 reached — final close (best outcome)
      r.outcome    = "tp3";
      r.exitPrice  = r.takeProfit3;
      r.pnlPoints  = r.takeProfit3Points;
      r.resolvedAt = now;
      console.log(`[HISTORY] Auto-resolved ${r.cfd} ${r.direction} → TP3 @ ${r.takeProfit3}`);
      changed = true;
      // RL legacy + unified learning removed (PPO Puro phase — dead code cleaned up)
      // PPO Online Learning — update neural network weights with real trade result
      learnFromLiveTrade(
        r.id, r.cfd, r.direction, "tp3", r.pnlPoints,
        r.ppoStateAtEntry, r.ppoHeadActions, r.ppoHeadLogProbs, r.ppoRisk,
        r.ppoContext,
      ).catch(e => console.warn(`[ONLINE] TP3 learn error: ${(e as Error).message}`));

    } else if (tp2Hit && !r.tp2HitAt) {
      // TP2 crossed — move SL to TP1 (lock partial profit), keep trade open
      // Also stamp TP1 and midpoint if they weren't already (price may have skipped)
      r.tp2HitAt     = now;
      if (!r.tp1HitAt) r.tp1HitAt = now;
      if (!r.midTP1TP2HitAt) r.midTP1TP2HitAt = now;
      r.trailingStop = r.takeProfit1;  // SL at TP1 level — always the best position after TP2
      const note = `TP2 alcanzado @ ${r.takeProfit2} (${now.slice(0,16)}), SL movido a TP1 (${r.takeProfit1})`;
      r.notes = r.notes ? `${r.notes} | ${note}` : note;
      console.log(`[HISTORY] ${r.cfd} ${r.direction} → TP2 hit, SL → TP1 @ ${r.takeProfit1}`);
      changed = true;

      // FIX 2: Modify SL on MT5
      if (r.mt5Ticket && r.mt5Ticket > 0) {
        mt5ModifySL(r.mt5Ticket, r.trailingStop).then(res => {
          if (res.success) console.log(`[MT5-TRAIL] SL modified ticket #${r.mt5Ticket} → ${r.trailingStop}`);
          else console.warn(`[MT5-TRAIL] Failed to modify SL: ${res.error}`);
        }).catch(e => console.warn(`[MT5-TRAIL] Error: ${(e as Error).message}`));
      }

    } else if (midHit && r.tp1HitAt && !r.midTP1TP2HitAt && !r.tp2HitAt) {
      // Midpoint TP1-TP2 crossed — move SL to TP1 (intermediate step)
      r.midTP1TP2HitAt = now;
      r.trailingStop = r.takeProfit1;
      const note = `Midpoint TP1-TP2 alcanzado @ ${midTP1TP2.toFixed(2)} (${now.slice(0,16)}), SL movido a TP1 (${r.takeProfit1})`;
      r.notes = r.notes ? `${r.notes} | ${note}` : note;
      console.log(`[HISTORY] ${r.cfd} ${r.direction} → Mid TP1-TP2 hit, SL → TP1 @ ${r.takeProfit1}`);
      changed = true;

      // FIX 2: Modify SL on MT5
      if (r.mt5Ticket && r.mt5Ticket > 0) {
        mt5ModifySL(r.mt5Ticket, r.trailingStop).then(res => {
          if (res.success) console.log(`[MT5-TRAIL] SL modified ticket #${r.mt5Ticket} → ${r.trailingStop}`);
          else console.warn(`[MT5-TRAIL] Failed to modify SL: ${res.error}`);
        }).catch(e => console.warn(`[MT5-TRAIL] Error: ${(e as Error).message}`));
      }

    } else if (tp1Hit && !r.tp1HitAt) {
      // TP1 crossed (and TP2 not yet hit) — move SL to breakeven
      // Guard: only downgrade trailing SL if TP2 hasn't already pushed it higher
      if (!r.tp2HitAt) {
        r.trailingStop = r.cfdEntryPrice;
      }
      r.tp1HitAt = now;
      const note = `TP1 alcanzado @ ${r.takeProfit1} (${now.slice(0,16)}), SL movido a breakeven (${r.cfdEntryPrice})`;
      r.notes = r.notes ? `${r.notes} | ${note}` : note;
      console.log(`[HISTORY] ${r.cfd} ${r.direction} → TP1 hit, SL → BE @ ${r.cfdEntryPrice}`);
      changed = true;

      // FIX 2: Modify SL on MT5
      if (r.mt5Ticket && r.mt5Ticket > 0) {
        mt5ModifySL(r.mt5Ticket, r.trailingStop!).then(res => {
          if (res.success) console.log(`[MT5-TRAIL] SL modified ticket #${r.mt5Ticket} → ${r.trailingStop}`);
          else console.warn(`[MT5-TRAIL] Failed to modify SL: ${res.error}`);
        }).catch(e => console.warn(`[MT5-TRAIL] Error: ${(e as Error).message}`));
      }

    } else if (slHit) {
      // SL hit (original or trailing)
      r.outcome    = "sl";
      r.exitPrice  = price;
      r.pnlPoints  = isSHORT ? r.cfdEntryPrice - price : price - r.cfdEntryPrice;
      r.resolvedAt = now;
      const slType = r.trailingStop !== undefined ? "trailing SL" : "SL";
      console.log(`[HISTORY] Auto-resolved ${r.cfd} ${r.direction} → ${slType} @ ${price} (effective SL: ${effectiveSL})`);
      changed = true;
      // RL legacy + unified learning removed (PPO Puro phase — dead code cleaned up)
      // PPO Online Learning — update neural network weights with real trade result
      learnFromLiveTrade(
        r.id, r.cfd, r.direction, "sl", r.pnlPoints,
        r.ppoStateAtEntry, r.ppoHeadActions, r.ppoHeadLogProbs, r.ppoRisk,
        r.ppoContext,
      ).catch(e => console.warn(`[ONLINE] SL learn error: ${(e as Error).message}`));
    }
  }

  if (changed) saveHistory(records);
}

/** Manually resolve a trade. */
export function resolveRecord(
  id: string,
  outcome: TradeRecord["outcome"],
  exitPrice?: number
): TradeRecord | null {
  const records = loadHistory();
  const record = records.find(r => r.id === id);
  if (!record) return null;

  record.outcome = outcome;
  record.resolvedAt = new Date().toISOString();

  // RL legacy + unified learning removed (PPO Puro phase — dead code cleaned up)

  if (exitPrice !== undefined) {
    record.exitPrice = exitPrice;
    const isSHORT = record.direction === "SHORT";
    record.pnlPoints = isSHORT
      ? record.cfdEntryPrice - exitPrice
      : exitPrice - record.cfdEntryPrice;
  } else {
    // Use TP level as exit price estimate
    const tpMap: Record<string, number> = {
      tp1: record.takeProfit1, tp2: record.takeProfit2, tp3: record.takeProfit3,
      sl: record.stopLoss,
    };
    if (tpMap[outcome]) {
      record.exitPrice = tpMap[outcome];
      const isSHORT = record.direction === "SHORT";
      record.pnlPoints = outcome === "sl"
        ? -(record.stopLossPoints)
        : (isSHORT ? record.cfdEntryPrice - tpMap[outcome] : tpMap[outcome] - record.cfdEntryPrice);
    }
  }

  // PPO Online Learning — update neural network weights with manual resolution
  if (outcome !== "open" && outcome !== "cancelled") {
    learnFromLiveTrade(
      record.id, record.cfd, record.direction, outcome, record.pnlPoints,
      record.ppoStateAtEntry, record.ppoHeadActions, record.ppoHeadLogProbs, record.ppoRisk,
      record.ppoContext,
    ).catch(e => console.warn(`[ONLINE] Manual resolve learn error: ${(e as Error).message}`));
  }

  saveHistory(records);
  return record;
}

/** Delete a record by id. */
export function deleteRecord(id: string): boolean {
  const records = loadHistory();
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return false;
  records.splice(idx, 1);
  saveHistory(records);
  return true;
}

// ============ STATS ============

export function getStats(records: TradeRecord[]): TradeStats {
  const resolved = records.filter(r => r.outcome !== "open" && r.outcome !== "cancelled");
  const wins = resolved.filter(r => ["tp1","tp2","tp3"].includes(r.outcome));
  const losses = resolved.filter(r => r.outcome === "sl");

  const winRate = (wins.length + losses.length) > 0
    ? Math.round(wins.length / (wins.length + losses.length) * 100)
    : 0;

  const avgRR = resolved.length > 0
    ? Math.round(resolved.reduce((s, r) => s + (r.riskRewardRatio || 0), 0) / resolved.length * 10) / 10
    : 0;

  const avgPnlPoints = resolved.length > 0
    ? Math.round(resolved.reduce((s, r) => s + (r.pnlPoints || 0), 0) / resolved.length * 10) / 10
    : 0;

  // Streak calculation
  let bestStreak = 0;
  let currentStreak = 0;
  let streak = 0;
  const sortedResolved = [...resolved].sort((a, b) =>
    new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime()
  );
  for (const r of sortedResolved) {
    const isWin = ["tp1","tp2","tp3"].includes(r.outcome);
    if (isWin) {
      streak = streak > 0 ? streak + 1 : 1;
    } else {
      streak = streak < 0 ? streak - 1 : -1;
    }
    if (streak > bestStreak) bestStreak = streak;
  }
  currentStreak = streak;

  // By CFD
  const cfds = ["NAS100","US30","XAUUSD"];
  const byCfd: TradeStats["byCfd"] = {};
  for (const cfd of cfds) {
    const cfdRecords = resolved.filter(r => r.cfd === cfd);
    const cfdWins = cfdRecords.filter(r => ["tp1","tp2","tp3"].includes(r.outcome)).length;
    const cfdLosses = cfdRecords.filter(r => r.outcome === "sl").length;
    byCfd[cfd] = {
      total: cfdRecords.length,
      wins: cfdWins,
      losses: cfdLosses,
      winRate: (cfdWins + cfdLosses) > 0 ? Math.round(cfdWins / (cfdWins + cfdLosses) * 100) : 0,
    };
  }

  // By score bracket
  const high = resolved.filter(r => r.score >= 90);
  const med  = resolved.filter(r => r.score >= 75 && r.score < 90);
  const low  = resolved.filter(r => r.score < 75);
  const countWins = (arr: TradeRecord[]) => arr.filter(r => ["tp1","tp2","tp3"].includes(r.outcome)).length;

  return {
    total: records.length,
    open: records.filter(r => r.outcome === "open").length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    cancelled: records.filter(r => r.outcome === "cancelled").length,
    winRate,
    avgRR,
    avgPnlPoints,
    bestStreak,
    currentStreak,
    byCfd,
    byScore: {
      high: { total: high.length, wins: countWins(high) },
      med:  { total: med.length,  wins: countWins(med)  },
      low:  { total: low.length,  wins: countWins(low)  },
    },
  };
}

// ============ FIX 6: MACRO EVENT PROTECTION ============

/**
 * Tighten SL to breakeven on all open trades when a macro event is imminent (< 30 min).
 * If trade hasn't hit TP1 yet, move SL to breakeven.
 * If TP1 already hit, tighten SL to TP1 (lock profit).
 */
export function protectBeforeMacro(
  cfdPrices: Record<string, number>,
  macroAlert: { isActive: boolean; hoursUntil: number; event: string },
): void {
  if (!macroAlert.isActive || macroAlert.hoursUntil > 0.5 || macroAlert.hoursUntil < 0) return;

  const records = loadHistory();
  let changed = false;

  for (const r of records) {
    if (r.outcome !== "open") continue;
    const price = cfdPrices[r.cfd];
    if (!price) continue;

    // If TP1 already hit — tighten SL to TP1 (lock profit)
    if (r.tp1HitAt) {
      if (!r.trailingStop || r.trailingStop < r.takeProfit1) {
        r.trailingStop = r.takeProfit1;
        r.notes = (r.notes || "") + ` | Macro ${macroAlert.event}: SL → TP1`;
        changed = true;
      }
    } else {
      // TP1 not hit — move SL to breakeven at minimum
      r.trailingStop = r.cfdEntryPrice;
      r.notes = (r.notes || "") + ` | Macro ${macroAlert.event}: SL → BE (protección pre-noticia)`;
      changed = true;
    }

    // Call MT5 modifySL
    if (r.mt5Ticket && r.mt5Ticket > 0 && r.trailingStop) {
      mt5ModifySL(r.mt5Ticket, r.trailingStop).catch(e =>
        console.warn(`[MACRO-PROTECT] Error modifying SL: ${(e as Error).message}`)
      );
    }

    console.log(`[MACRO-PROTECT] ${r.cfd} ${r.direction}: SL → ${r.trailingStop} (${macroAlert.event} in ${(macroAlert.hoursUntil * 60).toFixed(0)}min)`);
  }

  if (changed) saveHistory(records);
}

// ============ FIX 12: SESSION CLOSE AT 3:50PM ET ============

/**
 * Close all open intraday positions near market close (3:50pm ET).
 * Prevents overnight gap risk.
 */
export function sessionCloseCheck(cfdPrices: Record<string, number>): void {
  // Check if it's near market close (3:50-4:00 ET)
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  // Simple EDT check (March-November)
  const mo = now.getUTCMonth() + 1;
  const isEDT = mo > 3 && mo < 11; // simplified
  const etH = ((utcH + (isEDT ? -4 : -5)) % 24 + 24) % 24;
  const etMins = etH * 60 + utcM;

  // 3:50pm ET = 950 mins, market closes 4pm = 960 mins
  if (etMins < 950 || etMins >= 960) return;

  const records = loadHistory();
  let changed = false;

  for (const r of records) {
    if (r.outcome !== "open") continue;
    const price = cfdPrices[r.cfd];
    if (!price) continue;

    const isSHORT = r.direction === "SHORT";
    r.outcome = "session_close";
    r.exitPrice = price;
    r.pnlPoints = isSHORT ? r.cfdEntryPrice - price : price - r.cfdEntryPrice;
    r.resolvedAt = new Date().toISOString();
    r.notes = (r.notes || "") + ` | Cierre de sesión 3:50pm ET`;

    // Close on MT5 too
    if (r.mt5Ticket && r.mt5Ticket > 0) {
      mt5ClosePosition(r.mt5Ticket).then(res => {
        if (res.success) console.log(`[SESSION-CLOSE] Cerrado ticket #${r.mt5Ticket} @ ${price}`);
        else console.warn(`[SESSION-CLOSE] ${res.error}`);
      }).catch(e => console.warn(`[SESSION-CLOSE] Error: ${(e as Error).message}`));
    }

    console.log(`[SESSION-CLOSE] ${r.cfd} ${r.direction}: cerrado @ ${price} (P&L: ${r.pnlPoints?.toFixed(1)} pts)`);
    changed = true;
  }

  if (changed) saveHistory(records);
}

// ============ FIX 13: MAX DAILY LOSS PROTECTION ============

const MAX_DAILY_LOSSES = 3;   // max SL hits per day
const MAX_DAILY_LOSS_USD = 30; // max $ loss per day

/**
 * Check if daily loss limit has been reached.
 * Returns true if trading should be blocked.
 */
export function isDailyLossLimitReached(): boolean {
  const records = loadHistory();
  const today = new Date().toISOString().slice(0, 10);

  const todayLosses = records.filter(r =>
    r.resolvedAt?.startsWith(today) &&
    (r.outcome === "sl" || (r.pnlPoints !== undefined && r.pnlPoints < 0))
  );

  const lossCount = todayLosses.length;
  const totalLossUSD = todayLosses.reduce((sum, r) => {
    if (r.pnlPoints === undefined || r.pnlPoints >= 0) return sum;
    const spec: Record<string, number> = { NAS100: 0.10, US30: 0.10, XAUUSD: 1.00 };
    return sum + Math.abs(r.pnlPoints) * (spec[r.cfd] || 0.01);
  }, 0);

  if (lossCount >= MAX_DAILY_LOSSES) {
    console.log(`[RISK] Daily loss limit: ${lossCount} SLs today (max ${MAX_DAILY_LOSSES}) — BLOCKED`);
    return true;
  }
  if (totalLossUSD >= MAX_DAILY_LOSS_USD) {
    console.log(`[RISK] Daily loss limit: $${totalLossUSD.toFixed(2)} lost today (max $${MAX_DAILY_LOSS_USD}) — BLOCKED`);
    return true;
  }

  return false;
}
