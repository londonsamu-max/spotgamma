/**
 * auto-trade-config.ts — Auto-trading configuration + Kill Switch
 *
 * Config persisted at data/auto-trading-config.json.
 * Kill switch: if last N live trades have WR < minWR%, auto-trading is paused.
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../data/auto-trading-config.json");

export interface AutoTradingConfig {
  enabled:                 boolean;
  confidenceThreshold:     number;   // 0-100 — minimum PPO confidence to auto-trade
  maxDailyTrades:          number;   // max trades per calendar day
  maxConcurrentPositions:  number;   // max open positions at same time
  killSwitchEnabled:       boolean;
  killSwitchLookback:      number;   // last N trades to check
  killSwitchMinWR:         number;   // % — if WR < this, pause auto-trading
  killSwitchTriggered:     boolean;
  killSwitchTriggeredAt:   string | null;
  volumes:                 Record<string, number>;
  disabledCFDs:            string[];
}

const DEFAULT_CONFIG: AutoTradingConfig = {
  enabled:                 false,
  confidenceThreshold:     70,
  maxDailyTrades:          3,
  maxConcurrentPositions:  1,
  killSwitchEnabled:       true,
  killSwitchLookback:      10,
  killSwitchMinWR:         30,
  killSwitchTriggered:     false,
  killSwitchTriggeredAt:   null,
  volumes:                 { NAS100: 0.1, US30: 0.1, XAUUSD: 0.01 },
  disabledCFDs:            [],
};

export function loadAutoConfig(): AutoTradingConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch (e) {
    console.warn("[AutoTrade] Error loading config:", e);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveAutoConfig(cfg: AutoTradingConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/** Check kill switch — returns { triggered, liveWR, liveTotal } */
export function checkKillSwitch(records: any[]): {
  triggered: boolean;
  liveWR: number;
  liveTotal: number;
  liveWins: number;
} {
  const cfg = loadAutoConfig();
  if (!cfg.killSwitchEnabled) return { triggered: false, liveWR: 0, liveTotal: 0, liveWins: 0 };

  // Only look at trades that were actually executed on MT5 (have ticket)
  const liveResolved = records
    .filter(r => r.mt5Ticket && r.outcome && r.outcome !== "open" && r.outcome !== "cancelled" && r.outcome !== "pending")
    .slice(-cfg.killSwitchLookback);

  const liveTotal = liveResolved.length;
  if (liveTotal < 3) return { triggered: false, liveWR: 0, liveTotal, liveWins: 0 }; // need at least 3

  const liveWins = liveResolved.filter(r => ["tp1","tp2","tp3"].includes(r.outcome)).length;
  const liveWR = Math.round(liveWins / liveTotal * 100);
  const triggered = liveWR < cfg.killSwitchMinWR;

  // If newly triggered, save state
  if (triggered && !cfg.killSwitchTriggered) {
    const updated = { ...cfg, killSwitchTriggered: true, killSwitchTriggeredAt: new Date().toISOString() };
    saveAutoConfig(updated);
    console.warn(`[KillSwitch] 🔴 ACTIVADO — Live WR=${liveWR}% < ${cfg.killSwitchMinWR}% (${liveWins}/${liveTotal} últimos trades)`);
  }

  return { triggered, liveWR, liveTotal, liveWins };
}

/** Count today's auto-executed trades */
export function countTodayAutoTrades(records: any[]): number {
  const today = new Date().toISOString().slice(0, 10);
  return records.filter(r =>
    r.mt5Ticket &&
    r.mt5ExecutedAt &&
    r.mt5ExecutedAt.startsWith(today)
  ).length;
}

/** Count currently open MT5 positions */
export function countOpenMT5Positions(records: any[]): number {
  return records.filter(r => r.mt5Ticket && r.outcome === "open").length;
}

/** Returns full stats for dashboard */
export function getAutoTradingStats(records: any[]) {
  const cfg = loadAutoConfig();
  const killSwitch = checkKillSwitch(records);
  const todayTrades = countTodayAutoTrades(records);
  const openPositions = countOpenMT5Positions(records);

  // Rolling win rates for display
  const liveResolved = records.filter(r =>
    r.mt5Ticket &&
    r.outcome && r.outcome !== "open" && r.outcome !== "cancelled" && r.outcome !== "pending"
  );
  const last10 = liveResolved.slice(-10);
  const last20 = liveResolved.slice(-20);
  const calcWR = (arr: any[]) => {
    if (arr.length === 0) return null;
    const w = arr.filter(r => ["tp1","tp2","tp3"].includes(r.outcome)).length;
    return Math.round(w / arr.length * 100);
  };

  const isEffectivelyEnabled = cfg.enabled && !killSwitch.triggered;

  return {
    config:          cfg,
    effectiveEnabled: isEffectivelyEnabled,
    killSwitch:      killSwitch,
    todayTrades,
    openPositions,
    liveWR10:        calcWR(last10),
    liveWR20:        calcWR(last20),
    liveTotal:       liveResolved.length,
    status: isEffectivelyEnabled ? "ACTIVE" : cfg.enabled && killSwitch.triggered ? "KILL_SWITCH" : "PAUSED",
  };
}
