/**
 * Synth-OI Daily loader — uses data/historical/synth-oi-daily/{SYM}.json
 * Provides daily regime + VRP + IV rank + skew for SPX, SPY, QQQ, DIA, GLD.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const HIST = path.resolve(process.cwd(), "data/historical/synth-oi-daily");

export interface SynthOIDay {
  quote_date: string;
  sym: string;
  upx: number; // spot price
  callsum: number;
  putsum: number;
  put_call_ratio: number;
  gamma_ratio: string | number; // 0-1 typically
  delta_ratio: string | number;
  atm_iv30: number;
  rv30: number;
  options_implied_move: number;
  iv_rank: number;
  skew_rank: number;
  ne_skew: number;
  skew: number;
  vrp_scanner_high: boolean;
  squeeze_scanner: any;
  atmgc?: any;
  activity_factor?: number;
  large_call_oi?: number;
  large_put_oi?: number;
  stock_volume?: number;
  stock_volume_30d_avg?: number;
}

const cache = new Map<string, SynthOIDay[]>();

function loadSymbol(sym: string): SynthOIDay[] {
  if (cache.has(sym)) return cache.get(sym)!;
  const file = path.join(HIST, `${sym}.json`);
  if (!fs.existsSync(file)) {
    cache.set(sym, []);
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  parsed.sort((a: SynthOIDay, b: SynthOIDay) => a.quote_date.localeCompare(b.quote_date));
  cache.set(sym, parsed);
  return parsed;
}

/** Find the synth-OI entry on or before `date` (YYYY-MM-DD) */
export function getSynthOi(sym: string, date: string): SynthOIDay | null {
  const bars = loadSymbol(sym);
  if (bars.length === 0) return null;
  const dateIso = `${date}T`;
  let lastMatch: SynthOIDay | null = null;
  for (const b of bars) {
    if (b.quote_date.slice(0, 10) > date) break;
    lastMatch = b;
  }
  return lastMatch;
}

export interface RegimeInfo {
  regime: "very_positive" | "positive" | "neutral" | "negative" | "very_negative";
  vrp: number; // atm_iv30 - rv30 (positive = premium, negative = discount)
  ivRank: number;
  skewBias: "call_skew" | "put_skew" | "neutral";
  putCallRatio: number;
  implied_move: number;
  bullBearRegime: "bullish" | "bearish" | "neutral";
}

/** Determine regime for a symbol on a date */
export function getRegime(sym: string, date: string): RegimeInfo | null {
  const s = getSynthOi(sym, date);
  if (!s) return null;
  const gammaRatio = Number(s.gamma_ratio);
  const deltaRatio = Number(s.delta_ratio);

  let regime: RegimeInfo["regime"] = "neutral";
  if (gammaRatio > 0.3) regime = "very_positive";
  else if (gammaRatio > 0.1) regime = "positive";
  else if (gammaRatio > -0.1) regime = "neutral";
  else if (gammaRatio > -0.3) regime = "negative";
  else regime = "very_negative";

  const vrp = (s.atm_iv30 ?? 0) - (s.rv30 ?? 0);

  let skewBias: RegimeInfo["skewBias"] = "neutral";
  if (s.skew < -0.3) skewBias = "put_skew";
  else if (s.skew > 0.3) skewBias = "call_skew";

  let bullBearRegime: RegimeInfo["bullBearRegime"] = "neutral";
  if (deltaRatio > 0.3) bullBearRegime = "bullish";
  else if (deltaRatio < -0.3) bullBearRegime = "bearish";

  return {
    regime,
    vrp,
    ivRank: s.iv_rank ?? 0,
    skewBias,
    putCallRatio: s.put_call_ratio ?? 1,
    implied_move: s.options_implied_move ?? 0,
    bullBearRegime,
  };
}
