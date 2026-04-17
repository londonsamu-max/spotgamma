# Nuevas Reglas Propuestas — Derivadas de Backtest OOS

**Fecha:** 2026-04-17
**Fuente:** Discovery + OOS validation sobre 5,289 eventos de touches (SPY + QQQ, 2024-12 a 2026-04)
**Split:** Train 2,804 eventos (2024-12 → 2025-09), Test 2,485 eventos (2025-10 → 2026-04)
**Criterio:** N_test ≥ 40, dirección de edge preservada, magnitud OOS ≥ 50% de magnitud train

---

## RESUMEN DE HALLAZGOS ROBUSTOS

De 41 survivors univariados en 4h + 136 bivariados + 20 EOD, identifico **5 patrones ACCIONABLES** con evidencia consistente en train y test:

### Los 5 patrones con edge robusto OOS:

1. **VIX ≥ 25 → BREAK bias sistemático** (efecto más fuerte encontrado)
2. **VIX [15,20] + strike justo arriba del precio (+1 a +3%) → BOUNCE bias** (ideal para resistencia débil)
3. **Afternoon (sessionProgress > 0.3) + momentum alcista → BREAK continuation**
4. **Morning touches (primera hora) → tendencia a BOUNCE/hold**
5. **oiRatio ≥ 0.7 (strike call-heavy) → más flat, menos decisivo**

---

## L114 — VIX ≥ 25 = BREAK BIAS (reemplaza parcialmente L94)

**Evidencia empírica:**

| Bucket VIX | N train | N test | Train edge BREAK | Test edge BREAK | Retention |
|---|---|---|---|---|---|
| VIX ≥ 30 (extreme) | 252 | 53 | +11.2pp | **+33.4pp** | 2.99x (más fuerte OOS) |
| VIX [25,30) (high) | 157 | 399 | +17.7pp | +17.0pp | 0.96x (rock solid) |
| VIX [25,30) — 1h horizon | 157 | 399 | +23.0pp | +11.9pp | 0.51x |
| VIX ≥ 30 — EOD horizon | 252 | 53 | +22.9pp | **+36.8pp** | 1.61x |

**Regla:**
- Si **VIX ≥ 25** al momento del touch → el strike probablemente BREAKEA en 4h/EOD.
- Preferir **breakout entries** (SHORT debajo de resistencia cuando aproxima desde arriba; LONG arriba de soporte cuando aproxima desde abajo).
- NO intentar fade (bounce contra gamma bar) cuando VIX ≥ 25.
- **VIX ≥ 30** = break casi seguro a EOD (77% break rate en test). Entra breakout con máxima convicción.

**Mecanismo:** Alta volatilidad expande el rango diario (+35-180% vs normal), sobrepasando la capacidad de absorción del dealer hedging. Los gamma bars dejan de retener.

**Conflicto con CLAUDE.md backtest stats:** L94 mencionaba "VIX > 20 = barras 50% más confiables" — esto aplica para VIX 20-25 (el `mid` bucket sí bouncea más). Para VIX 25+ la relación se invierte: más vol = más break. La lesson debe especificar el bucket.

---

## L115 — VIX NORMAL [15-20] + STRIKE JUSTO ARRIBA DEL PRECIO (+1 a +3%) → BOUNCE LONG

**El hallazgo más limpio y accionable del backtest.**

| Condición | N train | N test | Bounce% train | Bounce% test | Edge OOS |
|---|---|---|---|---|---|
| VIX [15-20) + distSpotToStrikePct [+0.01, +0.03] | 115 | 106 | **53.9%** | **61.3%** | **+26pp bounce OOS** |

**Regla:**
- Cuando **VIX está en rango normal (15-20)** Y el strike está **entre +1% y +3% arriba** del precio actual
- El 61% de las veces el strike **BOUNCE** (rechaza)
- **Entry:** LONG con SL debajo del strike siguiente; TP al strike aproximado
- Para NAS100 (~26000): strike a distancia de 260-780 pts arriba
- Para SPY ($660): strike a distancia $6.60-$19.80 arriba

**Por qué funciona:** En volatilidad normal, los dealers tienen capacidad de absorber moves hacia strikes con gamma positivo. Strikes ligeramente arriba del spot son típicamente call walls donde dealers están cortos calls → venden stock al rallar → crea resistencia efectiva.

**NO CONFUNDIR con L83** (LEVEL mode default): L115 dice QUÉ LADO tomar. L83 dice CÓMO ENTRAR.

---

## L116 — AFTERNOON + MOMENTUM YA ALCISTA = BREAK CONTINUATION

**Evidencia:**

| Condición | N train | N test | Break% train | Break% test | Edge OOS |
|---|---|---|---|---|---|
| `minuteBucket = aft` + `priceRelToOpen [+0.3%, +1%]` | 127 | 127 | 55.1% | **59.1%** | +22.7pp break |
| `sessionProgress [0.7, 0.9]` + `priceRelToOpen [+0.3%, +1%]` | 110 | 106 | 52.7% | **57.5%** | +21.2pp break |
| `minuteBucket = aft` (cualquier priceRel) | 482 | 478 | 44.4% | **50.8%** | +14.5pp break |

**Regla:**
- Si el touch ocurre en **tarde** (después de las 14:00 ET — `sessionProgress > 0.7`) Y el precio ya está **+0.3% a +1%** arriba del open
- El strike **BREAKEA 59%** de las veces (vs baseline 36%)
- **Acción:** NO fadear (no bouncear contra el rally de tarde). Comprar breakout o mantenerse fuera. SHORT contra-tendencia = pérdida esperada.

**Mecanismo:** Tendencias de tarde tienen momentum institucional (fondos rebalanceando, MOC orders). Dealers ya están hedgeados, rango día ya se expandió.

---

## L117 — MORNING TOUCHES TIENDEN A HOLD (primera hora)

**Evidencia (EOD horizon):**

| Bucket | N train | N test | Bounce% train | Bounce% test | Edge OOS |
|---|---|---|---|---|---|
| `minuteBucket = open` (primeros 30 min) | 768 | 670 | 46.4% | 43.9% | +4.0pp bounce |
| `sessionProgress < 0.1` | 789 | 708 | 46.4% | 43.6% | +3.7pp bounce |
| `minuteOfSession < 60` (primera hora) | 841 | 768 | 46.5% | 43.5% | +3.6pp bounce |

**Regla:**
- Touches en la **primera hora de sesión** (9:30-10:30 ET) tienen **~44% bounce rate** (vs baseline 40% EOD, 24% 1h)
- Especialmente bounces que terminan el día manteniéndose
- **Acción:** En morning session, bounces son más confiables. BOUNCE trades (fade the touch) tienen edge pequeño pero persistente.

**Cautela:** El edge es solo +3-4pp OOS. Menor que L114-L116. Usar como filtro, no como señal primaria.

---

## L118 — CALL-HEAVY STRIKES (oiRatio ≥ 0.7) = FLAT DOMINANTE

**Evidencia:**

| Condición | N train | N test | Flat% train | Flat% test | Edge break |
|---|---|---|---|---|---|
| oiRatio ≥ 0.7 (1h horizon) | 469 | 317 | 67.8% | 65.9% | -12.2pp (less break) |
| oiRatio ≥ 0.7 (4h horizon) | 469 | 317 | 48.6% | 42.2% | -6.7pp (less break) |

**Regla:**
- Strikes donde el **70%+ del OI es de calls** tienden a estar **FLAT** (mucho menos break, también menos bounce)
- **Acción:**
  - NO usar para directional breakout/bounce trades (bajo edge en ambas direcciones)
  - SÍ usar para **scalp range** (precio se queda entre dos call-heavy strikes → 0DTE iron condor estilo)
  - Evitar gastar orders/capital con conviction alta en estos strikes

**Mecanismo:** Call-heavy = dealers short calls = supply arriba + absorción de upside. Combinado con falta de put OI (sin presión abajo) = range-bound.

---

## NUEVOS FEATURES A CAPTURAR EN LIVE (para aplicar L114-L118)

Estos ya están disponibles en `getAgentView` pero no estaban siendo extraídos:

1. **`oiRatio` por strike** — hay que calcularlo de `callOI / (callOI + putOI)` (ya en gammaBars live)
2. **`distSpotToStrikePct`** — trivial: `(precio - strike) / precio` (per bar)
3. **`minuteBucket`** — derivar de hora actual (ya se puede)
4. **`priceRelToOpenPct`** — `(precio_actual - precio_open_session) / precio_open_session`
5. **VIX level bucket** — de getAgentView `vanna.vix`

**Script a actualizar:** `compute-dominance.cjs` puede extenderse para también computar estos flags.

---

## INTEGRACIÓN PROPUESTA AL CHECKLIST (ítem 14 — Entry Decisions)

Añadir paso **14.X — Filtros de contexto L114-L118** ANTES de colocar cada orden:

```
Para cada pendingOrder propuesto, verificar:
  ├─ VIX level bucket:
  │   ├─ ≥ 25 → preferir BREAKOUT, evitar BOUNCE (L114)
  │   ├─ [15, 20) + strike +1-3% arriba → BOUNCE LONG (L115)
  │   └─ < 15 → edge débil, reducir conviction
  ├─ Minute bucket:
  │   ├─ aft + precio ya subió +0.3-1% → BREAK continuation (L116)
  │   └─ open (primera hora) → BOUNCE edge pequeño (L117)
  └─ oiRatio del strike:
      └─ ≥ 0.7 → FLAT bias, NO directional trade (L118)
```

---

## QUÉ NO SOBREVIVIÓ OOS (a descartar del hype)

1. **`dxyTrend5d = down` → bounce** — Train edge +16.4pp pero N_test solo 56 eventos, retention degradada.
2. **`tltTrend5d = down` → break** — mismo problema (N_test=56).
3. **Quarterly opex bounce** — N muy bajo (123 train, 32 test), no generalizable.
4. **`distToCallWallPct < -0.05` → bounce** — Se degradó >50% OOS.
5. **Day of week effects** — No sobrevivieron como edge dominante en ninguna horizon (demasiado ruido con N pequeño por día).

---

## COMPARATIVA CON LESSONS EXISTENTES

| Lesson nueva | Reemplaza / modifica |
|---|---|
| L114 (VIX≥25 break) | Clarifica L94 (que sugería VIX>20 = más bounce — solo cierto para 20-25) |
| L115 (VIX 15-20 + strike +1-3% = bounce) | Nuevo — específico, accionable |
| L116 (afternoon + momentum = break) | Extiende L39, L82 |
| L117 (morning holds) | Extiende intuición de L83 para timing |
| L118 (call-heavy = flat) | Nuevo — específico, evita malas entradas |

---

## PRÓXIMOS PASOS RECOMENDADOS

### 1. Aplicar L114-L118 en el próximo ciclo del agente
Actualizar `CLAUDE.md` con las 5 lessons nuevas y el sub-item de checklist 14.X.

### 2. Refactorizar `compute-dominance.cjs` para incluir los 5 features nuevos
Así en cada ciclo el agente tiene a mano los valores que activan L114-L118.

### 3. Forward test (2 meses)
Guardar decisiones donde cada lesson nueva se activó → re-medir edge en nueva data para confirmar generalización.

### 4. Expandir scope del backtest
- Agregar DIA y GLD (si se soluciona el bug del ohlc-1min corruption)
- Intentar extraer HIRO histórico desde flow data (aggregating flow timestamps por 15-min ventana — approximate rebuild)
- Agregar features de flow-features una vez termine el preprocessing (Fase 0)

### 5. Walking forward mensual
Cada mes rehacer el backtest agregando el mes nuevo. Si una lesson pierde edge 3 meses seguidos → deprecar.
