# SpotGamma Trading Agent — Bootstrap para Windows

## PARA CLAUDE CODE EN WINDOWS: LEE ESTO PRIMERO

Este es un sistema de trading autónomo de CFDs (NAS100, US30, XAUUSD) que usa datos de opciones de SpotGamma para tomar decisiones. Claude Code ES el cerebro — analiza, decide, ejecuta, aprende y se adapta.

---

## Arquitectura

```
Claude Code (scheduled task cada 1 min) — EL CEREBRO
  → Lee SpotGamma data via getAgentView (localhost:3099/api/trpc/market.getAgentView)
  → Lee memoria persistente (data/agent-state.json)
  → Analiza 14 puntos: regime, HIRO, tape, levels, gamma bars, vol, vanna, GEX, 0DTE, flow, candles, macro, broker, entry
  → Escribe órdenes a data/agent-orders.json
  → El Fast Executor (dentro del server) ejecuta cuando precio toca el trigger
  → Actualiza memoria con tesis, lecciones, performance

Server Node.js + tRPC (PM2, puerto 3099) — LA INFRAESTRUCTURA
  → Scrapes SpotGamma cada 15s (niveles, GEX, HIRO, tape, vanna, vol, 0DTE, flow)
  → Fast Executor: loop 500ms, lee órdenes, ejecuta al instante
  → Live Flow Watcher: poll 5s capturando TODOS los trades de opciones
  → MT5 Bridge: comunicación JSON con MetaTrader 5 EA
  → TradingView WebSocket: precios CFD en tiempo real
  → SpotGamma live prices: cada 5s para trigger matching

MetaTrader 5 (Pepperstone Demo) — LA EJECUCIÓN
  → EA SpotGammaBridge v2: envía bid/ask, recibe órdenes, reporta fills
  → Comunicación por archivos JSON en MQL5/Files/
```

---

## Setup en Windows

### 1. Prerequisitos
```powershell
# Instalar nvm-windows: https://github.com/coreybutler/nvm-windows/releases
nvm install lts
nvm use lts
npm i -g pnpm pm2

# Instalar MetaTrader 5 de Pepperstone
# Login demo: cuenta 61498408, server Pepperstone-Demo
```

### 2. Instalar el proyecto
```powershell
cd C:\Users\TuUsuario\spotgamma_monitor
pnpm install
pnpm run build
pm2 start ecosystem.config.js
pm2 save
```

### 3. Verificar que funciona
```powershell
# Debe retornar JSON, no HTML
curl http://localhost:3099/api/trpc/market.getAgentView

# Ver logs
pm2 logs spotgamma --lines 30
```

### 4. MetaTrader 5
- Copiar `SpotGammaBridge.mq5` a `C:\Users\TuUsuario\AppData\Roaming\MetaQuotes\Terminal\...\MQL5\Experts\`
- Compilar en MetaEditor
- Arrastrar EA a cualquier chart
- Habilitar AutoTrading
- Los archivos JSON de comunicación están en `MQL5\Files\`

### 5. Recrear el Scheduled Task en Claude Code
Pedir a Claude Code:
> "Crea un scheduled task llamado trading-agent, que corra cada 1 minuto, con este prompt: 'Run the trading-agent scheduled task: check SpotGamma data, evaluate ETF triggers, and execute trades if conditions are met.'"

### 6. Copiar la memoria
Copiar los archivos de `memory/` a la ruta equivalente de Claude Code en Windows:
`C:\Users\TuUsuario\.claude\projects\...\memory\`

---

## CUENTA BROKER
- Pepperstone Demo #61498408
- Balance actual: $912.81
- Leverage: 200x
- Símbolos: NAS100 (min 0.10 lots), US30 (min 0.10 lots), XAUUSD (min 0.01 lots)

---

## FILOSOFÍA DE TRADING — "DATA MANDA"

### Principios Core
1. NO predecir — reaccionar a lo que la data muestra EN VIVO
2. SIEMPRE tener setups LONG y SHORT para cada CFD
3. Sin etiquetas (no "scalp" ni "swing") — entrar en estructura, dejar que el precio decida
4. Sin límites artificiales — sin kill switch, sin max trades, sin min conviction
5. Posiciones ilimitadas por activo — puede haber 3 LONGs en NAS a diferentes niveles
6. Todo es dinámico — órdenes y posiciones viven y mueren con la data
7. Posiciones = análisis continuo — si la data invalida, cerrar inmediatamente
8. Cuenta demo = operar sin miedo. Cada trade es data para mejorar.
9. Eventos macro = catalizadores, no amenazas. Chequear flow, no cerrar posiciones.

### Entry Logic
- ENTRY en nivel gamma (soporte/resistencia) con edge estructural
- SL detrás del nivel gamma (donde la tesis se invalida)
- TP1 siguiente nivel gamma, TP2/TP3 más lejos o trailing
- El mercado decide si es scalp (5min a TP1) o swing (días a TP3)

### Trailing SL (Gamma-Based)
- Después de breakeven (1R profit): SL = entry + 2pts
- Luego SL salta de nivel gamma a nivel gamma
- Buffer: 15pts NAS/US30, 5pts XAUUSD
- Sin partial closes — posición completa con trailing

### Position Sizing
- NAS100: 0.10 lots ($0.10/punto)
- US30: 0.10 lots ($0.10/punto)
- XAUUSD: 0.01 lots ($1.00/punto)
- Si el SL resulta en riesgo >5% de cuenta, skip (no achicar SL)

---

## CHECKLIST OBLIGATORIO — 14 PUNTOS (NUNCA SALTAR)

Cada ciclo FULL debe chequear TODOS los 14 ítems en orden. Sin excepciones.

### 1. REGIME CHECK
SPX, QQQ, GLD, DIA: gamma regime + VRP (IV30-RV30)

### 2. HIRO (8 símbolos)
SPX, QQQ, SPY, GLD, DIA, VIX, UVIX, IWM — trend + percentil
Consenso: cuántos bearish vs bullish? HIRO = flujo institucional (confiar para dirección)

### 3. TAPE (7 símbolos)
SPX, QQQ, SPY, GLD, DIA, VIX, UVIX — sentiment score
Contradicciones con HIRO? Tape puede ser ruido retail (L51)

### 4. LEVELS
CallWall, PutWall, GammaFlip, KeyGamma, MaxGamma por símbolo
QQQ topStrikes con net positioning (crítico para NAS100!)

### 5. ⭐ GAMMA BARS — MULTI-SYMBOL (LO MÁS IMPORTANTE)
- NAS100: barras de SPX + QQQ + SPY combinadas (top 20 por |gamma|)
- US30: barras de DIA + SPX + SPY
- XAUUSD: barras de GLD
- Identificar las barras MÁS GORDAS cerca del precio — esos son los niveles reales
- Green bars (+gamma) = soporte (dealers absorben ventas)
- Red bars (-gamma) = resistencia/acelerador (dealers amplifican)
- SPY y QQQ agregan aceleradores OCULTOS no visibles en SPX solo (L44, L45)
- TODAS las entradas DEBEN ser en una gamma bar gorda. R:R mínimo 1:2.

### 6. VOLATILITY
Régimen, term structure (contango/backwardation), IV + skew por activo, VIX-SPX correlación

### 7. VANNA
VIX change + signal, UVXY change + refuge signal, GLD vanna

### 8. GEX FULL BREAKDOWN
SPX, QQQ, DIA, GLD: total gamma, call gamma, put gamma, 0DTE gamma, gamma flip
Zero call gamma en QQQ/DIA/GLD = sin soporte alcista

### 9. 0DTE TRACE
Bias, ratio, maxStrike (= TP magnético)

### 10. ⭐ OPTIONS FLOW — TRADES INDIVIDUALES POR INSTRUMENTO
Para CADA símbolo: P/C ratio, net delta, net gamma, dominant flow
LARGEST TRADES: premium, strike, call/put, buy/sell, expiration
Clasificar por tamaño: Institucional(>$50K)⭐⭐⭐, Medium($10K-50K)⭐⭐, Retail(<$10K)⭐
Clasificar por expiración: 0DTE, weekly, monthly, LEAPS
NUNCA filtrar trades pequeños. NUNCA usar solo tape agregado (L52)

### 11. PRICE ACTION + CANDLES
MT5 OHLC últimas 3 velas por CFD. Patrones en niveles gamma clave.

### 12. MACRO
DXY + TLT, calendario, countdown a eventos

### 13. BROKER + POSICIONES
Bid/ask/spread. Posiciones abiertas P&L. Balance/equity.
Validar CADA posición abierta: ¿data sigue soportando la tesis?
Validar CADA orden pendiente: ¿niveles correctos? ¿R:R >= 1:2?

### 14. ENTRY DECISIONS
Para cada CFD: LONG y SHORT en gamma bars específicos.
Entry mode: confirm para bounces, level para breakouts.
SL detrás de la siguiente gamma bar + buffer.
TP = siguiente gamma bar gorda en dirección del trade.
Verificar R:R >= 1:2 antes de colocar CUALQUIER orden.
Escribir a data/agent-orders.json.

---

## SISTEMA DE TRIGGERS ETF (ÚLTIMA VERSIÓN — MÁS PRECISO)

Las órdenes disparan en precio ETF/Index directamente (SPX, GLD, QQQ, DIA):
- `triggerSource: "spotgamma"` + `triggerSymbol: "SPX"` + `triggerLevel: 6600`
- SpotGamma live prices se actualizan cada 5 segundos
- Tolerancia: SPX ±2pts, GLD ±$0.50
- CERO drift de conversión — el gamma bar ESTÁ en SPX $6,600, el trigger se activa cuando SPX toca $6,600
- SL/TP siguen en precios CFD (para ejecución MT5)
- Reportar niveles como strikes ETF en análisis: "SPX $6,600 (+1,680M)" NO "NAS $24,795"

### Entry Modes
- `confirm`: bounces en green walls (+gamma). Espera micro-candle rejection. ±10pts NAS/US30, ±5pts XAU.
- `level`: breakouts en red accelerators (-gamma). Entra al pasar. ±5pts NAS/US30, ±3pts XAU.
- `zone`: rango amplio. Raramente usar.

---

## 89 LECCIONES APRENDIDAS (RESUMEN CRÍTICO)

### Entradas
- L43: Entrar SOLO en las barras gamma más gordas
- L44: QQQ y SPY agregan aceleradores ocultos no visibles en SPX solo
- L48: R:R mínimo 1:2 siempre
- L49: Confirm para bounces, Level para breakouts
- L58: Nivel-a-nivel: cuando rompe una barra, viaja a la siguiente
- L59: TP = siguiente barra gamma gorda, no distancia arbitraria
- L69: No entrar en congestión entre barras <20pts
- L83: CONFIRM en paredes verdes, LEVEL en aceleradores rojos

### Bounce vs Break (L60)
Score: HIRO + institutional flow + tape + VRP + gamma sign + candle
Flow pressure > gamma absorption = breaks (L63)

### Flow
- L51: GLD tape bullish + HIRO bearish = retail compra dip, instituciones venden. TRUST HIRO.
- L52: NUNCA usar tape agregado solo. Leer trades individuales por instrumento.
- L53: Institucional(>$50K) = mayor peso. Confiar sobre retail.
- L61: Órdenes vivas = intención en cada nivel
- L85: Chequear posicionamiento institucional CADA ciclo

### Overnight (Lecciones caras: -$54.88)
- L75: NUNCA LONG+SHORT en mismo exactLevel (-$6.74)
- L76: NO overnight 11PM-6AM Colombia. Bajo volumen = barras no sostienen.
- L79: Pre-market 7AM+ SÍ es válido con data fresca
- L81: Actualizar niveles ANTES de apertura con data fresca

### Sistema
- L77/L86: Ratios de conversión cambian cada ciclo
- L84: Ciclo FULL de 14 puntos cada vez, sin atajos
- L87: Precios SpotGamma vs MT5 difieren ~25pts NAS, ~13pts XAU
- L88: Usar triggers SpotGamma ETF elimina drift de conversión

---

## ARCHIVOS CLAVE

### Data del Agente
- `data/agent-state.json` — Memoria persistente (tesis, lecciones L1-L89, performance, rules)
- `data/agent-orders.json` — Órdenes pendientes + posiciones gestionadas
- `data/agent-playbook.json` — Estadísticas históricas de 2,800 días
- `data/agent-entry-models.json` — 7 modelos de entrada estandarizados
- `data/claude-decisions.jsonl` — Log append-only de cada decisión
- `data/trade-history.json` — Historial completo de trades
- `data/auto-trading-config.json` — Config de auto-trading (enabled, volumes)

### Server
- `server/_core/index.ts` — Entry point (Express + tRPC en /api/trpc/)
- `server/routers.ts` — Todos los endpoints incluyendo getAgentView
- `server/spotgamma-scraper.ts` — API calls a SpotGamma (JWT auth)
- `server/fast-executor.ts` — Executor con trigger matching
- `server/live-flow-watcher.ts` — Captura de flow en tiempo real
- `server/market-monitor.ts` — Monitor de mercado y alertas

### Endpoints
- `market.getAgentView` — Data compacta (25 keys, niveles en CFD prices)
- `market.getMT5Status` — Estado MT5 + precios broker
- `market.executeClaudeTrade` — Ejecutar trade con SL/TP/volume
- `market.getExecutorState` — Estado del executor

### Config
- `ecosystem.config.js` — PM2 config (puerto 3099)
- `.env` — Credenciales SpotGamma + Groq
- `.sg_token` — JWT token de SpotGamma (expira cada ~3 días)

---

## FORMATO DE ÓRDENES (agent-orders.json)

```json
{
  "pendingOrders": [
    {
      "id": "claude-sg-NAS-LONG-maxgamma",
      "cfd": "NAS100",
      "direction": "LONG",
      "entryZone": [24785, 24805],
      "exactLevel": 24795,
      "entryMode": "confirm",
      "triggerSource": "spotgamma",
      "triggerSymbol": "SPX",
      "triggerLevel": 6600,
      "sl": 24690,
      "tp1": 25171,
      "tp2": 25246,
      "volume": 0.1,
      "reasoning": "BOUNCE at SPX 6600 (+1,680M). Confirm mode.",
      "createdAt": "2026-04-08T00:10:00Z",
      "expiresAt": "2026-04-08T21:00:00Z",
      "status": "pending"
    }
  ],
  "managedPositions": [],
  "lastPriceCheck": "2026-04-08T00:10:00.000Z"
}
```

---

## HORARIOS
- Mercado: 8:30AM-3:00PM Colombia = 9:30AM-4:00PM ET
- Pre-market válido: 7AM+ Colombia con data fresca
- NO overnight: 11PM-6AM Colombia (L76)
- Macro events esta semana: FOMC Wed 2PM ET, PCE Thu 8:30AM ET, CPI Fri 8:30AM ET

---

## TOKEN SPOTGAMMA
El JWT en `.sg_token` expira cada ~3 días. Si las API calls fallan con "fetch failed":
1. Verificar: `curl -H "Authorization: Bearer $(cat .sg_token)" https://api.spotgamma.com/v1/free_running_hiro`
2. Si falla, re-autenticar: login en spotgamma.com, capturar nuevo JWT del browser
3. `pm2 restart spotgamma` después de actualizar token

---

## MULTI-SYMBOL GAMMA BARS — Cómo Funciona

El usuario opera mirando las barras de gamma del SpotGamma Equity Hub. Las barras más gordas (mayor |gamma|) son los niveles más importantes.

Para NAS100: se combinan barras de SPX + QQQ + SPY porque los 3 ETFs afectan al NAS. Un soporte en SPX puede tener un acelerador oculto en SPY que lo debilita (L44).

Para US30: barras de DIA + SPX + SPY combinadas.

Para XAUUSD: barras de GLD solamente.

Green bar (+gamma) = soporte = dealers absorben ventas ahí → LONG con confirm
Red bar (-gamma) = acelerador = dealers amplifican movimiento → SHORT/breakout con level

---

## NOTAS OPERATIVAS IMPORTANTES

### 1. Endpoint correcto
- SIEMPRE usar `/api/trpc/market.getAgentView`, NO `/trpc/`
- Si recibe HTML en vez de JSON → está usando la ruta mal (recibes el frontend)

### 2. Cuando la API falla
- `pm2 restart spotgamma` — esto limpia el cache corrupto en memoria
- Verificar token: `curl -H "Authorization: Bearer $(cat .sg_token)" https://api.spotgamma.com/v1/free_running_hiro`

### 3. Token SpotGamma
- Expira cada ~3 días
- Para regenerar: login en spotgamma.com → capturar JWT del browser → guardar en `.sg_token`
- `pm2 restart spotgamma` después de actualizar

### 4. Frecuencia adaptativa del ciclo
- Price delta <15pts = FLAT (log breve, no repetir análisis completo)
- 15-30pts = MEDIUM (check items clave)
- >30pts = FULL (14 puntos completos obligatorios)

### 5. Output de getAgentView
- Es JSON nested en `result.data.json` — NO es plano
- Ejemplo: `curl -s http://localhost:3099/api/trpc/market.getAgentView | node -e "...JSON.parse(d).result.data.json..."`

### 6. Scoring bounce vs break (L60)
- HIRO + institutional flow + tape + VRP + gamma sign + candle
- Mayoría gana. NO es un score numérico — es consenso cualitativo.
- VRP positivo = bounce likely. VRP negativo = break likely.
- Flow pressure > gamma absorption = breaks (L63)

### 7. Trade history ($972 → $912)
- -$41.44 overnight trades (L76: NO overnight)
- -$6.74 LONG+SHORT en mismo nivel (L75)
- -$15 por bugs del executor con SL
- Stale levels: Missed NAS SHORT +256pts porque no actualizó antes de apertura (L81)

### 8. Idioma
- El usuario habla español — TODAS las respuestas en español

### 9. Semana macro (2026-04-08)
- FOMC Meeting Minutes: Miércoles Abril 8, 2PM ET
- Core PCE + GDP: Jueves Abril 9, 8:30AM ET
- CPI: Viernes Abril 10, 8:30AM ET

### 10. Dashboard
- Desktop: `http://localhost:3099`
- Mobile: `http://localhost:3099/mobile`
- Monitorear visualmente: ExecutorPanel, LivePnLPanel, SetupVisualizerPanel

### 11. Data stale detection
- SpotGamma NO tiene data fresca fuera de horario de opciones, pre-market, o API down
- Verificar `timestamp` en getAgentView — si es viejo (>30min), la data es stale
- NO operar con data vieja. Esperar scrape fresco.

### 12. Puerto del server
- El puerto es **3099** (definido en `ecosystem.config.cjs`), NO 3000 del `.env`
- `ecosystem.config.cjs` override el `.env`

### 13. Expiración de órdenes
- Cada orden tiene `expiresAt`. Si la hora pasó, ignorarla y crear nuevas con data fresca
- Típicamente expiran al cierre del mercado (21:00 UTC)

### 14. MT5 EA SpotGammaBridge v2
- Comunica por archivos JSON en `MQL5/Files/` (sg_order.json, sg_result.json, sg_status.json)
- Si MT5 no está abierto o el EA no está corriendo, las órdenes NO se ejecutan en el broker
- Verificar con `market.getMT5Status` — `connected: true` + `timestamp` reciente

### 15. NO filtrar nada — "Data manda"
- El usuario NO quiere que filtres nada. Analizas TODO y dejas que los datos hablen.
- Reportar todo lo que la data muestra, sin sesgo ni filtro personal.

### 16. Setups para los 3 CFDs SIEMPRE
- NAS100, US30, XAUUSD — LONG y SHORT para cada uno, cada ciclo
- No solo NAS. Los 3 activos tienen gamma bars y oportunidades.

### 17. Groq API rate limit
- 100K tokens/día. Cuando se agota, el LLM interno del server (narración) falla.
- NO afecta a Claude Code. Solo afecta el dashboard "AI Chat" panel.

### 18. Diferencia MT5 vs SpotGamma precios
- MT5 bid puede ser $24,030 cuando SpotGamma dice NAS $24,055 (~25pts diferencia)
- XAUUSD: ~$13 diferencia
- Usar SpotGamma ETF prices para triggers (más precisos)
- Usar MT5 broker prices para ejecución (lo que el broker realmente llena)

---

## ESTADO ACTUAL (2026-04-08 pre-market)

- NAS100: $25,057 (SHORT x2 abiertos @ $25,023-$25,024)
- US30: $47,860
- XAUUSD: $4,790
- SPX: $6,795 | VIX: $20.35
- GEX: -2.07T (dealers muy short gamma)
- HIRO: 3 bearish (QQQ P34, DIA P9, GLD P31), 1 bullish (SPY P67), 1 neutral (SPX P52)
- Balance: $913.05 | Equity: ~$906
- 9 órdenes totales (7 pendientes + 2 ejecutadas SHORT NAS)
- FOMC HOY 2PM ET
