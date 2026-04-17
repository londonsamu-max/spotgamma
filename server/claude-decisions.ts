/**
 * Claude Decision Engine
 *
 * Claude analiza los datos de mercado de SpotGamma cada ciclo y decide:
 * SKIP, LONG, o SHORT para cada CFD (NAS100, US30, XAUUSD).
 *
 * Si decide operar, el resultado se pasa a executeClaudeTrade() en routers.ts
 * que ejecuta via MT5.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

const DECISIONS_FILE = path.join(process.cwd(), "data", "claude-decisions.jsonl");
const STATE_FILE = path.join(process.cwd(), "data", "agent-state.json");

// Cooldown: no tomar decisiones más frecuente que cada 2 minutos por CFD
const _lastDecisionTime: Record<string, number> = {};
const DECISION_COOLDOWN_MS = 2 * 60 * 1000;

// Avoid spamming Claude API — max 1 decision cycle per 90 seconds
let _lastCycleTime = 0;
const CYCLE_COOLDOWN_MS = 90 * 1000;

// ─── Types ────────────────────────────────────────────────

export interface ClaudeDecision {
  action: "SKIP" | "LONG" | "SHORT";
  cfd: "NAS100" | "US30" | "XAUUSD";
  confidence: number;
  risk: "tight" | "normal" | "wide";
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  volume?: number;
  reasoning: string;
  entryPrice?: number;
}

export interface DecisionCycleResult {
  decisions: ClaudeDecision[];
  timestamp: string;
  error?: string;
}

// ─── System Prompt ────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un trader algoritmico experto especializado en gamma y flujo institucional para CFDs: NAS100 (Nasdaq), US30 (Dow Jones), XAUUSD (Oro).

Tu trabajo: analizar datos de SpotGamma en tiempo real y decidir si operar o no.

## REGLAS DE DECISION

**Regimen Gamma:**
- Gamma POSITIVO = dealers amortiguan movimientos = mean-reversion, bounces confiables
- Gamma NEGATIVO = dealers amplifican = momentum violento, tendencias fuertes
- Gamma MUY NEGATIVO = amplificacion extrema, movimientos explosivos

**Señales clave:**
- HIRO: flujo institucional. Alcista = compras institucionales. Bajista = ventas.
- TAPE: flujo de opciones. Calls > Puts = sentimiento alcista. Net delta positivo = bullish.
- GEX 0DTE: max gamma strike es objetivo magnetico (precio atrae hacia ahi).
- VRP: Volatility Risk Premium. Positivo = mean-reversion. Negativo = momentum.
- Gamma Flip: nivel donde dealers pasan de amortiguar a amplificar. Precio cerca = zona peligrosa.

**Cuando operar:**
- Score de confirmaciones alto (GEX + HIRO + TAPE alineados)
- R:R minimo 1.5:1
- Precio en zona de soporte/resistencia gamma con confluencia
- VRP confirma regimen (positivo = fade extremos, negativo = seguir tendencia)

**Cuando NO operar (SKIP):**
- Precio en gamma flip (50/50, sin edge)
- HIRO y TAPE divergen (institucional vs retail opuesto)
- Antes de evento macro importante (FOMC, CPI, NFP)
- Kill switch activo o win rate muy bajo reciente
- Sin confluencia de señales (< 3 confirmaciones)
- Mercado lateral sin volumen

**SL y TP:**
- SL: detras del nivel de gamma mas cercano, o ATR-based
- TP1: proximo nivel de gamma (soporte/resistencia), cerrar 50%
- TP2: siguiente nivel, cerrar 30%
- TP3: trailing stop, dejar correr 20%

## FORMATO DE RESPUESTA

Responde SOLO con un JSON array. Un objeto por cada CFD que analices.
Si decides SKIP, incluye reasoning pero no sl/tp.

\`\`\`json
[
  {
    "action": "SKIP",
    "cfd": "NAS100",
    "confidence": 0,
    "risk": "normal",
    "reasoning": "Precio en gamma flip, sin edge claro"
  },
  {
    "action": "LONG",
    "cfd": "XAUUSD",
    "confidence": 78,
    "risk": "normal",
    "sl": 4650.00,
    "tp1": 4700.00,
    "tp2": 4730.00,
    "volume": 0.01,
    "reasoning": "GLD vanna bullish, tape calls dominante, soporte gamma en 4660"
  }
]
\`\`\`

IMPORTANTE: Se conservador. Es mejor SKIP que un trade malo. Solo opera con conviccion >= 70.`;

// ─── Build Market Data Prompt ─────────────────────────────

function buildMarketPrompt(marketData: any, positions: any[], thesis: any): string {
  const md = marketData;
  if (!md) return "Sin datos de mercado disponibles.";

  const parts: string[] = [];

  // CFD Prices
  parts.push("## PRECIOS CFD ACTUALES");
  if (md.cfdPrices) {
    const cfds = [
      { name: "NAS100", data: md.cfdPrices.nas100 },
      { name: "US30", data: md.cfdPrices.us30 },
      { name: "XAUUSD", data: md.cfdPrices.xauusd },
    ];
    for (const c of cfds) {
      if (c.data?.price) {
        parts.push(`- ${c.name}: $${c.data.price.toFixed(c.name === "XAUUSD" ? 2 : 0)} (${c.data.changePct >= 0 ? "+" : ""}${c.data.changePct?.toFixed(2)}%)`);
      }
    }
  }

  // Trade Setups (scoring from trading engine)
  if (md.tradeSetups?.length > 0) {
    parts.push("\n## SETUPS DEL ENGINE (score 0-100)");
    for (const s of md.tradeSetups) {
      const confs = [
        s.gexConfirmed ? "GEX" : null,
        s.hiroConfirmed ? "HIRO" : null,
        s.tapeConfirmed ? "TAPE" : null,
        s.levelConfirmed ? "NIVEL" : null,
        s.vannaConfirmed ? "VANNA" : null,
        s.regimeConfirmed ? "REGIMEN" : null,
      ].filter(Boolean);
      parts.push(`- ${s.cfd}: ${s.direction} score=${s.score}/100, confirmaciones=[${confs.join(",")}] (${confs.length}/6)`);
      if (s.cfdEntryPrice > 0) {
        const dec = s.cfd === "XAUUSD" ? 2 : 0;
        parts.push(`  Entry=${s.cfdEntryPrice.toFixed(dec)} SL=${s.stopLoss?.toFixed(dec)} TP1=${s.takeProfit1?.toFixed(dec)} TP2=${s.takeProfit2?.toFixed(dec)} R:R=1:${s.riskRewardRatio?.toFixed(1)}`);
      }
      if (s.entryMode) parts.push(`  Modo: ${s.entryMode} ${s.entryNote || ""}`);
      if (s.reason) parts.push(`  Razon: ${s.reason}`);
    }
  }

  // HIRO
  if (md.hiro?.perAsset) {
    parts.push("\n## HIRO (Flujo Institucional)");
    for (const [sym, d] of Object.entries(md.hiro.perAsset) as [string, any][]) {
      parts.push(`- ${sym}: ${d.hiroTrend?.toUpperCase()} (valor=${d.hiroValue?.toFixed(0)}, rango30d=[${d.hiroRange30dMin?.toFixed(0)}, ${d.hiroRange30dMax?.toFixed(0)}])`);
    }
  }

  // Tape
  if (md.tape?.perAsset) {
    parts.push("\n## TAPE (Flujo Opciones)");
    for (const [sym, d] of Object.entries(md.tape.perAsset) as [string, any][]) {
      parts.push(`- ${sym}: ${d.sentiment?.toUpperCase()} score=${d.sentimentScore}, calls=${d.callCount} puts=${d.putCount}, P/C=${d.putCallRatio?.toFixed(2)}, netDelta=${d.netDelta?.toFixed(0)}`);
    }
  }

  // 0DTE GEX
  if (md.traceData) {
    const t = md.traceData;
    parts.push("\n## 0DTE GEX (SPX)");
    parts.push(`- Bias: ${t.netGexBias?.toUpperCase()}, Ratio S/R: ${t.gexRatio?.toFixed(2)}`);
    parts.push(`- Max gamma strike: ${t.maxGexStrike} (objetivo magnetico)`);
    parts.push(`- Gamma Flip: ${t.gammaFlip || "N/A"}`);
    if (t.topSupport?.length > 0) parts.push(`- Soportes: ${t.topSupport.slice(0, 3).map((s: any) => s.strike).join(", ")}`);
    if (t.topResistance?.length > 0) parts.push(`- Resistencias: ${t.topResistance.slice(0, 3).map((r: any) => r.strike).join(", ")}`);
  }

  // Official SG Levels
  if (md.officialLevels) {
    parts.push("\n## NIVELES SPOTGAMMA OFICIALES");
    for (const [sym, lev] of Object.entries(md.officialLevels) as [string, any][]) {
      if (!lev) continue;
      const items = [];
      if (lev.callWall) items.push(`CallWall=$${lev.callWall}`);
      if (lev.putWall) items.push(`PutWall=$${lev.putWall}`);
      if (lev.zeroGamma) items.push(`GammaFlip=$${lev.zeroGamma}`);
      if (lev.keyGamma) items.push(`KeyGamma=$${lev.keyGamma}`);
      if (lev.gammaRegime) items.push(`Regimen=${lev.gammaRegime}`);
      if (lev.impliedMove) items.push(`IM=${lev.impliedMove.toFixed(1)}pts`);
      if (items.length > 0) parts.push(`- ${sym}: ${items.join(", ")}`);
    }
  }

  // Volatility context
  if (md.volContext) {
    parts.push("\n## VOLATILIDAD");
    parts.push(`- Regimen: ${md.volContext.overallRegime}`);
    parts.push(`- Term Structure: ${md.volContext.avgTermStructure}`);
    if (md.volContext.marketSummary) parts.push(`- Resumen: ${md.volContext.marketSummary}`);
  }

  // Vanna context
  if (md.vannaContext) {
    const vc = md.vannaContext;
    parts.push("\n## VANNA");
    if (vc.vixChangePct !== undefined) parts.push(`- VIX: ${vc.vixChangePct >= 0 ? "+" : ""}${vc.vixChangePct.toFixed(1)}% (${vc.vixVannaSignal})`);
    if (vc.indexVannaActive) parts.push(`- Vanna Indices ACTIVO`);
    if (vc.goldVannaActive) parts.push(`- Vanna GLD ACTIVO`);
    if (vc.refugeFlowActive) parts.push(`- FLUJO REFUGIO ACTIVO`);
  }

  // GEX Change Tracker
  if (md.gexChangeTracker?.changes) {
    const ch = md.gexChangeTracker.changes;
    parts.push("\n## CAMBIOS GEX RECIENTES");
    parts.push(`- Bias cambio: ${ch.biasChanged ? "SI" : "NO"} (${ch.prevBias} -> ${ch.newBias})`);
    parts.push(`- Ratio cambio: ${ch.ratioChange?.toFixed(2)}`);
    if (ch.description) parts.push(`- ${ch.description}`);
  }

  // Open positions
  if (positions && positions.length > 0) {
    parts.push("\n## POSICIONES ABIERTAS");
    for (const p of positions) {
      parts.push(`- ${p.cfd} ${p.direction} entry=${p.cfdEntryPrice} SL=${p.stopLoss} TP1=${p.takeProfit1} (ticket=${p.mt5Ticket || "pending"})`);
    }
  } else {
    parts.push("\n## POSICIONES ABIERTAS: Ninguna");
  }

  // Thesis from agent-state
  if (thesis?.thesis) {
    parts.push("\n## TESIS ACTUAL DEL AGENTE");
    for (const [cfd, t] of Object.entries(thesis.thesis) as [string, any][]) {
      parts.push(`- ${cfd}: ${typeof t === "string" ? t : JSON.stringify(t)}`);
    }
  }

  // Performance
  if (thesis?.performance) {
    const perf = thesis.performance;
    parts.push(`\n## PERFORMANCE: ${perf.totalTrades || 0} trades, ${perf.wins || 0} wins, ${perf.losses || 0} losses`);
  }

  // Economic calendar
  if (md.economicCalendar?.length > 0) {
    parts.push("\n## EVENTOS MACRO HOY");
    for (const ev of md.economicCalendar.slice(0, 5)) {
      parts.push(`- ${ev.time || ""} ${ev.title || ev.event || ""} (${ev.impact || ""})`);
    }
  }

  parts.push(`\n## HORA ACTUAL: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  parts.push(`## MERCADO: ${md.marketStatus?.toUpperCase() || "DESCONOCIDO"}`);

  return parts.join("\n");
}

// ─── Invoke Claude for Decisions ──────────────────────────

export async function getClaudeDecisions(marketData: any, openPositions: any[], agentState: any): Promise<DecisionCycleResult> {
  const now = Date.now();

  // Cycle cooldown
  if (now - _lastCycleTime < CYCLE_COOLDOWN_MS) {
    return { decisions: [], timestamp: new Date().toISOString(), error: "cooldown" };
  }
  _lastCycleTime = now;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { decisions: [], timestamp: new Date().toISOString(), error: "ANTHROPIC_API_KEY not set" };
  }

  // Don't decide if market is closed
  if (marketData?.marketStatus === "closed") {
    return { decisions: [], timestamp: new Date().toISOString(), error: "market_closed" };
  }

  try {
    const client = new Anthropic({ apiKey });
    const marketPrompt = buildMarketPrompt(marketData, openPositions, agentState);

    console.log(`[CLAUDE-DECISION] Requesting analysis... (${marketPrompt.length} chars)`);

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Analiza estos datos y decide para cada CFD:\n\n${marketPrompt}` },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    console.log(`[CLAUDE-DECISION] Response: ${text.slice(0, 200)}...`);

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[CLAUDE-DECISION] No JSON array found in response");
      logDecision({ action: "ERROR", reasoning: "No JSON in response: " + text.slice(0, 200), timestamp: new Date().toISOString() });
      return { decisions: [], timestamp: new Date().toISOString(), error: "no_json_in_response" };
    }

    const decisions: ClaudeDecision[] = JSON.parse(jsonMatch[0]);

    // Filter by cooldown per CFD
    const filtered = decisions.filter(d => {
      if (d.action === "SKIP") return true; // Always log SKIPs
      const lastTime = _lastDecisionTime[d.cfd] || 0;
      if (now - lastTime < DECISION_COOLDOWN_MS) {
        console.log(`[CLAUDE-DECISION] ${d.cfd} cooldown active, skipping`);
        return false;
      }
      _lastDecisionTime[d.cfd] = now;
      return true;
    });

    // Log all decisions
    for (const d of filtered) {
      logDecision({
        ...d,
        timestamp: new Date().toISOString(),
        executed: false, // Will be updated by executeClaudeTrade
      });
    }

    return { decisions: filtered, timestamp: new Date().toISOString() };
  } catch (e: any) {
    console.error(`[CLAUDE-DECISION] API error: ${e.message}`);
    return { decisions: [], timestamp: new Date().toISOString(), error: e.message };
  }
}

// ─── Load Agent State ─────────────────────────────────────

export function loadAgentState(): any {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Log Decision ─────────────────────────────────────────

function logDecision(entry: any): void {
  try {
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("[CLAUDE-DECISION] Failed to log:", e);
  }
}
