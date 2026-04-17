import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Activity,
  Bell,
  Clock,
  RefreshCw,
  Zap,
  BarChart2,
  Target,
  Volume2,
  VolumeX,
  Shield,
  Crosshair,
  Thermometer,
  GitBranch,
  BookOpen,
  Database,
  Wifi,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { GexTab } from "@/components/dashboard/tabs/GexTab";
import { FlowLevelsTab } from "@/components/dashboard/tabs/FlowLevelsTab";
import { MetricsVolTab } from "@/components/dashboard/tabs/MetricsVolTab";
import { StrikesTab } from "@/components/dashboard/tabs/StrikesTab";
import { HistoryTab } from "@/components/dashboard/tabs/HistoryTab";
import { AnalyticsTab } from "@/components/dashboard/tabs/AnalyticsTab";
import { BacktestTab } from "@/components/dashboard/tabs/BacktestTab";
import { BotConfigTab } from "@/components/dashboard/tabs/BotConfigTab";
import { MultiTimeframeTab } from "@/components/dashboard/tabs/MultiTimeframeTab";
import { SYMBOLS, SYMBOL_COLORS, formatNumber, formatPrice } from "@/components/dashboard/constants";
import { PriceChange, TrendBadge, CountdownRing, MarketStatusBadge, SectionHeader } from "@/components/dashboard/shared";
import { TradeSetupCard, VixCorrelationPanel, UvixGldDivergencePanel, GexChangeTrackerPanel, AlertItem } from "@/components/dashboard/charts";
import { ExecutorPanel } from "@/components/dashboard/charts/ExecutorPanel";
import { LivePnLPanel } from "@/components/dashboard/charts/LivePnLPanel";
import { SetupVisualizerPanel } from "@/components/dashboard/charts/SetupVisualizerPanel";
import { AIChatPanel } from "@/components/dashboard/AIChatPanel";

// ====== MAIN DASHBOARD ======
export default function Dashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState("SPX");
  const [countdown, setCountdown] = useState(30);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [analyzingStrike, setAnalyzingStrike] = useState<number | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [histFilter, setHistFilter] = useState({ cfd: 'all', outcome: 'all' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // tRPC queries
  const { data: marketData, refetch: refetchMarket } = trpc.market.getData.useQuery(undefined, { refetchInterval: 15000, staleTime: 10000 });
  const { data: livePrices } = trpc.market.getLivePrices.useQuery(undefined, { refetchInterval: 5000, staleTime: 4000 });
  const { data: sgLivePrices } = trpc.market.getLiveSpotGammaPrices.useQuery(undefined, { refetchInterval: 5000, staleTime: 4000 });
  const { data: tradeAlertsData, refetch: refetchTradeAlerts } = trpc.market.getTradeAlerts.useQuery(undefined, { refetchInterval: 4000, staleTime: 3000 });
  const { data: etfGexData } = trpc.market.getTradierGex.useQuery(undefined, { refetchInterval: 90_000, staleTime: 60_000 });
  const markTradeAlertsRead = trpc.market.markTradeAlertsRead.useMutation({ onSuccess: () => refetchTradeAlerts() });
  const { data: tradeHistoryData, refetch: refetchHistory } = trpc.market.getTradeHistory.useQuery(undefined, { refetchInterval: 30_000, staleTime: 25_000 });
  const resolveTradeManually = trpc.market.resolveTradeManually.useMutation({ onSuccess: () => refetchHistory() });
  const deleteTradeRecord = trpc.market.deleteTradeRecord.useMutation({ onSuccess: () => refetchHistory() });
  const { data: mt5Status } = trpc.market.getMT5Status.useQuery(undefined, { refetchInterval: 8000, retry: false });
  const { data: mt5Positions } = trpc.market.getMT5Positions.useQuery(undefined, { refetchInterval: 8000, retry: false });
  const { data: setupAnalytics } = trpc.market.getSetupAnalytics.useQuery(undefined, { refetchInterval: 60_000, staleTime: 55_000 });
  const { data: trackedSetups } = trpc.market.getAllTrackedSetups.useQuery(undefined, { refetchInterval: 60_000, staleTime: 55_000 });
  const executeMT5Trade = trpc.market.executeMT5Trade.useMutation({ onSuccess: () => refetchHistory() });
  const closeMT5Trade = trpc.market.closeMT5Trade.useMutation({ onSuccess: () => refetchHistory() });
  const fetchHistoricalRange = trpc.market.fetchHistoricalRange.useMutation();
  const { data: rlStatsData, refetch: refetchRLStats } = trpc.market.getRLStats.useQuery(undefined, { refetchInterval: 30_000, staleTime: 25_000 });
  const replayRLHistory = trpc.market.replayRLHistory.useMutation({ onSuccess: () => refetchRLStats() });
  const { data: mlStats, refetch: refetchMLStats } = trpc.market.getMLStats.useQuery(undefined, { refetchInterval: 15_000, staleTime: 10_000 });
  const { data: autoTradingData, refetch: refetchAutoTrading } = trpc.market.getAutoTradingConfig.useQuery(undefined, { refetchInterval: 10_000, staleTime: 8_000 });
  const setAutoTradingConfig = trpc.market.setAutoTradingConfig.useMutation({ onSuccess: () => { refetchAutoTrading(); refetchMLStats(); } });
  const { data: historicalData, refetch: refetchHistorical } = trpc.market.getHistoricalData.useQuery(undefined, { refetchInterval: false, staleTime: Infinity });
  const [mt5Executing, setMt5Executing] = useState<string | null>(null);
  const [backtestStart, setBacktestStart] = useState("2026-01-01");
  const [backtestEnd, setBacktestEnd] = useState(new Date().toISOString().split("T")[0]);
  const [backtestMinScore, setBacktestMinScore] = useState(0);
  const [backtestCfd, setBacktestCfd] = useState("all");
  const [isDownloadingHist, setIsDownloadingHist] = useState(false);
  const { data: backtestData, refetch: refetchBacktest } = trpc.market.runBacktest.useQuery(
    { minScore: backtestMinScore, cfd: backtestCfd === "all" ? undefined : backtestCfd },
    { refetchInterval: false, staleTime: Infinity, enabled: false }
  );

  const cfdPrices = livePrices ?? marketData?.cfdPrices;
  const { data: marketStatus, refetch: refetchStatus } = trpc.market.getStatus.useQuery(undefined, { refetchInterval: 3000 });
  const { data: alerts, refetch: refetchAlerts } = trpc.alerts.getToday.useQuery(undefined, { refetchInterval: 10000 });
  const { data: narration, refetch: refetchNarration } = trpc.narration.getLatest.useQuery(undefined, { refetchInterval: 45000 });

  const generateNarration = trpc.narration.generate.useMutation({ onSuccess: () => refetchNarration() });
  const analyzeZone = trpc.narration.analyzeZone.useMutation({
    onSuccess: (data) => { setAnalysisResult(data.analysis); setAnalyzingStrike(null); },
  });
  const forceRefresh = trpc.market.forceRefresh.useMutation({
    onSuccess: () => { refetchMarket(); refetchAlerts(); toast.success("Datos actualizados"); },
  });

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { refetchMarket(); refetchStatus(); return 15; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [refetchMarket, refetchStatus]);

  // Alert sound
  const playAlertSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = "sine";
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
    } catch (e) { /* ignore */ }
  }, [soundEnabled]);

  // Trade exit alert notifications
  useEffect(() => {
    if (!tradeAlertsData?.alerts) return;
    const unread = tradeAlertsData.alerts.filter((a: any) => !a.read);
    for (const a of unread) {
      if (a.severity === "critical") { playAlertSound(); toast.error(a.title, { description: a.message, duration: 10000 }); }
      else if (a.severity === "warning") { toast.warning(a.title, { description: a.message, duration: 8000 }); }
      else { toast.success(a.title, { description: a.message, duration: 6000 }); }
    }
    if (unread.length > 0) markTradeAlertsRead.mutate();
  }, [tradeAlertsData?.unreadCount]);

  useEffect(() => {
    if (!alerts || alerts.length === 0) return;
    const criticalAlerts = alerts.filter((a: any) => a.severity === "critical" && !a.isRead);
    if (criticalAlerts.length > 0) {
      playAlertSound();
      toast.error(`${criticalAlerts[0].title}`, { description: criticalAlerts[0].message, duration: 8000 });
    }
  }, [alerts?.length, playAlertSound]);

  const selectedAsset = marketData?.assets?.find((a: any) => a.symbol === selectedSymbol);
  const liveAssetPrice = sgLivePrices?.prices?.[selectedSymbol];
  const displayPrice = liveAssetPrice?.price || selectedAsset?.currentPrice || 0;
  const displayChange = liveAssetPrice?.change ?? selectedAsset?.dailyChange ?? 0;
  const displayChangePct = liveAssetPrice?.changePct ?? selectedAsset?.dailyChangePct ?? 0;
  const selectedTradeSetup = marketData?.tradeSetups?.find((t: any) => t.asset === selectedSymbol || t.cfd === selectedSymbol) ||
    marketData?.tradeSetups?.find((t: any) => {
      const assetToCfd: Record<string, string> = { SPX: 'NAS100', SPY: 'NAS100', QQQ: 'NAS100', DIA: 'US30', GLD: 'XAUUSD' };
      return t.cfd === assetToCfd[selectedSymbol];
    });

  const sgLevels = useMemo(() => {
    if (!marketData?.spotgammaLevels) return null;
    const levels = marketData.spotgammaLevels as Record<string, any>;
    return levels[selectedSymbol] || null;
  }, [marketData?.spotgammaLevels, selectedSymbol]);

  const handleAnalyzeStrike = useCallback(
    (strike: number) => {
      if (!selectedAsset) return;
      setAnalyzingStrike(strike); setAnalysisResult(null);
      analyzeZone.mutate({ symbol: selectedSymbol, strike, currentPrice: selectedAsset.currentPrice, gexTrend: marketData?.gex?.gexTrend, hiroTrend: marketData?.hiro?.hiroTrend });
    },
    [selectedAsset, selectedSymbol, marketData, analyzeZone]
  );

  const unreadAlerts = alerts?.filter((a: any) => !a.isRead).length || 0;
  const mt5Connected = (mt5Status as any)?.connected === true;
  const mt5Sim = (mt5Status as any)?.mode === 'simulation';

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ═══ HEADER BAR ═══ */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 py-1.5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Activity className="text-emerald-400" size={18} />
              <span className="font-bold text-foreground text-xs tracking-wider">SPOTGAMMA</span>
            </div>
            <Separator orientation="vertical" className="h-4" />
            <MarketStatusBadge status={marketStatus?.status} />
            <span className="text-[10px] text-muted-foreground font-mono">{marketStatus?.colombiaTime || "—"}</span>

            {/* CFD Prices inline */}
            {cfdPrices && (
              <>
                <Separator orientation="vertical" className="h-4" />
                <div className="flex items-center gap-3">
                  {[{name: 'NAS100', data: cfdPrices.nas100, color: 'text-cyan-400'},
                    {name: 'US30', data: cfdPrices.us30, color: 'text-blue-400'},
                    {name: 'XAUUSD', data: cfdPrices.xauusd, color: 'text-yellow-400'}]
                    .filter(c => c.data?.price > 0)
                    .map(c => (
                    <div key={c.name} className="flex items-center gap-1.5">
                      <span className={`text-[10px] font-bold ${c.color}`}>{c.name}</span>
                      <span className="font-mono text-[10px] font-bold text-foreground">
                        {c.name === 'XAUUSD' ? `$${c.data.price.toFixed(2)}` : c.data.price.toLocaleString(undefined, {maximumFractionDigits: 0})}
                      </span>
                      <span className={`font-mono text-[9px] font-bold ${c.data.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {c.data.changePct >= 0 ? '+' : ''}{c.data.changePct.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* MT5 status indicator */}
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full border text-[9px] font-bold ${
              mt5Connected ? 'border-emerald-500/30 text-emerald-400' : mt5Sim ? 'border-yellow-500/30 text-yellow-400' : 'border-border text-muted-foreground'
            }`}>
              <Wifi size={10} />
              MT5 {mt5Connected ? 'ON' : mt5Sim ? 'SIM' : 'OFF'}
              {mt5Connected && (mt5Positions as any)?.total > 0 && (
                <span className="bg-cyan-500/20 text-cyan-400 px-1 rounded">{(mt5Positions as any)?.total}</span>
              )}
            </div>
            <CountdownRing seconds={countdown} />
            <Button size="sm" variant="outline" onClick={() => setSoundEnabled(!soundEnabled)} className="h-7 w-7 p-0 border-border/50">
              {soundEnabled ? <Volume2 size={12} className="text-emerald-400" /> : <VolumeX size={12} className="text-muted-foreground" />}
            </Button>
            <Button size="sm" variant="outline" onClick={() => forceRefresh.mutate()} disabled={forceRefresh.isPending} className="h-7 text-[10px] border-border/50 px-2">
              <RefreshCw size={10} className={forceRefresh.isPending ? "animate-spin" : ""} />
            </Button>
            {unreadAlerts > 0 && (
              <div className="relative">
                <Bell size={16} className="text-yellow-400" />
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[8px] rounded-full w-3.5 h-3.5 flex items-center justify-center font-bold">
                  {unreadAlerts > 9 ? "9+" : unreadAlerts}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Asset Ticker Bar */}
        <div className="flex items-center gap-1 px-4 pb-1.5 overflow-x-auto">
          {marketData?.assets?.map((asset: any) => {
            const sgPrice = sgLivePrices?.prices?.[asset.symbol];
            const cfd = cfdPrices;
            let dp = asset.currentPrice;
            let dpPct = asset.dailyChangePct || 0;
            if (sgPrice && sgPrice.price && sgPrice.price > 0) { dp = sgPrice.price; dpPct = sgPrice.changePct || 0; }
            else if (asset.symbol === 'UVIX' && cfd?.uvix?.price) { dp = cfd.uvix.price; dpPct = cfd.uvix.changePct || 0; }
            else if (asset.symbol === 'GLD' && cfd?.gld?.price && (asset.currentPrice < 100 || !asset.currentPrice)) { dp = cfd.gld.price; dpPct = cfd.gld.changePct || 0; }
            return (
              <button key={asset.symbol} onClick={() => setSelectedSymbol(asset.symbol)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all whitespace-nowrap ${
                  selectedSymbol === asset.symbol ? "bg-emerald-500/20 border border-emerald-500/50 text-emerald-400" : "bg-card border border-border text-muted-foreground hover:text-foreground"
                }`}>
                <span className="font-bold" style={{ color: SYMBOL_COLORS[asset.symbol] }}>{asset.symbol}</span>
                <span className={dpPct >= 0 ? "text-emerald-400" : "text-red-400"}>{dp ? formatPrice(dp) : '—'}</span>
                <span className={`${dpPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {dpPct >= 0 ? "▲" : "▼"}{Math.abs(dpPct).toFixed(2)}%
                </span>
              </button>
            );
          })}
        </div>
      </header>

      {/* ═══ MAIN CONTENT — 2 columns: main + right sidebar ═══ */}
      <div className="flex flex-1 overflow-hidden">

        {/* ─── MAIN AREA ─── */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4">

            {/* ═══ ALL TRADE SETUPS — Horizontal Cards ═══ */}
            {marketData?.tradeSetups && marketData.tradeSetups.length > 0 && (
              <div>
                <SectionHeader icon={Target} title="SETUPS DE TRADING" badge={
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[8px] border-emerald-500/30 text-emerald-400">{marketData.tradeSetups.length} activos</Badge>
                    {autoTradingData?.effectiveEnabled ? (
                      <Badge className="text-[8px] bg-emerald-600/80 border-0 animate-pulse">🤖 AUTO ON</Badge>
                    ) : autoTradingData?.killSwitch?.triggered ? (
                      <Badge className="text-[8px] bg-red-600/80 border-0">🔴 KILL SWITCH</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[8px] border-yellow-500/30 text-yellow-400">🤖 AUTO OFF</Badge>
                    )}
                    {mlStats?.models?.lstm?.available && (
                      <Badge variant="outline" className="text-[8px] border-purple-500/30 text-purple-400">LSTM+MLP</Badge>
                    )}
                  </div>
                } />
                <div className="grid grid-cols-3 gap-3">
                  {marketData.tradeSetups.map((t: any) => {
                    const isSelected = selectedSymbol === t.asset;
                    return (
                      <div key={t.cfd} className={`cursor-pointer transition-all ${isSelected ? 'ring-2 ring-emerald-500/60 rounded-xl' : 'opacity-80 hover:opacity-100'}`}
                        onClick={() => setSelectedSymbol(t.asset)}>
                        <TradeSetupCard setup={t} />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ═══ NEW PANELS: Executor + Live P&L + Setup Visualizer ═══ */}
            <div className="grid grid-cols-3 gap-3">
              <ExecutorPanel />
              <LivePnLPanel />
              <SetupVisualizerPanel tradeSetups={marketData?.tradeSetups || []} cfdPrices={cfdPrices} />
            </div>

            {/* Selected Asset Header */}
            {selectedAsset && (
              <div className="flex items-center justify-between pt-2 border-t border-border/30">
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold" style={{ color: SYMBOL_COLORS[selectedSymbol] }}>{selectedSymbol}</h1>
                  <div className="font-mono text-2xl font-bold text-foreground">{formatPrice(displayPrice)}</div>
                  <PriceChange value={displayChange} pct={displayChangePct} />
                </div>
                <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-1">
                  <Clock size={10} />
                  {selectedAsset.lastUpdated ? new Date(selectedAsset.lastUpdated).toLocaleTimeString("es-CO", { timeZone: "America/Bogota" }) : "—"}
                </div>
              </div>
            )}

            {/* ═══ TABBED ANALYSIS — Reduced to 5 tabs ═══ */}
            <Tabs defaultValue="gex">
              <TabsList className="bg-card border border-border h-auto gap-0.5 p-1">
                <TabsTrigger value="gex" className="text-[10px] h-7 px-3"><Crosshair size={10} className="mr-1" /> GEX</TabsTrigger>
                <TabsTrigger value="flow-levels" className="text-[10px] h-7 px-3"><Shield size={10} className="mr-1" /> Flujo y Niveles</TabsTrigger>
                <TabsTrigger value="metrics-vol" className="text-[10px] h-7 px-3"><Thermometer size={10} className="mr-1" /> Metricas y Vol</TabsTrigger>
                <TabsTrigger value="strikes" className="text-[10px] h-7 px-3"><Target size={10} className="mr-1" /> Strikes</TabsTrigger>
                <TabsTrigger value="history" className="text-[10px] h-7 px-3"><BookOpen size={10} className="mr-1" /> Historial</TabsTrigger>
                <TabsTrigger value="analytics" className="text-[10px] h-7 px-3"><BarChart2 size={10} className="mr-1" /> Analiticas</TabsTrigger>
                <TabsTrigger value="tendencia" className="text-[10px] h-7 px-3"><Clock size={10} className="mr-1" /> Tendencia 4H</TabsTrigger>
                <TabsTrigger value="backtest" className="text-[10px] h-7 px-3"><Database size={10} className="mr-1" /> Backtest</TabsTrigger>
                <TabsTrigger value="bot" className="text-[10px] h-7 px-3 relative">
                  <span className="mr-1">🤖</span> Bot
                  {autoTradingData?.effectiveEnabled && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                  )}
                  {autoTradingData?.killSwitch?.triggered && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  )}
                </TabsTrigger>
              </TabsList>

              {/* ═══ GEX TAB (combines 0DTE GEX + Gamma Chart + ETF GEX) ═══ */}
              <TabsContent value="gex" className="mt-3 space-y-3">
                <GexTab marketData={marketData} selectedAsset={selectedAsset} selectedSymbol={selectedSymbol} displayPrice={displayPrice} etfGexData={etfGexData} />
              </TabsContent>

              {/* ═══ FLOW & LEVELS TAB (combines Flow + Levels + Expiration) ═══ */}
              <TabsContent value="flow-levels" className="mt-3 space-y-3">
                <FlowLevelsTab selectedAsset={selectedAsset} selectedSymbol={selectedSymbol} marketData={marketData} sgLevels={sgLevels} displayPrice={displayPrice} />
              </TabsContent>

              {/* ═══ METRICS & VOL TAB (combines Metrics + Volatility) ═══ */}
              <MetricsVolTab selectedAsset={selectedAsset} selectedSymbol={selectedSymbol} marketData={marketData} setSelectedSymbol={setSelectedSymbol} />

              {/* ═══ STRIKES TAB ═══ */}
              <StrikesTab selectedAsset={selectedAsset} selectedSymbol={selectedSymbol} handleAnalyzeStrike={handleAnalyzeStrike} analyzingStrike={analyzingStrike} analysisResult={analysisResult} />

              {/* ═══ HISTORIAL TAB ═══ */}
              <TabsContent value="history" className="mt-3">
                <HistoryTab
                  tradeHistoryData={tradeHistoryData}
                  mt5Status={mt5Status}
                  mt5Positions={mt5Positions}
                  mt5Connected={mt5Connected}
                  mt5Sim={mt5Sim}
                  histFilter={histFilter}
                  setHistFilter={setHistFilter}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                  resolveTradeManually={resolveTradeManually}
                  deleteTradeRecord={deleteTradeRecord}
                  executeMT5Trade={executeMT5Trade}
                  closeMT5Trade={closeMT5Trade}
                  mt5Executing={mt5Executing}
                  setMt5Executing={setMt5Executing}
                  refetchHistory={refetchHistory}
                  rlStatsData={rlStatsData}
                  replayRLHistory={replayRLHistory}
                />
              </TabsContent>

              {/* ═══ ANALYTICS TAB ═══ */}
              <TabsContent value="analytics" className="mt-3 space-y-3">
                <AnalyticsTab setupAnalytics={setupAnalytics} />
              </TabsContent>

              {/* ═══ TENDENCIA 4H TAB ═══ */}
              <TabsContent value="tendencia" className="mt-3">
                <MultiTimeframeTab />
              </TabsContent>

              {/* ═══ BACKTEST TAB ═══ */}
              <TabsContent value="backtest" className="mt-3">
                <BacktestTab
                  backtestStart={backtestStart} setBacktestStart={setBacktestStart}
                  backtestEnd={backtestEnd} setBacktestEnd={setBacktestEnd}
                  backtestMinScore={backtestMinScore} setBacktestMinScore={setBacktestMinScore}
                  backtestCfd={backtestCfd} setBacktestCfd={setBacktestCfd}
                  isDownloadingHist={isDownloadingHist} setIsDownloadingHist={setIsDownloadingHist}
                  fetchHistoricalRange={fetchHistoricalRange} refetchHistorical={refetchHistorical}
                  refetchBacktest={refetchBacktest}
                  backtestData={backtestData} historicalData={historicalData}
                />
              </TabsContent>

              {/* ═══ BOT / PPO AUTO-TRADING TAB ═══ */}
              <TabsContent value="bot" className="mt-3 space-y-3">
                <BotConfigTab
                  autoTradingData={autoTradingData}
                  setAutoTradingConfig={setAutoTradingConfig}
                  mlStats={mlStats}
                />
              </TabsContent>

            </Tabs>

            {/* ═══ BOTTOM PANELS: HIRO + Divergence + GEX Tracker ═══ */}
            <div className="grid grid-cols-3 gap-3">
              {/* HIRO Panel */}
              <Card className="bg-card border-border">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
                    <Zap size={12} className="text-yellow-400" /> HIRO
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {marketData?.hiro?.perAsset ? (
                    <div className="space-y-1">
                      {(() => {
                        const ah = marketData.hiro.perAsset[selectedSymbol];
                        if (!ah) return null;
                        return (
                          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-2 mb-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold" style={{ color: SYMBOL_COLORS[selectedSymbol] || '#fff' }}>{selectedSymbol}</span>
                              <TrendBadge trend={ah.hiroTrend} />
                            </div>
                            <div className="flex items-center justify-between mt-1">
                              <span className="text-[9px] text-muted-foreground">HIRO</span>
                              <span className={`font-mono text-xs font-bold ${ah.hiroValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatNumber(ah.hiroValue)}</span>
                            </div>
                            <div className="flex items-center justify-between mt-0.5">
                              <span className="text-[8px] text-muted-foreground">Rango 20d</span>
                              <span className="font-mono text-[8px] text-muted-foreground">{formatNumber(ah.hiroRange30dMin)} → {formatNumber(ah.hiroRange30dMax)}</span>
                            </div>
                          </div>
                        );
                      })()}
                      {Object.entries(marketData.hiro.perAsset)
                        .filter(([sym]: [string, any]) => sym !== selectedSymbol)
                        .sort(([,a]: [string, any], [,b]: [string, any]) => Math.abs(b.hiroValue) - Math.abs(a.hiroValue))
                        .map(([sym, d]: [string, any]) => (
                          <div key={sym} className="flex items-center justify-between py-0.5 cursor-pointer hover:bg-muted/30 rounded px-1" onClick={() => setSelectedSymbol(sym)}>
                            <span className="text-[9px] font-bold" style={{ color: SYMBOL_COLORS[sym] || '#888' }}>{sym}</span>
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono text-[9px] font-bold ${d.hiroValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatNumber(d.hiroValue)}</span>
                              <span className={`text-[8px] px-0.5 rounded ${d.hiroTrend === 'bullish' ? 'bg-emerald-500/20 text-emerald-400' : d.hiroTrend === 'bearish' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'}`}>
                                {d.hiroTrend === 'bullish' ? '▲' : d.hiroTrend === 'bearish' ? '▼' : '—'}
                              </span>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground text-xs py-4">
                      <Zap size={20} className="mx-auto mb-1 opacity-30" /> Cargando...
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* UVIX-GLD Divergence */}
              <UvixGldDivergencePanel vannaContext={marketData?.vannaContext} cfdPrices={cfdPrices} />

              {/* GEX Change Tracker */}
              <Card className="bg-card border-border">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
                    <GitBranch size={12} className="text-purple-400" /> Rastreador GEX
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <GexChangeTrackerPanel gexTracker={marketData?.gexChangeTracker} />
                </CardContent>
              </Card>
            </div>
          </div>
        </main>

        {/* ─── RIGHT SIDEBAR: Narration + Vanna + VIX + Chat + Alerts ─── */}
        <aside className="w-80 border-l border-border bg-card/20 flex-shrink-0 flex flex-col overflow-y-auto">
          {/* Market Narration */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Activity size={9} /> {narration?.narration?.startsWith('📋') ? 'Analisis Pre-Mercado' : 'Narracion IA'}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[8px] text-emerald-400/60 font-mono">auto</span>
                <Button size="sm" variant="ghost" onClick={() => generateNarration.mutate()} disabled={generateNarration.isPending} className="h-5 text-[10px] px-1.5">
                  {generateNarration.isPending ? <RefreshCw size={9} className="animate-spin" /> : <RefreshCw size={9} />}
                </Button>
              </div>
            </div>
            <div className={`rounded-lg p-2.5 border min-h-[60px] ${narration?.narration?.startsWith('📋') ? 'bg-purple-500/5 border-purple-500/30' : 'bg-card/50 border-border/50'}`}>
              {narration ? (
                <div>
                  {narration.narration.startsWith('📋') && (
                    <div className="flex items-center gap-1 mb-1.5">
                      <Zap size={8} className="text-purple-400" />
                      <span className="text-[9px] font-bold text-purple-400">IA</span>
                    </div>
                  )}
                  <p className="text-[10px] text-foreground leading-relaxed whitespace-pre-line">{narration.narration}</p>
                  <div className="text-[8px] text-muted-foreground mt-1.5 font-mono flex items-center gap-1">
                    <Clock size={7} />
                    {narration.createdAt ? new Date(narration.createdAt as Date).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" }) : ""}
                  </div>
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground text-center py-2">
                  <Zap size={14} className="mx-auto mb-1 opacity-30" />
                  <p>Generacion automatica cada 3 min</p>
                </div>
              )}
            </div>
          </div>

          {/* Pre-market Summary */}
          {marketData?.preMarketSummary && (
            <div className="px-3 pt-3 pb-0">
              <div className="rounded-lg p-2.5 border border-yellow-500/30 bg-yellow-500/5">
                <div className="text-[9px] font-bold text-yellow-400 flex items-center gap-1 mb-1.5">
                  <Clock size={9} /> RESUMEN
                </div>
                <p className="text-[10px] text-foreground leading-relaxed">
                  {typeof marketData.preMarketSummary === 'string'
                    ? marketData.preMarketSummary
                    : (marketData.preMarketSummary as any)?.summary || 'Generando...'}
                </p>
              </div>
            </div>
          )}

          {/* VIX-SPX Correlation */}
          <div className="px-3 pt-3 pb-0">
            <VixCorrelationPanel correlation={marketData?.vixSpxCorrelation} />
          </div>

          {/* Vanna Monitor */}
          {marketData?.vannaContext && (
            <div className="px-3 pt-3 pb-0">
              <div className="rounded-lg p-2.5 border border-blue-500/30 bg-blue-500/5">
                <div className="text-[9px] font-bold text-blue-400 flex items-center gap-1 mb-2">
                  <Zap size={9} /> VANNA MONITOR
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">VIX</span>
                    <div className="flex items-center gap-1">
                      <span className={`font-mono text-[10px] font-bold ${(marketData.vannaContext.vixChangePct || 0) < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(marketData.vannaContext.vixChangePct || 0) > 0 ? '+' : ''}{(marketData.vannaContext.vixChangePct || 0).toFixed(1)}%
                      </span>
                      <span className={`text-[8px] px-1 rounded font-bold ${
                        marketData.vannaContext.vixVannaSignal === 'bullish' ? 'bg-emerald-500/20 text-emerald-400' :
                        marketData.vannaContext.vixVannaSignal === 'bearish' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'
                      }`}>{marketData.vannaContext.vixVannaSignal === 'bullish' ? 'ALC' : marketData.vannaContext.vixVannaSignal === 'bearish' ? 'BAJ' : 'NEU'}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">UVXY</span>
                    <div className="flex items-center gap-1">
                      <span className={`font-mono text-[10px] font-bold ${(marketData.vannaContext.uvxyChangePct || 0) < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(marketData.vannaContext.uvxyChangePct || 0) > 0 ? '+' : ''}{(marketData.vannaContext.uvxyChangePct || 0).toFixed(1)}%
                      </span>
                      <span className={`text-[8px] px-1 rounded font-bold ${
                        marketData.vannaContext.uvxyRefugeSignal === 'buy_gold' ? 'bg-yellow-500/20 text-yellow-400' :
                        marketData.vannaContext.uvxyRefugeSignal === 'risk_on' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-400'
                      }`}>{marketData.vannaContext.uvxyRefugeSignal === 'buy_gold' ? 'ORO' : marketData.vannaContext.uvxyRefugeSignal === 'risk_on' ? 'RISK' : 'NEU'}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">GLD IV</span>
                    <div className="flex items-center gap-1">
                      <span className={`font-mono text-[10px] font-bold ${(marketData.vannaContext.gldIVChange || 0) < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {(marketData.vannaContext.gldIVChange || 0) > 0 ? '+' : ''}{((marketData.vannaContext.gldIVChange || 0) * 100).toFixed(1)}%
                      </span>
                      <span className={`text-[8px] px-1 rounded font-bold ${
                        marketData.vannaContext.gldVannaSignal === 'bullish' ? 'bg-emerald-500/20 text-emerald-400' :
                        marketData.vannaContext.gldVannaSignal === 'bearish' ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'
                      }`}>{marketData.vannaContext.gldVannaSignal === 'bullish' ? 'ALC' : marketData.vannaContext.gldVannaSignal === 'bearish' ? 'BAJ' : 'NEU'}</span>
                    </div>
                  </div>
                  <Separator className="my-1" />
                  <div className="space-y-0.5">
                    {marketData.vannaContext.indexVannaActive && <div className="text-[9px] font-bold text-blue-400">Vanna Indices ACTIVO</div>}
                    {marketData.vannaContext.goldVannaActive && <div className="text-[9px] font-bold text-yellow-400">Vanna GLD ACTIVO</div>}
                    {marketData.vannaContext.refugeFlowActive && <div className="text-[9px] font-bold text-orange-400 animate-pulse">FLUJO REFUGIO</div>}
                    {!marketData.vannaContext.indexVannaActive && !marketData.vannaContext.goldVannaActive && !marketData.vannaContext.refugeFlowActive && (
                      <div className="text-[9px] text-muted-foreground">Sin vanna activo</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* AI Chat */}
          <div className="border-y border-border mt-3" style={{ height: '260px' }}>
            <AIChatPanel />
          </div>

          {/* Alerts */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-[200px]">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
              <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Bell size={9} /> Alertas
                {unreadAlerts > 0 && (
                  <span className="bg-red-500 text-white text-[8px] rounded-full px-1.5 py-0.5 font-bold ml-1">{unreadAlerts}</span>
                )}
              </div>
            </div>
            <ScrollArea className="flex-1 p-2">
              {alerts && alerts.length > 0 ? (
                alerts.map((alert: any) => <AlertItem key={alert.id} alert={alert} />)
              ) : (
                <div className="text-center text-muted-foreground text-[10px] py-6">
                  <Bell size={20} className="mx-auto mb-1.5 opacity-30" />
                  <p>Sin alertas</p>
                </div>
              )}
            </ScrollArea>
          </div>
        </aside>
      </div>
    </div>
  );
}
