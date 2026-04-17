import { z } from "zod";
import fs from "fs";
import path from "path";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { invokeLLM } from "./_core/llm";
import {
  getAlerts,
  getLatestGexData,
  getLatestNarration,
  getLatestSnapshots,
  getNarrationHistory,
  markAlertRead,
  saveAlert,
  saveGexData,
  saveKeyStrikes,
  saveMarketSnapshot,
  saveNarration,
} from "./db";
import { fetchAllMarketData, getMarketStatus, getSessionDate, exploreHiroEndpoints, fetchTraceDataOnly, getGexHistory, fetchCFDPricesFromTradingView, fetchSpotGammaLivePrices } from "./spotgamma-scraper";
// getSessionContext removed (Fase 3 PPO Puro — session is a PPO feature now)
import { loadHistory, saveHistory, logSetupIfNew, resolveRecord, deleteRecord, autoResolveOpen, getStats, protectBeforeMacro, sessionCloseCheck, isDailyLossLimitReached } from "./trade-history";
import { getMT5Status, placeOrder as mt5PlaceOrder, closePosition as mt5ClosePosition, modifySL as mt5ModifySL, getMT5FilesDir, getBrokerPrices } from "./mt5-file-bridge";
import { getLiveFlowAlerts, getLiveFlowSummary } from "./live-flow-watcher";
import { getMacroAlert, refreshDXYTLT } from "./session-tracker";
import { evaluateRetest, getRetestMemory } from "./retest-memory";
import { loadAutoConfig, saveAutoConfig, checkKillSwitch, getAutoTradingStats, countTodayAutoTrades, countOpenMT5Positions } from "./auto-trade-config.js";
// RL-Agent removed (Fase 3 PPO Puro) — all RL imports replaced with stubs
const suggestAction = () => ({ action: 0 });
const extractRLState = () => ({});
const learnFromTrade = () => {};
const replayTradeHistory = () => {};
const pretrainFromHistorical = () => {};
const pretrainFromChartData = () => {};
const getRLStats = () => ({ totalEpisodes: 0, winRate: 0, epsilon: 0 });
const getAdaptivePolicy = () => null;
type PolicyActions = Record<string, number>;
import { getExecutorStatus } from "./fast-executor";
import { recordSnapshot, getMultiTimeframeView } from "./multi-timeframe-store";
import { downloadAllHistorical, getDownloadStatus, downloadGEXHistory, downloadTapeFlow, downloadTraceGamma, downloadGammaDeltaTilt, downloadDailyOHLC, downloadChartData } from "./historical-downloader";
import { downloadChartDataRange, getChartDataStatus } from "./historical-chart-fetcher";
import { runHistoricalSimulation, runPPOTraining, runMultiHeadPPOTraining, getSimulationStatus, probeSpotGammaHistory } from "./historical-simulator";
import { fetchAllCFDPrices, getYahooPriceStatus } from "./yahoo-price-fetcher";

// Debug endpoint for HIRO exploration
const hiroDebugRouter = router({
  exploreHiro: publicProcedure.query(async () => {
    return await exploreHiroEndpoints();
  }),
});

// ============ TRADE EXIT ALERT SYSTEM ============

export interface TradeAlert {
  id: string;
  cfd: string;            // NAS100, US30, XAUUSD
  direction: string;      // LONG / SHORT
  type: "tp1_hit" | "tp2_hit" | "tp3_hit" | "sl_hit" | "gamma_flip" | "hiro_reversal" | "invalidated";
  title: string;
  message: string;
  currentPrice: number;
  triggerLevel: number;
  severity: "info" | "warning" | "critical";
  timestamp: string;
  read: boolean;
}

// Circular buffer — keep last 20 alerts
const tradeAlertQueue: TradeAlert[] = [];
const MAX_ALERTS = 20;

// Track last known setup state for comparison
let lastSetupSnapshot: Record<string, { setup: any; checkedAt: number }> = {};

function addTradeAlert(alert: Omit<TradeAlert, "id" | "timestamp" | "read">) {
  const full: TradeAlert = {
    ...alert,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    read: false,
  };
  tradeAlertQueue.unshift(full);
  if (tradeAlertQueue.length > MAX_ALERTS) tradeAlertQueue.pop();
  console.log(`[ALERT] ${full.severity.toUpperCase()} | ${full.title}`);
}

function checkTradeAlerts(data: Awaited<ReturnType<typeof fetchAllMarketData>>) {
  if (!data?.tradeSetups || !data?.cfdPrices) return;

  for (const setup of data.tradeSetups) {
    if (setup.direction === "NO_TRADE" || setup.cfdEntryPrice === 0) continue;
    const key = setup.cfd;
    const last = lastSetupSnapshot[key];

    // Get current CFD price
    const cfdPriceNow = key === "NAS100" ? data.cfdPrices.nas100?.price
      : key === "US30" ? data.cfdPrices.us30?.price
      : data.cfdPrices.xauusd?.price;
    if (!cfdPriceNow || cfdPriceNow === 0) continue;

    const isLong = setup.direction === "LONG";
    const cooldownMs = 120_000; // Don't re-alert same level within 2 min
    const now = Date.now();

    // Only check if we have a previous snapshot and cooldown passed
    if (last && now - last.checkedAt > cooldownMs) {
      const prevPrice = last.setup.cfdEntryPrice || cfdPriceNow;

      // TP1 hit
      if (setup.takeProfit1 > 0) {
        const tp1Hit = isLong ? (cfdPriceNow >= setup.takeProfit1) : (cfdPriceNow <= setup.takeProfit1);
        if (tp1Hit) {
          addTradeAlert({
            cfd: key, direction: setup.direction, type: "tp1_hit",
            title: `✅ TP1 alcanzado — ${key}`,
            message: `${key} ${isLong ? "LONG" : "SHORT"}: precio en ${cfdPriceNow.toFixed(key === "XAUUSD" ? 2 : 0)} alcanzó TP1 ${setup.takeProfit1.toFixed(key === "XAUUSD" ? 2 : 0)}. Cerrar 50% y mover SL a break-even.`,
            currentPrice: cfdPriceNow, triggerLevel: setup.takeProfit1, severity: "info",
          });
        }
      }

      // TP2 hit
      if (setup.takeProfit2 > 0) {
        const tp2Hit = isLong ? (cfdPriceNow >= setup.takeProfit2) : (cfdPriceNow <= setup.takeProfit2);
        if (tp2Hit) {
          addTradeAlert({
            cfd: key, direction: setup.direction, type: "tp2_hit",
            title: `🎯 TP2 alcanzado — ${key}`,
            message: `${key}: precio en ${cfdPriceNow.toFixed(key === "XAUUSD" ? 2 : 0)} alcanzó TP2 ${setup.takeProfit2.toFixed(key === "XAUUSD" ? 2 : 0)}. Cerrar 30%, dejar runner con trailing.`,
            currentPrice: cfdPriceNow, triggerLevel: setup.takeProfit2, severity: "info",
          });
        }
      }

      // SL hit
      if (setup.stopLoss > 0) {
        const slHit = isLong ? (cfdPriceNow <= setup.stopLoss) : (cfdPriceNow >= setup.stopLoss);
        if (slHit) {
          addTradeAlert({
            cfd: key, direction: setup.direction, type: "sl_hit",
            title: `🛑 Stop Loss tocado — ${key}`,
            message: `${key}: precio en ${cfdPriceNow.toFixed(key === "XAUUSD" ? 2 : 0)} alcanzó SL ${setup.stopLoss.toFixed(key === "XAUUSD" ? 2 : 0)}. Salir ahora. Riesgo: $${setup.stopLossRiskUSD?.toFixed(2)}.`,
            currentPrice: cfdPriceNow, triggerLevel: setup.stopLoss, severity: "critical",
          });
        }
      }

      // Gamma flip invalidation (for indices)
      if (setup.invalidation?.gammaFlipCFD > 0) {
        const flipHit = isLong
          ? (cfdPriceNow <= setup.invalidation.gammaFlipCFD)
          : (cfdPriceNow >= setup.invalidation.gammaFlipCFD);
        if (flipHit) {
          addTradeAlert({
            cfd: key, direction: setup.direction, type: "gamma_flip",
            title: `⚠️ Gamma Flip cruzado — ${key}`,
            message: `Precio cruzó el Gamma Flip ($${setup.invalidation.gammaFlipLevel}). Setup ${setup.direction} INVALIDADO. Dealers pasan a amplificar movimientos.`,
            currentPrice: cfdPriceNow, triggerLevel: setup.invalidation.gammaFlipCFD, severity: "warning",
          });
        }
      }

      // HIRO reversal
      if (setup.invalidation?.hiroReversed) {
        addTradeAlert({
          cfd: key, direction: setup.direction, type: "hiro_reversal",
          title: `🔄 HIRO Revertido — ${key}`,
          message: `HIRO ${setup.asset} revertió contra el ${setup.direction}. Flujo institucional ahora en contra. Considerar salida parcial.`,
          currentPrice: cfdPriceNow, triggerLevel: 0, severity: "warning",
        });
      }
    }

    // Update snapshot
    lastSetupSnapshot[key] = { setup: { ...setup, cfdEntryPrice: cfdPriceNow }, checkedAt: now };
  }
}

// In-memory cache for real-time data
let lastMarketData: Awaited<ReturnType<typeof fetchAllMarketData>> | null = null;
let lastFetchTime = 0;
let isFetching = false;
let previousPrices: Record<string, number> = {};

async function getMarketDataCached() {
  const now = Date.now();
  if (lastMarketData && now - lastFetchTime < 28000) {
    return lastMarketData;
  }
  if (isFetching) return lastMarketData;

  isFetching = true;
  try {
    const data = await fetchAllMarketData();
    lastMarketData = data;
    lastFetchTime = now;

    // Record multi-timeframe snapshot (every ~15 min)
    try { recordSnapshot(data); } catch (e: any) { console.warn("[MultiTF]", e.message); }

    // Check trade exit alerts
    try { checkTradeAlerts(data); } catch (e: any) { console.warn("[ALERTS]", e.message); }

    // Auto-log new setups to trade history
    try {
      const sessionDate = getSessionDate();
      const cfdPriceMap: Record<string, number> = {
        NAS100: data?.cfdPrices?.nas100?.price || 0,
        US30: data?.cfdPrices?.us30?.price || 0,
        XAUUSD: data?.cfdPrices?.xauusd?.price || 0,
      };

      // All CFDs tracked 24/5 — quality filters (score, level proximity, cooldowns) control entries
      const colDay    = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })).getDay();
      const isWeekday = colDay >= 1 && colDay <= 5;

      // Auto-trade config: desde data/auto-trading-config.json (gestionado por dashboard)
      const atCfg = loadAutoConfig();
      const defaultVolume: Record<string, number> = atCfg.volumes ?? { NAS100: 0.1, US30: 0.1, XAUUSD: 0.01 };

      // Score threshold for current session (used by retest memory)
      const sessionThreshold = 70; // Default score threshold (session context removed in Fase 3 PPO Puro)

      for (const rawSetup of data?.tradeSetups || []) {
        // ── Retest memory: promote VIGILANCIA→ENTRADA si precio vuelve al nivel ──
        const cfdPriceForRetest = rawSetup.cfd === "NAS100" ? (data?.cfdPrices?.nas100?.price || 0)
          : rawSetup.cfd === "US30" ? (data?.cfdPrices?.us30?.price || 0)
          : (data?.cfdPrices?.xauusd?.price || 0);
        const { setup, promoted } = evaluateRetest(rawSetup, cfdPriceForRetest, sessionThreshold);
        if (promoted) {
          console.log(`[RETEST] ✅ ${setup.cfd} ${setup.direction} promovido a ENTRADA por retest`);
        }

        if (
          isWeekday &&
          setup.entryMode === "ENTRADA" &&   // only log confirmed entries, not VIGILANCIA
          (setup.cfdEntryPrice || 0) > 0
        ) {
          const newRecord = logSetupIfNew(setup, sessionDate);

          // ── Auto-ejecución PPO-gated en MT5 ──────────────────────
          if (newRecord && atCfg.enabled) {
            const allRecords = loadHistory();

            // ── Kill switch: check live WR ─────────────────────────────
            const ks = checkKillSwitch(allRecords);
            if (ks.triggered) {
              console.warn(`[AUTO-MT5] 🔴 Kill switch activo — live WR=${ks.liveWR}% — ${newRecord.cfd} no ejecutado`);
            } else if (atCfg.disabledCFDs?.includes(newRecord.cfd)) {
              console.log(`[AUTO-MT5] ${newRecord.cfd} deshabilitado en config — skip`);
            } else {
              // ── Daily limits ───────────────────────────────────────────
              const todayCount  = countTodayAutoTrades(allRecords);
              const openCount   = countOpenMT5Positions(allRecords);

              if (todayCount >= atCfg.maxDailyTrades) {
                console.log(`[AUTO-MT5] Límite diario alcanzado (${todayCount}/${atCfg.maxDailyTrades}) — ${newRecord.cfd} skip`);
              } else if (openCount >= atCfg.maxConcurrentPositions) {
                console.log(`[AUTO-MT5] Máx posiciones abiertas (${openCount}/${atCfg.maxConcurrentPositions}) — ${newRecord.cfd} skip`);
              } else {
                // ── PPO confidence gate ────────────────────────────────
                const ap = setup.adaptivePolicy as any;
                const ppoConf    = ap?.confidence ?? 0;
                const ppoRisk    = ap?.riskProfile ?? "normal";

                if (ppoConf < atCfg.confidenceThreshold) {
                  console.log(`[AUTO-MT5] ${newRecord.cfd}: PPO conf=${ppoConf.toFixed(1)}% < ${atCfg.confidenceThreshold}% threshold — skip`);
                } else {
                  // ── Execute ────────────────────────────────────────────
                  const sizingMap: Record<string, number> = { small: 0.5, medium: 1.0, full: 1.5 };
                  const sizingKey = ap?.sizing ?? "medium";
                  const sizeMultiplier = sizingMap[sizingKey] ?? 1.0;
                  const baseVol = defaultVolume[newRecord.cfd] ?? 0.01;
                  let volume = Math.round(baseVol * sizeMultiplier * 100) / 100;
                  if (volume < 0.01) volume = 0.01;

                  console.log(`[AUTO-MT5] ✅ ${newRecord.cfd} ${newRecord.direction} | conf=${ppoConf.toFixed(1)}% risk=${ppoRisk} sizing=${sizingKey} vol=${volume} (trade ${todayCount+1}/${atCfg.maxDailyTrades} hoy)`);

                  const mt5Status = getMT5Status();
                  if (mt5Status.connected) {
                    mt5PlaceOrder({
                      cfd:       newRecord.cfd,
                      direction: newRecord.direction,
                      volume,
                      sl:        newRecord.stopLoss,
                      tp1:       newRecord.takeProfit1,
                      tp2:       newRecord.takeProfit2,
                      tp3:       newRecord.takeProfit3,
                    }).then(result => {
                      if (result.success && result.ticket) {
                        const records2 = loadHistory();
                        const idx = records2.findIndex(r => r.id === newRecord.id);
                        if (idx >= 0) {
                          records2[idx] = {
                            ...records2[idx],
                            mt5Ticket:        result.ticket,
                            mt5Volume:        result.volume ?? volume,
                            mt5ExecutedAt:    new Date().toISOString(),
                            mt5ExecutedPrice: result.price,
                          };
                          saveHistory(records2);
                          console.log(`[AUTO-MT5] 🎯 ${newRecord.cfd} ${newRecord.direction} → Ticket #${result.ticket} @ ${result.price}`);
                        }
                      } else {
                        console.warn(`[AUTO-MT5] ❌ ${newRecord.cfd} ${newRecord.direction} — ${result.error}`);
                      }
                    }).catch(e => console.warn("[AUTO-MT5] Error:", e.message));
                  } else {
                    console.warn(`[AUTO-MT5] EA no conectado — ${newRecord.cfd} guardado sin ejecutar`);
                  }
                }
              }
            }
          }
        }
      }
      // Auto-resolve always runs to catch TP/SL hits regardless of hour
      autoResolveOpen(cfdPriceMap);

      // FIX 6: Protect open trades before macro events
      const macroAlertForProtect = getMacroAlert();
      protectBeforeMacro(cfdPriceMap, macroAlertForProtect);

      // FIX 12 desactivado: usuario prefiere no cerrar al final del día
    } catch (e: any) { console.warn("[HISTORY]", e.message); }

    // Persist to DB asynchronously
    persistMarketData(data).catch(console.error);

    return data;
  } finally {
    isFetching = false;
  }
}

async function persistMarketData(data: Awaited<ReturnType<typeof fetchAllMarketData>>) {
  const sessionDate = getSessionDate();

  for (const asset of data.assets) {
    if (asset.currentPrice === 0) continue;

    // Save snapshot
    await saveMarketSnapshot({
      symbol: asset.symbol,
      currentPrice: asset.currentPrice,
      previousClose: asset.previousClose,
      dailyChange: asset.dailyChange,
      dailyChangePct: asset.dailyChangePct,
      callGamma: asset.callGamma,
      putGamma: asset.putGamma,
      totalGamma: asset.callGamma + Math.abs(asset.putGamma),
      highVolPoint: asset.highVolPoint,
      lowVolPoint: asset.lowVolPoint,
      callVolume: asset.callVolume,
      putVolume: asset.putVolume,
      putCallRatio: asset.putCallRatio,
      ivRank: asset.ivRank,
      impliedMove: asset.impliedMove,
      oneMonthIV: asset.oneMonthIV,
      oneMonthRV: asset.oneMonthRV,
      topGammaExp: asset.topGammaExp,
      rawData: asset.chartData,
      sessionDate,
    });

    // Save key strikes
    if (asset.topStrikes.length > 0) {
      const snapshotRows = await import("./db").then((m) => m.getLatestSnapshots(sessionDate));
      const snap = snapshotRows.find((r) => r.symbol === asset.symbol);
      if (snap) {
        await saveKeyStrikes(
          asset.topStrikes.map((s, i) => ({
            snapshotId: snap.id,
            symbol: asset.symbol,
            strike: s.strike,
            callGamma: s.callGamma,
            putGamma: s.putGamma,
            totalGamma: s.totalGamma,
            gammaNotional: s.gammaNotional,
            distanceFromPrice:
              asset.currentPrice > 0 ? ((s.strike - asset.currentPrice) / asset.currentPrice) * 100 : 0,
            rank: i + 1,
            levelType: s.levelType,
            sessionDate,
          }))
        );
      }
    }

    // Check if price is near a strike zone and generate alert
    if (asset.currentPrice > 0 && asset.topStrikes.length > 0) {
      for (const strike of asset.topStrikes) {
        const distancePct = Math.abs((asset.currentPrice - strike.strike) / asset.currentPrice) * 100;
        const prevPrice = previousPrices[asset.symbol] || 0;

        if (distancePct < 0.3 && prevPrice !== asset.currentPrice) {
          // Price is within 0.3% of a key strike
          await saveAlert({
            symbol: asset.symbol,
            alertType: "price_at_strike",
            strikeLevel: strike.strike,
            currentPrice: asset.currentPrice,
            severity: distancePct < 0.1 ? "critical" : "warning",
            title: `${asset.symbol} en zona clave: ${strike.strike}`,
            message: `El precio de ${asset.symbol} (${asset.currentPrice.toFixed(2)}) está a ${distancePct.toFixed(2)}% del strike ${strike.strike} (${strike.levelType || "Gamma Key"}). Revisar GEX del SPX para confirmar dirección.`,
            sessionDate,
          });
        }
      }
      previousPrices[asset.symbol] = asset.currentPrice;
    }
  }

  // Save GEX data
  if (data.gex) {
    await saveGexData({
      gexValue: data.gex.gexValue,
      gexTrend: data.gex.gexTrend,
      dealerIntent: data.gex.dealerIntent,
      keyLevel: data.gex.keyLevel,
      rawData: { rawText: data.gex.rawText },
      sessionDate,
    });
  }
}

async function generateMarketNarration(data: Awaited<ReturnType<typeof fetchAllMarketData>>): Promise<string> {
  try {
    const spx = data.assets.find((a) => a.symbol === "SPX");
    const spy = data.assets.find((a) => a.symbol === "SPY");
    const qqq = data.assets.find((a) => a.symbol === "QQQ");
    const gld = data.assets.find((a) => a.symbol === "GLD");
    const vix = data.assets.find((a) => a.symbol === "VIX");
    const dia = data.assets.find((a) => a.symbol === "DIA");
    const gex = data.gex;
    const hiro = data.hiro;
    const tape = data.tape;
    const signals = data.entrySignals || [];

    // Format tape summary
    const tapeSummary = tape
      ? `Tape: Flujo dominante ${tape.dominantFlow.toUpperCase()} | Premium alcista: ${(tape.bullishPremium / 1e3).toFixed(0)}K | Premium bajista: ${(tape.bearishPremium / 1e3).toFixed(0)}K | Últimas transacciones: ${tape.recentFlows.slice(0, 3).map(f => `${f.symbol} ${f.callPut} ${f.strike} (${f.signal})`).join(', ')}`
      : 'Tape: Sin datos disponibles';

    // Format entry signals
    const signalsSummary = signals.length > 0
      ? signals.filter(s => s.signal !== 'ESPERA').map(s => `${s.asset}: ${s.signal} (${s.confidence}) en zona ${s.strikeZone}`).join(' | ')
      : 'Sin señales activas en zonas clave';

    // v2 Trade setups
    const tradeSetups = data.tradeSetups || [];
    const activeSetups = tradeSetups.filter(t => t.direction !== 'NO_TRADE' && t.score >= 40);
    const setupsSummary = activeSetups.length > 0
      ? activeSetups.map(t => `${t.asset}→${t.cfd}: ${t.direction} (Score ${t.score}/100) | SL: $${t.stopLoss.toFixed(2)} | TP1: $${t.takeProfit1.toFixed(2)} | TP2: $${t.takeProfit2.toFixed(2)} | R:R ${t.riskRewardRatio}:1${t.vannaSignal.detected ? ' | VANNA: ' + t.vannaSignal.type : ''}`).join('\n')
      : 'Sin setups activos';

    const context = `
Datos actuales del mercado (${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })} hora Colombia):

ACTIVOS:
- SPX: $${spx?.currentPrice || "N/A"} (${spx?.dailyChangePct?.toFixed(2) || "N/A"}%) | Call Gamma: ${spx?.callGamma ? (spx.callGamma/1e9).toFixed(1)+'B' : 'N/A'} | Put Gamma: ${spx?.putGamma ? (spx.putGamma/1e9).toFixed(1)+'B' : 'N/A'} | High Vol: $${spx?.highVolPoint || 'N/A'} | Low Vol: $${spx?.lowVolPoint || 'N/A'}
- SPY: $${spy?.currentPrice || "N/A"} (${spy?.dailyChangePct?.toFixed(2) || "N/A"}%)
- QQQ: $${qqq?.currentPrice || "N/A"} (${qqq?.dailyChangePct?.toFixed(2) || "N/A"}%)
- GLD: $${gld?.currentPrice || "N/A"} (${gld?.dailyChangePct?.toFixed(2) || "N/A"}%)
- VIX: ${vix?.currentPrice || "N/A"} (${vix?.dailyChangePct?.toFixed(2) || "N/A"}%) - ${(vix?.currentPrice || 0) > 30 ? 'MIEDO EXTREMO' : (vix?.currentPrice || 0) > 20 ? 'VOLATILIDAD ELEVADA' : 'VOLATILIDAD NORMAL'}
- DIA: $${dia?.currentPrice || "N/A"} (${dia?.dailyChangePct?.toFixed(2) || "N/A"}%)

GEX DEL SPX (Trace): ${gex?.gexTrend?.toUpperCase() || "N/A"} | ${gex?.dealerIntent || 'Sin datos'}

HIRO: ${hiro?.hiroTrend?.toUpperCase() || "N/A"} (${hiro?.hiroValue ? (hiro.hiroValue/1e9).toFixed(2)+'B' : 'N/A'}) | ${hiro?.description || 'Sin datos'}

${tapeSummary}

STRIKES CLAVE DEL SPX (por mayor gamma):
${spx?.topStrikes?.map((s) => `- Strike $${s.strike.toLocaleString()} (${s.levelType}): Gamma Total ${(s.totalGamma/1e9).toFixed(2)}B | Call Gamma ${(s.callGamma/1e9).toFixed(2)}B | Put Gamma ${(Math.abs(s.putGamma)/1e9).toFixed(2)}B`).join("\n") || "No disponible"}

SEÑALES DE ENTRADA ACTIVAS: ${signalsSummary}

TRADE SETUPS (Motor v2):
${setupsSummary}

Estado del mercado: ${data.marketStatus}
`;

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `Eres un analista experto en opciones, gamma exposure y flujo institucional. Trabajas para un trader intradía que opera CFDs (compra si sube, vende si baja) en SPX, SPY, QQQ, GLD, VIX y DIA.

Su estrategia usa el sistema de trading v2 basado en estructura de opciones:
1. Los niveles de gamma son ZONAS DE DECISION (no soporte/resistencia). El bot evalúa si es zona de compra o venta.
2. GEX solo aplica para SPX, SPY, QQQ, DIA. Para GLD se usa UVIX.
3. Confirmaciones: GEX (dealers) + HIRO (institucional) + Tape (flujo real) + Volatilidad (VIX/UVIX)
4. Vanna trades: si la volatilidad cae y el precio sube, dealers compran futuros → movimiento tendencial.
5. Niveles: menor (pausa), reacción (retroceso), dominante (reversión).
6. CFD mapping: SPX/SPY/QQQ→NAS100, DIA→US30, GLD→XAUUSD.
7. Score 0-100: GEX + Top Strike + HIRO + Tape + Volatilidad.

Narra en 3-4 oraciones concisas y accionables. Incluye:
- El trade setup con mejor score y su CFD equivalente
- Si hay Vanna flow activo
- SL/TP sugeridos y R:R
- Qué confirma o falta para ejecutar
Usa español. Sé directo y específico con precios.`,
        },
        {
          role: "user",
          content: `Narra el mercado ahora mismo:\n${context}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    return typeof content === 'string' ? content : "Datos de mercado actualizándose...";
  } catch (err) {
    console.error("[Narration] Error generating narration:", err);
    return "Analizando condiciones del mercado...";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Price Memory — tracks intraday price history for agent context
// ══════════════════════════════════════════════════════════════════════════════
interface PriceTick { ts: number; price: number; }
const _priceMemory: Record<string, PriceTick[]> = {};
const _sessionHighLow: Record<string, { high: number; low: number; open: number; date: string }> = {};

function recordPrice(cfd: string, price: number) {
  if (!price || price <= 0) return;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Init or reset on new day
  if (!_priceMemory[cfd]) _priceMemory[cfd] = [];
  if (!_sessionHighLow[cfd] || _sessionHighLow[cfd].date !== today) {
    _sessionHighLow[cfd] = { high: price, low: price, open: price, date: today };
  }

  // Update high/low
  if (price > _sessionHighLow[cfd].high) _sessionHighLow[cfd].high = price;
  if (price < _sessionHighLow[cfd].low) _sessionHighLow[cfd].low = price;

  // Only record if price changed or >30s since last tick
  const ticks = _priceMemory[cfd];
  const last = ticks[ticks.length - 1];
  if (last && Math.abs(price - last.price) < 0.01 && now - last.ts < 30000) return;

  ticks.push({ ts: now, price });

  // Keep last 120 ticks (~2 hours at 1/min)
  while (ticks.length > 120) ticks.shift();
}

function getPriceContext(cfd: string, currentPrice: number): {
  current: number;
  ago1m: number | null;
  ago5m: number | null;
  ago15m: number | null;
  ago30m: number | null;
  ago1h: number | null;
  sessionHigh: number;
  sessionLow: number;
  sessionOpen: number;
  sessionRange: number;
  priceInRange: number; // 0 = at low, 100 = at high
  momentum5m: number;   // % change last 5 min
  momentum15m: number;
  momentum1h: number;
  recentTrend: string;  // "rising", "falling", "flat"
  ticks: number;
} {
  const ticks = _priceMemory[cfd] || [];
  const hl = _sessionHighLow[cfd] || { high: currentPrice, low: currentPrice, open: currentPrice, date: '' };
  const now = Date.now();

  function priceAt(msAgo: number): number | null {
    const target = now - msAgo;
    // Find closest tick to target time
    let closest: PriceTick | null = null;
    let minDist = Infinity;
    for (const t of ticks) {
      const dist = Math.abs(t.ts - target);
      if (dist < minDist && dist < msAgo * 0.5) { // within 50% tolerance
        minDist = dist;
        closest = t;
      }
    }
    return closest?.price ?? null;
  }

  const ago1m = priceAt(60_000);
  const ago5m = priceAt(300_000);
  const ago15m = priceAt(900_000);
  const ago30m = priceAt(1_800_000);
  const ago1h = priceAt(3_600_000);

  const range = hl.high - hl.low;
  const priceInRange = range > 0 ? Math.round((currentPrice - hl.low) / range * 100) : 50;

  const momentum5m = ago5m ? Math.round((currentPrice - ago5m) / ago5m * 10000) / 100 : 0;
  const momentum15m = ago15m ? Math.round((currentPrice - ago15m) / ago15m * 10000) / 100 : 0;
  const momentum1h = ago1h ? Math.round((currentPrice - ago1h) / ago1h * 10000) / 100 : 0;

  // Trend: check last 5 ticks
  let recentTrend = "flat";
  if (ticks.length >= 3) {
    const recent = ticks.slice(-5);
    const first = recent[0].price;
    const last = recent[recent.length - 1].price;
    const changePct = (last - first) / first * 100;
    if (changePct > 0.03) recentTrend = "rising";
    else if (changePct < -0.03) recentTrend = "falling";
  }

  return {
    current: currentPrice,
    ago1m, ago5m, ago15m, ago30m, ago1h,
    sessionHigh: hl.high, sessionLow: hl.low, sessionOpen: hl.open,
    sessionRange: Math.round(range * 100) / 100,
    priceInRange,
    momentum5m, momentum15m, momentum1h,
    recentTrend,
    ticks: ticks.length,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Improvement 5: Detect real market session by price movement
// ══════════════════════════════════════════════════════════════════════════════
function isMarketLiveByPriceMovement(): boolean {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  for (const cfd of Object.keys(_priceMemory)) {
    const ticks = _priceMemory[cfd];
    if (!ticks || ticks.length < 2) continue;
    // Get ticks from the last 5 minutes
    const recentTicks = ticks.filter(t => t.ts >= fiveMinAgo);
    if (recentTicks.length < 2) continue;
    const first = recentTicks[0].price;
    const last = recentTicks[recentTicks.length - 1].price;
    const delta = Math.abs(last - first);
    if (delta > 1) return true; // >1 point movement = market is live
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Improvement 7: 15-min OHLC candles from price memory + pattern detection
// ══════════════════════════════════════════════════════════════════════════════
interface Candle15m {
  open: number; high: number; low: number; close: number;
  ts: number; // bucket start timestamp
  pattern: string;
}

function get15MinCandles(cfd: string): { candles: Candle15m[]; currentPattern: string } {
  const ticks = _priceMemory[cfd] || [];
  if (ticks.length < 2) return { candles: [], currentPattern: "insufficient_data" };

  // Group ticks into 15-min buckets
  const BUCKET_MS = 15 * 60 * 1000;
  const buckets: Record<number, PriceTick[]> = {};
  for (const t of ticks) {
    const bucket = Math.floor(t.ts / BUCKET_MS) * BUCKET_MS;
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(t);
  }

  // Build OHLC candles
  const sortedKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const candles: Candle15m[] = [];
  for (const key of sortedKeys) {
    const bTicks = buckets[key];
    if (bTicks.length === 0) continue;
    const o = bTicks[0].price;
    const c = bTicks[bTicks.length - 1].price;
    let h = -Infinity, l = Infinity;
    for (const t of bTicks) {
      if (t.price > h) h = t.price;
      if (t.price < l) l = t.price;
    }
    candles.push({ open: o, high: h, low: l, close: c, ts: key, pattern: "" });
  }

  // Detect patterns on each candle (need at least the candle itself)
  for (let i = 0; i < candles.length; i++) {
    candles[i].pattern = detectCandlePattern(candles, i);
  }

  const currentPattern = candles.length > 0 ? candles[candles.length - 1].pattern : "no_data";
  return { candles: candles.slice(-6), currentPattern }; // last 6 candles (~1.5h)
}

function detectCandlePattern(candles: Candle15m[], idx: number): string {
  const c = candles[idx];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return "doji";

  const bodyRatio = body / range;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isBullish = c.close > c.open;

  // Doji: body < 10% of range
  if (bodyRatio < 0.1) return "doji";

  // Hammer: small body at top, long lower wick (>= 2x body)
  if (lowerWick >= body * 2 && upperWick < body * 0.5 && bodyRatio < 0.4) {
    return "hammer"; // bullish reversal
  }

  // Shooting Star: small body at bottom, long upper wick (>= 2x body)
  if (upperWick >= body * 2 && lowerWick < body * 0.5 && bodyRatio < 0.4) {
    return "shooting_star"; // bearish reversal
  }

  // Engulfing: current body > previous body, opposite direction
  if (idx > 0) {
    const prev = candles[idx - 1];
    const prevBody = Math.abs(prev.close - prev.open);
    const prevBullish = prev.close > prev.open;
    if (body > prevBody && isBullish !== prevBullish && prevBody > 0) {
      return isBullish ? "bullish_engulfing" : "bearish_engulfing";
    }
  }

  // Default directional
  return isBullish ? "bullish" : "bearish";
}

export const appRouter = router({
  system: systemRouter,
  hiroDebug: hiroDebugRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  market: router({
    // Obtener todos los datos del mercado en tiempo real
    getData: publicProcedure.query(async () => {
      const data = await getMarketDataCached();
      return data;
    }),

    // Obtener datos de un activo específico
    getAsset: publicProcedure
      .input(z.object({ symbol: z.string() }))
      .query(async ({ input }) => {
        const data = await getMarketDataCached();
        return data?.assets.find((a) => a.symbol === input.symbol) || null;
      }),

    // Obtener los 3 strikes más relevantes de un activo
    getTopStrikes: publicProcedure
      .input(z.object({ symbol: z.string() }))
      .query(async ({ input }) => {
        const data = await getMarketDataCached();
        const asset = data?.assets.find((a) => a.symbol === input.symbol);
        return asset?.topStrikes || [];
      }),

    // Obtener datos del GEX del SPX
    getGex: publicProcedure.query(async () => {
      const data = await getMarketDataCached();
      return data?.gex || null;
    }),

    // Obtener datos de HIRO
    getHiro: publicProcedure.query(async () => {
      const data = await getMarketDataCached();
      return data?.hiro || null;
    }),

    // Obtener estado del mercado
    getStatus: publicProcedure.query(() => {
      const status = getMarketStatus();
      const colombiaTime = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
      // Improvement 5: detect real session by price movement
      const marketLive = isMarketLiveByPriceMovement();
      const effectiveStatus = (!status.isOpen && marketLive)
        ? { status: "open" as const, isOpen: true }
        : status;
      return {
        ...effectiveStatus,
        marketLive, // true if prices moved >1pt in last 5 min (independent of timezone schedule)
        scheduledStatus: status.status, // original timezone-based status for reference
        colombiaTime,
        sessionDate: getSessionDate(),
        lastFetchTime: lastFetchTime > 0 ? new Date(lastFetchTime).toISOString() : null,
        nextFetchIn: lastFetchTime > 0 ? Math.max(0, 30 - Math.floor((Date.now() - lastFetchTime) / 1000)) : 0,
      };
    }),

    // Forzar actualización de datos
    forceRefresh: publicProcedure.mutation(async () => {
      lastFetchTime = 0;
      const data = await getMarketDataCached();
      return { success: true, fetchedAt: data?.fetchedAt };
    }),

    // Obtener datos de TRACE 0DTE GEX (polling rápido)
    getTraceData: publicProcedure.query(async () => {
      const cached = lastMarketData;
      if (cached?.traceData) return cached.traceData;
      return await fetchTraceDataOnly();
    }),

    // GEX Change Tracker with delta vs previous reading
    getGexTracker: publicProcedure.query(async () => {
      const data = await getMarketDataCached();
      return data?.gexChangeTracker || null;
    }),

    // GEX History (last 50 readings)
    getGexHistory: publicProcedure.query(() => {
      return getGexHistory();
    }),

    // Fast live prices — only TradingView scanner, 5-second cache
    getLivePrices: publicProcedure.query(async () => {
      return await fetchCFDPricesFromTradingView();
    }),

    // Fast SpotGamma asset prices — calls /v3/equitiesBySyms for upx, 5-second cache
    getLiveSpotGammaPrices: publicProcedure.query(async () => {
      return await fetchSpotGammaLivePrices();
    }),

    // Multi-timeframe view — 4h of HIRO/GEX/tape snapshots
    getMultiTimeframe: publicProcedure.query(() => {
      return getMultiTimeframeView();
    }),

    // Fast executor state — pending orders + managed positions + status
    getExecutorState: publicProcedure.query(() => {
      const ORDERS_FILE = path.resolve(process.cwd(), "data/agent-orders.json");
      let fileState = { pendingOrders: [] as any[], managedPositions: [] as any[], lastPriceCheck: "" };
      try {
        if (fs.existsSync(ORDERS_FILE)) {
          fileState = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
        }
      } catch {}
      const status = getExecutorStatus();
      return {
        running: status.running,
        prices: status.prices,
        lastCheck: status.lastCheck,
        pendingOrders: fileState.pendingOrders,
        managedPositions: fileState.managedPositions,
      };
    }),

    // Live P&L for open positions (lightweight — no full market data)
    getLivePnL: publicProcedure.query(() => {
      const { getCachedData } = require("./spotgamma-scraper");
      const md = getCachedData();
      const cfd = md?.cfdPrices || {};
      const cfdPrices: Record<string, number> = {};
      for (const [k, v] of Object.entries(cfd)) {
        if (v && typeof v === "object" && "price" in (v as any)) {
          cfdPrices[k] = (v as any).price;
        }
      }

      const allRecords = loadHistory();
      const openPositions = allRecords
        .filter((r: any) => r.outcome === "open" && r.mt5Ticket)
        .map((r: any) => {
          const cfdKey = r.cfd === "NAS100" ? "nas100" : r.cfd === "US30" ? "us30" : "xauusd";
          const currentPrice = cfdPrices[cfdKey] || 0;
          const isLong = r.direction === "LONG";
          const pnlPoints = isLong ? currentPrice - (r.mt5ExecutedPrice || 0) : (r.mt5ExecutedPrice || 0) - currentPrice;
          const pnlPct = r.mt5ExecutedPrice > 0 ? pnlPoints / r.mt5ExecutedPrice * 100 : 0;
          return {
            id: r.id,
            ticket: r.mt5Ticket,
            cfd: r.cfd,
            direction: r.direction,
            entryPrice: r.mt5ExecutedPrice,
            currentPrice,
            sl: r.stopLoss,
            tp1: r.takeProfit1,
            volume: r.mt5Volume,
            pnlPoints: Math.round(pnlPoints * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
            openedAt: r.mt5ExecutedAt,
          };
        });

      return { positions: openPositions, count: openPositions.length };
    }),

    // Real-time trade exit alerts (TP/SL/invalidation) — poll every 3s
    getTradeAlerts: publicProcedure.query(() => {
      return {
        alerts: tradeAlertQueue,
        unreadCount: tradeAlertQueue.filter(a => !a.read).length,
        lastChecked: new Date().toISOString(),
      };
    }),

    // Mark all trade alerts as read
    markTradeAlertsRead: publicProcedure.mutation(() => {
      tradeAlertQueue.forEach(a => { a.read = true; });
      return { success: true };
    }),

    // Tradier GEX for GLD / DIA
    getTradierGex: publicProcedure.query(async () => {
      const data = await getMarketDataCached();
      return data?.tradierGex || {};
    }),

    // ── Trade History / Backtesting ──────────────────────────────
    getTradeHistory: publicProcedure.query(() => {
      const records = loadHistory();
      return { records, stats: getStats(records) };
    }),

    resolveTradeManually: publicProcedure
      .input(z.object({
        id: z.string(),
        outcome: z.enum(["open","tp1","tp2","tp3","sl","cancelled"]),
        exitPrice: z.number().optional(),
      }))
      .mutation(({ input }) => {
        return resolveRecord(input.id, input.outcome, input.exitPrice);
      }),

    deleteTradeRecord: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        return deleteRecord(input.id);
      }),

    // ── Historical Data & Backtesting ──────────────────────────────
    exploreTapeFilters: publicProcedure
      .input(z.object({ date: z.string() }))
      .query(async ({ input }) => {
        const { exploreTapeFilters } = await import("./historical-fetcher");
        return await exploreTapeFilters(input.date);
      }),

    fetchHistoricalDay: publicProcedure
      .input(z.object({ date: z.string() }))
      .mutation(async ({ input }) => {
        const { fetchHistoricalDay } = await import("./historical-fetcher");
        return await fetchHistoricalDay(input.date);
      }),

    fetchHistoricalRange: publicProcedure
      .input(z.object({ startDate: z.string(), endDate: z.string() }))
      .mutation(async ({ input }) => {
        const { fetchHistoricalRange } = await import("./historical-fetcher");
        await fetchHistoricalRange(input.startDate, input.endDate);
        return { success: true };
      }),

    downloadGammaBars: publicProcedure
      .input(z.object({ startDate: z.string(), endDate: z.string() }))
      .mutation(async ({ input }) => {
        const { downloadGammaBarsRange } = await import("./historical-gamma-bars");
        const logs: string[] = [];
        const result = await downloadGammaBarsRange(input.startDate, input.endDate, undefined, (msg) => logs.push(msg));
        return { ...result, logs };
      }),

    getGammaBarsHistory: publicProcedure
      .input(z.object({ date: z.string(), symbol: z.string().optional() }))
      .query(({ input }) => {
        const { loadDayBars, loadGammaBars } = require("./historical-gamma-bars");
        if (input.symbol) return loadGammaBars(input.date, input.symbol);
        return loadDayBars(input.date);
      }),

    exportMT5History: publicProcedure.mutation(async () => {
      const { exportHistory, readExportedHistory } = await import("./mt5-file-bridge");
      const result = await exportHistory();
      if (result.success) {
        // Wait a bit for files to be written, then read them
        await new Promise(r => setTimeout(r, 2000));
        const data = readExportedHistory();
        const summary = Object.entries(data).map(([k, v]) => `${k}: ${(v as any[]).length} bars`);
        return { success: true, files: summary, data };
      }
      return { success: false, error: result.error };
    }),

    getMT5HistoryData: publicProcedure.query(() => {
      const { readExportedHistory } = require("./mt5-file-bridge");
      return readExportedHistory();
    }),

    getGammaBarsSummary: publicProcedure.query(() => {
      const { getBarsSummary } = require("./historical-gamma-bars");
      return getBarsSummary();
    }),

    downloadEquities: publicProcedure
      .input(z.object({ startDate: z.string(), endDate: z.string() }))
      .mutation(async ({ input }) => {
        const { downloadEquitiesRange } = await import("./historical-gamma-bars");
        const logs: string[] = [];
        const result = await downloadEquitiesRange(input.startDate, input.endDate, (msg) => logs.push(msg));
        return { ...result, logs };
      }),

    getHistoricalData: publicProcedure.query(() => {
      const { loadHistoricalData } = require("./historical-fetcher");
      return loadHistoricalData();
    }),

    runBacktest: publicProcedure
      .input(z.object({
        minScore: z.number().optional(),
        cfd: z.string().optional(),
      }))
      .query(({ input }) => {
        const { runBacktest } = require("./historical-fetcher");
        return runBacktest(input);
      }),

    // ── RL Agent ─────────────────────────────────────────────────
    getRLStats: publicProcedure.query(() => {
      return getRLStats();
    }),

    getOnlineLearningStats: publicProcedure.query(async () => {
      const { getBufferStats } = await import("./online-learning");
      return getBufferStats();
    }),

    forceReplayRetrain: publicProcedure.mutation(async () => {
      const { forceReplayRetrain } = await import("./online-learning");
      return forceReplayRetrain();
    }),

    // ── Auto-Trading Config ───────────────────────────────────────
    getAutoTradingConfig: publicProcedure.query(() => {
      const records = loadHistory();
      return getAutoTradingStats(records);
    }),

    setAutoTradingConfig: publicProcedure
      .input(z.object({
        enabled:               z.boolean().optional(),
        confidenceThreshold:   z.number().min(0).max(100).optional(),
        maxDailyTrades:        z.number().min(1).max(20).optional(),
        maxConcurrentPositions: z.number().min(1).max(5).optional(),
        killSwitchEnabled:     z.boolean().optional(),
        killSwitchLookback:    z.number().min(3).max(50).optional(),
        killSwitchMinWR:       z.number().min(0).max(100).optional(),
        resetKillSwitch:       z.boolean().optional(),
        volumes:               z.record(z.string(), z.number()).optional(),
        disabledCFDs:          z.array(z.string()).optional(),
      }))
      .mutation(({ input }) => {
        const cfg = loadAutoConfig();
        const updated = {
          ...cfg,
          ...(input.enabled               !== undefined ? { enabled: input.enabled } : {}),
          ...(input.confidenceThreshold   !== undefined ? { confidenceThreshold: input.confidenceThreshold } : {}),
          ...(input.maxDailyTrades        !== undefined ? { maxDailyTrades: input.maxDailyTrades } : {}),
          ...(input.maxConcurrentPositions !== undefined ? { maxConcurrentPositions: input.maxConcurrentPositions } : {}),
          ...(input.killSwitchEnabled     !== undefined ? { killSwitchEnabled: input.killSwitchEnabled } : {}),
          ...(input.killSwitchLookback    !== undefined ? { killSwitchLookback: input.killSwitchLookback } : {}),
          ...(input.killSwitchMinWR       !== undefined ? { killSwitchMinWR: input.killSwitchMinWR } : {}),
          ...(input.volumes               !== undefined ? { volumes: input.volumes } : {}),
          ...(input.disabledCFDs          !== undefined ? { disabledCFDs: input.disabledCFDs } : {}),
          ...(input.resetKillSwitch ? { killSwitchTriggered: false, killSwitchTriggeredAt: null } : {}),
        };
        saveAutoConfig(updated);
        const records = loadHistory();
        return getAutoTradingStats(records);
      }),

    // ── ML/PPO/LSTM Combined Stats ────────────────────────────────
    getMLStats: publicProcedure.query(async () => {
      const { getBufferStats } = await import("./online-learning");
      const { getEpisodeBank } = await import("./episode-bank.js");
      const { isLSTMAvailable } = await import("./ppo-inference-lstm.js");
      const { isModelLoaded } = await import("./ppo-inference");
      const fs = await import("fs");
      const path = await import("path");

      const bufferStats   = getBufferStats();
      const bankStats     = getEpisodeBank().getStats();
      const lstmAvailable = isLSTMAvailable();
      const mlpAvailable  = isModelLoaded();
      const records       = loadHistory();
      const atStats       = getAutoTradingStats(records);

      // Rolling live win rates (MT5-executed trades only)
      const liveResolved  = records.filter((r: any) =>
        r.mt5Ticket &&
        r.outcome && r.outcome !== "open" && r.outcome !== "cancelled" && r.outcome !== "pending"
      );
      const calcWR = (arr: any[]) => arr.length === 0 ? null
        : Math.round(arr.filter((r: any) => ["tp1","tp2","tp3"].includes(r.outcome)).length / arr.length * 100);

      // Check for nightly retrain history
      const retrainLogPath = path.resolve(process.cwd(), "data/retrain-history.json");
      let lastRetrain: any = null;
      try {
        if (fs.existsSync(retrainLogPath)) {
          const rh = JSON.parse(fs.readFileSync(retrainLogPath, "utf8"));
          lastRetrain = rh.runs?.filter((r: any) => !r.skipped)?.slice(-1)?.[0] ?? null;
        }
      } catch {}

      return {
        models: {
          mlp:  { available: mlpAvailable,  type: "MLP Multi-Head",  params: "47K" },
          lstm: { available: lstmAvailable, type: "LSTM Dual-Input", params: "238K" },
          active: lstmAvailable ? "LSTM + MLP" : mlpAvailable ? "MLP" : "none",
        },
        onlineLearning: bufferStats,
        episodeBank: bankStats,
        liveStats: {
          total: liveResolved.length,
          wr10:  calcWR(liveResolved.slice(-10)),
          wr20:  calcWR(liveResolved.slice(-20)),
          wrAll: calcWR(liveResolved),
        },
        autoTrading: atStats,
        lastRetrain,
        nightlyRetrainSchedule: "0 5 * * 1-5 (5 AM ET, Mon-Fri)",
      };
    }),

    exportTrainingEpisodes: publicProcedure.mutation(async () => {
      // Export episode dataset to JSON for Python GPU training
      const { buildEpisodeDataset } = await import("./historical-simulator");
      const episodes = buildEpisodeDataset({});
      const fs = await import("fs");
      const path = await import("path");
      const outPath = path.resolve(process.cwd(), "data/training-episodes.json");
      fs.writeFileSync(outPath, JSON.stringify(episodes), "utf-8");
      return { episodes: episodes.length, path: outPath };
    }),

    getRLRecommendation: publicProcedure
      .input(z.object({
        score: z.number(),
        tapeFlow: z.string().optional(),
        hiroTrend: z.string().optional(),
        ivRegime: z.string().optional(),
        regime: z.string().optional(),
        etHour: z.number().optional(),
        cfd: z.string(),
      }))
      .query(({ input }) => {
        const state = extractRLState(input, input.etHour);
        return suggestAction(state);
      }),

    replayRLHistory: publicProcedure.mutation(() => {
      return replayTradeHistory();
    }),

    pretrainHistorical: publicProcedure.mutation(() => {
      return pretrainFromHistorical();
    }),

    pretrainFromChartData: publicProcedure.mutation(() => {
      return pretrainFromChartData();
    }),

    getAdaptivePolicyForState: publicProcedure
      .input(z.object({
        score: z.number(),
        tapeFlow: z.string().optional(),
        hiroTrend: z.string().optional(),
        ivRegime: z.string().optional(),
        regime: z.string().optional(),
        etHour: z.number().optional(),
        cfd: z.string(),
      }))
      .query(({ input }) => {
        const state = extractRLState(input, input.etHour);
        return getAdaptivePolicy(state);
      }),

    // ── Historical Data Download ─────────────────────────────────
    getDownloadStatus: publicProcedure.query(() => {
      return getDownloadStatus();
    }),

    // chart_data bulk download (works for any historical date)
    getChartDataStatus: publicProcedure.query(() => {
      return getChartDataStatus();
    }),

    downloadChartDataRange: publicProcedure
      .input(z.object({
        startDate: z.string(),
        endDate: z.string(),
      }))
      .mutation(async ({ input }) => {
        return downloadChartDataRange(input.startDate, input.endDate);
      }),

    // ── Historical Simulation (RL training) ──────────────────────
    getSimulationStatus: publicProcedure.query(() => {
      return {
        simulation: getSimulationStatus(),
        yahooPrices: getYahooPriceStatus(),
      };
    }),

    runHistoricalSimulation: publicProcedure
      .input(z.object({
        passes: z.number().min(1).max(200).default(20),
        useYahoo: z.boolean().default(true),
      }))
      .mutation(async ({ input }) => {
        console.log(`[ROUTER] Historical simulation: ${input.passes} passes, yahoo=${input.useYahoo}`);
        return runHistoricalSimulation(input.passes, input.useYahoo);
      }),

    runPPOTraining: publicProcedure
      .input(z.object({
        passes: z.number().min(1).max(10000).default(50),
      }))
      .mutation(async ({ input }) => {
        console.log(`[ROUTER] PPO training: ${input.passes} passes`);
        return runPPOTraining(input.passes);
      }),

    runMultiHeadPPOTraining: publicProcedure
      .input(z.object({
        passes: z.number().min(1).max(10000).default(50),
      }))
      .mutation(async ({ input }) => {
        console.log(`[ROUTER] Multi-Head PPO training: ${input.passes} passes`);
        return runMultiHeadPPOTraining(input.passes);
      }),

    fetchYahooPrices: publicProcedure.mutation(async () => {
      console.log(`[ROUTER] Fetching Yahoo Finance prices...`);
      const result = await fetchAllCFDPrices();
      const summary: Record<string, number> = {};
      for (const [sym, map] of Object.entries(result)) {
        summary[sym] = Object.keys(map).length;
      }
      return { downloaded: summary };
    }),

    probeSpotGammaHistory: publicProcedure.mutation(async () => {
      const { getToken } = await import("./spotgamma-scraper");
      const token = await getToken();
      if (!token) return { error: "No token", results: [] };
      const results = await probeSpotGammaHistory(token);
      return { results };
    }),

    downloadHistorical: publicProcedure
      .input(z.object({ days: z.number().min(1).max(60).default(10) }))
      .mutation(async ({ input }) => {
        return downloadAllHistorical(input.days);
      }),

    downloadGEXHistory: publicProcedure.mutation(async () => {
      return downloadGEXHistory();
    }),

    downloadTapeDay: publicProcedure
      .input(z.object({ date: z.string() }))
      .mutation(async ({ input }) => {
        return downloadTapeFlow(input.date);
      }),

    downloadTraceDay: publicProcedure
      .input(z.object({ date: z.string() }))
      .mutation(async ({ input }) => {
        return downloadTraceGamma(input.date);
      }),

    downloadGammaDeltaTilt: publicProcedure.mutation(async () => {
      return downloadGammaDeltaTilt();
    }),

    downloadDailyOHLC: publicProcedure.mutation(async () => {
      return downloadDailyOHLC();
    }),

    downloadChartData: publicProcedure
      .input(z.object({ days: z.number().min(1).max(500).default(30) }))
      .mutation(async ({ input }) => {
        return downloadChartData(input.days);
      }),

    // ── Price Memory (tracks intraday price history per CFD) ────────
    // Updated every time getAgentView is called
    _priceMemoryInternal: publicProcedure.query(() => null), // placeholder

    // ── Claude Agent Compact View ──────────────────────────────────
    getAgentView: publicProcedure.query(async () => {
      const { getCachedData } = require("./spotgamma-scraper");
      const md = getCachedData();
      if (!md) return { error: "No market data" };

      const cfd = md.cfdPrices || {};
      const levels = md.officialLevels || {};
      const assets: Record<string, any> = {};
      for (const a of (md.assets || [])) assets[a.symbol] = a;
      const hiro = md.hiro || {};
      const tape = md.tape || {};
      const vanna = md.vannaContext || {};
      const vol = md.volContext || {};
      const gex = md.gex || {};
      const trace = md.traceData || {};
      const tradierGex = md.tradierGex || {};
      const cal = md.economicCalendar || [];

      // CFD prices
      const cfdPrices: Record<string, { price: number; changePct: number }> = {};
      for (const [k, v] of Object.entries(cfd)) {
        if (v && typeof v === 'object' && 'price' in (v as any)) {
          cfdPrices[k] = { price: (v as any).price, changePct: (v as any).changePct || 0 };
        }
      }

      // CFD/options ratios for level conversion
      const spxPrice = assets.SPX?.currentPrice || 0;
      const diaPrice = assets.DIA?.currentPrice || 0;
      const gldPrice = assets.GLD?.currentPrice || 0;
      const nasPrice = cfdPrices.nas100?.price || 0;
      const us30Price = cfdPrices.us30?.price || 0;
      const xauPrice = cfdPrices.xauusd?.price || 0;
      const ratios: Record<string, { ratio: number; optionsSym: string }> = {
        NAS100: { ratio: spxPrice > 0 && nasPrice > 0 ? nasPrice / spxPrice : 3.64, optionsSym: "SPX" },
        US30:   { ratio: diaPrice > 0 && us30Price > 0 ? us30Price / diaPrice : 99.8, optionsSym: "DIA" },
        XAUUSD: { ratio: gldPrice > 0 && xauPrice > 0 ? xauPrice / gldPrice : 10.9, optionsSym: "GLD" },
      };

      // Build per-CFD analysis with CONVERTED levels
      function buildCFDView(cfdName: string, primarySyms: string[], secondarySyms: string[], gammaBarSyms?: string[]) {
        const r = ratios[cfdName];
        if (!r) return null;
        const cfdPrice = cfdPrices[cfdName.toLowerCase()]?.price || 0;
        const cfdChange = cfdPrices[cfdName.toLowerCase()]?.changePct || 0;

        // Levels converted to CFD prices
        const primary = primarySyms[0];
        const l = levels[primary] || {};
        const convert = (v: number) => v > 0 ? Math.round(v * r.ratio * 100) / 100 : 0;

        const convertedLevels = {
          callWall: convert(l.callWall || 0),
          putWall: convert(l.putWall || 0),
          gammaFlip: convert(l.zeroGamma || 0),
          keyGamma: convert(l.keyGamma || 0),
          keyDelta: convert(l.keyDelta || 0),
          maxGamma: convert(l.maxGamma || 0),
          volTrigger: convert(l.volTrigger || 0),
          putControl: convert(l.putControl || 0),
          hedgeWall: convert(l.hedgeWall || 0),
        };

        // Distance from price to each level (in %)
        const distances: Record<string, number> = {};
        for (const [name, level] of Object.entries(convertedLevels)) {
          if (level > 0 && cfdPrice > 0) distances[name] = Math.round((cfdPrice - level) / cfdPrice * 10000) / 100;
        }

        // HIRO per relevant symbol
        const hiroData: Record<string, { percentile: number; value: number }> = {};
        for (const sym of [...primarySyms, ...secondarySyms]) {
          const h = (hiro as any)?.perAsset?.[sym];
          if (h && h.hiroValue) {
            const rm = h.hiroRange30dMin || 0;
            const rx = h.hiroRange30dMax || 0;
            const pct = rx !== rm ? Math.round((h.hiroValue - rm) / (rx - rm) * 100) : 50;
            hiroData[sym] = {
              percentile: pct, value: h.hiroValue,
              trend: h.hiroTrend || "unknown",
              description: h.description || "",
            };
          }
        }

        // Tape per relevant symbol
        const tapeData: Record<string, any> = {};
        for (const sym of [...primarySyms, ...secondarySyms]) {
          const t = (tape as any)?.perAsset?.[sym];
          if (t && t.totalTrades > 0) {
            tapeData[sym] = {
              bullPct: Math.round(t.callCount / Math.max(t.totalTrades, 1) * 100),
              netGamma: t.netGamma || 0,
              netDelta: t.netDelta || 0,
              trades: t.totalTrades,
              sentiment: t.sentiment || "neutral",
              sentimentScore: t.sentimentScore || 0,
              dominantFlow: t.dominantFlow || "mixed",
              callPremium: t.callPremium || 0,
              putPremium: t.putPremium || 0,
              totalPremium: t.totalPremium || 0,
              // Top strike-level flow (where institutions are active)
              strikeFlow: (t.strikeFlow || []).slice(0, 5).map((s: any) => ({
                strike: s.strike, callPrem: s.callPremium || 0, putPrem: s.putPremium || 0,
                direction: s.direction || "?",
              })),
              // Largest individual trades (institutional blocks)
              largestTrades: (t.largestTrades || []).slice(0, 3).map((tr: any) => ({
                premium: tr.premium || 0, type: tr.type || "?", strike: tr.strike || 0,
              })),
            };
          }
        }

        // Tradier GEX with converted levels
        const tgData: Record<string, any> = {};
        for (const sym of primarySyms) {
          const tg = (tradierGex as any)?.[sym];
          if (tg && tg.totalGex) {
            tgData[sym] = {
              totalGex: tg.totalGex,
              bias: tg.netBias,
              gammaFlip_cfd: convert(tg.gammaFlipLevel || 0),
              support: (tg.topSupport || []).slice(0, 3).map((s: any) => ({
                cfdPrice: convert(s.strike), pctFromPrice: s.pctFromPrice,
              })),
              resistance: (tg.topResistance || []).slice(0, 3).map((s: any) => ({
                cfdPrice: convert(s.strike), pctFromPrice: s.pctFromPrice,
              })),
            };
          }
        }

        // Top strikes converted to CFD
        const topStrikes: { cfdPrice: number; gamma: number; oi: number; netPos: number }[] = [];
        for (const sym of primarySyms) {
          const a = assets[sym];
          if (!a) continue;
          for (const s of (a.topStrikes || []).slice(0, 5)) {
            topStrikes.push({
              cfdPrice: convert(s.strike),
              gamma: s.totalGamma || 0,
              oi: s.totalOI || 0,
              netPos: s.netPosTotal || 0,
            });
          }
        }

        // ── GAMMA BARS: All strikes near price sorted by |gamma| (the fat bars from SpotGamma chart) ──
        // Includes primary symbol (SPX) + secondary symbols (QQQ, SPY) for full picture
        const gammaBars: { cfdPrice: number; strike: number; symbol: string; gamma: number; callGamma: number; putGamma: number; oi: number; netPos: number; distPct: number; type: string }[] = [];
        // Use gammaBarSyms if provided (for US30=DIA only, XAUUSD=GLD only), otherwise all symbols
        const allGammaSyms = gammaBarSyms || [primary, ...primarySyms.filter(s => s !== primary), ...secondarySyms];
        for (const gSym of allGammaSyms) {
          const gAsset = assets[gSym];
          if (!gAsset?.strikes || !gAsset.currentPrice || gAsset.currentPrice <= 0) continue;
          // Each symbol has its own conversion ratio to CFD price
          const gRatio = gAsset.currentPrice > 0 ? cfdPrice / gAsset.currentPrice : 0;
          if (gRatio <= 0) continue;
          const nearStrikes = (gAsset.strikes as any[])
            .filter((s: any) => Math.abs(s.distancePct || 100) < 5)
            .sort((a: any, b: any) => Math.abs(b.totalGamma || 0) - Math.abs(a.totalGamma || 0))
            .slice(0, 10); // top 10 per symbol
          for (const s of nearStrikes) {
            gammaBars.push({
              cfdPrice: Math.round(s.strike * gRatio),
              strike: s.strike,
              symbol: gSym,
              gamma: s.totalGamma || 0,
              callGamma: s.callGamma || 0,
              putGamma: s.putGamma || 0,
              oi: s.totalOI || 0,
              netPos: s.netPosTotal || 0,
              distPct: s.distancePct || 0,
              type: (s.totalGamma || 0) > 0 ? "support" : "resistance",
            });
          }
        }
        // Ensure primary symbol always has representation (DIA bars tiny vs SPX, GLD vs SPX)
        // Strategy: reserve min 8 slots for primary, fill rest with all symbols by |gamma|
        const primaryBars = gammaBars.filter(b => b.symbol === primary)
          .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
          .slice(0, 10);
        const otherBars = gammaBars.filter(b => b.symbol !== primary)
          .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
          .slice(0, 10);
        // Combine: all primary bars first, then fill remaining from others
        const combined = [...primaryBars, ...otherBars];
        // Sort combined by |gamma| but keep all primary bars regardless
        combined.sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma));
        gammaBars.length = 0;
        gammaBars.push(...combined.slice(0, 20));

        // Outlier strikes converted
        const outliers: { cfdPrice: number; score: number; gamma: number }[] = [];
        for (const sym of primarySyms) {
          for (const s of (assets[sym]?.outlierStrikes || []).slice(0, 5)) {
            outliers.push({ cfdPrice: convert(s.strike), score: s.outlierScore, gamma: s.totalGamma });
          }
        }

        // Flow
        const flowData: Record<string, any> = {};
        for (const sym of primarySyms) {
          const fl = assets[sym]?.flowData;
          if (fl && fl.flowDirection) {
            flowData[sym] = {
              direction: fl.flowDirection, strength: fl.flowStrength,
              netCalls: fl.netCallPositioning || 0,
              netPuts: fl.netPutPositioning || 0,
              topFlowStrikes: (fl.topFlowStrikes || []).slice(0, 3).map((s: any) => ({
                strike: s.strike, netCalls: s.netCalls, netPuts: s.netPuts, direction: s.direction,
              })),
            };
          }
        }

        // Raw levels (for reference)
        const rawLevels = {
          gammaRegime: l.gammaRegime,
          iv30: l.atmIV30, ivRank: l.ivRank, rv30: l.rv30,
          skew: l.skew, callSkew: l.callSkew, putSkew: l.putSkew,
          impliedMovePct: l.impliedMovePct,
          totalDelta: l.totalDelta, activityFactor: l.activityFactor,
          d95: l.d95, d25ne: l.d25ne, fwdGarch: l.fwdGarch,
          levelsChanged: l.levelsChanged,
        };

        return {
          cfd: cfdName,
          price: cfdPrice,
          changePct: cfdChange,
          conversionRatio: r.ratio,
          optionsSymbol: primary,
          levels: convertedLevels,
          distancesToLevels: distances,
          rawLevels,
          hiro: hiroData,
          tape: tapeData,
          tradierGex: tgData,
          topStrikes: topStrikes.slice(0, 5),
          gammaBars, // Top 15 fattest gamma bars near price (like SpotGamma Equity Hub chart)
          outliers,
          flow: flowData,
        };
      }

      // Open positions with live P&L
      const allRecords = loadHistory();
      const openPositions = allRecords
        .filter((r: any) => r.outcome === "open" && r.mt5Ticket)
        .map((r: any) => {
          const cfdKey = r.cfd === "NAS100" ? "nas100" : r.cfd === "US30" ? "us30" : "xauusd";
          const currentPrice = cfdPrices[cfdKey]?.price || 0;
          const isLong = r.direction === "LONG";
          const pnlPoints = isLong ? currentPrice - (r.mt5ExecutedPrice || 0) : (r.mt5ExecutedPrice || 0) - currentPrice;
          const pnlPct = r.mt5ExecutedPrice > 0 ? pnlPoints / r.mt5ExecutedPrice * 100 : 0;
          return {
            id: r.id,
            ticket: r.mt5Ticket,
            cfd: r.cfd,
            direction: r.direction,
            entryPrice: r.mt5ExecutedPrice,
            currentPrice,
            sl: r.stopLoss,
            tp1: r.takeProfit1,
            tp2: r.takeProfit2,
            tp3: r.takeProfit3,
            volume: r.mt5Volume,
            pnlPoints: Math.round(pnlPoints * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
            openedAt: r.mt5ExecutedAt,
            reasoning: r.sessionLabel || "",
          };
        });

      // Recent closed trades (last 10) — exclude pending/cancelled which are not real closes
      const recentClosed = allRecords
        .filter((r: any) => r.outcome && r.outcome !== "open" && r.outcome !== "pending" && r.outcome !== "cancelled" && r.mt5Ticket)
        .sort((a: any, b: any) => (b.timestamp || "").localeCompare(a.timestamp || ""))
        .slice(0, 10)
        .map((r: any) => ({
          cfd: r.cfd, direction: r.direction, outcome: r.outcome,
          pnlPoints: r.pnlPoints || 0, date: (r.timestamp || "").slice(0, 16),
        }));

      // Vanna context
      const vannaView = {
        vix: (vanna as any)?.vixPrice || 0,
        vixChangePct: (vanna as any)?.vixChangePct || 0,
        uvixChangePct: (vanna as any)?.uvixChangePct || 0,
        indexVannaActive: (vanna as any)?.indexVannaActive || false,
        refugeFlowActive: (vanna as any)?.refugeFlowActive || false,
        uvixGldDivergence: (vanna as any)?.uvixGldDivergence || null,
      };

      // Vol context
      const volView = {
        regime: (vol as any)?.overallRegime || "unknown",
        termStructure: (vol as any)?.overallTermStructure || "unknown",
        perAsset: {} as Record<string, any>,
      };
      for (const [sym, va] of Object.entries((vol as any)?.perAsset || {})) {
        if (va && typeof va === 'object') {
          volView.perAsset[sym] = {
            ivLevel: (va as any).ivLevel, termStructure: (va as any).termStructure,
            termSpread: (va as any).termSpread, putCallSkew: (va as any).putCallSkew,
            atmIV: (va as any).atmIV, callIV: (va as any).callIV, putIV: (va as any).putIV,
            nearTermExpiry: (va as any).nearTermExpiry, nearTermIV: (va as any).nearTermIV,
            farTermExpiry: (va as any).farTermExpiry, farTermIV: (va as any).farTermIV,
          };
        }
      }

      // 0DTE (only relevant for NAS100/US30)
      const odteView = {
        bias: (trace as any)?.netBias || (trace as any)?.netGexBias || "unknown",
        gexRatio: (trace as any)?.gexRatio || 0,
        totalPositiveGex: (trace as any)?.totalPositiveGex || 0,
        totalNegativeGex: (trace as any)?.totalNegativeGex || 0,
        maxGexStrike: (trace as any)?.maxGexStrike || 0,
        maxGexStrike_nas100: Math.round(((trace as any)?.maxGexStrike || 0) * (ratios.NAS100?.ratio || 3.64)),
        gammaFlip: (trace as any)?.gammaFlip || 0,
        hedgeWall: (trace as any)?.hedgeWall || 0,
        support: ((trace as any)?.topSupport || []).slice(0, 5).map((s: any) => ({
          price: s.strike, gamma: s.gamma || s.netGex || 0,
          nas100: Math.round(s.strike * (ratios.NAS100?.ratio || 3.64)),
        })),
        resistance: ((trace as any)?.topResistance || []).slice(0, 5).map((s: any) => ({
          price: s.strike, gamma: s.gamma || s.netGex || 0,
          nas100: Math.round(s.strike * (ratios.NAS100?.ratio || 3.64)),
        })),
      };

      // Calendar (high + medium impact only) with countdown
      const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const todayStr = nowET.toISOString().split("T")[0];
      const nowHour = nowET.getHours();
      const nowMin = nowET.getMinutes();

      const calendar = cal
        .filter((e: any) => e.impact === "High" || e.impact === "Medium")
        .slice(0, 12)
        .map((e: any) => {
          const title = e.event || e.title || "Unknown";
          const eventDate = e.date || todayStr;
          const [hStr, mStr] = (e.time || "00:00").split(":");
          const eventHour = parseInt(hStr) || 0;
          const eventMin = parseInt(mStr) || 0;

          // Calculate hours until event
          const eventDateObj = new Date(eventDate + "T00:00:00");
          const todayDateObj = new Date(todayStr + "T00:00:00");
          const daysDiff = Math.round((eventDateObj.getTime() - todayDateObj.getTime()) / (1000 * 60 * 60 * 24));
          const hoursUntil = (daysDiff * 24) + (eventHour - nowHour) + ((eventMin - nowMin) / 60);

          // Generate awareness level (not fear — events are catalysts, not threats)
          let warning = "none";
          if (hoursUntil <= 0.5 && hoursUntil > -0.5) warning = "HAPPENING_NOW";
          else if (hoursUntil > 0 && hoursUntil <= 1) warning = "TIGHTEN_SL";
          else if (hoursUntil > 0 && hoursUntil <= 4) warning = "CHECK_FLOW";
          else if (hoursUntil > 0 && hoursUntil <= 12) warning = "PREPARE";

          return {
            date: eventDate,
            time: e.time,
            event: title,
            impact: e.impact,
            hoursUntil: Math.round(hoursUntil * 10) / 10,
            warning,
            previous: e.previous,
            forecast: e.forecast,
          };
        });

      // GEX overview
      const gexView = {
        trend: (gex as any)?.gexTrend || "unknown",
        value: (gex as any)?.gexValue || 0,
        dealerIntent: (gex as any)?.dealerIntent || "",
        is0DTE: (gex as any)?.is0DTE || false,
      };

      // Always use live market status, not cached from last scrape
      const liveStatus = getMarketStatus();

      return {
        timestamp: md.fetchedAt,
        marketStatus: liveStatus.status,
        isMarketOpen: liveStatus.isOpen,
        sessionDate: md.sessionDate,
        cfds: {
          NAS100: buildCFDView("NAS100", ["SPX", "QQQ"], ["SPY"], ["SPX", "QQQ", "SPY"]),
          US30: buildCFDView("US30", ["DIA", "SPX"], ["SPY"], ["DIA"]),
          XAUUSD: buildCFDView("XAUUSD", ["GLD"], [], ["GLD"]),
        },
        gex: gexView,
        vanna: vannaView,
        vol: volView,
        odte: odteView,
        calendar,
        positions: {
          open: openPositions,
          recentClosed,
        },
        // Price memory: intraday history + momentum + session range
        priceAction: (() => {
          const result: Record<string, any> = {};
          for (const [cfdName, cfdKey] of [["NAS100","nas100"],["US30","us30"],["XAUUSD","xauusd"]] as const) {
            const price = cfdPrices[cfdKey]?.price || 0;
            if (price > 0) {
              recordPrice(cfdName, price);
              result[cfdName] = getPriceContext(cfdName, price);
            }
          }
          // Also track VIX for vanna context
          const vixPrice = cfdPrices.vix?.price || (vanna as any)?.vixPrice || 0;
          if (vixPrice > 0) {
            recordPrice("VIX", vixPrice);
            result["VIX"] = getPriceContext("VIX", vixPrice);
          }
          return result;
        })(),

        // DXY + TLT (critical for XAUUSD: DXY up = gold down)
        // Improvement 6: Use refreshDXYTLT() to trigger fetch if cache expired (5-min TTL)
        macro: await (async () => {
          try {
            const dxyTlt = await refreshDXYTLT();
            return {
              dxy: dxyTlt?.dxy || 0,
              tlt: dxyTlt?.tlt || 0,
              note: "DXY↑ = USD strong = gold weak. TLT↑ = bonds rally = risk-off.",
            };
          } catch { return { dxy: 0, tlt: 0 }; }
        })(),

        // HIRO trend (not just current percentile — is it rising or falling?)
        hiroTrend: (() => {
          const result: Record<string, any> = {};
          for (const sym of ["SPX", "QQQ", "DIA", "GLD", "VIX"]) {
            const h = (hiro as any)?.perAsset?.[sym];
            if (!h || !h.hiroValue) continue;
            const rm = h.hiroRange30dMin || 0;
            const rx = h.hiroRange30dMax || 0;
            const pct = rx !== rm ? Math.round((h.hiroValue - rm) / (rx - rm) * 100) : 50;
            // Check if we have HIRO history in trading-engine
            const { _hiroHistory } = require("./trading-engine");
            const hist = _hiroHistory?.[sym] || [];
            let trend = "unknown";
            let change5m = 0;
            if (hist.length >= 2) {
              const now = hist[hist.length - 1];
              // Find entry ~5 min ago
              const target = now.ts - 300_000;
              const prev = hist.reduce((best: any, t: any) =>
                Math.abs(t.ts - target) < Math.abs((best?.ts || 0) - target) ? t : best, hist[0]);
              if (prev && rx !== rm) {
                const prevPct = Math.round((prev.value - rm) / (rx - rm) * 100);
                change5m = pct - prevPct;
                trend = change5m > 3 ? "rising" : change5m < -3 ? "falling" : "stable";
              }
            }
            result[sym] = { percentile: pct, trend, change5m };
          }
          return result;
        })(),

        // Options volume + positioning (institutional flow)
        optionsFlow: (() => {
          const result: Record<string, any> = {};
          for (const sym of ["SPX", "QQQ", "DIA", "GLD"]) {
            const a = assets[sym];
            const l = levels[sym];
            if (!a) continue;
            const cv = a.callVolume || 0;
            const pv = a.putVolume || 0;
            result[sym] = {
              callVolume: cv, putVolume: pv,
              putCallRatio: Math.round((a.putCallRatio || 0) * 100) / 100,
              // VRP: IV30 - RV30 (positive = overpriced vol = mean reversion. negative = breakout risk)
              vrp: l ? Math.round(((l.atmIV30 || 0) - (l.rv30 || l.atmIV30 || 0)) * 10000) / 10000 : 0,
              // Top institutional positions (net positioning at key strikes)
              topPositions: (a.topStrikes || []).slice(0, 3).map((s: any) => ({
                strike: s.strike,
                netCalls: s.netPosCalls || 0,
                netPuts: s.netPosPuts || 0,
                netTotal: s.netPosTotal || 0,
                interpretation: (s.netPosTotal || 0) > 5000 ? "bullish_positioning"
                  : (s.netPosTotal || 0) < -5000 ? "bearish_positioning" : "neutral",
              })),
            };
          }
          return result;
        })(),

        // GEX change tracker (has the structure shifted?)
        gexChanges: (() => {
          const gct = (md as any).gexChangeTracker || {};
          const changes = gct.changes || {};
          const tpAdj = gct.tpAdjustment || {};
          return {
            biasChanged: changes.biasChanged || false,
            prevBias: changes.prevBias || "?",
            newBias: changes.newBias || "?",
            ratioChange: Math.round((changes.ratioChange || 0) * 100) / 100,
            supportShifted: changes.supportShifted || false,
            resistanceShifted: changes.resistanceShifted || false,
            description: changes.description || "",
            tpSuggestion: {
              shouldAdjust: tpAdj.shouldAdjustTP || false,
              action: tpAdj.suggestedAction || "hold",
              reason: tpAdj.reason || "",
            },
          };
        })(),

        // Entry signals (SpotGamma's own analysis)
        entrySignals: ((md as any).entrySignals || []).slice(0, 7).map((s: any) => ({
          asset: s.asset, signal: s.signal, confidence: s.confidence,
          reason: (s.reason || "").slice(0, 120),
          nearestOutlier: s.nearestOutlier ? {
            strike: s.nearestOutlier.strike,
            gamma: s.nearestOutlier.gamma,
            distancePct: Math.round((s.nearestOutlier.distancePct || 0) * 100) / 100,
          } : null,
        })),

        // Large gamma strikes (SpotGamma official — top 3 per symbol)
        largeGammaStrikes: (() => {
          const sg = (md as any).spotgammaLevels || {};
          const result: Record<string, { strikes: number[]; impliedMove: number }> = {};
          for (const sym of ["SPX", "QQQ", "DIA", "GLD"]) {
            const s = sg[sym];
            if (!s) continue;
            const strikes = [s.largeGamma1, s.largeGamma2, s.largeGamma3].filter(Boolean);
            if (strikes.length > 0) {
              const r = ratios[sym === "SPX" || sym === "QQQ" ? "NAS100" : sym === "DIA" ? "US30" : "XAUUSD"];
              result[sym] = {
                strikes: strikes.map((st: number) => Math.round(st * (r?.ratio || 1))), // converted to CFD
                impliedMove: s.impliedMove || 0,
              };
            }
          }
          return result;
        })(),

        // VIX-SPX Correlation + divergence detection
        vixSpxCorrelation: (() => {
          const c = (md as any).vixSpxCorrelation || {};
          return {
            correlation: c.correlation || "unknown",
            isDivergence: c.isDivergence || false,
            spxChangePct: c.spxChangePct || 0,
            vixChangePct: c.vixChangePct || 0,
          };
        })(),

        // Tape global (cross-asset premium flow)
        tapeGlobal: (() => {
          const t = (tape as any) || {};
          return {
            dominantFlow: t.dominantFlow || "mixed",
            bullishPremium: t.bullishPremium || 0,
            bearishPremium: t.bearishPremium || 0,
            totalPremium: t.totalPremium || 0,
            topGammaTicker: t.topGammaTicker || null,
            topGammaNotional: t.topGammaNotional || 0,
          };
        })(),

        // ── FLOW ANALYSIS: Individual trades + breakdown by size/expiry/direction ──
        institutionalFlow: (() => {
          const t = (tape as any) || {};
          const relevantSyms = ["SPX","QQQ","SPY","GLD","VIX","DIA"];
          const sessionDate = md.sessionDate || "";
          const thisWeekEnd = (() => {
            const d = new Date(sessionDate); d.setDate(d.getDate() + (5 - d.getDay()));
            return d.toISOString().split("T")[0];
          })();

          // All trades from all assets combined
          const allTrades: any[] = [];
          for (const sym of relevantSyms) {
            const assetTape = t.perAsset?.[sym];
            if (assetTape) {
              for (const tr of [...(assetTape.largestTrades || []), ...(assetTape.recentTrades || [])]) {
                if (!allTrades.some(e => e.time === tr.time && e.strike === tr.strike && e.premium === tr.premium)) {
                  allTrades.push(tr);
                }
              }
            }
          }
          // Add global largest/recent
          for (const tr of [...(t.largestTrades || []), ...(t.recentFlows || [])]) {
            if (relevantSyms.includes(tr.symbol) && !allTrades.some(e => e.time === tr.time && e.strike === tr.strike && e.premium === tr.premium)) {
              allTrades.push(tr);
            }
          }

          // Categorize
          const institutional = allTrades.filter(tr => tr.premium > 50000);
          const medium = allTrades.filter(tr => tr.premium > 10000 && tr.premium <= 50000);
          const retail = allTrades.filter(tr => tr.premium <= 10000);

          const is0DTE = (tr: any) => tr.expiration?.startsWith(sessionDate);
          const isWeekly = (tr: any) => !is0DTE(tr) && tr.expiration?.slice(0,10) <= thisWeekEnd;
          const _monthEnd = new Date(sessionDate); _monthEnd.setMonth(_monthEnd.getMonth() + 1, 0);
          const monthEndStr = _monthEnd.toISOString().split('T')[0];
          const isMonthly = (tr: any) => tr.expiration?.slice(0,10) > thisWeekEnd && tr.expiration?.slice(0,10) <= monthEndStr;

          const sumPrem = (arr: any[], sig: string) => arr.filter(t => t.signal === sig).reduce((s,t) => s + t.premium, 0);
          const countSig = (arr: any[], sig: string) => arr.filter(t => t.signal === sig).length;

          // Top 15 trades by premium (the ones that matter)
          const bigTrades = allTrades
            .sort((a,b) => b.premium - a.premium)
            .slice(0, 15)
            .map((tr: any) => ({
              time: tr.time, premium: tr.premium, symbol: tr.symbol,
              callPut: tr.callPut, strike: tr.strike, expiration: tr.expiration,
              buySell: tr.buySell, side: tr.side, delta: tr.delta,
              gamma: tr.gamma, signal: tr.signal,
              is0DTE: is0DTE(tr),
              category: tr.premium > 50000 ? "institutional" : tr.premium > 10000 ? "medium" : "retail",
            }));

          // Highlights
          const highlights = (t.topPremiumTrades || [])
            .filter((tr: any) => relevantSyms.includes(tr.symbol) || tr.symbol === "NDX")
            .slice(0, 10)
            .map((tr: any) => ({ symbol: tr.symbol, premium: tr.premium, strike: tr.strike, isPut: tr.isPut, expiry: tr.expiry }));

          return {
            bigTrades,
            highlights,
            breakdown: {
              total: allTrades.length,
              institutional: { count: institutional.length, bullPrem: sumPrem(institutional,"bullish"), bearPrem: sumPrem(institutional,"bearish") },
              medium: { count: medium.length, bullPrem: sumPrem(medium,"bullish"), bearPrem: sumPrem(medium,"bearish") },
              retail: { count: retail.length, bullPrem: sumPrem(retail,"bullish"), bearPrem: sumPrem(retail,"bearish") },
              byExpiry: {
                dte0: { count: allTrades.filter(is0DTE).length, bull: countSig(allTrades.filter(is0DTE),"bullish"), bear: countSig(allTrades.filter(is0DTE),"bearish") },
                weekly: { count: allTrades.filter(isWeekly).length, bull: countSig(allTrades.filter(isWeekly),"bullish"), bear: countSig(allTrades.filter(isWeekly),"bearish") },
              },
              netDelta: allTrades.reduce((s,t) => s + (t.delta || 0), 0),
            },
          };
        })(),

        // ── LIVE FLOW: Real-time institutional alerts (polled every 5s) ──
        liveFlow: (() => {
          const alerts = getLiveFlowAlerts();
          const summary = getLiveFlowSummary();
          return {
            ...summary,
            recentAlerts: alerts.slice(-10), // last 10 institutional trades detected
          };
        })(),

        // Vanna detailed (full vanna context)
        vannaDetailed: (() => {
          const v = (vanna as any) || {};
          return {
            vixVannaSignal: v.vixVannaSignal || "neutral",
            vixVannaStrength: v.vixVannaStrength || "none",
            uvxyPrice: v.uvxyPrice || 0,
            uvxyChange: v.uvxyChange || 0,
            uvxyChangePct: v.uvxyChangePct || 0,
            gldVannaSignal: v.gldVannaSignal || "neutral",
            gldIVChangePct: v.gldIVChangePct || 0,
          };
        })(),

        // Per-asset gamma totals + 0DTE gamma (for each symbol)
        gammaBreakdown: (() => {
          const result: Record<string, any> = {};
          for (const sym of ["SPX", "QQQ", "DIA", "GLD"]) {
            const a = assets[sym];
            if (!a) continue;
            result[sym] = {
              callGamma: a.callGamma || 0,
              putGamma: a.putGamma || 0,
              totalGamma: a.totalGamma || 0,
              zeroDteGamma: a.zeroDteGamma || 0,
              gammaFlipLevel: a.gammaFlipLevel || 0,
            };
          }
          return result;
        })(),

        // Pre-market summary (AI analysis from morning)
        preMarket: (() => {
          const pm = (md as any).preMarketSummary || {};
          if (!pm.summary) return null;
          return {
            bias: pm.marketBias || "neutral",
            summary: (pm.summary || "").slice(0, 300),
            outlierZones: (pm.outlierZones || []).slice(0, 5).map((z: any) => ({
              asset: z.asset, strike: z.strike, type: z.type, action: z.action,
            })),
          };
        })(),

        // Agent's own performance (self-awareness)
        selfPerformance: (() => {
          const all = loadHistory();
          const mt5Trades = all.filter((r: any) => r.mt5Ticket);
          const wins = mt5Trades.filter((r: any) => ["tp1","tp2","tp3"].includes(r.outcome)).length;
          const losses = mt5Trades.filter((r: any) => r.outcome === "sl").length;
          const open = mt5Trades.filter((r: any) => r.outcome === "open").length;
          const resolved = wins + losses;
          // By regime
          const byRegime: Record<string, { w: number; l: number }> = {};
          for (const r of mt5Trades) {
            const regime = (r as any).regime || "unknown";
            if (!byRegime[regime]) byRegime[regime] = { w: 0, l: 0 };
            if (["tp1","tp2","tp3"].includes(r.outcome)) byRegime[regime].w++;
            else if (r.outcome === "sl") byRegime[regime].l++;
          }
          return {
            totalTrades: mt5Trades.length,
            wins, losses, open,
            winRate: resolved > 0 ? Math.round(wins / resolved * 100) : 0,
            byRegime,
          };
        })(),

        mt5: getMT5Status(),

        // Improvement 4: Real broker prices from MT5 EA (sg_status.json)
        brokerPrices: (() => {
          try {
            const bp = getBrokerPrices();
            const keys = Object.keys(bp);
            if (keys.length === 0) return { available: false, note: "broker_prices: unavailable" };
            return { available: true, prices: bp };
          } catch { return { available: false, note: "broker_prices: unavailable" }; }
        })(),

        // Improvement 5: Market live detection (price movement based)
        marketLive: isMarketLiveByPriceMovement(),

        // Improvement 7: 15-min candle signals per CFD
        candleSignals: (() => {
          const result: Record<string, ReturnType<typeof get15MinCandles>> = {};
          for (const cfdName of ["nas100", "us30", "xauusd"]) {
            const ticks = _priceMemory[cfdName];
            if (ticks && ticks.length >= 2) {
              result[cfdName] = get15MinCandles(cfdName);
            }
          }
          return result;
        })(),
      };
    }),

    // ── MT5 Bridge ───────────────────────────────────────────────
    // ── MT5 File Bridge (macOS nativo vía EA MQL5) ───────────────
    getMT5Status: publicProcedure.query(() => {
      return getMT5Status();
    }),

    getRetestMemory: publicProcedure.query(() => {
      return getRetestMemory();
    }),

    getSetupAnalytics: publicProcedure.query(() => {
      const { getSetupAnalytics } = require("./setup-tracker");
      return getSetupAnalytics();
    }),

    getAllTrackedSetups: publicProcedure.query(() => {
      const { getAllTrackedSetups } = require("./setup-tracker");
      return getAllTrackedSetups();
    }),

    executeMT5Trade: publicProcedure
      .input(z.object({
        tradeId: z.string(),
        volume:  z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const records = loadHistory();
        const record = records.find(r => r.id === input.tradeId);
        if (!record) return { success: false, error: "Trade no encontrado en historial" };
        if (record.outcome !== "open") return { success: false, error: "Solo se pueden ejecutar trades con outcome=open" };
        if (record.mt5Ticket) return { success: false, error: `Ya ejecutado en MT5 (ticket #${record.mt5Ticket})` };

        // Lot sizes por defecto según CFD
        const defaultVolume: Record<string, number> = { NAS100: 0.1, US30: 0.1, XAUUSD: 0.01 };
        const volume = input.volume ?? defaultVolume[record.cfd] ?? 0.01;

        const data = await mt5PlaceOrder({
          cfd:       record.cfd,
          direction: record.direction,
          volume,
          sl:        record.stopLoss,
          tp1:       record.takeProfit1,
          tp2:       record.takeProfit2,
          tp3:       record.takeProfit3,
        });

        if (!data.success) return { success: false, error: data.error };

        const idx = records.findIndex(r => r.id === input.tradeId);
        records[idx] = {
          ...records[idx],
          mt5Ticket:        data.ticket,
          mt5Volume:        data.volume ?? volume,
          mt5ExecutedAt:    new Date().toISOString(),
          mt5ExecutedPrice: data.price,
        };
        saveHistory(records);

        return { success: true, ticket: data.ticket, price: data.price, volume: data.volume ?? volume };
      }),

    closeMT5Trade: publicProcedure
      .input(z.object({
        tradeId: z.string(),
        volume:  z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const records = loadHistory();
        const record = records.find(r => r.id === input.tradeId);
        if (!record?.mt5Ticket) return { success: false, error: "Trade sin ticket MT5" };
        return mt5ClosePosition(record.mt5Ticket, input.volume);
      }),

    getMT5Positions: publicProcedure.query(() => {
      const status = getMT5Status();
      return { positions: [], connected: status.connected, filesDir: getMT5FilesDir() };
    }),

    // ── Claude Agent: Position Management ───────────────────────────

    // Modify SL/TP on an existing position
    modifyPosition: publicProcedure
      .input(z.object({
        tradeId:  z.string(),
        newSL:    z.number().optional(),
        newTP:    z.number().optional(),
        reasoning: z.string(),
      }))
      .mutation(async ({ input }) => {
        const records = loadHistory();
        const record = records.find(r => r.id === input.tradeId);
        if (!record?.mt5Ticket) return { success: false, error: "No MT5 ticket found" };

        const result = await mt5ModifySL(record.mt5Ticket, input.newSL ?? record.stopLoss, input.newTP ?? record.takeProfit1);

        if (result.success) {
          // Update local record
          const idx = records.findIndex(r => r.id === input.tradeId);
          if (idx >= 0) {
            if (input.newSL) records[idx].stopLoss = input.newSL;
            if (input.newTP) records[idx].takeProfit1 = input.newTP;
            saveHistory(records);
          }
          console.log(`[CLAUDE-AGENT] 🔧 Modified #${record.mt5Ticket} ${record.cfd}: SL=${input.newSL ?? 'unchanged'} TP=${input.newTP ?? 'unchanged'} | ${input.reasoning}`);
        }
        return result;
      }),

    // Partial close — take profit on part of the position
    partialClose: publicProcedure
      .input(z.object({
        tradeId:   z.string(),
        volume:    z.number(),  // lots to close
        reasoning: z.string(),
      }))
      .mutation(async ({ input }) => {
        const records = loadHistory();
        const record = records.find(r => r.id === input.tradeId);
        if (!record?.mt5Ticket) return { success: false, error: "No MT5 ticket found" };

        const result = await mt5ClosePosition(record.mt5Ticket, input.volume);
        if (result.success) {
          console.log(`[CLAUDE-AGENT] ✂️ Partial close #${record.mt5Ticket} ${record.cfd}: ${input.volume} lots | ${input.reasoning}`);
        }
        return result;
      }),

    // ── Claude Agent Trade Execution ────────────────────────────────
    executeClaudeTrade: publicProcedure
      .input(z.object({
        cfd:        z.enum(["NAS100", "US30", "XAUUSD"]),
        direction:  z.enum(["LONG", "SHORT"]),
        confidence: z.number().min(0).max(100),
        risk:       z.enum(["tight", "normal", "wide"]).default("normal"),
        reasoning:  z.string(),
        // Optional: Claude can set its own SL/TP dynamically
        sl:         z.number().optional(),   // explicit SL price
        tp1:        z.number().optional(),   // explicit TP1 price
        tp2:        z.number().optional(),   // explicit TP2 price
        tp3:        z.number().optional(),   // explicit TP3 price
        volume:     z.number().optional(),   // explicit lot size
      }))
      .mutation(async ({ input }) => {
        const atCfg = loadAutoConfig();
        // fs and path imported at top of file

        // Log decision to claude-decisions.jsonl
        const decisionLog = path.resolve(process.cwd(), "data/claude-decisions.jsonl");
        const decisionEntry = {
          ts: new Date().toISOString(),
          ...input,
          executed: false,
          ticket: null as number | null,
          error: null as string | null,
        };

        // ── Safety checks ───────────────────────────────────────────
        if (!atCfg.enabled) {
          decisionEntry.error = "Auto-trading disabled";
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: "Auto-trading disabled — enable in Bot tab" };
        }

        const allRecords = loadHistory();
        const ks = checkKillSwitch(allRecords);
        if (ks.triggered) {
          decisionEntry.error = `Kill switch: WR=${ks.liveWR}%`;
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: `Kill switch active — live WR=${ks.liveWR}%` };
        }

        if (atCfg.disabledCFDs?.includes(input.cfd)) {
          decisionEntry.error = `CFD ${input.cfd} disabled`;
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: `${input.cfd} disabled in config` };
        }

        const todayCount = countTodayAutoTrades(allRecords);
        if (todayCount >= atCfg.maxDailyTrades) {
          decisionEntry.error = `Daily limit ${todayCount}/${atCfg.maxDailyTrades}`;
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: `Daily limit reached (${todayCount}/${atCfg.maxDailyTrades})` };
        }

        const openCount = countOpenMT5Positions(allRecords);
        if (openCount >= atCfg.maxConcurrentPositions) {
          decisionEntry.error = `Max positions ${openCount}/${atCfg.maxConcurrentPositions}`;
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: `Max concurrent positions (${openCount}/${atCfg.maxConcurrentPositions})` };
        }

        // ── Compute SL/TP from risk profile and current price ───────
        const { getCachedData: getCachedMarket } = require("./spotgamma-scraper");
        const marketData = getCachedMarket();
        const cfdKey = input.cfd === "NAS100" ? "nas100" : input.cfd === "US30" ? "us30" : "xauusd";
        const cfdPrice = marketData?.cfdPrices?.[cfdKey]?.price ?? 0;

        if (!cfdPrice || cfdPrice <= 0) {
          decisionEntry.error = "No CFD price available";
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: "No CFD price available" };
        }

        const { CFD_SPECS } = require("./trading-engine");
        const spec = CFD_SPECS?.[input.cfd];
        const pointValue = spec?.valuePerPoint ?? 1;
        const isLong = input.direction === "LONG";

        // Risk params (used for record metadata)
        const riskParamsAll: Record<string, { sl: number; tp1: number; tp2: number; tp3: number }> = {
          tight:  { sl: 0.25, tp1: 0.20, tp2: 0.45, tp3: 0.90 },
          normal: { sl: 0.40, tp1: 0.25, tp2: 0.55, tp3: 1.20 },
          wide:   { sl: 0.65, tp1: 0.35, tp2: 0.75, tp3: 1.80 },
        };
        const rp = riskParamsAll[input.risk] ?? riskParamsAll.normal;

        // Use Claude's explicit SL/TP if provided, otherwise fall back to ATR-based
        let sl: number, tp1: number, tp2: number, tp3: number;
        let slPoints: number, tp1Points: number, tp2Points: number, tp3Points: number;

        if (input.sl && input.tp1) {
          // Claude provided explicit levels — use them directly
          sl = input.sl;
          tp1 = input.tp1;
          tp2 = input.tp2 ?? (isLong ? tp1 + (tp1 - cfdPrice) : tp1 - (cfdPrice - tp1));
          tp3 = input.tp3 ?? (isLong ? tp1 + (tp1 - cfdPrice) * 2 : tp1 - (cfdPrice - tp1) * 2);
          slPoints = Math.abs(cfdPrice - sl);
          tp1Points = Math.abs(tp1 - cfdPrice);
          tp2Points = Math.abs(tp2 - cfdPrice);
          tp3Points = Math.abs(tp3 - cfdPrice);
          console.log(`[CLAUDE-AGENT] Custom levels: SL=${sl} TP1=${tp1} TP2=${tp2} TP3=${tp3}`);
        } else {
          // Fallback: ATR-based SL/TP
          const riskParams: Record<string, { sl: number; tp1: number; tp2: number; tp3: number }> = {
            tight:  { sl: 0.25, tp1: 0.20, tp2: 0.45, tp3: 0.90 },
            normal: { sl: 0.40, tp1: 0.25, tp2: 0.55, tp3: 1.20 },
            wide:   { sl: 0.65, tp1: 0.35, tp2: 0.75, tp3: 1.80 },
          };
          const rp = riskParams[input.risk] ?? riskParams.normal;
          const atrPoints = cfdPrice * 1.0 / 100; // ~1% ATR
          slPoints = atrPoints * rp.sl;
          tp1Points = atrPoints * rp.tp1;
          tp2Points = atrPoints * rp.tp2;
          tp3Points = atrPoints * rp.tp3;
          sl  = isLong ? cfdPrice - slPoints  : cfdPrice + slPoints;
          tp1 = isLong ? cfdPrice + tp1Points : cfdPrice - tp1Points;
          tp2 = isLong ? cfdPrice + tp2Points : cfdPrice - tp2Points;
          tp3 = isLong ? cfdPrice + tp3Points : cfdPrice - tp3Points;
        }

        // Volume: Claude's explicit or config default
        const defaultVolume: Record<string, number> = { NAS100: 0.1, US30: 0.1, XAUUSD: 0.01 };
        const volume = input.volume ?? atCfg.volumes?.[input.cfd] ?? defaultVolume[input.cfd] ?? 0.01;

        // ── Log trade to trade-history.json ──────────────────────────
        const sessionDate = new Date().toISOString().slice(0, 10);
        const tradeRecord = logSetupIfNew({
          asset: input.cfd === "NAS100" ? "SPX" : input.cfd === "US30" ? "DIA" : "GLD",
          cfd: input.cfd,
          cfdLabel: input.cfd,
          tradeType: "claude_agent" as any,
          direction: input.direction,
          score: Math.round(input.confidence),
          entryPrice: cfdPrice,
          cfdEntryPrice: cfdPrice,
          entryZone: null,
          entryMode: "ENTRADA",
          entryQuality: "optimal",
          sessionLabel: `Claude Agent: ${input.reasoning.slice(0, 60)}`,
          stopLoss: sl,
          stopLossPoints: Math.round(slPoints),
          stopLossRiskUSD: slPoints * pointValue * (spec?.lotSize ?? 1),
          stopLossReason: `Claude risk=${input.risk}`,
          takeProfit1: tp1,
          takeProfit1Points: Math.round(tp1Points),
          takeProfit2: tp2,
          takeProfit2Points: Math.round(tp2Points),
          takeProfit3: tp3,
          takeProfit3Points: Math.round(tp3Points),
          riskRewardRatio: tp2Points / Math.max(slPoints, 0.01),
          gexConfirmed: true,
          hiroConfirmed: true,
          tapeConfirmed: true,
          levelConfirmed: true,
          vannaConfirmed: true,
          regimeConfirmed: true,
          sgLevels: null,
          adaptivePolicy: {
            riskProfile: input.risk,
            slMultiplier: rp.sl,
            tp1Pct: rp.tp1,
            tp2Pct: rp.tp2,
            tp3Pct: rp.tp3,
            confidence: input.confidence,
            sizing: "medium",
          },
          invalidation: { gammaFlipLevel: 0, gammaFlipCFD: 0, conditions: [] },
          timestamp: new Date().toISOString(),
          nearestLevels: [],
          confirmationDetails: [`Claude Agent: ${input.reasoning}`],
        } as any, sessionDate);

        // ── Execute on MT5 ──────────────────────────────────────────
        const mt5Status = getMT5Status();
        if (!mt5Status.connected) {
          decisionEntry.error = "MT5 not connected";
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: "MT5 EA not connected", tradeLogged: true, tradeId: tradeRecord?.id };
        }

        try {
          const result = await mt5PlaceOrder({
            cfd: input.cfd,
            direction: input.direction,
            volume,
            sl, tp1, tp2, tp3,
          });

          if (result.success && result.ticket) {
            // Update trade record with MT5 execution
            const records = loadHistory();
            const idx = records.findIndex(r => r.id === tradeRecord?.id);
            if (idx >= 0) {
              records[idx] = {
                ...records[idx],
                mt5Ticket: result.ticket,
                mt5Volume: result.volume ?? volume,
                mt5ExecutedAt: new Date().toISOString(),
                mt5ExecutedPrice: result.price,
              };
              saveHistory(records);
            }

            decisionEntry.executed = true;
            decisionEntry.ticket = result.ticket;
            fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");

            console.log(`[CLAUDE-AGENT] 🎯 ${input.cfd} ${input.direction} | conf=${input.confidence}% risk=${input.risk} → Ticket #${result.ticket} @ ${result.price}`);
            console.log(`[CLAUDE-AGENT] 💭 Reasoning: ${input.reasoning}`);

            return {
              success: true,
              ticket: result.ticket,
              price: result.price,
              volume: result.volume ?? volume,
              sl, tp1, tp2, tp3,
              reasoning: input.reasoning,
            };
          } else {
            decisionEntry.error = result.error ?? "MT5 execution failed";
            fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
            return { success: false, error: result.error, tradeLogged: true };
          }
        } catch (e: any) {
          decisionEntry.error = e.message;
          fs.appendFileSync(decisionLog, JSON.stringify(decisionEntry) + "\n");
          return { success: false, error: e.message };
        }
      }),
  }),

  alerts: router({
    // Obtener alertas del día
    getToday: publicProcedure.query(async () => {
      const sessionDate = getSessionDate();
      return await getAlerts(sessionDate, 100);
    }),

    // Marcar alerta como leída
    markRead: publicProcedure
      .input(z.object({ alertId: z.number() }))
      .mutation(async ({ input }) => {
        await markAlertRead(input.alertId);
        return { success: true };
      }),

    // Crear alerta manual
    create: publicProcedure
      .input(
        z.object({
          symbol: z.string(),
          alertType: z.enum([
            "price_at_strike",
            "bounce_confirmed",
            "breakout_confirmed",
            "gex_shift",
            "volatility_spike",
            "tape_signal",
            "hiro_signal",
            "sg_levels_changed",
            "vix_backwardation",
            "vanna_flow",
            "refuge_flow",
            "regime_change",
            "pin_risk",
          ]),
          title: z.string(),
          message: z.string(),
          severity: z.enum(["info", "warning", "critical"]).optional(),
          strikeLevel: z.number().optional(),
          currentPrice: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const sessionDate = getSessionDate();
        const alert = await saveAlert({
          ...input,
          severity: input.severity || "info",
          sessionDate,
        });
        return alert;
      }),
  }),

  narration: router({
    // Obtener la narración más reciente
    getLatest: publicProcedure.query(async () => {
      const sessionDate = getSessionDate();
      return await getLatestNarration(sessionDate);
    }),

    // Obtener historial de narraciones
    getHistory: publicProcedure.query(async () => {
      const sessionDate = getSessionDate();
      return await getNarrationHistory(sessionDate, 20);
    }),

    // Generar nueva narración
    generate: publicProcedure.mutation(async () => {
      const data = await getMarketDataCached();
      if (!data) return { narration: "Datos no disponibles" };

      const narration = await generateMarketNarration(data);
      const sessionDate = getSessionDate();

      await saveNarration({
        narration,
        context: { marketStatus: data.marketStatus, fetchedAt: data.fetchedAt },
        sessionDate,
      });

      return { narration, generatedAt: new Date().toISOString() };
    }),

    // Analizar una zona específica con LLM
    analyzeZone: publicProcedure
      .input(
        z.object({
          symbol: z.string(),
          strike: z.number(),
          currentPrice: z.number(),
          gexTrend: z.string().optional(),
          hiroTrend: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const distancePct = ((input.currentPrice - input.strike) / input.currentPrice) * 100;
          const direction = distancePct > 0 ? "por encima" : "por debajo";

          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: `Eres un experto en trading de opciones intradía. Analiza si el precio está rebotando o rompiendo una zona de gamma clave. 
Considera: GEX del SPX (intención de dealers), HIRO (flujo institucional), y la posición del precio relativa al strike.
Sé directo: ¿rebote o ruptura? ¿Qué confirma o niega la señal? Máximo 2-3 oraciones.`,
              },
              {
                role: "user",
                content: `${input.symbol} está en ${input.currentPrice} (${Math.abs(distancePct).toFixed(2)}% ${direction} del strike ${input.strike}).
GEX del SPX: ${input.gexTrend || "neutral"}. HIRO: ${input.hiroTrend || "neutral"}.
¿Es un rebote o una ruptura? ¿Qué confirma la señal?`,
              },
            ],
          });

          const analysisContent = response.choices[0]?.message?.content;
          return {
            analysis: typeof analysisContent === 'string' ? analysisContent : "Analizando...",
            generatedAt: new Date().toISOString(),
          };
        } catch (err) {
          return { analysis: "Error al generar análisis", generatedAt: new Date().toISOString() };
        }
      }),

    // AI Chatbot - open-ended questions about market data, trades, concepts
    chat: publicProcedure
      .input(z.object({
        message: z.string(),
        history: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })).optional(),
      }))
      .mutation(async ({ input }) => {
        try {
          const data = await getMarketDataCached();
          
          // Build comprehensive market context for the AI
          const spx = data?.assets.find(a => a.symbol === "SPX");
          const spy = data?.assets.find(a => a.symbol === "SPY");
          const qqq = data?.assets.find(a => a.symbol === "QQQ");
          const gld = data?.assets.find(a => a.symbol === "GLD");
          const vix = data?.assets.find(a => a.symbol === "VIX");
          const dia = data?.assets.find(a => a.symbol === "DIA");
          
          const tradeSetups = data?.tradeSetups || [];
          const activeSetups = tradeSetups.filter(t => t.direction !== 'NO_TRADE' && t.score >= 30);
          
          const vannaCtx = data?.vannaContext;
          const gexTracker = data?.gexChangeTracker;
          const cfdPrices = data?.cfdPrices;
          
          const marketContext = `
=== DATOS DEL MERCADO EN TIEMPO REAL ===
Fecha: ${new Date().toLocaleDateString("es-CO", { timeZone: "America/Bogota" })}
Hora Colombia: ${new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota" })}
Estado: ${data?.marketStatus || "desconocido"}

PRECIOS CFD (Pepperstone):
- NAS100: $${cfdPrices?.nas100?.price?.toFixed(2) || "N/A"} (${cfdPrices?.nas100?.changePct?.toFixed(2) || "0"}%)
- US30: $${cfdPrices?.us30?.price?.toFixed(0) || "N/A"} (${cfdPrices?.us30?.changePct?.toFixed(2) || "0"}%)
- XAUUSD: $${cfdPrices?.xauusd?.price?.toFixed(2) || "N/A"} (${cfdPrices?.xauusd?.changePct?.toFixed(2) || "0"}%)

ACTIVOS SUBYACENTES:
- SPX: $${spx?.currentPrice?.toFixed(2) || "N/A"} (${spx?.dailyChangePct?.toFixed(2) || "N/A"}%)
- SPY: $${spy?.currentPrice?.toFixed(2) || "N/A"} (${spy?.dailyChangePct?.toFixed(2) || "N/A"}%)
- QQQ: $${qqq?.currentPrice?.toFixed(2) || "N/A"} (${qqq?.dailyChangePct?.toFixed(2) || "N/A"}%)
- DIA: $${dia?.currentPrice?.toFixed(2) || "N/A"} (${dia?.dailyChangePct?.toFixed(2) || "N/A"}%)
- GLD: $${gld?.currentPrice?.toFixed(2) || "N/A"} (${gld?.dailyChangePct?.toFixed(2) || "N/A"}%)
- VIX: ${vix?.currentPrice?.toFixed(2) || "N/A"} (${vix?.dailyChangePct?.toFixed(2) || "N/A"}%)

VOLATILIDAD Y VANNA:
- UVIX: $${cfdPrices?.uvix?.price?.toFixed(2) || "N/A"} (${cfdPrices?.uvix?.changePct?.toFixed(2) || "0"}%)
- UVXY: $${cfdPrices?.uvxy?.price?.toFixed(2) || "N/A"} (${cfdPrices?.uvxy?.changePct?.toFixed(2) || "0"}%)
- VIX Vanna: ${vannaCtx?.vixVannaSignal || "N/A"} (${vannaCtx?.vixVannaStrength || "N/A"})
- GLD Vanna: ${vannaCtx?.gldVannaSignal || "N/A"} (${vannaCtx?.gldVannaStrength || "N/A"})
- Flujo Refugio: ${vannaCtx?.uvxyRefugeSignal || "N/A"}
- Divergencia UVIX-GLD: ${vannaCtx?.uvixGldDivergence?.description || "N/A"}

GEX (Gamma Exposure):
- Tendencia: ${data?.gex?.gexTrend || "N/A"}
- Intent Dealers: ${data?.gex?.dealerIntent || "N/A"}
- GEX Tracker: Bias=${gexTracker?.currentSnapshot?.netBias || "N/A"} Ratio=${gexTracker?.currentSnapshot?.gexRatio?.toFixed(2) || "N/A"}
- Cambios: ${gexTracker?.changes?.description || "Sin datos previos"}
- TP Dinamico: ${gexTracker?.tpAdjustment?.reason || "N/A"}

HIRO (Hedging Impact Real-time Overlay):
- Tendencia: ${data?.hiro?.hiroTrend || "N/A"}
- Descripcion: ${data?.hiro?.description || "N/A"}

TAPE (Flujo de opciones):
- Flujo dominante: ${data?.tape?.dominantFlow || "N/A"}

NIVELES SPOTGAMMA OFICIALES:
${Object.entries(data?.officialLevels || {}).map(([sym, l]: [string, any]) => 
  `- ${sym}: CW=$${l.callWall || 0} PW=$${l.putWall || 0} KeyG=$${l.keyGamma || 0} VT=$${l.volTrigger || 0} IM=${l.impliedMove?.toFixed(1) || 0} Regime=${l.gammaRegime || "N/A"}`
).join("\n")}

TRADE SETUPS ACTIVOS (Motor v3 - 6 confirmaciones):
${activeSetups.length > 0 ? activeSetups.map(t => 
  `- ${t.cfd} ${t.direction} (Score ${t.score}/100, Tipo: ${t.tradeType})
    Entry: $${t.cfdEntryPrice?.toFixed(2)} | SL: $${t.stopLoss?.toFixed(2)} (${t.stopLossPoints?.toFixed(1)} pts) | TP1: $${t.takeProfit1?.toFixed(2)} | TP2: $${t.takeProfit2?.toFixed(2)} | R:R ${t.riskRewardRatio}:1
    Confirmaciones: GEX=${t.gexConfirmed?"SI":"NO"} HIRO=${t.hiroConfirmed?"SI":"NO"} TAPE=${t.tapeConfirmed?"SI":"NO"} NIVEL=${t.levelConfirmed?"SI":"NO"} VANNA=${t.vannaConfirmed?"SI":"NO"} REGIMEN=${t.regimeConfirmed?"SI":"NO"}
    Razon: ${t.reason}`
).join("\n") : "Sin setups activos"}

TAMANOS DE POSICION:
- NAS100: 0.1 lote ($1/punto)
- US30: 0.01 lote ($0.10/punto)
- XAUUSD: 0.01 lote ($0.10/punto)
`;

          const messages: any[] = [
            {
              role: "system",
              content: `Eres el asistente AI del Dashboard SpotGamma Market Monitor. Tu trabajo es ayudar al trader a entender los datos del mercado, las senales de trading, y los conceptos de gamma/opciones.

TIENES ACCESO A DATOS EN TIEMPO REAL del mercado (proporcionados abajo). Usa estos datos para responder preguntas especificas.

CONOCIMIENTOS CLAVE:
1. **GEX (Gamma Exposure)**: Mide el posicionamiento de dealers. Gamma positivo = dealers compran dips (soporte). Gamma negativo = dealers venden rallies (resistencia amplificada).
2. **HIRO**: Flujo institucional en tiempo real. Bullish = instituciones comprando calls/vendiendo puts.
3. **Tape Flow**: Flujo real de opciones grandes (>$50K premium). Muestra donde ponen dinero los grandes.
4. **Vanna**: Cuando IV cae, dealers deben comprar futuros para rebalancear delta → movimiento alcista tendencial.
5. **Niveles SG**: Call Wall (resistencia), Put Wall (soporte), Vol Trigger (divide gamma +/-), Key Gamma (nivel mas activo).
6. **UVIX/UVXY**: ETFs de volatilidad. Suben con miedo. Divergencia UVIX-GLD = oportunidad en oro.
7. **Regimen Gamma**: Positivo (mean reversion, rangos) vs Negativo (tendencial, breakouts).
8. **0DTE GEX**: Posicionamiento de opciones que expiran HOY. Cambia rapido y mueve el mercado intradía.

MAPEO CFD:
- SPX/SPY/QQQ → NAS100 (Pepperstone)
- DIA → US30 (Pepperstone)
- GLD → XAUUSD (Pepperstone)
- XAUUSD NO usa 0DTE GEX, usa UVXY/flujo refugio

ESTILO:
- Responde en espanol
- Se directo y accionable
- Usa precios CFD reales cuando sea relevante
- Si el usuario pregunta "que operar?", da recomendaciones basadas en los datos actuales
- Si pregunta conceptos, explica de forma clara con ejemplos del mercado actual
- Maximo 300 palabras por respuesta

${marketContext}`,
            },
          ];
          
          // Add conversation history
          if (input.history && input.history.length > 0) {
            for (const msg of input.history.slice(-10)) { // Keep last 10 messages
              messages.push({ role: msg.role, content: msg.content });
            }
          }
          
          // Add current user message
          messages.push({ role: "user", content: input.message });
          
          const response = await invokeLLM({
            messages,
            maxTokens: 2048,
          });
          
          const content = response.choices[0]?.message?.content;
          return {
            reply: typeof content === 'string' ? content : "No pude generar una respuesta.",
            generatedAt: new Date().toISOString(),
          };
        } catch (err: any) {
          console.error("[CHAT] Error:", err.message);
          return {
            reply: "Error al procesar tu pregunta. Intenta de nuevo.",
            generatedAt: new Date().toISOString(),
          };
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;

// ─── Internal function for Claude Decision Cycle (called from market-monitor) ───
export async function executeClaudeTradeInternal(input: {
  cfd: "NAS100" | "US30" | "XAUUSD";
  direction: "LONG" | "SHORT";
  confidence: number;
  risk: "tight" | "normal" | "wide";
  reasoning: string;
  sl?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  volume?: number;
}): Promise<{ success: boolean; ticket?: number; price?: number; error?: string }> {
  // Use tRPC caller to invoke the mutation internally
  const caller = appRouter.createCaller({});
  try {
    const result = await caller.market.executeClaudeTrade(input);
    return result as any;
  } catch (e: any) {
    console.error(`[executeClaudeTradeInternal] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}
