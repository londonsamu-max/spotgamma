import { Wifi, Trash2, BookOpen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function HistoryTab({
  tradeHistoryData, mt5Status, mt5Positions, mt5Connected, mt5Sim,
  histFilter, setHistFilter, expandedId, setExpandedId,
  resolveTradeManually, deleteTradeRecord, executeMT5Trade, closeMT5Trade,
  mt5Executing, setMt5Executing, refetchHistory,
  rlStatsData, replayRLHistory,
}: {
  tradeHistoryData: any; mt5Status: any; mt5Positions: any;
  mt5Connected: boolean; mt5Sim: boolean;
  histFilter: { cfd: string; outcome: string }; setHistFilter: (f: any) => void;
  expandedId: string | null; setExpandedId: (id: string | null) => void;
  resolveTradeManually: any; deleteTradeRecord: any; executeMT5Trade: any; closeMT5Trade: any;
  mt5Executing: string | null; setMt5Executing: (id: string | null) => void;
  refetchHistory: () => void;
  rlStatsData: any; replayRLHistory: any;
}) {
  const records: any[] = tradeHistoryData?.records || [];
  const stats: any = tradeHistoryData?.stats || {};

  const filtered = records.filter(r => {
    if (histFilter.cfd !== 'all' && r.cfd !== histFilter.cfd) return false;
    if (histFilter.outcome === 'open' && r.outcome !== 'open') return false;
    if (histFilter.outcome === 'wins' && !['tp1','tp2','tp3'].includes(r.outcome)) return false;
    if (histFilter.outcome === 'losses' && r.outcome !== 'sl') return false;
    return true;
  }).sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

  const outcomeLabel: Record<string, { label: string; color: string }> = {
    open:      { label: 'ABIERTA', color: 'text-yellow-400 animate-pulse' },
    tp1:       { label: 'TP1 \u2713',   color: 'text-emerald-400' },
    tp2:       { label: 'TP2 \u2713\u2713',  color: 'text-emerald-300' },
    tp3:       { label: 'TP3 \u2713\u2713\u2713', color: 'text-emerald-200' },
    sl:        { label: 'SL \u2717',     color: 'text-red-400' },
    cancelled: { label: 'CANCEL',   color: 'text-muted-foreground' },
  };

  return (
    <div className="space-y-3">
      {/* MT5 STATUS */}
      <div className={`flex items-center justify-between px-3 py-2 rounded-lg border ${mt5Connected ? 'border-emerald-500/30 bg-emerald-500/5' : mt5Sim ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${mt5Connected ? 'bg-emerald-400 animate-pulse' : mt5Sim ? 'bg-yellow-400' : 'bg-red-400'}`} />
          <span className="text-[10px] font-bold text-foreground">MT5</span>
          <span className={`text-[9px] ${mt5Connected ? 'text-emerald-400' : mt5Sim ? 'text-yellow-400' : 'text-muted-foreground'}`}>
            {mt5Connected ? `Conectado — ${(mt5Status as any)?.account}` : mt5Sim ? 'Simulacion' : 'No disponible'}
          </span>
        </div>
        {mt5Connected && (
          <div className="flex items-center gap-3 text-[9px] font-mono">
            <span className="text-muted-foreground">Bal: <b className="text-foreground">{(mt5Status as any)?.balance?.toLocaleString()}</b></span>
            <span className={`font-bold ${((mt5Status as any)?.profit ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              P&L: {((mt5Status as any)?.profit ?? 0) >= 0 ? '+' : ''}{(mt5Status as any)?.profit?.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* STATS */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { label: 'Total', value: stats.total || 0, color: 'text-foreground' },
          { label: 'Tasa Victoria', value: `${stats.winRate || 0}%`, color: stats.winRate >= 60 ? 'text-emerald-400' : stats.winRate >= 40 ? 'text-yellow-400' : 'text-red-400' },
          { label: 'RR Prom', value: `1:${stats.avgRR || 0}`, color: 'text-cyan-400' },
          { label: 'Ganadas', value: stats.wins || 0, color: 'text-emerald-400' },
          { label: 'Perdidas', value: stats.losses || 0, color: 'text-red-400' },
        ].map(s => (
          <Card key={s.label} className="bg-card border-border">
            <CardContent className="p-2 text-center">
              <div className="text-[8px] text-muted-foreground mb-0.5">{s.label}</div>
              <div className={`font-mono text-sm font-bold ${s.color}`}>{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* POR CFD */}
      <div className="grid grid-cols-3 gap-2">
        {['NAS100','US30','XAUUSD'].map(cfd => {
          const cs = stats.byCfd?.[cfd] || { total:0, wins:0, losses:0, winRate:0 };
          return (
            <Card key={cfd} className="bg-card border-border">
              <CardContent className="p-1.5 flex items-center justify-between">
                <span className="text-[10px] font-bold text-foreground">{cfd}</span>
                <div className="text-right">
                  <span className="text-[9px] text-muted-foreground">{cs.total} ops · </span>
                  <span className={`text-[10px] font-bold ${cs.winRate >= 60 ? 'text-emerald-400' : cs.winRate >= 40 ? 'text-yellow-400' : 'text-muted-foreground'}`}>{cs.winRate}%</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* RL AGENT CARD */}
      {rlStatsData && (() => {
        const volLabels = ['SKIP','0.25x','1x','1.5x','2x'];
        const riskLabels = ['TIGHT','NORMAL','WIDE'];
        const setupLabels = ['ALL','BOUNCE','BREAK'];
        const entryLabels = ['INMEDIATO','ESPERAR','AGRESIVO'];
        const riskColors = ['text-blue-400','text-cyan-400','text-orange-400'];
        const setupColors = ['text-cyan-400','text-emerald-400','text-red-400'];
        const entryColors = ['text-cyan-400','text-yellow-400','text-orange-400'];
        const volColors = ['text-muted-foreground','text-blue-400','text-cyan-400','text-yellow-400','text-orange-400'];
        const exploitPct = Math.max(0, 100 - rlStatsData.epsilon * 100);
        return (
        <Card className="bg-card border-border">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-cyan-400">RL Adaptivo — 4 Q-Tables</span>
              <button
                disabled={replayRLHistory.isPending}
                onClick={() => replayRLHistory.mutate()}
                className="text-[9px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
              >
                {replayRLHistory.isPending ? 'Replay...' : 'Replay'}
              </button>
            </div>
            {/* Learning progress */}
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] text-muted-foreground">Aprendizaje</span>
                <span className="text-[9px] font-mono">
                  <span className="text-yellow-400">{(rlStatsData.epsilon * 100).toFixed(0)}% explora</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-emerald-400">{exploitPct.toFixed(0)}% explota</span>
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden flex">
                <div className="h-full bg-emerald-500/70 rounded-l-full transition-all" style={{ width: `${exploitPct}%` }} />
                <div className="h-full bg-yellow-400/50 rounded-r-full transition-all" style={{ width: `${rlStatsData.epsilon * 100}%` }} />
              </div>
            </div>
            {/* Stats row */}
            <div className="grid grid-cols-4 gap-1.5 text-center">
              <div>
                <div className="text-[11px] font-bold font-mono text-foreground">{rlStatsData.totalEpisodes}</div>
                <div className="text-[8px] text-muted-foreground">Episodios</div>
              </div>
              <div>
                <div className="text-[11px] font-bold font-mono text-foreground">{rlStatsData.statesVisited}</div>
                <div className="text-[8px] text-muted-foreground">Estados</div>
              </div>
              <div>
                <div className={`text-[11px] font-bold font-mono ${rlStatsData.totalWins > rlStatsData.totalLosses ? 'text-emerald-400' : 'text-red-400'}`}>
                  {rlStatsData.totalEpisodes > 0 ? `${Math.round(rlStatsData.totalWins / rlStatsData.totalEpisodes * 100)}%` : '--'}
                </div>
                <div className="text-[8px] text-muted-foreground">Win Rate</div>
              </div>
              <div>
                <div className="text-[11px] font-bold font-mono text-foreground">v{rlStatsData.version || 0}</div>
                <div className="text-[8px] text-muted-foreground">Version</div>
              </div>
            </div>
            {/* Policy decisions per CFD */}
            <div className="space-y-1">
              <div className="text-[9px] text-muted-foreground font-medium">Politica actual por estado</div>
              {rlStatsData.topStates && rlStatsData.topStates.slice(0, 8).map((s: any) => {
                const parts = s.stateKey.split('|');
                const cfd = parts[6] || '?';
                const time = parts[5] || '?';
                const score = parts[0] || '?';
                const bestVol = volLabels[s.bestAction] || '?';
                const bestRisk = riskLabels[s.bestRiskAction] || riskLabels[1];
                const bestSetup = setupLabels[s.bestSetupTypeAction] || setupLabels[0];
                const bestEntry = entryLabels[s.bestEntryAction] || entryLabels[0];
                return (
                  <div key={s.stateKey} className="bg-muted/30 rounded px-2 py-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[9px] font-bold text-foreground">{cfd} <span className="text-muted-foreground font-normal">{time} / {score}</span></span>
                      <span className="text-[8px] text-muted-foreground">{s.visits}x</span>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      <span className={`text-[8px] px-1 py-px rounded ${s.bestAction === 0 ? 'bg-red-500/20 text-red-400' : 'bg-cyan-500/15'} ${volColors[s.bestAction]}`}>
                        Vol:{bestVol}
                      </span>
                      <span className={`text-[8px] px-1 py-px rounded bg-cyan-500/15 ${riskColors[s.bestRiskAction] || riskColors[1]}`}>
                        {bestRisk}
                      </span>
                      <span className={`text-[8px] px-1 py-px rounded bg-cyan-500/15 ${setupColors[s.bestSetupTypeAction] || setupColors[0]}`}>
                        {bestSetup}
                      </span>
                      <span className={`text-[8px] px-1 py-px rounded bg-cyan-500/15 ${entryColors[s.bestEntryAction] || entryColors[0]}`}>
                        {bestEntry}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        );
      })()}

      {/* FILTERS */}
      <div className="flex gap-1.5 flex-wrap">
        {['all','NAS100','US30','XAUUSD'].map(c => (
          <button key={c} onClick={() => setHistFilter((f: any) => ({ ...f, cfd: c }))}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${histFilter.cfd === c ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400' : 'border-border text-muted-foreground hover:border-cyan-500/30'}`}>
            {c === 'all' ? 'Todos' : c}
          </button>
        ))}
        <div className="w-px bg-border mx-0.5" />
        {[{k:'all',l:'Todas'},{k:'open',l:'Abiertas'},{k:'wins',l:'Ganadas'},{k:'losses',l:'Perdidas'}].map(({ k, l }) => (
          <button key={k} onClick={() => setHistFilter((f: any) => ({ ...f, outcome: k }))}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${histFilter.outcome === k ? 'bg-purple-500/20 border-purple-500/40 text-purple-400' : 'border-border text-muted-foreground hover:border-purple-500/30'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* TABLE */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-xs">
              <BookOpen size={28} className="mx-auto mb-2 opacity-30" />
              Sin registros. Los setups con score ≥ 75 se registran automaticamente.
            </div>
          ) : (
            <div className="divide-y divide-border">
              <div className="grid grid-cols-8 gap-1 px-3 py-1.5 text-[9px] text-muted-foreground font-medium bg-card/50">
                <span>Fecha</span><span>CFD</span><span>Dir</span><span>Score</span>
                <span>Entrada</span><span>SL</span><span>RR</span><span>Resultado</span>
              </div>
              {filtered.map((r: any) => {
                const oc = outcomeLabel[r.outcome] || { label: r.outcome, color: 'text-muted-foreground' };
                const isExpanded = expandedId === r.id;
                return (
                  <div key={r.id}>
                    <button onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      className="w-full grid grid-cols-8 gap-1 px-3 py-1.5 text-[10px] hover:bg-muted/30 transition-colors text-left">
                      <span className="text-muted-foreground font-mono">{r.sessionDate?.slice(5)}</span>
                      <span className="font-bold text-foreground">{r.cfd}</span>
                      <span className={r.direction === 'SHORT' ? 'text-red-400' : 'text-emerald-400'}>{r.direction}</span>
                      <span className={`font-mono font-bold ${r.score >= 90 ? 'text-emerald-400' : r.score >= 75 ? 'text-yellow-400' : 'text-muted-foreground'}`}>{r.score}</span>
                      <span className="font-mono text-foreground">{r.cfd === 'XAUUSD' ? r.cfdEntryPrice?.toFixed(1) : r.cfdEntryPrice?.toFixed(0)}</span>
                      <span className="font-mono text-muted-foreground">{r.stopLossPoints?.toFixed(0)}</span>
                      <span className="font-mono text-cyan-400">1:{r.riskRewardRatio?.toFixed(1)}</span>
                      <span className={`font-bold ${oc.color}`}>{oc.label}</span>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-2 bg-muted/10">
                        <div className="text-[9px] text-muted-foreground">{r.gexDetail}</div>
                        <div className="flex flex-wrap gap-1 text-[8px]">
                          {r.confirmationDetails?.map((c: string) => (
                            <span key={c} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{c}</span>
                          ))}
                          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">IV {r.ivRank?.toFixed(0)}% {r.ivRegime}</span>
                        </div>
                        <div className="text-[9px] text-muted-foreground grid grid-cols-3 gap-1">
                          <span>TP1: <b className="text-foreground">{r.cfd === 'XAUUSD' ? r.takeProfit1?.toFixed(1) : r.takeProfit1?.toFixed(0)}</b></span>
                          <span>TP2: <b className="text-foreground">{r.cfd === 'XAUUSD' ? r.takeProfit2?.toFixed(1) : r.takeProfit2?.toFixed(0)}</b></span>
                          <span>TP3: <b className="text-foreground">{r.cfd === 'XAUUSD' ? r.takeProfit3?.toFixed(1) : r.takeProfit3?.toFixed(0)}</b></span>
                        </div>
                        {r.outcome === 'open' && (
                          <div className="space-y-1.5 mt-1">
                            {!r.mt5Ticket ? (
                              <div className="flex items-center gap-2">
                                <button disabled={mt5Executing === r.id}
                                  onClick={async () => {
                                    setMt5Executing(r.id);
                                    try { await executeMT5Trade.mutateAsync({ tradeId: r.id }); }
                                    catch (e: any) { alert(`Error MT5: ${e.message}`); }
                                    finally { setMt5Executing(null); }
                                  }}
                                  className={`text-[9px] px-2 py-1 rounded border font-bold transition-colors ${
                                    mt5Connected ? 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20' : 'border-border text-muted-foreground cursor-not-allowed opacity-50'
                                  }`}>
                                  {mt5Executing === r.id ? '\u23F3...' : '\u25B6 MT5'}
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] text-emerald-400 font-bold">\u2705 #{r.mt5Ticket}</span>
                                <span className="text-[9px] text-muted-foreground">{r.mt5Volume}L @ {r.cfd === 'XAUUSD' ? r.mt5ExecutedPrice?.toFixed(2) : r.mt5ExecutedPrice?.toFixed(0)}</span>
                                <button onClick={() => { if (confirm(`Cerrar #${r.mt5Ticket}?`)) closeMT5Trade.mutate({ tradeId: r.id }); }}
                                  className="text-[9px] px-1.5 py-0.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10">Cerrar</button>
                              </div>
                            )}
                            <div className="flex gap-1 flex-wrap">
                              <span className="text-[9px] text-muted-foreground mr-1">Resolver:</span>
                              {(['tp1','tp2','tp3','sl','cancelled'] as const).map(oc => (
                                <button key={oc} onClick={() => resolveTradeManually.mutate({ id: r.id, outcome: oc })}
                                  className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                                    ['tp1','tp2','tp3'].includes(oc) ? 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10' :
                                    oc === 'sl' ? 'border-red-500/40 text-red-400 hover:bg-red-500/10' :
                                    'border-border text-muted-foreground hover:bg-muted/30'
                                  }`}>{oc.toUpperCase()}</button>
                              ))}
                              <button onClick={() => deleteTradeRecord.mutate({ id: r.id })}
                                className="text-[9px] px-1.5 py-0.5 rounded border border-red-500/20 text-red-500 hover:bg-red-500/10 ml-auto">
                                <Trash2 size={9} />
                              </button>
                            </div>
                          </div>
                        )}
                        {r.outcome !== 'open' && r.pnlPoints !== undefined && (
                          <div className={`text-[10px] font-bold ${r.pnlPoints >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            PnL: {r.pnlPoints >= 0 ? '+' : ''}{r.pnlPoints?.toFixed(1)} pts
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
