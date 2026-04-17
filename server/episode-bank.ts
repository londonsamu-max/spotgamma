/**
 * Episode Bank — Banco persistente de episodios de trading en vivo
 *
 * Almacena TODOS los trades que el agente ejecuta en producción en JSONL
 * (una línea JSON por episodio, fácil de leer y agregar).
 *
 * Dos archivos:
 *   - live-episodes.jsonl   → trades cerrados con outcome real (TP/SL)
 *   - daily-context.jsonl   → estado SpotGamma diario (para LSTM histórico)
 *
 * Flujo:
 *   1. Al abrir trade: openEpisode(tradeId, state, action, metadata)
 *   2. Al cerrar trade: closeEpisode(tradeId, outcome, reward)
 *   3. Una vez al día: saveDailyContext(date, state)
 *   4. Nightly retrain lee live-episodes.jsonl y los mezcla con training histórico
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");

const BANK_PATH    = path.join(DATA_DIR, "live-episodes.jsonl");
const CONTEXT_PATH = path.join(DATA_DIR, "daily-context.jsonl");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveEpisode {
  date:      string;          // "YYYY-MM-DD"
  ts:        number;          // Unix ms
  state:     number[];        // 94 features (normalized for inference)
  rawState:  number[];        // 94 features (pre z-score, post normalizeForInference)
  action: {
    direction:      number;   // 0=SKIP, 1=LONG, 2=SHORT
    risk:           number;   // 0=tight, 1=normal, 2=wide
    entry:          number;   // 0=at_market, 1=at_level, 2=at_wall
    sizing:         number;   // 0=small, 1=medium, 2=full
    session:        number;   // 0=trade_now, 1=wait
    overExtension:  number;   // 0=TRADE, 1=SKIP
    entryQuality:   number;   // 0=ACCEPT_CAUTION, 1=WAIT_OPTIMAL
    scoreThreshold: number;   // 0=LOW, 1=MED, 2=HIGH, 3=EXTRA
  };
  outcome:  "tp1" | "tp2" | "tp3" | "sl" | "cancelled" | null;
  reward:   number | null;
  symbol:   string;           // "SPX", "QQQ", "DIA", "GLD"
  cfd:      string;           // "NAS100", "US30", "XAUUSD"
  price:    number;           // precio entrada CFD
  // SpotGamma snapshot (para reconstruir contexto)
  gexLevel:   number;
  gammaFlip:  number;
  hiroValue:  number;
  confidence: number;         // confianza del agente [0-1]
}

export interface DailyContext {
  date:    string;       // "YYYY-MM-DD"
  state:   number[];     // 94 features (normalized) — snapshot del día
  gex:     number;
  flip:    number;
  hiro:    number;
}

// ── Episode Bank ──────────────────────────────────────────────────────────────

class EpisodeBank {
  private closedEpisodes: LiveEpisode[] = [];
  private dailyContexts:  DailyContext[] = [];
  private pendingMap = new Map<string, LiveEpisode>(); // tradeId → episode

  constructor() {
    this._load();
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  private _load() {
    // Cargar episodios cerrados
    if (fs.existsSync(BANK_PATH)) {
      const lines = fs.readFileSync(BANK_PATH, "utf8")
        .split("\n").filter(Boolean);
      for (const line of lines) {
        try { this.closedEpisodes.push(JSON.parse(line)); } catch {}
      }
      console.log(`[EpisodeBank] ${this.closedEpisodes.length} episodios cargados`);
    }

    // Cargar contextos diarios
    if (fs.existsSync(CONTEXT_PATH)) {
      const lines = fs.readFileSync(CONTEXT_PATH, "utf8")
        .split("\n").filter(Boolean);
      for (const line of lines) {
        try { this.dailyContexts.push(JSON.parse(line)); } catch {}
      }
      console.log(`[EpisodeBank] ${this.dailyContexts.length} contextos diarios cargados`);
    }
  }

  // ── Trade lifecycle ─────────────────────────────────────────────────────────

  /** Llamar al abrir el trade */
  openEpisode(
    tradeId:  string,
    episode:  Omit<LiveEpisode, "outcome" | "reward">,
  ) {
    // Sanitize state arrays — replace null/NaN with 0
    const sanitize = (arr: number[]) => arr.map(v => (v == null || !isFinite(v)) ? 0 : v);
    const ep = { ...episode, outcome: null as any, reward: null as any };
    ep.state = sanitize(ep.state);
    ep.rawState = sanitize(ep.rawState);
    this.pendingMap.set(tradeId, ep);
    console.log(`[EpisodeBank] Opened episode ${tradeId}: ${ep.state.length} features, ${ep.symbol}/${ep.cfd}`);
  }

  /** Llamar cuando el trade cierra (TP/SL/cancelled) */
  closeEpisode(
    tradeId: string,
    outcome: LiveEpisode["outcome"],
    reward:  number,
  ) {
    const ep = this.pendingMap.get(tradeId);
    if (!ep) {
      console.warn(`[EpisodeBank] closeEpisode: tradeId ${tradeId} no encontrado`);
      return;
    }
    ep.outcome = outcome;
    ep.reward  = reward;
    this.pendingMap.delete(tradeId);

    // Append a JSONL (una línea por episodio)
    try {
      fs.appendFileSync(BANK_PATH, JSON.stringify(ep) + "\n");
      this.closedEpisodes.push(ep);
    } catch (err) {
      console.error("[EpisodeBank] Error guardando episodio:", err);
    }
  }

  // ── Daily context ───────────────────────────────────────────────────────────

  /**
   * Guardar contexto SpotGamma del día (llamar una vez al día, ej. 10am ET).
   * Usado como input de la secuencia LSTM para los días siguientes.
   */
  saveDailyContext(ctx: DailyContext) {
    if (this.dailyContexts.some(d => d.date === ctx.date)) {
      return; // Ya guardado hoy
    }
    // Sanitize: replace null/NaN/undefined with 0 in state
    ctx.state = ctx.state.map(v => (v == null || !isFinite(v)) ? 0 : v);
    try {
      fs.appendFileSync(CONTEXT_PATH, JSON.stringify(ctx) + "\n");
      this.dailyContexts.push(ctx);
      console.log(`[EpisodeBank] Daily context: ${ctx.state.length} features, ${ctx.state.filter(v => Math.abs(v) > 0.001).length} non-zero`);
    } catch (err) {
      console.error("[EpisodeBank] Error guardando contexto diario:", err);
    }
  }

  // ── LSTM sequence retrieval ─────────────────────────────────────────────────

  /**
   * Retorna los últimos `seqLen` contextos diarios ANTES de `today`.
   * Si no hay suficiente historia, rellena con ceros al inicio.
   *
   * Esto es el input de la rama LSTM: información histórica sin look-ahead.
   */
  getHistoricalSequence(today: string, seqLen: number): number[][] {
    const STATE_SIZE = 108;
    const ZERO = new Array(STATE_SIZE).fill(0);

    const sorted = [...this.dailyContexts]
      .filter(d => d.date < today)                    // solo pasado
      .sort((a, b) => a.date.localeCompare(b.date))   // cronológico
      .slice(-seqLen);                                 // últimos N

    // Padding con ceros si no hay suficiente historia
    const result: number[][] = [];
    const needed = seqLen - sorted.length;
    for (let i = 0; i < needed; i++) result.push([...ZERO]);
    for (const ctx of sorted) result.push(ctx.state);

    return result; // shape: [seqLen, STATE_SIZE]
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getStats() {
    const closed = this.closedEpisodes;
    const wins   = closed.filter(e => e.outcome && e.outcome !== "sl" && e.outcome !== "cancelled");
    const losses = closed.filter(e => e.outcome === "sl");
    return {
      total:         closed.length,
      pending:       this.pendingMap.size,
      wins:          wins.length,
      losses:        losses.length,
      winRate:       closed.length ? `${(wins.length / closed.length * 100).toFixed(1)}%` : "N/A",
      dailyContexts: this.dailyContexts.length,
      avgReward:     closed.length
        ? (closed.reduce((s, e) => s + (e.reward ?? 0), 0) / closed.length).toFixed(3)
        : "N/A",
    };
  }

  getRecentEpisodes(n: number): LiveEpisode[] {
    return this.closedEpisodes.slice(-n);
  }

  getAllEpisodes(): LiveEpisode[] {
    return this.closedEpisodes;
  }

  getDailyContexts(): DailyContext[] {
    return this.dailyContexts;
  }

  hasDailyContext(date: string): boolean {
    return this.dailyContexts.some(d => d.date === date);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _bank: EpisodeBank | null = null;

export function getEpisodeBank(): EpisodeBank {
  if (!_bank) _bank = new EpisodeBank();
  return _bank;
}
