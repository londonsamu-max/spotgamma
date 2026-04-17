import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Activity, Bell, RefreshCw, TrendingUp, TrendingDown, Target,
  DollarSign, ArrowUpCircle, ArrowDownCircle, PauseCircle, CheckCircle, XCircle, Zap, Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SYMBOL_COLORS, formatNumber, formatPrice } from "@/components/dashboard/constants";
import { MarketStatusBadge } from "@/components/dashboard/shared";
import { AlertItem } from "@/components/dashboard/charts";

type MobileTab = "inicio" | "trades" | "pnl" | "alertas";

export default function MobileDashboard() {
  const [activeTab, setActiveTab] = useState<MobileTab>("inicio");
  const audioCtxRef = useRef<AudioContext | null>(null);

  // tRPC queries — longer intervals for mobile
  const { data: marketData, refetch: refetchMarket } = trpc.market.getData.useQuery(undefined, { refetchInterval: 20000 });
  const { data: livePrices } = trpc.market.getLivePrices.useQuery(undefined, { refetchInterval: 8000 });
  const { data: tradeAlertsData, refetch: refetchTradeAlerts } = trpc.market.getTradeAlerts.useQuery(undefined, { refetchInterval: 6000 });
  const markTradeAlertsRead = trpc.market.markTradeAlertsRead.useMutation({ onSuccess: () => refetchTradeAlerts() });
  const { data: tradeHistoryData } = trpc.market.getTradeHistory.useQuery(undefined, { refetchInterval: 30000 });
  const { data: mt5Status } = trpc.market.getMT5Status.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const { data: mt5Positions } = trpc.market.getMT5Positions.useQuery(undefined, { refetchInterval: 10000, retry: false });
  const { data: marketStatus } = trpc.market.getStatus.useQuery(undefined, { refetchInterval: 5000 });
  const { data: alerts } = trpc.alerts.getToday.useQuery(undefined, { refetchInterval: 10000 });
  const { data: autoTradingData } = trpc.market.getAutoTradingConfig.useQuery(undefined, { refetchInterval: 15000 });
  const forceRefresh = trpc.market.forceRefresh.useMutation({
    onSuccess: () => { refetchMarket(); toast.success("Actualizado"); },
  });

  const cfdPrices = livePrices ?? marketData?.cfdPrices;
  const mt5Connected = (mt5Status as any)?.connected === true;
  const unreadAlerts = alerts?.filter((a: any) => !a.isRead).length || 0;
  const unreadTradeAlerts = tradeAlertsData?.unreadCount || 0;

  // Alert sound
  const playAlertSound = useCallback(() => {
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
    } catch { /* ignore */ }
  }, []);

  // Trade alert notifications
  useEffect(() => {
    if (!tradeAlertsData?.alerts) return;
    const unread = tradeAlertsData.alerts.filter((a: any) => !a.read);
    for (const a of unread) {
      if (a.severity === "critical") { playAlertSound(); toast.error(a.title, { description: a.message }); }
      else if (a.severity === "warning") toast.warning(a.title, { description: a.message });
      else toast.success(a.title, { description: a.message });
    }
    if (unread.length > 0) markTradeAlertsRead.mutate();
  }, [tradeAlertsData?.unreadCount]);

  const tradeSetups = marketData?.tradeSetups || [];
  const stats = tradeHistoryData?.stats as any;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ═══ MOBILE HEADER ═══ */}
      <header className="border-b border-border bg-card/50 sticky top-0 z-50 px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="text-emerald-400" size={16} />
            <span className="font-bold text-foreground text-xs">SG</span>
            <MarketStatusBadge status={marketStatus?.status} />
          </div>
          <div className="flex items-center gap-2">
            {mt5Connected && <Badge variant="outline" className="text-[8px] border-emerald-500/30 text-emerald-400">MT5</Badge>}
            {autoTradingData?.effectiveEnabled && <Badge className="text-[8px] bg-emerald-600/80 border-0 animate-pulse">AUTO</Badge>}
            <Button size="sm" variant="outline" onClick={() => forceRefresh.mutate()} disabled={forceRefresh.isPending} className="h-6 w-6 p-0 border-border/50">
              <RefreshCw size={10} className={forceRefresh.isPending ? "animate-spin" : ""} />
            </Button>
            {(unreadAlerts + unreadTradeAlerts) > 0 && (
              <div className="relative" onClick={() => setActiveTab("alertas")}>
                <Bell size={14} className="text-yellow-400" />
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[7px] rounded-full w-3 h-3 flex items-center justify-center font-bold">
                  {unreadAlerts + unreadTradeAlerts}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* CFD Price Strip */}
        <div className="flex items-center gap-3 mt-1.5 overflow-x-auto pb-0.5">
          {[
            { name: "NAS100", data: cfdPrices?.nas100, color: "text-cyan-400" },
            { name: "US30", data: cfdPrices?.us30, color: "text-blue-400" },
            { name: "XAUUSD", data: cfdPrices?.xauusd, color: "text-yellow-400" },
          ].filter(c => c.data && c.data.price && c.data.price > 0).map(c => {
            const d = c.data!;
            return (
              <div key={c.name} className="flex items-center gap-1 shrink-0">
                <span className={`text-[10px] font-bold ${c.color}`}>{c.name}</span>
                <span className="font-mono text-[10px] font-bold text-foreground">
                  {c.name === "XAUUSD" ? `$${d.price!.toFixed(2)}` : d.price!.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className={`font-mono text-[9px] font-bold ${(d.changePct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {(d.changePct ?? 0) >= 0 ? "+" : ""}{(d.changePct ?? 0).toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      </header>

      {/* ═══ CONTENT ═══ */}
      <main className="flex-1 overflow-y-auto pb-16">
        {activeTab === "inicio" && (
          <div className="p-3 space-y-3">
            {/* Trade Setups */}
            {tradeSetups.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Target size={10} /> SETUPS ACTIVOS
                </div>
                <div className="space-y-2">
                  {tradeSetups.map((setup: any) => {
                    const isLong = setup.direction === "LONG";
                    const isShort = setup.direction === "SHORT";
                    const isNoTrade = setup.direction === "NO_TRADE";
                    const Icon = isLong ? ArrowUpCircle : isShort ? ArrowDownCircle : PauseCircle;
                    const dirColor = isLong ? "text-emerald-400" : isShort ? "text-red-400" : "text-slate-400";
                    const dirBg = isLong ? "border-emerald-500/30 bg-emerald-500/5" : isShort ? "border-red-500/30 bg-red-500/5" : "border-slate-500/30 bg-slate-500/5";
                    const dirLabel = isLong ? "COMPRA" : isShort ? "VENTA" : "NO OPERAR";
                    const scoreColor = setup.score >= 70 ? "text-emerald-400" : setup.score >= 50 ? "text-yellow-400" : "text-red-400";
                    const decimals = setup.cfd === "XAUUSD" ? 2 : 0;
                    const fmt = (v: number) => v ? v.toFixed(decimals) : "—";

                    const confirmations = [
                      { label: "GEX", ok: setup.gexConfirmed },
                      { label: "HIRO", ok: setup.hiroConfirmed },
                      { label: "TAPE", ok: setup.tapeConfirmed },
                      { label: "NIVEL", ok: setup.levelConfirmed },
                      { label: "VANNA", ok: setup.vannaConfirmed },
                      { label: "REG", ok: setup.regimeConfirmed },
                    ];
                    const confirmedCount = confirmations.filter(c => c.ok).length;

                    return (
                      <Card key={setup.cfd} className={`border ${dirBg}`}>
                        <CardContent className="p-3">
                          {/* Header */}
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Icon size={18} className={dirColor} />
                              <span className={`text-sm font-black ${dirColor}`}>{dirLabel}</span>
                              <span className="text-xs font-bold text-cyan-400">{setup.cfd}</span>
                            </div>
                            <span className={`font-mono text-lg font-black ${scoreColor}`}>{setup.score}</span>
                          </div>

                          {/* Confirmations */}
                          <div className="grid grid-cols-6 gap-1 mb-2">
                            {confirmations.map(c => (
                              <div key={c.label} className={`text-center py-0.5 rounded border text-[8px] font-bold ${
                                c.ok ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-red-500/5 border-red-500/20 text-red-400/60"
                              }`}>
                                {c.ok ? <CheckCircle size={7} className="inline" /> : <XCircle size={7} className="inline" />} {c.label}
                              </div>
                            ))}
                          </div>

                          {/* Levels */}
                          {!isNoTrade && setup.cfdEntryPrice > 0 && (
                            <div className="grid grid-cols-4 gap-1.5 text-[9px]">
                              <div className="bg-blue-500/10 rounded p-1.5 text-center">
                                <div className="text-blue-400 font-bold">ENTRY</div>
                                <div className="font-mono font-bold text-foreground">{fmt(setup.cfdEntryPrice)}</div>
                              </div>
                              <div className="bg-red-500/10 rounded p-1.5 text-center">
                                <div className="text-red-400 font-bold">SL</div>
                                <div className="font-mono font-bold text-red-400">{fmt(setup.stopLoss)}</div>
                              </div>
                              <div className="bg-emerald-500/10 rounded p-1.5 text-center">
                                <div className="text-emerald-400 font-bold">TP1</div>
                                <div className="font-mono font-bold text-emerald-400">{fmt(setup.takeProfit1)}</div>
                              </div>
                              <div className="bg-emerald-500/10 rounded p-1.5 text-center">
                                <div className="text-emerald-400 font-bold">R:R</div>
                                <div className="font-mono font-bold text-foreground">1:{setup.riskRewardRatio?.toFixed(1)}</div>
                              </div>
                            </div>
                          )}

                          {/* Reason */}
                          <p className="text-[9px] text-muted-foreground mt-2 leading-snug line-clamp-2">{setup.reason}</p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quick Stats */}
            {stats && (
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "Total", value: stats.total || 0, color: "text-foreground" },
                  { label: "Win%", value: `${stats.winRate || 0}%`, color: stats.winRate >= 60 ? "text-emerald-400" : stats.winRate >= 40 ? "text-yellow-400" : "text-red-400" },
                  { label: "Wins", value: stats.wins || 0, color: "text-emerald-400" },
                  { label: "Losses", value: stats.losses || 0, color: "text-red-400" },
                ].map(s => (
                  <Card key={s.label} className="bg-card border-border">
                    <CardContent className="p-2 text-center">
                      <div className="text-[8px] text-muted-foreground">{s.label}</div>
                      <div className={`font-mono text-sm font-bold ${s.color}`}>{s.value}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* HIRO Summary */}
            {marketData?.hiro?.perAsset && (
              <Card className="bg-card border-border">
                <CardContent className="p-3">
                  <div className="text-[10px] font-bold text-yellow-400 mb-2 flex items-center gap-1">
                    <Zap size={10} /> HIRO
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(marketData.hiro.perAsset).slice(0, 4).map(([sym, d]: [string, any]) => (
                      <div key={sym} className="flex items-center justify-between">
                        <span className="text-[10px] font-bold" style={{ color: SYMBOL_COLORS[sym] || "#888" }}>{sym}</span>
                        <div className="flex items-center gap-1">
                          <span className={`font-mono text-[10px] font-bold ${d.hiroValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {formatNumber(d.hiroValue)}
                          </span>
                          <span className={`text-[8px] px-1 rounded ${
                            d.hiroTrend === "bullish" ? "bg-emerald-500/20 text-emerald-400" :
                            d.hiroTrend === "bearish" ? "bg-red-500/20 text-red-400" : "bg-slate-500/20 text-slate-400"
                          }`}>
                            {d.hiroTrend === "bullish" ? "ALC" : d.hiroTrend === "bearish" ? "BAJ" : "NEU"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {activeTab === "trades" && (
          <div className="p-3 space-y-2">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
              MT5 {mt5Connected ? "Conectado" : "Desconectado"}
              {mt5Connected && (mt5Status as any)?.balance && (
                <span className="ml-2 font-mono text-foreground">Bal: {(mt5Status as any).balance.toLocaleString()}</span>
              )}
            </div>

            {/* Open positions from MT5 */}
            {(mt5Positions as any)?.positions?.length > 0 ? (
              (mt5Positions as any).positions.map((pos: any, i: number) => (
                <Card key={i} className={`border ${pos.profit >= 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${pos.type === 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {pos.type === 0 ? "LONG" : "SHORT"}
                        </span>
                        <span className="text-xs font-bold text-cyan-400">{pos.symbol}</span>
                        <span className="text-[9px] text-muted-foreground">#{pos.ticket}</span>
                      </div>
                      <span className={`font-mono text-sm font-bold ${pos.profit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {pos.profit >= 0 ? "+" : ""}{pos.profit?.toFixed(2)}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-1.5 text-[9px]">
                      <div><span className="text-muted-foreground">Open: </span><span className="font-mono">{pos.openPrice}</span></div>
                      <div><span className="text-muted-foreground">SL: </span><span className="font-mono text-red-400">{pos.sl || "—"}</span></div>
                      <div><span className="text-muted-foreground">TP: </span><span className="font-mono text-emerald-400">{pos.tp || "—"}</span></div>
                    </div>
                  </CardContent>
                </Card>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground text-xs">
                <DollarSign size={24} className="mx-auto mb-2 opacity-30" />
                Sin posiciones abiertas
              </div>
            )}

            {/* Recent trades from history */}
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-4 mb-1">Ultimos Trades</div>
            {(tradeHistoryData?.records || []).slice(0, 10).map((r: any) => {
              const isWin = ["tp1", "tp2", "tp3"].includes(r.outcome);
              const isLoss = r.outcome === "sl";
              const isOpen = r.outcome === "open";
              return (
                <div key={r.id} className="flex items-center justify-between py-1.5 border-b border-border/30 text-[10px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{r.sessionDate?.slice(5)}</span>
                    <span className="font-bold text-foreground">{r.cfd}</span>
                    <span className={r.direction === "SHORT" ? "text-red-400" : "text-emerald-400"}>{r.direction}</span>
                  </div>
                  <span className={`font-bold ${isWin ? "text-emerald-400" : isLoss ? "text-red-400" : isOpen ? "text-yellow-400 animate-pulse" : "text-muted-foreground"}`}>
                    {r.outcome?.toUpperCase()}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "pnl" && (
          <div className="p-3 space-y-3">
            {stats ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "Win Rate", value: `${stats.winRate || 0}%`, color: stats.winRate >= 60 ? "text-emerald-400" : "text-yellow-400" },
                    { label: "Avg R:R", value: `1:${stats.avgRR || 0}`, color: "text-cyan-400" },
                    { label: "Best Streak", value: stats.bestStreak || 0, color: "text-emerald-400" },
                    { label: "Current Streak", value: stats.currentStreak || 0, color: stats.currentStreak >= 0 ? "text-emerald-400" : "text-red-400" },
                  ].map(s => (
                    <Card key={s.label} className="bg-card border-border">
                      <CardContent className="p-3 text-center">
                        <div className="text-[9px] text-muted-foreground">{s.label}</div>
                        <div className={`font-mono text-xl font-bold ${s.color}`}>{s.value}</div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* By CFD */}
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Por CFD</div>
                {["NAS100", "US30", "XAUUSD"].map(cfd => {
                  const cs = stats.byCfd?.[cfd] || { total: 0, wins: 0, losses: 0, winRate: 0 };
                  return (
                    <Card key={cfd} className="bg-card border-border">
                      <CardContent className="p-2.5 flex items-center justify-between">
                        <span className="text-xs font-bold text-foreground">{cfd}</span>
                        <div className="flex items-center gap-3 text-[10px]">
                          <span className="text-muted-foreground">{cs.total} ops</span>
                          <span className="text-emerald-400">{cs.wins}W</span>
                          <span className="text-red-400">{cs.losses}L</span>
                          <span className={`font-bold ${cs.winRate >= 60 ? "text-emerald-400" : cs.winRate >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                            {cs.winRate}%
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}

                {/* MT5 Account */}
                {mt5Connected && (mt5Status as any)?.balance && (
                  <>
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-2">Cuenta MT5</div>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Balance", value: `$${(mt5Status as any).balance?.toLocaleString()}` },
                        { label: "Equity", value: `$${(mt5Status as any).equity?.toLocaleString()}` },
                        { label: "Profit", value: `${(mt5Status as any).profit >= 0 ? "+" : ""}$${(mt5Status as any).profit?.toFixed(2)}`, color: (mt5Status as any).profit >= 0 ? "text-emerald-400" : "text-red-400" },
                        { label: "Margin", value: `$${(mt5Status as any).margin?.toFixed(2)}` },
                      ].map(s => (
                        <Card key={s.label} className="bg-card border-border">
                          <CardContent className="p-2 text-center">
                            <div className="text-[8px] text-muted-foreground">{s.label}</div>
                            <div className={`font-mono text-xs font-bold ${(s as any).color || "text-foreground"}`}>{s.value}</div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-xs">Cargando estadisticas...</div>
            )}
          </div>
        )}

        {activeTab === "alertas" && (
          <div className="p-3 space-y-2">
            {alerts && alerts.length > 0 ? (
              alerts.map((alert: any) => <AlertItem key={alert.id} alert={alert} />)
            ) : (
              <div className="text-center py-8 text-muted-foreground text-xs">
                <Bell size={24} className="mx-auto mb-2 opacity-30" />
                Sin alertas
              </div>
            )}
          </div>
        )}
      </main>

      {/* ═══ BOTTOM NAV ═══ */}
      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border flex items-center justify-around py-2 z-50">
        {([
          { id: "inicio" as MobileTab, label: "Inicio", icon: Activity },
          { id: "trades" as MobileTab, label: "Trades", icon: DollarSign },
          { id: "pnl" as MobileTab, label: "P&L", icon: TrendingUp },
          { id: "alertas" as MobileTab, label: "Alertas", icon: Bell, badge: unreadAlerts + unreadTradeAlerts },
        ]).map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors relative ${
                isActive ? "text-emerald-400" : "text-muted-foreground"
              }`}>
              <Icon size={18} />
              <span className="text-[9px] font-bold">{tab.label}</span>
              {tab.badge && tab.badge > 0 && (
                <span className="absolute -top-0.5 right-1 bg-red-500 text-white text-[7px] rounded-full w-3.5 h-3.5 flex items-center justify-center font-bold">
                  {tab.badge > 9 ? "9+" : tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
