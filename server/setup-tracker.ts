import * as fs from "fs";
import * as path from "path";

const TRACKING_FILE = path.join(process.cwd(), "data", "setup-tracking.json");

export interface TrackedSetup {
  id: string;               // cfd_direction_type_timestamp
  trackedAt: string;        // ISO cuando se registró
  sessionDate: string;      // YYYY-MM-DD ET
  cfd: string;              // NAS100, US30, XAUUSD
  direction: "LONG" | "SHORT";
  tradeType: string;        // breakout, bounce, vanna_index, etc.
  score: number;
  entryMode: string;        // ENTRADA, VIGILANCIA, NO_OPERAR
  confirmations: string[];  // ["gex","hiro","tape","level","vanna","regime"]
  confirmationCount: number;
  levelLabel: string;       // "Put Wall $6500", "Vol Trigger $460", etc.
  levelPrice: number;       // precio del nivel en el asset subyacente
  cfdEntryPrice: number;    // precio CFD en el momento del setup
  stopLoss: number;
  stopLossPoints: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskReward: number;
  regime: string;           // positive, negative, very_negative
  ivRank: number;
  skewBias: string;
  isAlt: boolean;           // true si es setup ALT-N
  altIndex: number;         // 0=principal, 1,2,3=alternativo
  // Outcome fields (filled when resolved)
  outcome: "open" | "tp1" | "tp2" | "tp3" | "sl" | "expired";
  exitPrice: number;
  pnlPoints: number;
  resolvedAt: string;
  durationMinutes: number;
}

export interface SetupAnalytics {
  totalTracked: number;
  totalResolved: number;
  byTradeType: Record<string, { total: number; tp1: number; tp2: number; tp3: number; sl: number; expired: number; avgPnl: number; winRate: number }>;
  byScoreRange: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  byConfirmationCount: Record<number, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  byLevelType: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  byRegime: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  byCfd: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  byEntryMode: Record<string, { total: number; wins: number; losses: number; winRate: number; avgPnl: number }>;
  topPerforming: TrackedSetup[];
  recentSetups: TrackedSetup[];
}

let trackingData: TrackedSetup[] = [];
let lastLoad = 0;

function loadTracking(): TrackedSetup[] {
  const now = Date.now();
  if (now - lastLoad < 5000) return trackingData; // cache 5s
  try {
    if (fs.existsSync(TRACKING_FILE)) {
      trackingData = JSON.parse(fs.readFileSync(TRACKING_FILE, "utf-8"));
    }
  } catch { trackingData = []; }
  lastLoad = now;
  return trackingData;
}

function saveTracking(data: TrackedSetup[]): void {
  try {
    fs.mkdirSync(path.dirname(TRACKING_FILE), { recursive: true });
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
    trackingData = data;
    lastLoad = Date.now();
  } catch (e: any) {
    console.error(`[TRACKER] Save error: ${e.message}`);
  }
}

export function trackSetups(setups: any[], cfdPrices: any): void {
  const data = loadTracking();
  const now = new Date();
  const sessionDate = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let added = 0;

  for (const setup of setups) {
    if (!setup.direction || setup.direction === "NO_TRADE") continue;
    if (!setup.cfd || !setup.cfdEntryPrice) continue;

    // Detectar si es ALT setup
    const isAlt = setup.reason?.includes("[ALT-") || false;
    const altMatch = setup.reason?.match(/\[ALT-(\d+)\]/);
    const altIndex = altMatch ? parseInt(altMatch[1]) : 0;

    // ID único por nivel + dirección + día (evitar duplicar el mismo setup cada 15s)
    const levelKey = setup.entryZone?.strike || setup.cfdEntryPrice;
    const id = `${sessionDate}_${setup.cfd}_${setup.direction}_${setup.tradeType}_${Math.round(levelKey)}`;

    // No re-registrar el mismo setup del mismo día
    const exists = data.find(d => d.id === id && d.sessionDate === sessionDate);
    if (exists) continue;

    // Extraer confirmaciones desde campos booleanos
    const confKeys = ["gexConfirmed","hiroConfirmed","tapeConfirmed","levelConfirmed","vannaConfirmed","regimeConfirmed"];
    const confLabels = ["gex","hiro","tape","level","vanna","regime"];
    const confirmations = confLabels.filter((_, i) => setup[confKeys[i]]);

    // Extraer label del nivel
    const levelLabel = setup.entryZone?.sgLevelType
      || setup.reason?.match(/(?:RUPTURA|REBOTE|RECHAZO)\s+([^|]+)/)?.[1]?.trim()
      || "N/A";

    const tracked: TrackedSetup = {
      id,
      trackedAt: now.toISOString(),
      sessionDate,
      cfd: setup.cfd,
      direction: setup.direction,
      tradeType: setup.tradeType || "unknown",
      score: setup.score || 0,
      entryMode: setup.entryMode || "NO_OPERAR",
      confirmations,
      confirmationCount: confirmations.length,
      levelLabel: levelLabel.slice(0, 50),
      levelPrice: setup.entryZone?.strike || levelKey,
      cfdEntryPrice: setup.cfdEntryPrice,
      stopLoss: setup.stopLoss || 0,
      stopLossPoints: setup.stopLossPoints || 0,
      takeProfit1: setup.takeProfit1 || 0,
      takeProfit2: setup.takeProfit2 || 0,
      takeProfit3: setup.takeProfit3 || 0,
      riskReward: setup.riskRewardRatio || 0,
      regime: setup.sgLevels?.gammaRegime || "unknown",
      ivRank: setup.ivRank || 0,
      skewBias: setup.skewBias || "neutral",
      isAlt,
      altIndex,
      outcome: "open",
      exitPrice: 0,
      pnlPoints: 0,
      resolvedAt: "",
      durationMinutes: 0,
    };

    data.push(tracked);
    added++;
  }

  if (added > 0) {
    saveTracking(data);
    console.log(`[TRACKER] Registered ${added} new setups (total: ${data.length})`);
  }
}

export function resolveSetupOutcomes(cfdPrices: any): void {
  const data = loadTracking();
  const specs: Record<string, number> = { NAS100: 0.10, US30: 0.10, XAUUSD: 1.00 };
  let updated = 0;

  const getPrice = (cfd: string): number => {
    const key = cfd === "NAS100" ? "nas100" : cfd === "US30" ? "us30" : "xauusd";
    return cfdPrices?.[key]?.price || 0;
  };

  const now = Date.now();
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // expire after 24h

  for (const setup of data) {
    if (setup.outcome !== "open") continue;

    const price = getPrice(setup.cfd);
    if (!price) continue;

    const trackedAt = new Date(setup.trackedAt).getTime();
    const ageMs = now - trackedAt;

    // Expire old setups
    if (ageMs > MAX_AGE_MS) {
      setup.outcome = "expired";
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
      continue;
    }

    const isLong = setup.direction === "LONG";

    // Check SL first (tightest constraint)
    if (isLong && price <= setup.stopLoss) {
      setup.outcome = "sl";
      setup.exitPrice = setup.stopLoss;
      setup.pnlPoints = -(setup.stopLossPoints);
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
      continue;
    }
    if (!isLong && price >= setup.stopLoss) {
      setup.outcome = "sl";
      setup.exitPrice = setup.stopLoss;
      setup.pnlPoints = -(setup.stopLossPoints);
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
      continue;
    }

    // Check TPs
    if (isLong && price >= setup.takeProfit3 && setup.takeProfit3 > 0) {
      setup.outcome = "tp3";
      setup.exitPrice = setup.takeProfit3;
      setup.pnlPoints = setup.takeProfit3 - setup.cfdEntryPrice;
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
    } else if (!isLong && price <= setup.takeProfit3 && setup.takeProfit3 > 0) {
      setup.outcome = "tp3";
      setup.exitPrice = setup.takeProfit3;
      setup.pnlPoints = setup.cfdEntryPrice - setup.takeProfit3;
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
    } else if (isLong && price >= setup.takeProfit1 && setup.takeProfit1 > 0) {
      setup.outcome = "tp1";
      setup.exitPrice = setup.takeProfit1;
      setup.pnlPoints = setup.takeProfit1 - setup.cfdEntryPrice;
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
    } else if (!isLong && price <= setup.takeProfit1 && setup.takeProfit1 > 0) {
      setup.outcome = "tp1";
      setup.exitPrice = setup.takeProfit1;
      setup.pnlPoints = setup.cfdEntryPrice - setup.takeProfit1;
      setup.resolvedAt = new Date().toISOString();
      setup.durationMinutes = Math.round(ageMs / 60000);
      updated++;
    }
  }

  if (updated > 0) {
    saveTracking(data);
    console.log(`[TRACKER] Resolved ${updated} setup outcomes`);
  }
}

export function getSetupAnalytics(): SetupAnalytics {
  const data = loadTracking();
  const resolved = data.filter(d => d.outcome !== "open");
  const specs: Record<string, number> = { NAS100: 0.10, US30: 0.10, XAUUSD: 1.00 };

  const isWin = (s: TrackedSetup) => ["tp1","tp2","tp3"].includes(s.outcome);
  const isLoss = (s: TrackedSetup) => s.outcome === "sl";

  function groupStats(items: TrackedSetup[]) {
    const wins = items.filter(isWin).length;
    const losses = items.filter(isLoss).length;
    const closed = wins + losses;
    const avgPnl = closed > 0
      ? items.filter(s => isWin(s) || isLoss(s)).reduce((sum, s) => sum + (s.pnlPoints * (specs[s.cfd] || 0.1)), 0) / closed
      : 0;
    return { total: items.length, wins, losses, winRate: closed > 0 ? (wins / closed) * 100 : 0, avgPnl };
  }

  // By trade type
  const byTradeType: any = {};
  for (const s of resolved) {
    if (!byTradeType[s.tradeType]) byTradeType[s.tradeType] = { total:0,tp1:0,tp2:0,tp3:0,sl:0,expired:0,avgPnl:0,winRate:0 };
    byTradeType[s.tradeType].total++;
    byTradeType[s.tradeType][s.outcome] = (byTradeType[s.tradeType][s.outcome] || 0) + 1;
  }

  // By score range
  const byScoreRange: any = {};
  const ranges: [number, number, string][] = [[0,39,"0-39"],[40,59,"40-59"],[60,74,"60-74"],[75,84,"75-84"],[85,94,"85-94"],[95,100,"95-100"]];
  for (const [min, max, label] of ranges) {
    const items = data.filter(d => d.score >= min && d.score <= max);
    byScoreRange[label] = groupStats(items);
  }

  // By confirmation count
  const byConfirmationCount: any = {};
  for (let i = 0; i <= 6; i++) {
    const items = data.filter(d => d.confirmationCount === i);
    if (items.length > 0) byConfirmationCount[i] = groupStats(items);
  }

  // By level type
  const byLevelType: any = {};
  for (const s of data) {
    const key = s.tradeType + "_" + (s.levelLabel?.split(" ")[0] || "unknown");
    if (!byLevelType[key]) byLevelType[key] = [];
    byLevelType[key].push(s);
  }
  const byLevelTypeStats: any = {};
  for (const [k, items] of Object.entries(byLevelType)) {
    byLevelTypeStats[k] = groupStats(items as TrackedSetup[]);
  }

  // By regime
  const byRegime: any = {};
  for (const regime of ["positive","negative","very_negative","neutral","unknown"]) {
    const items = data.filter(d => d.regime === regime);
    if (items.length > 0) byRegime[regime] = groupStats(items);
  }

  // By CFD
  const byCfd: any = {};
  for (const cfd of ["NAS100","US30","XAUUSD"]) {
    byCfd[cfd] = groupStats(data.filter(d => d.cfd === cfd));
  }

  // By entry mode
  const byEntryMode: any = {};
  for (const mode of ["ENTRADA","VIGILANCIA","NO_OPERAR"]) {
    byEntryMode[mode] = groupStats(data.filter(d => d.entryMode === mode));
  }

  return {
    totalTracked: data.length,
    totalResolved: resolved.length,
    byTradeType,
    byScoreRange,
    byConfirmationCount,
    byLevelType: byLevelTypeStats,
    byRegime,
    byCfd,
    byEntryMode,
    topPerforming: data.filter(isWin).sort((a,b) => b.pnlPoints - a.pnlPoints).slice(0,10),
    recentSetups: [...data].sort((a,b) => new Date(b.trackedAt).getTime() - new Date(a.trackedAt).getTime()).slice(0,50),
  };
}

export function getAllTrackedSetups(): TrackedSetup[] {
  return loadTracking();
}
