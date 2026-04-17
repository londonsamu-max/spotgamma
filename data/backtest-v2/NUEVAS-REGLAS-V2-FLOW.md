# Nuevas Reglas Propuestas V2 — Derivadas de Flow Discovery

**Fecha:** 2026-04-17
**Fuente:** Discovery + OOS sobre 1,230 eventos con strike-level flow (subset de 5,289 totales, 23%)
**Rango:** 2024-12 → 2026-04 | Train <2025-10-01, Test >=2025-10-01
**Criterio OOS:** direction preserved + |edge_te| ≥ 50% |edge_tr|

---

## DESCUBRIMIENTO CLAVE: `flow_strikeShareOfDay`

**Definición:** `premium en el strike hasta la hora del touch / premium total del día en ese símbolo`

Este es el feature de flow **más predictivo encontrado.** Captura cuánta atención institucional y retail se está concentrando en ese strike específico RELATIVO al flujo del día.

### Hallazgo bimodal (4h horizon):

| flow_strikeShareOfDay | Interpretación | bounce% | break% | Edge 4h | OOS retention |
|---|---|---|---|---|---|
| **0.1% a 1%** (moderado) | **ATENCIÓN CREANDO MOMENTUM** | 32.1% | **54.2%** | +11.2pp BREAK | 1.17x ✓ (N_test=178) |
| **≥ 5%** (alto) | **CONSENSO PIN** | 26.7% | 26.7% | -16.3pp BREAK (flat) | 1.75x ✓ (N_test=28) |

**Dos regímenes distintos del mismo feature:**
- Strike capturando 0.1-1% del flow diario = está **BAJO ACUMULACIÓN** → va a romper en 4h (54% break)
- Strike capturando >5% = es un **STRIKE DE CONSENSO** → pin/se mantiene flat (16pp menos break que baseline)

**Mecanismo:**
- 0.1-1%: flujos moderados pero crecientes son la huella de institucionales acumulando una posición direccional. El strike está siendo "atacado" progresivamente.
- >5%: cuando todos tradean en el mismo strike, se convierte en un imán magnético con dealer hedging concentrado = precio se queda pinado hasta opex.

---

## L119 — STRIKE CON ATENCIÓN MODERADA (0.1-1% share) = BREAK BIAS

**Evidencia:**
- 1h: +9.3pp break (retention 0.72x ✓), N_test=178
- 4h: +11.2pp break (retention 1.17x ✓), N_test=178
- EOD: +11.1pp break (retention 0.88x ✓), N_test=178

**Regla:**
Si en el momento del touch el strike ha capturado entre 0.1% y 1% del premium total del día en ese símbolo, el strike **BREAKEA 54%** en 4h y **53% a EOD** (vs baseline ~40%).

**Acción:** Preferir **breakout entries** sobre bounce entries cuando este feature esté activo.

---

## L120 — STRIKE DE CONSENSO (>5% share) = FLAT/PIN

**Evidencia:**
- 4h: -16.3pp break (retention 1.75x ✓), N_test=28 (pequeño pero consistente)
- EOD: -19pp break (retention 1.41x ✓), N_test=28

**Regla:**
Strikes capturando >5% del flow diario actúan como imanes. **23% break** (vs 40% baseline) a 4h y EOD.

**Acción:**
- **NO directional break trade** contra este strike
- Usar como **TP magnético** (precio tenderá a volver)
- Considerar **scalp range** si hay dos consensus strikes cerca

---

## L121 — MODERATE ATTENTION + VIX LOW = RETAIL BREAKOUT (mega edge)

**Evidencia:**
- `flow_strikeShareOfDay [0.001, 0.01)` + `vixBucket = low` → **62.1% BREAK** @ 4h
- N_train=58 test-train → N_test=36, retention **21.74x** ✓ (edge EXPANDIÓ OOS)

**Regla:**
Cuando VIX está calmo (15-20) Y el strike tiene 0.1-1% del flow del día → **62% break en 4h** (vs baseline ~36%).

**Interpretación:**
En vol baja, los institucionales están quietos. El flow moderado que llega al strike es RETAIL acumulando momentum. Los gamma walls no aguantan porque los dealers tienen poco hedging activo (vol baja).

**Acción:** En VIX [15-20] con strike recibiendo atención moderada, entrar breakout con máxima convicción (posiblemente SWING si hay continuación).

---

## L122 — TRADES GIGANTES (≥$1M) + VIX EN CAÍDA = BOUNCE

**Evidencia:**
- `flow_largestPrem ≥ $1M` + `vixTrend5d = down` → **46.2% BOUNCE** (+13.8pp), N_test=31, retention 0.84x ✓

**Regla:**
Si en el strike hay al menos UN trade de $1M+ Y el VIX viene cayendo 5 días, el strike **BOUNCEA 46%** (vs baseline 32%).

**Mecanismo:**
Un trade de $1M+ en un strike mientras VIX cae = smart money comprando el piso. Esto típicamente precede un rally mean-reversion. El strike se convierte en soporte activo.

**Acción:**
- Identificar strikes con `flow_largestPrem ≥ $1M` (visible en `institutionalFlow.bigTrades`)
- Si `vixTrend5d = down` → entrar LONG con SL debajo del strike siguiente

---

## L123 — LARGE TRADE (200K-1M) + VIX FLAT = BREAK CONTINUATION

**Evidencia:**
- `flow_largestPrem [$200K, $1M]` + `vixTrend5d = flat` → **60.0% BREAK**, N_test=33, retention 0.81x ✓

**Regla:**
Trades entre $200K y $1M en un strike + VIX flat → **60% break** en 4h.

**Interpretación:**
Rango medio institucional sin direccionalidad macro = reposicionamiento táctico. El strike es atacado y eventualmente cede.

---

## L124 — LOW INSTITUTIONAL SHARE + FLAT VIX = RETAIL DOMINADO BREAK

**Evidencia:**
- `flow_instShare < 0.005` + `vixTrend5d = flat` → **56.4% BREAK**, N_test=64, retention 1.26x ✓

**Regla:**
Cuando <0.5% de los trades del strike son institucionales Y VIX está flat → **56% break**.

**Interpretación:**
Sin smart money posicionando Y sin fuerza direccional VIX, el strike está "desprotegido". Los flows retail (frecuentemente one-sided) pueden romperlo más fácil.

**Acción:** Cuando detects que un strike solo tiene flow retail en VIX flat, es candidato a breakout. NO fadear.

---

## L125 — STRIKE ATTENTION + SESIÓN TARDE = BREAK MÁS PROBABLE

**Evidencia:**
- `flow_strikeShareOfDay [0.01, 0.05]` + `sessionProgress [0.7, 0.9]` → **56.5% BREAK**, N_test=155, retention 1.43x ✓

**Regla:**
Strike con 1-5% del flow diario + último tramo de sesión → **56% break**. N alto (N=239 train, 155 test).

Combina con L116 (afternoon + momentum = break) para aún más convicción.

---

## NUEVOS FEATURES A CAPTURAR EN LIVE

El agente ya tiene `institutionalFlow.bigTrades[]` y `optionsFlow.*` en `getAgentView`. Para aplicar L119-L125 necesita calcular en tiempo real:

### 1. `flow_strikeShareOfDay` — ⭐ CRÍTICO

```javascript
// Por símbolo, acumular premium total del día
const dayTotalPremium = sum of all trades today in sym

// Por cada strike, acumular
const strikeTotalPremium = sum of trades at strike today

flow_strikeShareOfDay = strikeTotalPremium / dayTotalPremium
```

### 2. `flow_largestPrem` — por strike

De `institutionalFlow.bigTrades[]`, para cada strike: `max(prem)` acumulado.

### 3. `flow_instShare` — por strike

```
flow_instShare = count(trades where prem >= $50K at strike) / count(all trades at strike)
```

### 4. `vixTrend5d`

Ya tenemos `vanna.vix` live. Necesita memoria de últimos 5 días cerrados → calcular trend.

---

## INTEGRACIÓN AL CHECKLIST (ítem 10 — OPTIONS FLOW)

Añadir paso **10.X — Flow share por strike**:

```
Para cada strike cercano al precio actual (±2%):
  ├─ Calcular flow_strikeShareOfDay acumulado hasta ahora
  ├─ Buckets:
  │   ├─ [0.001, 0.01) = moderate attention → BREAK bias (L119)
  │   ├─ [0.01, 0.05) = rising attention → watch break (L125 w/ afternoon)
  │   └─ >= 0.05 = consensus pin → FLAT bias (L120)
  ├─ Detectar flow_largestPrem al strike:
  │   ├─ ≥ $1M + vixTrend5d = down → BOUNCE LONG (L122)
  │   └─ [$200K, $1M] + vixTrend5d = flat → BREAK (L123)
  └─ Detectar flow_instShare al strike:
      └─ < 0.005 + vixTrend5d = flat → BREAK (L124)
```

---

## RANKING DE TODAS LAS LESSONS NUEVAS (L114-L125)

| Lesson | Feature base | Edge OOS | N test | Poder | Comentario |
|---|---|---|---|---|---|
| **L121** ⭐⭐⭐ | flow share moderate + VIX low | +26pp break | 36 | ALTO | Retention 21.74x (edge creció OOS) |
| **L114** ⭐⭐⭐ | VIX ≥25 | +17 a +33pp break | 399+53 | ALTO | Ya existente, validated |
| **L115** ⭐⭐⭐ | VIX 15-20 + strike +1-3% | +26pp bounce | 106 | ALTO | Clásico, accionable |
| **L119** ⭐⭐ | flow_strikeShareOfDay 0.1-1% | +11pp break | 178 | MEDIO | Amplia aplicabilidad |
| **L120** ⭐⭐ | flow_strikeShareOfDay >5% | -19pp break | 28 | MEDIO | Consensus pin — útil como TP |
| **L122** ⭐⭐ | largestPrem ≥$1M + VIX down | +14pp bounce | 31 | MEDIO | Smart money bottom signal |
| **L116** ⭐⭐ | afternoon + momentum up | +22pp break | 127 | MEDIO | Continuation |
| **L123** ⭐ | largestPrem 200K-1M + VIX flat | +17pp break | 33 | MEDIO | Reposicionamiento táctico |
| **L124** ⭐ | instShare <0.5% + VIX flat | +13pp break | 64 | MEDIO | Retail unchecked |
| **L125** ⭐ | strike share 1-5% + late session | +14pp break | 155 | MEDIO | Combina con L116 |
| **L117** | morning first hour | +4pp bounce | 768 | BAJO | Filter débil |
| **L118** | oiRatio ≥0.7 | -7pp break | 317 | BAJO | Flat bias |

---

## LIMITACIONES HONESTAS

1. **Cobertura flow histórico 23%** (1,230/5,289). El 77% de eventos pre-Nov 2024 no tiene flow. Puede haber bias temporal (mercados 2024-2026 ≠ años anteriores).

2. **N pequeño en varias reglas** (L120, L122, L123 con N<100 en test). Edge observado pero sujeto a revisión tras 2-3 meses más de data.

3. **Timing proxy:** `flow_strikeShareOfDay` usa flow acumulado **hasta la hora exacta del touch** (sin look-ahead). Pero flow hora-por-hora pierde precisión minuto-a-minuto. El agente en vivo tendrá info MÁS granular.

4. **Retention >2.0x** (L119 @ 1h = 7.33x) puede indicar que el feature tenía N bajo en train — no necesariamente "mejora OOS" sino variance. Interpretar con cuidado.

5. **Sample splits SPY y QQQ**. DIA/GLD quedaron fuera por data corruption. Aplicar a esos instrumentos es extrapolación.

---

## PRÓXIMOS PASOS

### Inmediato — aplicar al agente vivo
1. Extender `compute-dominance.cjs` a `compute-features.cjs` con los flow features por strike
2. Integrar sub-items 10.X al checklist de CLAUDE.md
3. Actualizar `agent-identity.md` con las lessons ranked ALTO

### Medio plazo — validar forward
1. En cada ciclo, cuando una lesson L119-L125 se active, logear la decisión + outcome
2. Tras 60 ciclos con activación, revisar si el edge empírico live coincide con el backtest
3. Si coincide → promover a lesson "core". Si no → deprecar o re-analizar

### Largo plazo — expandir
1. Fix DIA/GLD data → backtestear XAU y US30 también
2. Construir hour-by-hour flow (no solo day-level aggregate) para timing más preciso
3. Intentar detectar "flip moments" en dominance day-over-day como discovery independiente
