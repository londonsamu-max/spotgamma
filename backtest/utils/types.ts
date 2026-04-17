/** Shared types for the backtest */

export type CFD = "NAS100" | "US30" | "XAUUSD";
export type Direction = "LONG" | "SHORT";
export type TradeMode = "scalp" | "intraday" | "swing";
export type MarketStructure =
  | "accumulation" | "distribution" | "markup" | "markdown"
  | "congestion" | "squeeze" | "trend_day" | "rotation_day";

export interface GammaBar {
  strike: number;
  netGamma: number;
  totalGamma: number;
  type: "support" | "resistance" | "neutral";
  netPositioning: number;
  callGamma: number;
  putGamma: number;
  callOI: number;
  putOI: number;
  symbol: string; // SPX, QQQ, SPY, DIA, GLD
  cfdPrice?: number; // converted to CFD price
}

export interface GammaBarsDaily {
  date: string;
  symbol: string;
  spotPrice: number;
  zeroGamma: number;
  callWall: number;
  putWall: number;
  allBars: GammaBar[];
}

export interface OHLCBar {
  t: number; // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MT5Candle {
  datetime: string; // "YYYY.MM.DD HH:MM"
  t?: number; // parsed unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
  spread: number;
}

export interface AgentViewSnapshot {
  t: number; // timestamp
  date: string; // YYYY-MM-DD
  timeStr: string; // HH:MM UTC
  cfdPrices: Record<CFD, number>;
  gammaBarsNear: Record<CFD, GammaBar[]>; // top 10 fat bars per CFD near price
  conversionRatios: { NAS100: number; US30: number; XAUUSD: number };
  spotGammaFlags: {
    callWall: Record<string, number>;
    putWall: Record<string, number>;
    zeroGamma: Record<string, number>;
  };
  marketStructure?: Record<CFD, MarketStructure>;
}

export interface TradeIntent {
  id: string;
  cfd: CFD;
  direction: Direction;
  tradeMode: TradeMode;
  exactLevel: number;
  entryMode: "level" | "zone" | "confirm";
  structuralSL: number;
  tp1: number;
  tp2?: number;
  tp3?: number;
  volume: number;
  rationale: string;
  conviction: "HIGH" | "MEDIUM" | "LOW";
  triggerSymbol: string;
  triggerLevel: number;
  createdAt: number;
  expiresAt: number;
}

export interface SimulatedFill {
  intentId: string;
  filledAt: number;
  entryPrice: number;
  slippage: number;
}

export interface ClosedTrade {
  intentId: string;
  cfd: CFD;
  direction: Direction;
  tradeMode: TradeMode;
  entry: number;
  entryTs: number;
  exit: number;
  exitTs: number;
  exitReason: "sl" | "tp1" | "tp2" | "tp3" | "trail" | "eod" | "manual";
  pnlPts: number;
  pnlDollars: number;
  durationMin: number;
  maxAdverse: number; // worst drawdown against position
  maxFavorable: number; // best unrealized profit
}

export interface DayResult {
  date: string;
  cfdOpenClose: Record<CFD, { open: number; close: number; high: number; low: number }>;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  pnlDollars: number;
  pnlByCfd: Record<CFD, number>;
  pnlByMode: Record<TradeMode, number>;
  trades: ClosedTrade[];
  notes?: string;
}

export interface BacktestReport {
  startDate: string;
  endDate: string;
  daysProcessed: number;
  totalTrades: number;
  winRate: number;
  netPnlDollars: number;
  pnlByCfd: Record<CFD, number>;
  pnlByMode: Record<TradeMode, number>;
  pnlByDayOfWeek: Record<string, number>;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  startingEquity: number;
  endingEquity: number;
  days: DayResult[];
}

// Broker specs
export const BROKER_SPECS: Record<CFD, { dollarsPerPoint: number; minLot: number; symbol: string }> = {
  NAS100: { dollarsPerPoint: 0.10, minLot: 0.10, symbol: "NAS100" },
  US30: { dollarsPerPoint: 0.10, minLot: 0.10, symbol: "US30" },
  XAUUSD: { dollarsPerPoint: 1.00, minLot: 0.01, symbol: "XAUUSD" },
};

// SL/TP buffers from CLAUDE.md (L58, L66 region + trade mode defaults)
export const BUFFERS: Record<CFD, { slBuffer: number; beBuffer: number }> = {
  NAS100: { slBuffer: 15, beBuffer: 5 },  // L106
  US30: { slBuffer: 15, beBuffer: 5 },
  XAUUSD: { slBuffer: 5, beBuffer: 2 },   // L106
};
