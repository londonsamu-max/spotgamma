/**
 * Market Monitor Service
 * Runs background polling every 30 seconds during market hours
 * Generates:
 *   1. Pre-market analysis (once at ~8:00 AM Colombia, before open)
 *   2. Real-time market narration (every 3 minutes during session)
 *   3. Intelligent AI-powered alerts when price approaches key gamma zones
 */

import { fetchAllMarketData, getMarketStatus, getSessionDate, getGexHistory, fetchCFDPricesFromTradingView } from "./spotgamma-scraper";
import { saveAlert, saveNarration, getLatestNarration } from "./db";
import { invokeLLM } from "./_core/llm";
import { getMacroAlert, getCachedDXYTLT, refreshDXYTLT, ingestLiveEconCalendar } from "./session-tracker";
import { autoResolveOpen, loadHistory } from "./trade-history";
import { getClaudeDecisions, loadAgentState } from "./claude-decisions";
import { startLiveFlowWatcher } from "./live-flow-watcher";

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let narrationInterval: ReturnType<typeof setInterval> | null = null;
let preMarketInterval: ReturnType<typeof setInterval> | null = null;
let traceInterval: ReturnType<typeof setInterval> | null = null;
let autoResolveInterval: ReturnType<typeof setInterval> | null = null;
let claudeDecisionInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// Track TRACE GEX history for level-shift detection
let prevTraceGexRatio: number | null = null;

// Track previous prices to detect movements
const prevPrices: Record<string, number> = {};
const alertCooldowns: Record<string, number> = {}; // prevent spam alerts
let preMarketDone = false; // flag to run pre-market analysis only once per day
let lastPreMarketDate = "";

// ============================================================
// 1. PRE-MARKET ANALYSIS (runs once before market open)
// ============================================================
async function generatePreMarketAnalysis(data: Awaited<ReturnType<typeof fetchAllMarketData>>): Promise<string> {
  try {
    const spx = data.assets.find((a) => a.symbol === "SPX");
    const spy = data.assets.find((a) => a.symbol === "SPY");
    const qqq = data.assets.find((a) => a.symbol === "QQQ");
    const vix = data.assets.find((a) => a.symbol === "VIX");
    const gld = data.assets.find((a) => a.symbol === "GLD");
    const dia = data.assets.find((a) => a.symbol === "DIA");
    const gex = data.gex;
    const hiro = data.hiro;

    // Fetch DXY/TLT for gold context
    await refreshDXYTLT();
    const { dxy, tlt } = getCachedDXYTLT();

    // Macro event alert
    const macro = getMacroAlert();

    // CFD prices from live data
    const cfdPrices = data.cfdPrices;
    const nas100Price  = cfdPrices?.nas100?.price  || 0;
    const us30Price    = cfdPrices?.us30?.price    || 0;
    const xauusdPrice  = cfdPrices?.xauusd?.price  || 0;
    const nas100Chg    = cfdPrices?.nas100?.changePct || 0;
    const us30Chg      = cfdPrices?.us30?.changePct   || 0;
    const xauusdChg    = cfdPrices?.xauusd?.changePct || 0;

    // Gamma flip level for SPX (used as NAS100/US30 trend ref)
    const gammaFlipLevel: number = (spx as any)?.gammaFlipLevel || spx?.topStrikes?.find((s: any) => s.levelType === "Gamma Flip")?.strike || 0;

    // VIX classification
    const vixVal = vix?.currentPrice ?? 0;
    const vixLabel = vixVal > 30 ? "MIEDO EXTREMO ⚠️" : vixVal > 20 ? "VOLATILIDAD ELEVADA" : "VOLATILIDAD NORMAL ✅";

    // Macro event block — prefer live calendar from SpotGamma, fallback to getMacroAlert()
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD ET
    const next7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() + i);
      return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    });
    const upcomingEvents = (data.economicCalendar || [])
      .filter((e: any) => next7Days.includes(e.date) && (e.impact === "High" || e.impact === "Medium"))
      .sort((a: any, b: any) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));

    const todayEvents = upcomingEvents.filter((e: any) => e.date === todayStr);
    const futureEvents = upcomingEvents.filter((e: any) => e.date !== todayStr).slice(0, 5);

    let macroBlock = "";
    if (todayEvents.length > 0) {
      macroBlock += `⚡ EVENTOS HOY (${todayStr}):\n`;
      for (const ev of todayEvents) {
        const adjustNote = macro.isActive && macro.event === ev.event
          ? ` → SL ×${macro.slMult.toFixed(2)}${macro.requireOptimalOnly ? ", solo óptimos" : ""}`
          : "";
        macroBlock += `  • ${ev.time || "?"} ET — ${ev.event} [${ev.impact}]${adjustNote}\n`;
      }
    } else {
      macroBlock += `Sin eventos de alto impacto hoy.\n`;
    }
    if (futureEvents.length > 0) {
      macroBlock += `\n📅 PRÓXIMOS EVENTOS:\n`;
      for (const ev of futureEvents) {
        macroBlock += `  • ${ev.date} ${ev.time || ""} ET — ${ev.event} [${ev.impact}]\n`;
      }
    }
    if (!macroBlock.trim()) macroBlock = "Sin eventos macro de alto impacto en los próximos 7 días.";

    // Key SPX strikes
    const strikesBlock = spx?.topStrikes
      ?.slice(0, 6)
      .map((s: any) => `  • $${s.strike.toLocaleString()} [${s.levelType}] — Gamma ${(s.totalGamma / 1e9).toFixed(2)}B  dist: ${spx.currentPrice > 0 ? ((s.strike - spx.currentPrice) / spx.currentPrice * 100).toFixed(2) : "N/A"}%`)
      .join("\n") || "  No disponible";

    // Outlier strikes
    const outliersBlock = spx?.chartData
      ?.filter((b: any) => b.isOutlier)
      .map((b: any) => `  • $${b.strike}: ${(b.totalGamma / 1e9).toFixed(2)}B`)
      .join("\n") || "  Sin outliers detectados";

    const context = `
Fecha: ${new Date().toLocaleDateString("es-CO", { timeZone: "America/Bogota", weekday: "long", year: "numeric", month: "long", day: "numeric" })}
Hora Colombia: ${new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota" })}
Estado: PRE-MERCADO

━━━ EVENTO MACRO ━━━
${macroBlock}

━━━ CFDs QUE OPERAS ━━━
- NAS100 (Nasdaq 100 CFD): $${nas100Price > 0 ? nas100Price.toLocaleString() : "N/A"} (${nas100Chg.toFixed(2)}%)
- US30 (Dow Jones CFD):    $${us30Price > 0 ? us30Price.toLocaleString() : "N/A"} (${us30Chg.toFixed(2)}%)
- XAUUSD (Oro CFD):        $${xauusdPrice > 0 ? xauusdPrice.toFixed(2) : "N/A"} (${xauusdChg.toFixed(2)}%)

━━━ CONTEXTO SPX (referencia para NAS100/US30) ━━━
SPX: $${spx?.currentPrice?.toFixed(2) || "N/A"} (${spx?.dailyChangePct?.toFixed(2) || "N/A"}%)
Gamma Flip Level: $${gammaFlipLevel || "N/A"}
  → NAS100 ${nas100Price > 0 && gammaFlipLevel > 0 ? (nas100Price > gammaFlipLevel * (nas100Price / (spx?.currentPrice || 1)) ? "POR ENCIMA del flip → régimen positivo (rebotes)" : "POR DEBAJO del flip → régimen negativo (momentum)") : "N/A"}
High Vol Point: $${spx?.highVolPoint || "N/A"} | Low Vol Point: $${spx?.lowVolPoint || "N/A"}
Call Gamma: ${spx?.callGamma ? (spx.callGamma/1e9).toFixed(1)+"B" : "N/A"} | Put Gamma: ${spx?.putGamma ? (spx.putGamma/1e9).toFixed(1)+"B" : "N/A"}
Put/Call Ratio: ${spx?.putCallRatio?.toFixed(2) || "N/A"} | IV Rank: ${spx?.ivRank?.toFixed(1) || "N/A"}%
Implied Move Diario: ${spx?.impliedMovePct ? spx.impliedMovePct.toFixed(2)+"%" : "N/A"}

GEX SPX: ${gex?.gexTrend?.toUpperCase() || "N/A"} | ${gex?.gexValue ? (gex.gexValue/1e9).toFixed(1)+"B" : "N/A"} | ${gex?.dealerIntent || "Sin datos"}
HIRO:    ${hiro?.hiroTrend?.toUpperCase() || "N/A"} (${hiro?.hiroValue ? (hiro.hiroValue/1e9).toFixed(2)+"B" : "N/A"})

━━━ VIX ━━━
VIX: ${vixVal.toFixed(2)} → ${vixLabel}
QQQ: $${qqq?.currentPrice?.toFixed(2) || "N/A"} (${qqq?.dailyChangePct?.toFixed(2) || "N/A"}%)
SPY: $${spy?.currentPrice?.toFixed(2) || "N/A"} (${spy?.dailyChangePct?.toFixed(2) || "N/A"}%)
DIA: $${dia?.currentPrice?.toFixed(2) || "N/A"} (${dia?.dailyChangePct?.toFixed(2) || "N/A"}%)

━━━ ORO — DXY / TLT ━━━
GLD: $${gld?.currentPrice?.toFixed(2) || "N/A"} (${gld?.dailyChangePct?.toFixed(2) || "N/A"}%)
DXY (Dollar Index): ${dxy?.price ? "$"+dxy.price.toFixed(2)+" ("+(dxy.changePct||0).toFixed(2)+"%)" : "N/A"} → ${dxy?.price ? ((dxy.changePct||0) > 0.3 ? "USD fuerte → presión bajista en oro" : (dxy.changePct||0) < -0.3 ? "USD débil → soporte alcista en oro" : "USD neutro") : "N/A"}
TLT (Bonos 20Y):    ${tlt?.price ? "$"+tlt.price.toFixed(2)+" ("+(tlt.changePct||0).toFixed(2)+"%)" : "N/A"} → ${tlt?.price ? ((tlt.changePct||0) > 0.5 ? "Yields bajan → favorable para oro" : (tlt.changePct||0) < -0.5 ? "Yields suben → presión en oro" : "Yields neutros") : "N/A"}

━━━ STRIKES CLAVE SPX ━━━
${strikesBlock}

━━━ OUTLIERS GAMMA ━━━
${outliersBlock}
`;

    const response = await invokeLLM({
      maxTokens: 2500,
      messages: [
        {
          role: "system",
          content: `Eres un analista senior de opciones, gamma exposure y flujo institucional. Preparas briefings de PREMERCADO para un trader intradía que opera EXCLUSIVAMENTE CFDs: NAS100 (Nasdaq), US30 (Dow Jones) y XAUUSD (Oro).

El análisis debe ser accionable y enfocado en esos 3 CFDs. Estructura OBLIGATORIA:

**1. 🗓️ CONTEXTO DEL DÍA**
Panorama general: VIX, cambios overnight, sentimiento. Si hay evento macro (FOMC/CPI/NFP), explica el impacto esperado y el ajuste de parámetros (SL ampliado, solo setups óptimos antes del evento).

**2. 📊 SESGO DEL MERCADO**
Basado en GEX (positivo = dealers amortiguan movimientos, negativo = amplifican), HIRO (flujo institucional), y posición del precio vs Gamma Flip:
- Tendencia de fondo: alcista / bajista / lateral
- Régimen: rebotes (gamma positivo) vs momentum (gamma negativo)
- Sesgo por CFD: NAS100, US30, XAUUSD

**3. 🎯 NIVELES CLAVE**
Para cada CFD menciona:
- Soporte principal y resistencia principal (en puntos del CFD)
- Zona de invalidación / Gamma Flip equivalent
- Si el precio está por encima o debajo del nivel de control (Gamma Flip)

**4. 📋 PLAN DE SESIÓN**
Para cada CFD (NAS100, US30, XAUUSD):
- Escenario alcista: condición + zona de entrada aproximada
- Escenario bajista: condición + zona de entrada aproximada
- ⚠️ Advertencia si hay evento macro que ajusta los parámetros

**5. ⚡ ALERTA DEL DÍA**
Una sola línea: el riesgo principal o la oportunidad más clara de hoy.

Escribe en español. Sé específico con precios y niveles reales del contexto. Máximo 500 palabras. Usa emojis con moderación para facilitar la lectura rápida.`,
        },
        {
          role: "user",
          content: `Genera el briefing de premercado para hoy:\n${context}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    return typeof content === "string" ? content : "Análisis de premercado en preparación...";
  } catch (err) {
    console.error("[Monitor] Error generating pre-market analysis:", err);
    return "Error al generar análisis de premercado. Reintentando en el próximo ciclo...";
  }
}

// ============================================================
// 2. REAL-TIME MARKET NARRATION (every 3 minutes during session)
// ============================================================
async function generateAutoNarration(data: Awaited<ReturnType<typeof fetchAllMarketData>>): Promise<string> {
  try {
    const spx = data.assets.find((a) => a.symbol === "SPX");
    const spy = data.assets.find((a) => a.symbol === "SPY");
    const qqq = data.assets.find((a) => a.symbol === "QQQ");
    const vix = data.assets.find((a) => a.symbol === "VIX");
    const gld = data.assets.find((a) => a.symbol === "GLD");
    const gex = data.gex;
    const hiro = data.hiro;
    const tape = data.tape;
    const signals = data.entrySignals || [];

    // Format active signals
    const activeSignals = signals
      .filter((s: any) => s.signal !== "ESPERA")
      .map((s: any) => `${s.asset}: ${s.signal} (${s.confidence})`)
      .join(", ");

    // Format tape
    const tapeInfo = tape
      ? `Tape: ${tape.dominantFlow.toUpperCase()} | Premium alcista: ${(tape.bullishPremium / 1e3).toFixed(0)}K | Premium bajista: ${(tape.bearishPremium / 1e3).toFixed(0)}K`
      : "Tape: sin datos";

    const context = `
Hora: ${new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota" })}
SPX: $${spx?.currentPrice?.toFixed(2)} (${spx?.dailyChangePct?.toFixed(2)}%) | SPY: $${spy?.currentPrice?.toFixed(2)} (${spy?.dailyChangePct?.toFixed(2)}%) | QQQ: $${qqq?.currentPrice?.toFixed(2)} (${qqq?.dailyChangePct?.toFixed(2)}%)
VIX: ${vix?.currentPrice?.toFixed(2)} (${vix?.dailyChangePct?.toFixed(2)}%) | GLD: $${gld?.currentPrice?.toFixed(2)} (${gld?.dailyChangePct?.toFixed(2)}%)
GEX SPX: ${gex?.gexTrend?.toUpperCase()} (${gex?.gexValue ? (gex.gexValue/1e9).toFixed(1)+'B' : 'N/A'})
HIRO: ${hiro?.hiroTrend?.toUpperCase()} (${hiro?.hiroValue ? (hiro.hiroValue/1e9).toFixed(2)+'B' : 'N/A'})
${tapeInfo}
Strikes clave SPX: ${spx?.topStrikes?.map((s) => `$${s.strike} (${s.levelType}, ${spx.currentPrice > 0 ? ((s.strike - spx.currentPrice) / spx.currentPrice * 100).toFixed(2) : "?"}%)`).join(", ") || "N/A"}
Señales activas: ${activeSignals || "Ninguna"}
`;

    const response = await invokeLLM({
      maxTokens: 512,
      messages: [
        {
          role: "system",
          content: `Eres un analista de trading intradía. Narra en tiempo real qué está pasando en el mercado.

Estructura (máximo 4 oraciones):
1. Estado general del mercado y movimiento principal
2. Qué están haciendo los dealers (GEX) y el flujo institucional (HIRO)
3. Zona clave más cercana y si hay señal de entrada
4. Recomendación concreta: comprar, vender, o esperar y por qué

Usa español. Sé directo y específico con precios.`,
        },
        {
          role: "user",
          content: `Narra el mercado ahora:\n${context}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    return typeof content === "string" ? content : "Analizando condiciones del mercado...";
  } catch (err) {
    console.log("[Monitor] LLM unavailable for narration, using rule-based summary");
    // Fallback: generate a rule-based narration
    return generateRuleBasedNarration(data);
  }
}

function generateRuleBasedNarration(data: Awaited<ReturnType<typeof fetchAllMarketData>>): string {
  const spx = data.assets.find((a) => a.symbol === "SPX");
  const vix = data.assets.find((a) => a.symbol === "VIX");
  const gex = data.gex;
  const hiro = data.hiro;
  const tape = data.tape;

  const parts: string[] = [];

  // 1. Market state
  if (spx) {
    const dir = (spx.dailyChangePct || 0) > 0 ? "sube" : "baja";
    parts.push(`SPX ${dir} ${Math.abs(spx.dailyChangePct || 0).toFixed(2)}% a $${spx.currentPrice?.toFixed(2)}.`);
  }

  // 2. GEX + HIRO
  if (gex && hiro) {
    const gexLabel = gex.gexTrend === "bullish" ? "positivo (dealers amortiguan)" : "negativo (dealers amplifican)";
    const hiroLabel = hiro.hiroTrend === "bullish" ? "alcista" : hiro.hiroTrend === "bearish" ? "bajista" : "neutral";
    parts.push(`GEX ${gexLabel}, flujo institucional (HIRO) ${hiroLabel}.`);
  }

  // 3. Nearest key zone
  if (spx && spx.topStrikes && spx.topStrikes.length > 0) {
    const nearest = spx.topStrikes.reduce((prev, curr) => {
      const prevDist = Math.abs((spx.currentPrice || 0) - prev.strike);
      const currDist = Math.abs((spx.currentPrice || 0) - curr.strike);
      return currDist < prevDist ? curr : prev;
    });
    const distPct = spx.currentPrice ? ((nearest.strike - spx.currentPrice) / spx.currentPrice * 100).toFixed(2) : "?";
    const zoneType = (spx.currentPrice || 0) > nearest.strike ? "soporte" : "resistencia";
    parts.push(`Zona clave mas cercana: $${nearest.strike.toLocaleString()} (${zoneType}, ${distPct}%).`);
  }

  // 4. VIX context
  if (vix) {
    const vixLevel = (vix.currentPrice || 0) > 30 ? "MIEDO EXTREMO" : (vix.currentPrice || 0) > 20 ? "volatilidad elevada" : "volatilidad normal";
    parts.push(`VIX en ${vix.currentPrice?.toFixed(2)} (${vixLevel}).`);
  }

  // 5. Recommendation
  const gexBear = gex?.gexTrend === "bearish";
  const hiroBear = hiro?.hiroTrend === "bearish";
  const tapeBear = (tape?.dominantFlow as string) === "bearish" || tape?.dominantFlow === "puts";
  const bearCount = [gexBear, hiroBear, tapeBear].filter(Boolean).length;
  const bullCount = [gex?.gexTrend === "bullish", hiro?.hiroTrend === "bullish", (tape?.dominantFlow as string) === "bullish" || tape?.dominantFlow === "calls"].filter(Boolean).length;

  if (bearCount >= 2) {
    parts.push("Sesgo BAJISTA. Precaucion con posiciones largas.");
  } else if (bullCount >= 2) {
    parts.push("Sesgo ALCISTA. Buscar compras en soportes de gamma.");
  } else {
    parts.push("Senales mixtas. ESPERAR confirmacion antes de operar.");
  }

  return parts.join(" ");
}

// ============================================================
// 3. INTELLIGENT AI-POWERED ALERTS
// ============================================================
function generateRuleBasedAnalysis(
  asset: any,
  strike: any,
  distancePct: number,
  gexTrend: string,
  hiroTrend: string,
  tapeFlow: string,
): string {
  const zoneType = asset.currentPrice > strike.strike ? "resistencia" : "soporte";
  const isBearish = gexTrend === "bearish";
  const isHiroBearish = hiroTrend === "bearish";
  const isTapeBearish = tapeFlow === "bearish";
  const bearishCount = [isBearish, isHiroBearish, isTapeBearish].filter(Boolean).length;
  const isBullish = gexTrend === "bullish";
  const isHiroBullish = hiroTrend === "bullish";
  const isTapeBullish = tapeFlow === "bullish";
  const bullishCount = [isBullish, isHiroBullish, isTapeBullish].filter(Boolean).length;

  if (zoneType === "soporte") {
    if (bearishCount >= 2) {
      return `GEX ${gexTrend.toUpperCase()} + HIRO ${hiroTrend.toUpperCase()} + Tape ${tapeFlow.toUpperCase()} sugieren RUPTURA bajista del soporte $${strike.strike.toLocaleString()}. Acción: VENDER si rompe con volumen.`;
    } else if (bullishCount >= 2) {
      return `GEX ${gexTrend.toUpperCase()} + HIRO ${hiroTrend.toUpperCase()} favorecen REBOTE en soporte $${strike.strike.toLocaleString()}. Acción: COMPRAR con stop debajo del strike.`;
    } else {
      return `Señales mixtas en soporte $${strike.strike.toLocaleString()} (GEX: ${gexTrend}, HIRO: ${hiroTrend}, Tape: ${tapeFlow}). Acción: ESPERAR confirmación de dirección.`;
    }
  } else {
    if (bullishCount >= 2) {
      return `GEX ${gexTrend.toUpperCase()} + HIRO ${hiroTrend.toUpperCase()} + Tape ${tapeFlow.toUpperCase()} sugieren RUPTURA alcista de resistencia $${strike.strike.toLocaleString()}. Acción: COMPRAR si rompe con volumen.`;
    } else if (bearishCount >= 2) {
      return `GEX ${gexTrend.toUpperCase()} + HIRO ${hiroTrend.toUpperCase()} favorecen RECHAZO en resistencia $${strike.strike.toLocaleString()}. Acción: VENDER con stop encima del strike.`;
    } else {
      return `Señales mixtas en resistencia $${strike.strike.toLocaleString()} (GEX: ${gexTrend}, HIRO: ${hiroTrend}, Tape: ${tapeFlow}). Acción: ESPERAR confirmación de dirección.`;
    }
  }
}

async function generateAlertAnalysis(
  asset: any,
  strike: any,
  distancePct: number,
  gexTrend: string,
  hiroTrend: string,
  tapeFlow: string,
): Promise<string> {
  try {
    const direction = asset.currentPrice > strike.strike ? "por encima" : "por debajo";
    const zoneType = asset.currentPrice > strike.strike ? "resistencia" : "soporte";

    const response = await invokeLLM({
      maxTokens: 256,
      messages: [
        {
          role: "system",
          content: `Analista de opciones intradía. El precio se acerca a una zona de gamma clave. Determina en máximo 2 oraciones:
1. Si es probable un rebote o una ruptura basándote en GEX, HIRO y tape
2. Acción concreta: COMPRAR, VENDER, o ESPERAR`,
        },
        {
          role: "user",
          content: `${asset.symbol} en $${asset.currentPrice.toFixed(2)}, a ${distancePct.toFixed(2)}% ${direction} del strike ${strike.strike.toLocaleString()} (${strike.levelType || "Gamma"}, zona de ${zoneType}).
GEX SPX: ${gexTrend}. HIRO: ${hiroTrend}. Tape: ${tapeFlow}.
¿Rebote o ruptura? ¿Qué hacer?`,
        },
      ],
    });
    const content = response.choices[0]?.message?.content;
    return typeof content === "string" ? content : generateRuleBasedAnalysis(asset, strike, distancePct, gexTrend, hiroTrend, tapeFlow);
  } catch (e) {
    console.log("[Monitor] LLM unavailable, using rule-based analysis");
    return generateRuleBasedAnalysis(asset, strike, distancePct, gexTrend, hiroTrend, tapeFlow);
  }
}

// Helper: get CFD equivalent price and label for an asset
function getCFDContext(asset: any, cfdPrices: any): { cfd: string; price: number; label: string } | null {
  if (!cfdPrices) return null;
  const sym = asset.symbol;
  if (["SPX", "SPY", "QQQ"].includes(sym)) return { cfd: "NAS100", price: cfdPrices.nas100?.price || 0, label: "NAS100" };
  if (sym === "DIA") return { cfd: "US30", price: cfdPrices.us30?.price || 0, label: "US30" };
  if (sym === "GLD") return { cfd: "XAUUSD", price: cfdPrices.xauusd?.price || 0, label: "XAUUSD" };
  return null;
}

// Helper: convert a SPX-level distance to CFD entry price
function levelToCFDPrice(
  assetPrice: number,
  targetStrike: number,
  cfdCurrentPrice: number,
): number {
  if (!assetPrice || !cfdCurrentPrice) return 0;
  const pctDistance = (targetStrike - assetPrice) / assetPrice;
  return Math.round((cfdCurrentPrice * (1 + pctDistance)) * 100) / 100;
}

async function checkAndGenerateAlerts(data: Awaited<ReturnType<typeof fetchAllMarketData>>) {
  const sessionDate = getSessionDate();
  const now = Date.now();
  const gexTrend = data.gex?.gexTrend || "neutral";
  const hiroTrend = data.hiro?.hiroTrend || "neutral";
  const tapeFlow = data.tape?.dominantFlow || "neutral";
  const cfdPrices = data.cfdPrices;

  for (const asset of data.assets) {
    if (!asset.currentPrice || asset.currentPrice === 0) continue;

    const prevPrice = prevPrices[asset.symbol];
    const priceChanged = prevPrice && Math.abs(asset.currentPrice - prevPrice) > 0.01;

    // Get CFD context for this asset
    const cfdCtx = getCFDContext(asset, cfdPrices);

    // Build CFD context string for alert messages
    const cfdStr = cfdCtx && cfdCtx.price > 0
      ? ` | ${cfdCtx.label}: $${cfdCtx.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "";

    // Check proximity to key strikes
    for (const strike of asset.topStrikes || []) {
      const distancePct = Math.abs((asset.currentPrice - strike.strike) / asset.currentPrice) * 100;
      const zoneType = asset.currentPrice > strike.strike ? "resistencia" : "soporte";

      // ─── TIER 1: APPROACHING alert (0.75% – 0.35%) ──────────────────────
      const approachKey = `${asset.symbol}_${strike.strike}_approach`;
      const lastApproach = alertCooldowns[approachKey] || 0;
      const approachCooldownPassed = now - lastApproach > 10 * 60 * 1000; // 10 min cooldown

      if (distancePct < 0.75 && distancePct >= 0.35 && approachCooldownPassed) {
        alertCooldowns[approachKey] = now;

        // CFD level at the strike
        const cfdAtStrike = cfdCtx && cfdCtx.price > 0
          ? levelToCFDPrice(asset.currentPrice, strike.strike, cfdCtx.price)
          : 0;
        const cfdStrikeStr = cfdAtStrike > 0
          ? ` → ${cfdCtx!.label} en $${cfdAtStrike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} al llegar`
          : "";

        await saveAlert({
          symbol: asset.symbol,
          alertType: "price_approaching_strike",
          strikeLevel: strike.strike,
          currentPrice: asset.currentPrice,
          severity: "info",
          title: `⚠️ ${asset.symbol} ACERCÁNDOSE a ${zoneType}: $${strike.strike.toLocaleString()} (${distancePct.toFixed(2)}%)`,
          message: `Precio $${asset.currentPrice.toFixed(2)} se acerca al nivel $${strike.strike.toLocaleString()} (${strike.levelType || "Gamma"}, ${distancePct.toFixed(2)}% de distancia). GEX: ${gexTrend.toUpperCase()} | HIRO: ${hiroTrend.toUpperCase()} | Tape: ${tapeFlow.toUpperCase()}${cfdStr}${cfdStrikeStr}. PREPARAR entrada.`,
          sessionDate,
        });

        console.log(`[Monitor] APPROACHING alert: ${asset.symbol} -> strike ${strike.strike} (${distancePct.toFixed(2)}%)`);
      }

      // ─── TIER 2: AT LEVEL alert (<0.35%) ─────────────────────────────────
      const atLevelKey = `${asset.symbol}_${strike.strike}`;
      const lastAlert = alertCooldowns[atLevelKey] || 0;
      const cooldownPassed = now - lastAlert > 5 * 60 * 1000; // 5 min cooldown

      if (distancePct < 0.35 && cooldownPassed) {
        alertCooldowns[atLevelKey] = now;

        // Generate AI analysis for the alert
        const analysis = await generateAlertAnalysis(asset, strike, distancePct, gexTrend, hiroTrend, tapeFlow);

        // Confirm count for this alert
        const confirmBull = [gexTrend === "bullish", hiroTrend === "bullish", tapeFlow === "calls"].filter(Boolean).length;
        const confirmBear = [gexTrend === "bearish", hiroTrend === "bearish", tapeFlow === "puts"].filter(Boolean).length;
        const dominantConf = zoneType === "soporte" ? confirmBull : confirmBear;
        const confStr = `${dominantConf}/3 confirmaciones`;

        // CFD entry price at the exact strike
        const cfdEntryAtStrike = cfdCtx && cfdCtx.price > 0
          ? levelToCFDPrice(asset.currentPrice, strike.strike, cfdCtx.price)
          : 0;
        const cfdEntryStr = cfdEntryAtStrike > 0
          ? ` | ENTRADA ${cfdCtx!.label}: $${cfdEntryAtStrike.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : "";

        const severity = distancePct < 0.08 ? "critical" : "warning";

        await saveAlert({
          symbol: asset.symbol,
          alertType: "price_at_strike",
          strikeLevel: strike.strike,
          currentPrice: asset.currentPrice,
          severity,
          title: `${severity === "critical" ? "🚨" : "🎯"} ${asset.symbol} EN zona ${zoneType}: $${strike.strike.toLocaleString()} (${confStr})`,
          message: `Precio $${asset.currentPrice.toFixed(2)} a ${distancePct.toFixed(2)}% del strike $${strike.strike.toLocaleString()} (${strike.levelType || "Gamma"}). GEX: ${gexTrend.toUpperCase()} | HIRO: ${hiroTrend.toUpperCase()} | Tape: ${tapeFlow.toUpperCase()}${cfdStr}${cfdEntryStr}`,
          analysis,
          sessionDate,
        });

        console.log(`[Monitor] AT-LEVEL alert: ${asset.symbol} at strike ${strike.strike} (${distancePct.toFixed(2)}%) ${confStr} - ${analysis.substring(0, 80)}...`);
      }
    }

    // Check for significant price movements
    if (prevPrice && priceChanged) {
      const movePct = ((asset.currentPrice - prevPrice) / prevPrice) * 100;
      const moveKey = `${asset.symbol}_move`;
      const lastMoveAlert = alertCooldowns[moveKey] || 0;

      if (Math.abs(movePct) > 0.5 && now - lastMoveAlert > 10 * 60 * 1000) {
        alertCooldowns[moveKey] = now;
        const direction = movePct > 0 ? "subida" : "bajada";
        const emoji = movePct > 0 ? "📈" : "📉";

        await saveAlert({
          symbol: asset.symbol,
          alertType: "tape_signal",
          currentPrice: asset.currentPrice,
          severity: Math.abs(movePct) > 1 ? "warning" : "info",
          title: `${emoji} Movimiento ${asset.symbol}: ${movePct > 0 ? "+" : ""}${movePct.toFixed(2)}%`,
          message: `${asset.symbol} registra una ${direction} de ${Math.abs(movePct).toFixed(2)}% en los últimos 30s. Precio: $${asset.currentPrice.toFixed(2)}. GEX: ${gexTrend.toUpperCase()} | HIRO: ${hiroTrend.toUpperCase()}`,
          sessionDate,
        });
      }
    }

    prevPrices[asset.symbol] = asset.currentPrice;
  }

  // GEX shift alert (every 30 min)
  if (data.gex) {
    const gexKey = "SPX_gex";
    const lastGexAlert = alertCooldowns[gexKey] || 0;
    if (now - lastGexAlert > 30 * 60 * 1000) {
      alertCooldowns[gexKey] = now;
      await saveAlert({
        symbol: "SPX",
        alertType: "gex_shift",
        currentPrice: data.assets.find((a) => a.symbol === "SPX")?.currentPrice,
        severity: "info",
        title: `📊 GEX SPX: ${data.gex.gexTrend?.toUpperCase()}`,
        message: data.gex.dealerIntent || "Sin descripción",
        sessionDate,
      });
    }
  }

  // VIX spike alert
  const vix = data.assets.find((a) => a.symbol === "VIX");
  if (vix && vix.currentPrice) {
    const vixKey = "VIX_spike";
    const lastVixAlert = alertCooldowns[vixKey] || 0;
    if (vix.dailyChangePct > 5 && now - lastVixAlert > 15 * 60 * 1000) {
      alertCooldowns[vixKey] = now;
      await saveAlert({
        symbol: "VIX",
        alertType: "volatility_spike",
        currentPrice: vix.currentPrice,
        severity: vix.dailyChangePct > 10 ? "critical" : "warning",
        title: `VIX Spike: ${vix.currentPrice.toFixed(2)} (+${vix.dailyChangePct.toFixed(1)}%)`,
        message: `VIX sube ${vix.dailyChangePct.toFixed(1)}% a ${vix.currentPrice.toFixed(2)}. ${vix.currentPrice > 30 ? "MIEDO EXTREMO - posible capitulacion." : "Volatilidad elevada - precaucion con posiciones largas."}`,
        sessionDate,
      });
    }
  }

  // ============ NEW ALERTS v3 ============

  // 1. SG Levels Changed vs Yesterday
  if (data.officialLevels) {
    for (const [sym, levels] of Object.entries(data.officialLevels)) {
      if (!levels.levelsChanged) continue;
      const sgKey = `${sym}_sg_levels_changed`;
      const lastSGAlert = alertCooldowns[sgKey] || 0;
      if (now - lastSGAlert > 60 * 60 * 1000) { // 1 hour cooldown
        alertCooldowns[sgKey] = now;
        const changes: string[] = [];
        if (levels.callWall !== levels.prevCallWall) changes.push(`Call Wall: $${levels.prevCallWall} -> $${levels.callWall}`);
        if (levels.putWall !== levels.prevPutWall) changes.push(`Put Wall: $${levels.prevPutWall} -> $${levels.putWall}`);
        if (levels.keyGamma !== levels.prevKeyGamma) changes.push(`Key Gamma: $${levels.prevKeyGamma} -> $${levels.keyGamma}`);
        if (levels.maxGamma !== levels.prevMaxGamma) changes.push(`Max Gamma: $${levels.prevMaxGamma} -> $${levels.maxGamma}`);
        await saveAlert({
          symbol: sym,
          alertType: "sg_levels_changed",
          currentPrice: data.assets.find(a => a.symbol === sym)?.currentPrice,
          severity: "info",
          title: `Niveles SG ${sym} cambiaron vs ayer`,
          message: changes.join(" | "),
          sessionDate,
        });
      }
    }
  }

  // 2. VIX Backwardation (term structure inverted)
  if (data.volContext) {
    const isBackwardation = data.volContext.avgTermStructure === 'backwardation';
    const bwKey = "VIX_backwardation";
    const lastBWAlert = alertCooldowns[bwKey] || 0;
    if (isBackwardation && now - lastBWAlert > 30 * 60 * 1000) {
      alertCooldowns[bwKey] = now;
      await saveAlert({
        symbol: "VIX",
        alertType: "vix_backwardation",
        currentPrice: vix?.currentPrice,
        severity: "critical",
        title: `ALERTA: VIX en Backwardation`,
        message: `La estructura temporal del VIX esta invertida (backwardation). Esto indica MIEDO EXTREMO a corto plazo. Los institucionales esperan mas volatilidad AHORA que en el futuro. Precaucion maxima con posiciones largas.`,
        sessionDate,
      });
    }
  }

  // 3. Vanna Flow Activated (Indices)
  if (data.vannaContext?.indexVannaActive) {
    const vannaKey = "index_vanna_flow";
    const lastVannaAlert = alertCooldowns[vannaKey] || 0;
    if (now - lastVannaAlert > 15 * 60 * 1000) {
      alertCooldowns[vannaKey] = now;
      const vc = data.vannaContext;
      const direction = vc.vixVannaSignal === "bullish" ? "ALCISTA" : "BAJISTA";
      await saveAlert({
        symbol: "SPX",
        alertType: "vanna_flow",
        currentPrice: data.assets.find(a => a.symbol === "SPX")?.currentPrice,
        severity: "warning",
        title: `Vanna Flow ${direction} activado en indices`,
        message: `VIX ${vc.vixChangePct > 0 ? "+" : ""}${vc.vixChangePct.toFixed(1)}% -> Dealers rebalanceando delta. Flujo mecanico ${direction.toLowerCase()} en SPX/QQQ. ${direction === "ALCISTA" ? "Dealers comprando = soporte" : "Dealers vendiendo = presion bajista"}.`,
        sessionDate,
      });
    }
  }

  // 4. Vanna Flow Activated (GLD)
  if (data.vannaContext?.goldVannaActive) {
    const gldVannaKey = "gold_vanna_flow";
    const lastGldVannaAlert = alertCooldowns[gldVannaKey] || 0;
    if (now - lastGldVannaAlert > 15 * 60 * 1000) {
      alertCooldowns[gldVannaKey] = now;
      const vc = data.vannaContext;
      const direction = vc.gldVannaSignal === "bullish" ? "ALCISTA" : "BAJISTA";
      await saveAlert({
        symbol: "GLD",
        alertType: "vanna_flow",
        currentPrice: data.assets.find(a => a.symbol === "GLD")?.currentPrice,
        severity: "warning",
        title: `Vanna Flow ${direction} activado en GLD/XAUUSD`,
        message: `IV de GLD cambiando significativamente. Flujo vanna ${direction.toLowerCase()} en oro. ${direction === "ALCISTA" ? "IV cayendo = dealers compran GLD" : "IV subiendo = dealers venden GLD"}.`,
        sessionDate,
      });
    }
  }

  // 5. Refuge Flow Activated (UVXY up + GLD HIRO positive)
  if (data.vannaContext?.refugeFlowActive) {
    const refugeKey = "refuge_flow";
    const lastRefugeAlert = alertCooldowns[refugeKey] || 0;
    if (now - lastRefugeAlert > 15 * 60 * 1000) {
      alertCooldowns[refugeKey] = now;
      const vc = data.vannaContext;
      await saveAlert({
        symbol: "GLD",
        alertType: "refuge_flow",
        currentPrice: data.assets.find(a => a.symbol === "GLD")?.currentPrice,
        severity: "warning",
        title: `Flujo REFUGIO activado - Capital hacia ORO`,
        message: `UVXY +${vc.uvxyChangePct.toFixed(1)}% + GLD HIRO positivo. Panico en equities esta empujando capital hacia oro. Considerar COMPRA XAUUSD.`,
        sessionDate,
      });
    }
  }

  // 6. Price Crossed Vol Trigger (Regime Change)
  if (data.officialLevels?.SPX) {
    const spxLevels = data.officialLevels.SPX;
    const spxAsset = data.assets.find(a => a.symbol === "SPX");
    const spxPrev = prevPrices["SPX"];
    if (spxAsset?.currentPrice && spxPrev && spxLevels.volTrigger > 0) {
      const wasAbove = spxPrev > spxLevels.volTrigger;
      const isAbove = spxAsset.currentPrice > spxLevels.volTrigger;
      if (wasAbove !== isAbove) {
        const vtKey = "SPX_vol_trigger_cross";
        const lastVTAlert = alertCooldowns[vtKey] || 0;
        if (now - lastVTAlert > 10 * 60 * 1000) {
          alertCooldowns[vtKey] = now;
          const direction = isAbove ? "SOBRE" : "BAJO";
          const regime = isAbove ? "POSITIVO" : "NEGATIVO";
          await saveAlert({
            symbol: "SPX",
            alertType: "regime_change",
            strikeLevel: spxLevels.volTrigger,
            currentPrice: spxAsset.currentPrice,
            severity: "critical",
            title: `CAMBIO DE REGIMEN: SPX cruzo Vol Trigger ($${spxLevels.volTrigger})`,
            message: `SPX ahora ${direction} Vol Trigger. Gamma ${regime}. ${isAbove ? "Mean reversion favorecido. Dealers frenan movimientos." : "Trending favorecido. Dealers aceleran movimientos. NO hacer mean reversion."}`,
            sessionDate,
          });
        }
      }
    }
  }

  // 7. 0DTE Gamma > 40% of Total (Pin Risk)
  const spxAssetForGamma = data.assets.find(a => a.symbol === "SPX");
  if (spxAssetForGamma) {
    const totalGamma = Math.abs(spxAssetForGamma.callGamma) + Math.abs(spxAssetForGamma.putGamma);
    const zeroDteGamma = Math.abs(spxAssetForGamma.zeroDteGamma || 0);
    const zeroDtePct = totalGamma > 0 ? (zeroDteGamma / totalGamma) * 100 : 0;
    const pinKey = "SPX_0dte_pin_risk";
    const lastPinAlert = alertCooldowns[pinKey] || 0;
    if (zeroDtePct > 40 && now - lastPinAlert > 30 * 60 * 1000) {
      alertCooldowns[pinKey] = now;
      await saveAlert({
        symbol: "SPX",
        alertType: "pin_risk",
        currentPrice: spxAssetForGamma.currentPrice,
        severity: "warning",
        title: `0DTE Gamma ${zeroDtePct.toFixed(0)}% del total - Pin Risk ALTO`,
        message: `El ${zeroDtePct.toFixed(0)}% del gamma total de SPX expira HOY (0DTE). Mercado ultra-reactivo a flujos intradia. Stops mas ajustados recomendados.`,
        sessionDate,
      });
    }
  }
}

// ============================================================
// MONITOR LIFECYCLE
// ============================================================
export function startMarketMonitor() {
  if (isRunning) return;
  isRunning = true;
  console.log("[Monitor] Starting market monitor service...");

  // Start live flow watcher (polls every 5s for institutional trades)
  startLiveFlowWatcher();

  // Check for pre-market analysis every 60 seconds
  preMarketInterval = setInterval(async () => {
    const colombiaTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
    const hours = colombiaTime.getHours();
    const minutes = colombiaTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const day = colombiaTime.getDay();
    const today = colombiaTime.toISOString().split("T")[0];

    // Run pre-market analysis between 7:50 AM and 8:25 AM Colombia, once per day
    if (day >= 1 && day <= 5 && totalMinutes >= 7 * 60 + 50 && totalMinutes <= 8 * 60 + 25 && lastPreMarketDate !== today) {
      lastPreMarketDate = today;
      console.log("[Monitor] Generating pre-market analysis...");

      try {
        const data = await fetchAllMarketData();
        // Ingest live economic calendar from SpotGamma into session-tracker
        if (data.economicCalendar?.length) {
          ingestLiveEconCalendar(data.economicCalendar);
        }
        const analysis = await generatePreMarketAnalysis(data);
        const sessionDate = getSessionDate();

        await saveNarration({
          narration: `📋 ANÁLISIS PRE-MERCADO\n\n${analysis}`,
          context: {
            type: "pre-market",
            marketStatus: data.marketStatus,
            fetchedAt: data.fetchedAt,
            spxPrice: data.assets.find((a) => a.symbol === "SPX")?.currentPrice,
          },
          sessionDate,
        });

        console.log("[Monitor] Pre-market analysis generated successfully");
      } catch (err) {
        console.error("[Monitor] Error generating pre-market analysis:", err);
        lastPreMarketDate = ""; // Allow retry
      }
    }
  }, 60 * 1000); // Check every minute

  // Poll market data every 30 seconds
  // Track last off-hours fetch to throttle to every 2 minutes outside session
  let lastOffHoursFetch = 0;

  monitorInterval = setInterval(async () => {
    const colombiaTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
    const hours = colombiaTime.getHours();
    const minutes = colombiaTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const day = colombiaTime.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const isInSession = totalMinutes >= 8 * 60 && totalMinutes <= 15 * 60; // 8:00 AM – 3:00 PM Colombia

    if (!isWeekday) return; // Never run on weekends

    // Outside session: run every 2 minutes (XAUUSD + NAS100/US30 pre/post market tracking)
    if (!isInSession) {
      const now = Date.now();
      if (now - lastOffHoursFetch < 2 * 60 * 1000) return; // throttle to 2 min
      lastOffHoursFetch = now;
    }

    try {
      const data = await fetchAllMarketData();

      // Keep live economic calendar in sync
      if (data.economicCalendar?.length) {
        ingestLiveEconCalendar(data.economicCalendar);
      }

      // Generate alerts only during session (after 8:30 AM)
      if (isInSession && totalMinutes >= 8 * 60 + 30) {
        await checkAndGenerateAlerts(data);
      }
    } catch (err) {
      console.error("[Monitor] Error in polling cycle:", err);
    }
  }, 15000); // Poll every 15 seconds (throttled to 2 min outside session)

  // Generate narration every 3 minutes during market hours
  narrationInterval = setInterval(async () => {
    const colombiaTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
    const hours = colombiaTime.getHours();
    const minutes = colombiaTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const day = colombiaTime.getDay();

    if (day < 1 || day > 5) return;
    if (totalMinutes < 8 * 60 + 30 || totalMinutes > 13 * 60) return;

    try {
      const data = await fetchAllMarketData();
      const narration = await generateAutoNarration(data);
      const sessionDate = getSessionDate();

      await saveNarration({
        narration,
        context: {
          type: "real-time",
          marketStatus: data.marketStatus,
          fetchedAt: data.fetchedAt,
          spxPrice: data.assets.find((a) => a.symbol === "SPX")?.currentPrice,
          gexTrend: data.gex?.gexTrend,
          hiroTrend: data.hiro?.hiroTrend,
        },
        sessionDate,
      });

      console.log("[Monitor] Real-time narration generated");
    } catch (err) {
      console.error("[Monitor] Error generating narration:", err);
    }
  }, 3 * 60 * 1000); // every 3 minutes

  // ── TRACE GEX Level-Shift Detector (every 5 minutes) ──────────────────────
  traceInterval = setInterval(async () => {
    const colombiaTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
    const hours = colombiaTime.getHours();
    const minutes = colombiaTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const day = colombiaTime.getDay();

    if (day < 1 || day > 5) return;
    if (totalMinutes < 8 * 60 + 30 || totalMinutes > 13 * 60) return;

    try {
      const data = await fetchAllMarketData();
      const trace = data.traceData;
      if (!trace) return;

      const sessionDate = getSessionDate();
      const now = Date.now();
      const currentRatio = trace.gexRatio;

      // Detect significant TRACE GEX ratio shift (> 0.3 change)
      if (prevTraceGexRatio !== null) {
        const ratioShift = currentRatio - prevTraceGexRatio;
        const shiftKey = "TRACE_ratio_shift";
        const lastShiftAlert = alertCooldowns[shiftKey] || 0;

        if (Math.abs(ratioShift) > 0.3 && now - lastShiftAlert > 5 * 60 * 1000) {
          alertCooldowns[shiftKey] = now;
          const direction = ratioShift > 0 ? "MAS ALCISTA" : "MAS BAJISTA";
          const spxPrice = data.assets.find(a => a.symbol === "SPX")?.currentPrice;
          const nas100Price = data.cfdPrices?.nas100?.price;
          const cfdStr = nas100Price ? ` | NAS100: $${nas100Price.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "";

          await saveAlert({
            symbol: "SPX",
            alertType: "trace_gex_shift",
            currentPrice: spxPrice,
            severity: Math.abs(ratioShift) > 0.5 ? "warning" : "info",
            title: `📊 TRACE 0DTE GEX cambia: ratio ${prevTraceGexRatio.toFixed(2)} → ${currentRatio.toFixed(2)} (${direction})`,
            message: `El posicionamiento 0DTE de dealers cambió significativamente. Soporte: ${trace.topSupport.slice(0,2).map(s => `$${s.strike}`).join(", ")} | Resistencia: ${trace.topResistance.slice(0,2).map(r => `$${r.strike}`).join(", ")}${cfdStr}. Revisar niveles de TP/SL.`,
            sessionDate,
          });

          console.log(`[TRACE] GEX ratio shift: ${prevTraceGexRatio.toFixed(2)} → ${currentRatio.toFixed(2)} (${ratioShift > 0 ? "+" : ""}${ratioShift.toFixed(2)})`);
        }

        // Also alert if top support/resistance levels changed
        const tracker = data.gexChangeTracker;
        if (tracker?.changes?.biasChanged) {
          const biasKey = "TRACE_bias_change";
          const lastBiasAlert = alertCooldowns[biasKey] || 0;
          if (now - lastBiasAlert > 10 * 60 * 1000) {
            alertCooldowns[biasKey] = now;
            await saveAlert({
              symbol: "SPX",
              alertType: "trace_bias_change",
              currentPrice: data.assets.find(a => a.symbol === "SPX")?.currentPrice,
              severity: "warning",
              title: `🔄 TRACE 0DTE: Sesgo cambió de ${tracker.changes.prevBias.toUpperCase()} → ${tracker.changes.newBias.toUpperCase()}`,
              message: tracker.changes.description,
              sessionDate,
            });
          }
        }
      }

      prevTraceGexRatio = currentRatio;
    } catch (err) {
      console.error("[TRACE] Error in TRACE polling cycle:", err);
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // ── Auto-resolve 24/7 (loop ligero, solo precios CFD) ─────────────────────
  // Corre toda la semana sin depender de SpotGamma — solo busca precios CFD
  // para detectar TP/SL en posiciones abiertas de XAUUSD (opera 24/5).
  autoResolveInterval = setInterval(async () => {
    const day = new Date().getDay();
    if (day === 0 || day === 6) return; // solo días de semana
    try {
      const cfdData = await fetchCFDPricesFromTradingView();
      const priceMap: Record<string, number> = {
        NAS100: cfdData.nas100?.price || 0,
        US30:   cfdData.us30?.price   || 0,
        XAUUSD: cfdData.xauusd?.price || 0,
      };
      autoResolveOpen(priceMap);
    } catch { /* silencioso — no interrumpir el loop */ }
  }, 15 * 1000); // cada 15 segundos (más preciso para SL/TP en XAUUSD volátil)

  // ── CLAUDE API DECISION CYCLE — DISABLED ──────────────────────────────
  // Claude Code (terminal session) is the brain, not the Anthropic API.
  // This cycle was causing ANTHROPIC_API_KEY errors. Disabled.
  // claudeDecisionInterval = null;

  console.log("[Monitor] Market monitor started - Pre-market (7:50-8:25), Narration (3min), Alerts (15s), TRACE (5min), AutoResolve (24/7 15s)");
}

export function stopMarketMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (narrationInterval) {
    clearInterval(narrationInterval);
    narrationInterval = null;
  }
  if (preMarketInterval) {
    clearInterval(preMarketInterval);
    preMarketInterval = null;
  }
  if (traceInterval) {
    clearInterval(traceInterval);
    traceInterval = null;
  }
  if (autoResolveInterval) {
    clearInterval(autoResolveInterval);
    autoResolveInterval = null;
  }
  if (claudeDecisionInterval) {
    clearInterval(claudeDecisionInterval);
    claudeDecisionInterval = null;
  }
  isRunning = false;
  console.log("[Monitor] Market monitor stopped");
}
