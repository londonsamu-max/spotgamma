/**
 * RollingNormalizer — z-score adaptativo por ventana de 60 días
 *
 * Problema que resuelve:
 *   Un gammaTilt=0.5 en 2018 no significa lo mismo que en 2025 (el mercado de
 *   opciones cambió estructuralmente post-2020). La normalización estática de
 *   normalizeForInference() usa multiplicadores fijos que no capturan esto.
 *
 * Solución:
 *   Para cada feature[i], mantener la media y std de los últimos 60 días.
 *   z_score[i] = (feature[i] - mean60d[i]) / (std60d[i] + ε)
 *
 * Uso:
 *   const norm = RollingNormalizer.load();        // carga stats del disco
 *   const zFeatures = norm.normalize(features);   // z-score live
 *   norm.update(today, features);                 // actualiza ventana
 *   norm.save();                                  // persiste al disco
 *
 * Cold-start: si hay < MIN_DAYS días en el buffer, devuelve features sin cambio.
 * El modelo fue entrenado con z-scores; en cold-start funciona con features raw
 * porque tienen rangos similares (ambas en ~[-3, 3]).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATS_FILE  = path.resolve(__dirname, "../data/rolling-stats.json");
const WINDOW_DAYS = 60;    // días de historia para mean/std
const MIN_DAYS    = 10;    // mínimo para activar z-scoring
const FEATURE_DIM = 108;
const CLIP_RANGE  = 5.0;   // clamp z-scores a [-5, 5]

interface DayEntry {
  date:  string;       // "YYYY-MM-DD"
  mean:  number[];     // media de los features ese día (todos los episodios del día)
  count: number;       // cuántos episodios se promediaron
}

interface SerializedStats {
  days:        DayEntry[];
  lastUpdated: string;
  windowDays:  number;
  featureDim:  number;
}

export class RollingNormalizer {
  private days: DayEntry[] = [];   // ventana deslizante, ordenada por fecha

  // ── Normalizar features con la ventana actual ────────────────────────────
  normalize(features: number[]): number[] {
    if (this.days.length < MIN_DAYS) {
      return features;  // cold-start: pasar features sin cambio
    }

    const { mean, std } = this._computeStats();
    const out = new Array<number>(features.length);
    for (let i = 0; i < features.length; i++) {
      const z = (features[i] - mean[i]) / std[i];
      out[i] = Math.max(-CLIP_RANGE, Math.min(CLIP_RANGE, z));
    }
    return out;
  }

  // ── Actualizar ventana con un nuevo set de features ──────────────────────
  // Llamar UNA vez por señal, con la fecha de trading (YYYY-MM-DD)
  update(date: string, features: number[]): void {
    const dateKey = date.slice(0, 10);  // solo YYYY-MM-DD

    // Si ya existe una entrada para este día, promediar online
    const existing = this.days.find(d => d.date === dateKey);
    if (existing) {
      const n = existing.count;
      for (let i = 0; i < FEATURE_DIM; i++) {
        existing.mean[i] = (existing.mean[i] * n + features[i]) / (n + 1);
      }
      existing.count++;
    } else {
      this.days.push({
        date:  dateKey,
        mean:  features.slice(0, FEATURE_DIM),
        count: 1,
      });
    }

    // Mantener solo los últimos WINDOW_DAYS días
    this._pruneWindow();
  }

  // ── Cuántos días hay en el buffer ────────────────────────────────────────
  get daysInBuffer(): number {
    return this.days.length;
  }

  get isWarmedUp(): boolean {
    return this.days.length >= MIN_DAYS;
  }

  // ── Persistencia ─────────────────────────────────────────────────────────
  save(): void {
    const data: SerializedStats = {
      days:        this.days,
      lastUpdated: new Date().toISOString(),
      windowDays:  WINDOW_DAYS,
      featureDim:  FEATURE_DIM,
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(data));
  }

  static load(): RollingNormalizer {
    const norm = new RollingNormalizer();
    if (fs.existsSync(STATS_FILE)) {
      try {
        const data: SerializedStats = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
        norm.days = data.days ?? [];
        norm._pruneWindow();
        console.log(`[RollingNorm] Loaded ${norm.days.length} days (warmed: ${norm.isWarmedUp})`);
      } catch (e: any) {
        console.warn(`[RollingNorm] Load failed: ${e.message} — starting fresh`);
      }
    } else {
      console.log("[RollingNorm] No stats file found — cold-start mode");
    }
    return norm;
  }

  // ── Exportar stats actuales (para debugging / logging) ───────────────────
  getStats(): { mean: number[]; std: number[]; daysInBuffer: number } {
    if (this.days.length < MIN_DAYS) {
      return {
        mean:         new Array(FEATURE_DIM).fill(0),
        std:          new Array(FEATURE_DIM).fill(1),
        daysInBuffer: this.days.length,
      };
    }
    const { mean, std } = this._computeStats();
    return { mean: Array.from(mean), std: Array.from(std), daysInBuffer: this.days.length };
  }

  // ── Helpers privados ──────────────────────────────────────────────────────
  private _computeStats(): { mean: number[]; std: number[] } {
    const N = this.days.length;
    const mean = new Array<number>(FEATURE_DIM).fill(0);
    const std  = new Array<number>(FEATURE_DIM).fill(0);

    // Calcular media
    for (const day of this.days) {
      for (let i = 0; i < FEATURE_DIM; i++) {
        mean[i] += day.mean[i] / N;
      }
    }

    // Calcular std (desviación estándar muestral)
    for (const day of this.days) {
      for (let i = 0; i < FEATURE_DIM; i++) {
        const diff = day.mean[i] - mean[i];
        std[i] += (diff * diff) / N;
      }
    }
    for (let i = 0; i < FEATURE_DIM; i++) {
      std[i] = Math.sqrt(std[i]) + 1e-6;  // ε para evitar división por cero
    }

    return { mean, std };
  }

  private _pruneWindow(): void {
    // Ordenar por fecha y mantener solo los últimos WINDOW_DAYS
    this.days.sort((a, b) => a.date.localeCompare(b.date));
    if (this.days.length > WINDOW_DAYS) {
      this.days = this.days.slice(this.days.length - WINDOW_DAYS);
    }
  }
}

// Singleton para el servidor
let _instance: RollingNormalizer | null = null;

export function getRollingNormalizer(): RollingNormalizer {
  if (!_instance) {
    _instance = RollingNormalizer.load();
  }
  return _instance;
}
