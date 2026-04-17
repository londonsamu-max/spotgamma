/**
 * session-tracker.ts
 *
 * Tracks intraday context that requires persistent state across refresh cycles:
 *   - Session open / high / low / prev-close per analysis asset
 *   - Level touch count (freshness)
 *   - Macro event calendar (FOMC, CPI, NFP)
 *   - DXY / TLT prices (for XAUUSD context)
 */

import fs from "fs";
import path from "path";

// ─── File paths ───────────────────────────────────────────────────────────────
const SESSION_FILE = path.join(process.cwd(), "data", "session-prices.json");
const TOUCHES_FILE = path.join(process.cwd(), "data", "level-touches.json");
const MACRO_FILE   = path.join(process.cwd(), "data", "macro-events.json");

// ─── Internal types ───────────────────────────────────────────────────────────
interface AssetSession {
  openPrice:   number;   // first price at or after 9:30 ET
  prevClose:   number;   // last recorded price of the previous session
  sessionHigh: number;
  sessionLow:  number;
  openSet:     boolean;
}

interface SessionStore {
  date:   string;
  assets: Record<string, AssetSession>;
  dxy:    number;
  tlt:    number;
}

interface LevelTouches {
  [symbol: string]: { [levelKey: string]: string[] }; // ISO timestamps
}

interface MacroEventDef {
  date:   string;              // "YYYY-MM-DD" in ET
  event:  string;              // "FOMC" | "CPI" | "NFP" | ...
  time:   string;              // "HH:MM" 24-h ET
  impact: "high" | "medium";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getETMins(): number {
  const et = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [h, m] = et.split(":").map(Number);
  return h * 60 + m;
}

// ─── Session store ────────────────────────────────────────────────────────────
let _session: SessionStore | null = null;

function loadSession(): SessionStore {
  const today = getTodayET();
  if (_session?.date === today) return _session;

  let stored: SessionStore | null = null;
  try {
    if (fs.existsSync(SESSION_FILE))
      stored = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as SessionStore;
  } catch { /* ignore */ }

  if (stored?.date === today) {
    _session = stored;
    return _session;
  }

  // New trading day — roll prevClose from yesterday's session high/low mid
  const prevAssets: Record<string, AssetSession> = {};
  if (stored) {
    for (const [sym, d] of Object.entries(stored.assets)) {
      const closeProxy =
        d.sessionHigh > 0 && d.sessionLow < Infinity
          ? (d.sessionHigh + d.sessionLow) / 2
          : d.openPrice || d.prevClose;
      prevAssets[sym] = {
        openPrice: 0, prevClose: closeProxy,
        sessionHigh: 0, sessionLow: Infinity, openSet: false,
      };
    }
  }

  _session = { date: today, assets: prevAssets, dxy: 0, tlt: 0 };
  _saveSession();
  return _session;
}

function _saveSession(): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    if (_session) fs.writeFileSync(SESSION_FILE, JSON.stringify(_session, null, 2));
  } catch { /* ignore */ }
}

// ─── Level touches ────────────────────────────────────────────────────────────
let _touches: LevelTouches | null = null;

function loadTouches(): LevelTouches {
  if (_touches) return _touches;
  try {
    if (fs.existsSync(TOUCHES_FILE))
      _touches = JSON.parse(fs.readFileSync(TOUCHES_FILE, "utf-8")) as LevelTouches;
  } catch { /* ignore */ }
  if (!_touches) _touches = {};
  return _touches;
}

function _saveTouches(): void {
  try {
    fs.mkdirSync(path.dirname(TOUCHES_FILE), { recursive: true });
    if (_touches) fs.writeFileSync(TOUCHES_FILE, JSON.stringify(_touches, null, 2));
  } catch { /* ignore */ }
}

// ─── Macro events (static fallback + live override from SpotGamma/FMP) ────────
let _macroEvents: MacroEventDef[] | null = null;

function loadMacroEvents(): MacroEventDef[] {
  if (_macroEvents) return _macroEvents;
  try {
    if (fs.existsSync(MACRO_FILE))
      _macroEvents = JSON.parse(fs.readFileSync(MACRO_FILE, "utf-8")) as MacroEventDef[];
  } catch { /* ignore */ }
  if (!_macroEvents) _macroEvents = [];
  return _macroEvents;
}

/**
 * Merge live events from SpotGamma economic calendar into the in-memory list.
 * Called from market-monitor after each fetchAllMarketData() cycle.
 * Converts EconCalendarEvent format → MacroEventDef format.
 */
export function ingestLiveEconCalendar(liveEvents: Array<{
  date: string; time?: string; event: string; impact: string; country: string;
}>): void {
  const base = loadMacroEvents();

  // Keywords that classify as high-impact for our trading (beyond what FMP marks)
  const HIGH_KEYWORDS = [
    "fed", "fomc", "interest rate", "cpi", "inflation",
    "nfp", "nonfarm", "non-farm", "payroll", "gdp", "pce",
    "ppi", "retail sales", "unemployment", "jobless",
    "jackson hole", "powell", "jerome",
  ];

  const liveConverted: MacroEventDef[] = liveEvents
    .filter(e => {
      if (e.country !== "US" && e.country !== "<Global>") return false;
      if (e.impact !== "High" && e.impact !== "Medium") return false;
      // For medium impact, only keep ones matching our keyword list
      if (e.impact === "Medium") {
        const low = e.event.toLowerCase();
        return HIGH_KEYWORDS.some(kw => low.includes(kw));
      }
      return true;
    })
    .map(e => ({
      date:   e.date,
      event:  e.event,
      time:   e.time || "12:00",  // default noon ET if no time
      impact: "high" as const,
    }));

  // Merge: live events override static ones for the same date
  const liveByDate = new Map<string, MacroEventDef[]>();
  for (const ev of liveConverted) {
    if (!liveByDate.has(ev.date)) liveByDate.set(ev.date, []);
    liveByDate.get(ev.date)!.push(ev);
  }

  // Keep static events for dates not covered by live data; replace covered dates
  const today = new Date().toISOString().split("T")[0];
  const staticFiltered = base.filter(ev => !liveByDate.has(ev.date));
  const merged = [...staticFiltered, ...liveConverted];

  _macroEvents = merged;
  if (liveConverted.length > 0) {
    console.log(`[MACRO-CAL] Ingested ${liveConverted.length} live events from SpotGamma`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

// ─── 1. Update session price ──────────────────────────────────────────────────
/**
 * Call on every refresh cycle for each primary analysis asset (SPX, QQQ, GLD, DIA).
 * Maintains open / high / low for the current session.
 */
export function updateSessionPrice(symbol: string, price: number): void {
  if (!price || price <= 0) return;
  const session  = loadSession();
  const etMins   = getETMins();
  const inHours  = etMins >= 570 && etMins < 960; // 9:30–16:00 ET

  if (!session.assets[symbol]) {
    session.assets[symbol] = {
      openPrice: 0, prevClose: 0, sessionHigh: 0, sessionLow: Infinity, openSet: false,
    };
  }
  const a = session.assets[symbol];

  // First price after market open → session open
  if (inHours && !a.openSet) {
    a.openPrice = price;
    a.openSet   = true;
  }

  // Running high / low
  if (inHours) {
    if (price > a.sessionHigh) a.sessionHigh = price;
    if (price < a.sessionLow || a.sessionLow === Infinity) a.sessionLow = price;
  }

  // After-hours: store as prevClose proxy
  if (etMins >= 960 && price > 0) a.prevClose = price;

  _saveSession();
}

// ─── 2. Trend context (gamma flip or session open) ────────────────────────────
export interface TrendContext {
  source:         "gammaFlip" | "sessionOpen" | "none";
  isAbove:        boolean;        // price is above the reference level
  isCounterTrend: boolean;        // setup direction fights the structural bias
  referenceLevel: number;
  trendLabel:     string;
}

/**
 * Determine whether the current setup is with or against the structural trend.
 *
 * Equity indices (SPX, QQQ, DIA): use gamma flip level.
 *   - Above flip (positive gamma): dealers buy dips → LONG is structurally safe.
 *     SHORT above flip fights mean-reversion → counter-trend.
 *   - Below flip (negative gamma): dealers amplify moves → SHORT has momentum.
 *     LONG below flip fights dealer selling → counter-trend.
 *
 * Gold (GLD / XAUUSD): gamma flip less reliable → use session open instead.
 *   - Price > open: session bullish → SHORT is counter-trend.
 *   - Price < open: session bearish → LONG is counter-trend.
 */
export function getSessionTrend(
  symbol:        string,
  currentPrice:  number,
  direction:     "LONG" | "SHORT" | "NO_TRADE",
  gammaFlipLevel: number,
): TrendContext {
  const isGold = symbol === "GLD";

  // Gamma flip path (all equity-linked assets)
  if (!isGold && gammaFlipLevel > 0) {
    const isAbove        = currentPrice > gammaFlipLevel;
    const isCounterTrend =
      (direction === "LONG"  && !isAbove) ||   // LONG in negative-gamma regime
      (direction === "SHORT" && isAbove);       // SHORT in positive-gamma regime

    return {
      source: "gammaFlip",
      isAbove,
      isCounterTrend,
      referenceLevel: gammaFlipLevel,
      trendLabel: isAbove
        ? `Gamma+ (sobre flip $${gammaFlipLevel.toLocaleString()}) — dealers frenan caídas`
        : `Gamma– (bajo flip $${gammaFlipLevel.toLocaleString()}) — régimen momentum bajista`,
    };
  }

  // Session-open path (gold or missing gamma flip)
  const session = loadSession();
  const open    = session.assets[symbol]?.openPrice || 0;

  if (open > 0) {
    const isAbove        = currentPrice > open;
    const isCounterTrend =
      (direction === "LONG"  && !isAbove) ||   // buying in a bearish session
      (direction === "SHORT" && isAbove);       // shorting in a bullish session

    return {
      source: "sessionOpen",
      isAbove,
      isCounterTrend,
      referenceLevel: open,
      trendLabel: isAbove
        ? `Sesión alcista (apertura $${open.toFixed(2)}) — precio sobre open`
        : `Sesión bajista (apertura $${open.toFixed(2)}) — precio bajo open`,
    };
  }

  return {
    source: "none",
    isAbove: true,
    isCounterTrend: false,
    referenceLevel: 0,
    trendLabel: "Sin referencia de tendencia (primer refresh del día)",
  };
}

// ─── 3. Implied-move consumed ─────────────────────────────────────────────────
export interface ImpliedMoveStatus {
  consumed:        number;   // ratio: 1.0 = exactly at expected range
  dayRangePct:     number;   // actual session range as %
  impliedMovePct:  number;   // expected range from SpotGamma
  isExhausted:     boolean;  // consumed > 0.80 → caution
  isOverExtended:  boolean;  // consumed > 1.00 → no op
}

export function getImpliedMoveStatus(
  symbol:         string,
  impliedMovePct: number,  // e.g. 0.82 = 0.82%
): ImpliedMoveStatus {
  const session = loadSession();
  const a       = session.assets[symbol];
  const base    = a?.openPrice   || 0;
  const hi      = a?.sessionHigh || 0;
  const lo      = a?.sessionLow;
  const im      = impliedMovePct > 0 ? impliedMovePct : 0;

  if (!base || !hi || !lo || lo === Infinity || im === 0) {
    return { consumed: 0, dayRangePct: 0, impliedMovePct: im, isExhausted: false, isOverExtended: false };
  }

  const dayRangePct = ((hi - lo) / base) * 100;
  const consumed    = dayRangePct / im;

  return {
    consumed,
    dayRangePct,
    impliedMovePct: im,
    isExhausted:    consumed > 0.80,
    isOverExtended: consumed > 1.00,
  };
}

// ─── 4. Gap analysis ──────────────────────────────────────────────────────────
export interface GapContext {
  hasGap: boolean;
  gapPct: number;              // positive = gap up
  gapDir: "up" | "down" | "none";
  gapLabel: string;
}

export function getGapContext(symbol: string): GapContext {
  const session   = loadSession();
  const a         = session.assets[symbol];
  const open      = a?.openPrice || 0;
  const prevClose = a?.prevClose || 0;

  if (!open || !prevClose) {
    return { hasGap: false, gapPct: 0, gapDir: "none", gapLabel: "" };
  }

  const gapPct      = ((open - prevClose) / prevClose) * 100;
  const gapThreshold = 0.25; // 0.25% = meaningful gap

  if (Math.abs(gapPct) < gapThreshold) {
    return { hasGap: false, gapPct, gapDir: "none", gapLabel: "" };
  }

  const gapDir: "up" | "down" = gapPct > 0 ? "up" : "down";
  const gapLabel = `Gap ${gapDir === "up" ? "alcista ↑" : "bajista ↓"} ${Math.abs(gapPct).toFixed(2)}% (prev close $${prevClose.toFixed(2)})`;

  return { hasGap: true, gapPct, gapDir, gapLabel };
}

// ─── 5. Level freshness ───────────────────────────────────────────────────────
/**
 * Record a level "touch" when price comes within thresholdPct% of a gamma level.
 * Debounced to once per 2 hours to avoid inflating counts on choppy sessions.
 */
export function trackLevelTouch(
  symbol:       string,
  levelPrice:   number,
  currentPrice: number,
  thresholdPct: number = 0.15,
): void {
  const distPct = Math.abs(currentPrice - levelPrice) / levelPrice * 100;
  if (distPct > thresholdPct) return;

  const touches = loadTouches();
  const key     = levelPrice.toFixed(0);
  if (!touches[symbol]) touches[symbol] = {};
  if (!touches[symbol][key]) touches[symbol][key] = [];

  // Debounce: skip if touched < 2h ago
  const recent = touches[symbol][key];
  if (recent.length > 0) {
    const lastMs = new Date(recent[recent.length - 1]).getTime();
    if (Date.now() - lastMs < 2 * 3600 * 1000) return;
  }

  touches[symbol][key].push(new Date().toISOString());

  // Prune old entries (> 10 days)
  const cutoff = Date.now() - 10 * 24 * 3600 * 1000;
  touches[symbol][key] = touches[symbol][key].filter(
    t => new Date(t).getTime() > cutoff,
  );

  _saveTouches();
}

export interface FreshnessResult {
  touches5d:   number;
  isFresh:     boolean;   // 0–1 touches
  isTested:    boolean;   // 2–3 touches
  isOverused:  boolean;   // 4+ touches
  label:       string;
}

export function getLevelFreshness(symbol: string, levelPrice: number): FreshnessResult {
  const touches  = loadTouches();
  const key      = levelPrice.toFixed(0);
  const records  = touches[symbol]?.[key] || [];
  const cutoff   = Date.now() - 5 * 24 * 3600 * 1000;
  const touches5d = records.filter(t => new Date(t).getTime() > cutoff).length;

  return {
    touches5d,
    isFresh:    touches5d <= 1,
    isTested:   touches5d >= 2 && touches5d <= 3,
    isOverused: touches5d >= 4,
    label:
      touches5d === 0 ? "nivel virgen — primer toque"
      : touches5d === 1 ? "nivel fresco (1 toque previo)"
      : touches5d <= 3  ? `nivel testeado (${touches5d} toques esta semana)`
      :                   `nivel agotado (${touches5d}+ toques — mayor riesgo de ruptura)`,
  };
}

// ─── 6. Macro event calendar ──────────────────────────────────────────────────
export interface MacroAlert {
  hasEvent:           boolean;
  event:              string;
  time:               string;
  hoursUntil:         number;   // negative = event already passed today
  isPre:              boolean;  // within 2h before event
  isPost:             boolean;  // within 1h after event
  isActive:           boolean;  // isPre || isPost
  scoreBoost:         number;   // small extra score points required when active
  slMult:             number;   // SL multiplier during event window (wider = safer)
  requireOptimalOnly: boolean;  // true = only "optimal" entry quality accepted (not "valid")
}

export function getMacroAlert(): MacroAlert {
  const events     = loadMacroEvents();
  const todayET    = getTodayET();
  const etMins     = getETMins();
  const todayHigh  = events.filter(e => e.date === todayET && e.impact === "high");

  for (const ev of todayHigh) {
    const [h, m]     = ev.time.split(":").map(Number);
    const eventMins  = h * 60 + m;
    const diffMins   = eventMins - etMins;   // positive = future
    const hoursUntil = diffMins / 60;

    const isPre      = diffMins > 0   && diffMins <= 120;  // ≤ 2h before
    const isPost     = diffMins <= 0  && diffMins > -60;   // ≤ 1h after
    const blockEntry = Math.abs(diffMins) <= 30;           // ≤ 30 min window

    if (isPre || isPost) {
      return {
        hasEvent:    true,
        event:       ev.event,
        time:        ev.time,
        hoursUntil,
        isPre,
        isPost,
        isActive:           true,
        scoreBoost:         isPre ? 5 : 0,    // small boost pre-event; none post
        slMult:             isPre ? 1.45 : 1.20, // SL 45% wider pre-event, 20% wider post
        requireOptimalOnly: isPre,             // pre-event: only optimal entries (price tightly at level + HIRO/Tape confirm)
      };
    }
  }

  // Event today but outside active window — just inform, no adjustments
  if (todayHigh.length > 0) {
    const ev       = todayHigh[0];
    const [h, m]   = ev.time.split(":").map(Number);
    const diffMins = (h * 60 + m) - etMins;
    return {
      hasEvent: true, event: ev.event, time: ev.time, hoursUntil: diffMins / 60,
      isPre: false, isPost: false, isActive: false,
      scoreBoost: 0, slMult: 1.0, requireOptimalOnly: false,
    };
  }

  return {
    hasEvent: false, event: "", time: "", hoursUntil: 0,
    isPre: false, isPost: false, isActive: false,
    scoreBoost: 0, slMult: 1.0, requireOptimalOnly: false,
  };
}

// ─── 7. DXY / TLT (Yahoo Finance, cached 5 min) ───────────────────────────────
const CACHE_TTL = 5 * 60 * 1000;
let _dxyFetchedAt = 0;
let _tltFetchedAt = 0;

async function _fetchYahoo(ticker: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return 0;
  const json = (await res.json()) as {
    chart: { result: { meta: { regularMarketPrice: number } }[] }
  };
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
}

/** Fire-and-forget refresh — updates internal cache, returns current cached values */
export async function refreshDXYTLT(): Promise<{ dxy: number; tlt: number }> {
  const session = loadSession();
  const now     = Date.now();

  try {
    if (now - _dxyFetchedAt > CACHE_TTL) {
      const dxy = await _fetchYahoo("DX-Y.NYB");
      if (dxy > 0) { session.dxy = dxy; _dxyFetchedAt = now; }
    }
  } catch { /* ignore */ }

  try {
    if (now - _tltFetchedAt > CACHE_TTL) {
      const tlt = await _fetchYahoo("TLT");
      if (tlt > 0) { session.tlt = tlt; _tltFetchedAt = now; }
    }
  } catch { /* ignore */ }

  _saveSession();
  return { dxy: session.dxy, tlt: session.tlt };
}

export function getCachedDXYTLT(): { dxy: number; tlt: number } {
  const session = loadSession();
  return { dxy: session.dxy, tlt: session.tlt };
}
