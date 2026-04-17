/**
 * Live Flow Watcher — Polls SpotGamma flow every 5 seconds for new institutional trades.
 *
 * Detects new trades by comparing timestamps with previous poll.
 * Alerts on trades > $25K premium (institutional).
 * Maintains a rolling window of recent alerts for the agent to consume.
 */

import { streamApiCall, parseTapeFlowItem, getMarketStatus, TapeFlow } from "./spotgamma-scraper";

// ── State ──
let _interval: ReturnType<typeof setInterval> | null = null;
let _lastSeenTimes: Record<string, string> = {}; // symbol → latest trade time
let _alerts: LiveFlowAlert[] = [];
let _recentTrades: TapeFlow[] = []; // rolling window of last 100 trades across all symbols
const MAX_ALERTS = 500; // Keep more since we capture all trades
const MAX_RECENT = 500;
const POLL_INTERVAL = 5000; // 5 seconds
const MIN_PREMIUM_ALERT = 0; // Capture ALL trades — classify by size later (institutional >$50K, medium >$10K, retail <$10K)

export interface LiveFlowAlert {
  time: string;
  premium: number;
  symbol: string;
  callPut: string;
  strike: number;
  expiration: string;
  buySell: string;
  side: string;
  delta: number;
  gamma: number;
  signal: "bullish" | "bearish" | "neutral";
  is0DTE: boolean;
  detectedAt: string; // when we detected this trade
}

async function pollFlow() {
  const { isOpen } = getMarketStatus();
  if (!isOpen) return;

  const symbols = ["SPX", "QQQ", "SPY", "GLD"];
  const sessionDate = new Date().toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const filters = JSON.stringify([{ field: "underlying", operator: "isAnyOf", value: [sym] }]);
      const encoded = encodeURIComponent(filters);
      const rawData = await streamApiCall<any[]>(
        `/sg/tns_feed?filters=${encoded}&limit=20`,
        5000,
        true
      );

      if (!rawData || !Array.isArray(rawData)) continue;

      const trades = rawData
        .map(parseTapeFlowItem)
        .filter((t): t is TapeFlow => t !== null);

      if (trades.length === 0) continue;

      // Find NEW trades (time > last seen for this symbol, deduplicate by time+strike+premium)
      const lastSeen = _lastSeenTimes[sym] || "";
      const newTrades = trades.filter(t => t.time > lastSeen);
      // Deduplicate: same time+strike+premium+callPut = same trade
      const seen = new Set<string>();
      const uniqueNew = newTrades.filter(t => {
        const key = `${t.time}_${t.strike}_${t.premium}_${t.callPut}`;
        if (seen.has(key)) return false;
        seen.add(key);
        // Also check against existing alerts
        const exists = _alerts.some(a => a.time === t.time && a.strike === t.strike && a.premium === t.premium && a.callPut === t.callPut);
        return !exists;
      });

      if (uniqueNew.length > 0) {
        // Update last seen
        _lastSeenTimes[sym] = trades.reduce((max, t) => t.time > max ? t.time : max, lastSeen);

        // Add to recent trades
        _recentTrades.push(...uniqueNew);
        if (_recentTrades.length > MAX_RECENT) {
          _recentTrades = _recentTrades.slice(-MAX_RECENT);
        }

        // Check for institutional trades
        for (const t of uniqueNew) {
          if (t.premium >= MIN_PREMIUM_ALERT) {
            const alert: LiveFlowAlert = {
              time: t.time,
              premium: t.premium,
              symbol: t.symbol,
              callPut: t.callPut,
              strike: t.strike,
              expiration: t.expiration,
              buySell: t.buySell,
              side: t.side,
              delta: t.delta,
              gamma: t.gamma,
              signal: t.signal,
              is0DTE: t.expiration?.startsWith(sessionDate) || false,
              detectedAt: new Date().toISOString(),
            };
            _alerts.push(alert);
            if (_alerts.length > MAX_ALERTS) _alerts.shift();

            console.log(`[LIVE-FLOW] 🚨 $${(t.premium/1000).toFixed(0)}K ${t.symbol} ${t.callPut} ${t.strike} ${t.buySell} ${t.signal} ${alert.is0DTE ? '0DTE' : t.expiration?.slice(0,10)}`);
          }
        }
      }
    } catch (e) {
      // Silent fail — don't spam logs for poll errors
    }
  }
}

export function startLiveFlowWatcher() {
  if (_interval) return;
  _interval = setInterval(pollFlow, POLL_INTERVAL);
  console.log("[LIVE-FLOW] Started — polling every 5s for SPX/QQQ/SPY/GLD");
}

export function stopLiveFlowWatcher() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[LIVE-FLOW] Stopped");
  }
}

/** Get recent institutional alerts (for getAgentView) */
export function getLiveFlowAlerts(): LiveFlowAlert[] {
  return [..._alerts];
}

/** Get rolling window of recent trades across all symbols */
export function getRecentLiveTrades(): TapeFlow[] {
  return [..._recentTrades];
}

/** Summary stats for agent — classifies ALL trades by size and direction */
export function getLiveFlowSummary() {
  const now = Date.now();
  const last5min = _alerts.filter(a => now - new Date(a.detectedAt).getTime() < 5 * 60 * 1000);
  const last1min = _alerts.filter(a => now - new Date(a.detectedAt).getTime() < 60 * 1000);

  const classify = (trades: LiveFlowAlert[]) => {
    const inst = trades.filter(t => t.premium > 50000);
    const med = trades.filter(t => t.premium > 10000 && t.premium <= 50000);
    const ret = trades.filter(t => t.premium <= 10000);
    const sumBull = (arr: LiveFlowAlert[]) => arr.filter(t => t.signal === "bullish").reduce((s, t) => s + t.premium, 0);
    const sumBear = (arr: LiveFlowAlert[]) => arr.filter(t => t.signal === "bearish").reduce((s, t) => s + t.premium, 0);
    return {
      institutional: { count: inst.length, bull: sumBull(inst), bear: sumBear(inst) },
      medium: { count: med.length, bull: sumBull(med), bear: sumBear(med) },
      retail: { count: ret.length, bull: sumBull(ret), bear: sumBear(ret) },
      totalBull: sumBull(trades),
      totalBear: sumBear(trades),
    };
  };

  const c5 = classify(last5min);
  const c1 = classify(last1min);

  // Per-symbol breakdown last 5min
  const bySymbol: Record<string, { count: number; bullPrem: number; bearPrem: number }> = {};
  for (const a of last5min) {
    if (!bySymbol[a.symbol]) bySymbol[a.symbol] = { count: 0, bullPrem: 0, bearPrem: 0 };
    bySymbol[a.symbol].count++;
    if (a.signal === "bullish") bySymbol[a.symbol].bullPrem += a.premium;
    else if (a.signal === "bearish") bySymbol[a.symbol].bearPrem += a.premium;
  }

  return {
    alertsTotal: _alerts.length,
    alertsLast5min: last5min.length,
    alertsLast1min: last1min.length,
    last5min: c5,
    last1min: c1,
    bySymbol,
    bias5min: c5.totalBull > c5.totalBear * 1.5 ? "bullish" : c5.totalBear > c5.totalBull * 1.5 ? "bearish" : "neutral",
    // Institutional bias (what matters most)
    instBias5min: c5.institutional.bull > c5.institutional.bear * 1.3 ? "bullish" : c5.institutional.bear > c5.institutional.bull * 1.3 ? "bearish" : "neutral",
    recentTradesCount: _recentTrades.length,
    isRunning: _interval !== null,
  };
}
