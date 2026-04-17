/**
 * Retest Memory — SpotGamma Monitor
 *
 * Cuando un setup queda en VIGILANCIA con score cercano al umbral (≥ threshold - 10),
 * se guarda en memoria hasta RETEST_WINDOW_MS (12 minutos).
 *
 * En el siguiente ciclo, si el precio VUELVE al nivel GEX, el setup se promueve a
 * ENTRADA aunque el score fresco no alcance el umbral — porque ya confirmó su validez
 * cuando estuvo en el nivel la primera vez.
 *
 * Casos cubiertos:
 *   1. Ruido de precio (spike corto que aleja precio del nivel → vuelve)
 *   2. Retest post-breakout (precio rompe nivel, pullback al nivel roto → continúa)
 *
 * Casos NO cubiertos (correctamente ignorados):
 *   - Score < threshold - 10 la primera vez → no guardar (setup débil)
 *   - Precio se fue en dirección contraria > 0.5% → marcar como fallido, limpiar
 */

import type { TradeSetup } from "./trading-engine";

// ── Configuración ──────────────────────────────────────────────────
const RETEST_WINDOW_MS   = 12 * 60 * 1000;  // 12 minutos de ventana de memoria
const SCORE_MARGIN       = 10;               // score ≥ (threshold - 10) para guardar
const RETEST_DIST_PCT    = 0.40;             // precio dentro del 0.40% del nivel = retest válido
const FAILURE_DIST_PCT   = 0.60;            // precio se fue >0.60% contrario = setup fallido

// ── Tipos ──────────────────────────────────────────────────────────

export interface RetestEntry {
  cfd:           string;
  direction:     "LONG" | "SHORT";
  levelPrice:    number;    // nivel GEX original (entryLevel.strike)
  scoreAtTouch:  number;    // score cuando estuvo en el nivel
  threshold:     number;    // umbral de ENTRADA que no alcanzó
  tradeType:     "breakout" | "bounce" | "im_exhaustion" | "standard";
  savedAt:       number;    // timestamp ms
  expiresAt:     number;    // timestamp ms
  failed:        boolean;   // true si precio se fue demasiado en contra
  retestCount:   number;    // cuántas veces ha vuelto al nivel
}

// ── Estado en memoria (singleton, vive en el proceso Node.js) ──────
const retestMap = new Map<string, RetestEntry>();

function makeKey(cfd: string, direction: string, level: number): string {
  return `${cfd}_${direction}_${Math.round(level)}`;
}

// ── API Pública ────────────────────────────────────────────────────

/**
 * Evalúa un setup recién generado y decide si:
 *   a) guardarlo en memoria (era VIGILANCIA con score cercano)
 *   b) promoverlo a ENTRADA (retest de un nivel previamente guardado)
 *   c) marcarlo como fallido (precio se fue en contra)
 *
 * Retorna el setup (posiblemente modificado) y un flag indicando si fue promovido.
 */
export function evaluateRetest(
  setup: TradeSetup,
  currentPrice: number,
  scoreThreshold: number,
): { setup: TradeSetup; promoted: boolean } {
  if (setup.direction === "NO_TRADE" || !setup.entryZone) {
    return { setup, promoted: false };
  }

  const levelPrice  = setup.entryZone.strike;
  const key         = makeKey(setup.cfd, setup.direction, levelPrice);
  const now         = Date.now();
  const distPct     = Math.abs(currentPrice - levelPrice) / levelPrice * 100;

  // ── 1. Limpiar entradas expiradas ──────────────────────────────
  for (const [k, entry] of retestMap.entries()) {
    if (now > entry.expiresAt || entry.failed) {
      if (entry.failed) {
        console.log(`[RETEST] ❌ ${entry.cfd} ${entry.direction} @ ${entry.levelPrice} — fallido (precio en contra), limpiando`);
      } else {
        console.log(`[RETEST] ⏱ ${entry.cfd} ${entry.direction} @ ${entry.levelPrice} — expirado sin retest`);
      }
      retestMap.delete(k);
    }
  }

  const existing = retestMap.get(key);

  // ── 2. Si ya existe en memoria → evaluar retest ────────────────
  if (existing && !existing.failed) {
    // Verificar si el precio se fue demasiado en la dirección CONTRARIA (setup fallido)
    const wentAgainst =
      (setup.direction === "LONG"  && currentPrice < levelPrice * (1 - FAILURE_DIST_PCT / 100)) ||
      (setup.direction === "SHORT" && currentPrice > levelPrice * (1 + FAILURE_DIST_PCT / 100));

    if (wentAgainst) {
      existing.failed = true;
      console.log(`[RETEST] ❌ ${setup.cfd} ${setup.direction} @ ${levelPrice} — precio rompió en contra (${distPct.toFixed(2)}%), descartando`);
      return { setup, promoted: false };
    }

    // Verificar si el precio volvió al nivel (retest)
    const isRetesting = distPct <= RETEST_DIST_PCT;

    if (isRetesting) {
      existing.retestCount++;
      console.log(`[RETEST] 🔄 ${setup.cfd} ${setup.direction} @ ${levelPrice} — RETEST #${existing.retestCount} (dist ${distPct.toFixed(2)}%, score original ${existing.scoreAtTouch})`);

      // Solo promover si el setup actual no está en NO_OPERAR por razones duras
      // (implied move agotado, fuera de sesión, etc.) — esas no se pueden overridear
      const isHardBlock = setup.entryNote?.includes("Rango diario agotado") ||
                          setup.entryMode === "NO_OPERAR" && setup.entryNote?.includes("⛔") && !setup.entryNote?.includes("Score");

      if (!isHardBlock) {
        const promotedSetup: TradeSetup = {
          ...setup,
          entryMode:  "ENTRADA",
          entryNote:  `🔄 [RETEST] Nivel retestado (retest #${existing.retestCount}) | Score original: ${existing.scoreAtTouch}/${existing.threshold} | Dist: ${distPct.toFixed(2)}% | ${setup.entryNote}`,
          details:    [
            `[RETEST] ✅ Nivel ${levelPrice} retestado — precio volvió al nivel GEX tras alejarse (retest #${existing.retestCount})`,
            `[RETEST] Score en primer toque: ${existing.scoreAtTouch} (umbral: ${existing.threshold})`,
            ...setup.details,
          ],
        };
        return { setup: promotedSetup, promoted: true };
      }
    }

    return { setup, promoted: false };
  }

  // ── 3. Nuevo setup en VIGILANCIA con score cercano → guardar ───
  const scoreIsClose = setup.score >= scoreThreshold - SCORE_MARGIN;
  const priceIsNear  = distPct <= RETEST_DIST_PCT * 2; // margen más amplio para primer toque

  if (setup.entryMode === "VIGILANCIA" && scoreIsClose && priceIsNear) {
    const entry: RetestEntry = {
      cfd:          setup.cfd,
      direction:    setup.direction as "LONG" | "SHORT",
      levelPrice,
      scoreAtTouch: setup.score,
      threshold:    scoreThreshold,
      tradeType:    setup.tradeType as RetestEntry["tradeType"],
      savedAt:      now,
      expiresAt:    now + RETEST_WINDOW_MS,
      failed:       false,
      retestCount:  0,
    };
    retestMap.set(key, entry);
    console.log(`[RETEST] 💾 ${setup.cfd} ${setup.direction} @ ${levelPrice} guardado en memoria — score ${setup.score}/${scoreThreshold} (ventana: 12min)`);
  }

  return { setup, promoted: false };
}

/** Devuelve todos los setups en memoria (para debug/UI) */
export function getRetestMemory(): RetestEntry[] {
  return Array.from(retestMap.values()).filter(e => !e.failed);
}

/** Limpia toda la memoria (útil al inicio del día) */
export function clearRetestMemory(): void {
  retestMap.clear();
  console.log("[RETEST] Memoria limpiada");
}
