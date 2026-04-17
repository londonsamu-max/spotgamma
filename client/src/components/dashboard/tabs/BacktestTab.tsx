import { Download, PlayCircle, Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

export function BacktestTab({
  backtestStart, setBacktestStart, backtestEnd, setBacktestEnd,
  backtestMinScore, setBacktestMinScore, backtestCfd, setBacktestCfd,
  isDownloadingHist, setIsDownloadingHist,
  fetchHistoricalRange, refetchHistorical, refetchBacktest,
  backtestData, historicalData,
}: {
  backtestStart: any; setBacktestStart: any; backtestEnd: any; setBacktestEnd: any;
  backtestMinScore: any; setBacktestMinScore: any; backtestCfd: any; setBacktestCfd: any;
  isDownloadingHist: any; setIsDownloadingHist: any;
  fetchHistoricalRange: any; refetchHistorical: any; refetchBacktest: any;
  backtestData: any; historicalData: any;
}) {
  return (
    <div className="space-y-3">
      {/* Controls */}
      <Card className="bg-card border-border">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">Rango:</span>
            <input
              type="date"
              value={backtestStart}
              onChange={e => setBacktestStart(e.target.value)}
              className="text-[10px] px-2 py-1 rounded border border-border bg-background text-foreground font-mono h-7"
            />
            <span className="text-[9px] text-muted-foreground">{"\u2192"}</span>
            <input
              type="date"
              value={backtestEnd}
              onChange={e => setBacktestEnd(e.target.value)}
              className="text-[10px] px-2 py-1 rounded border border-border bg-background text-foreground font-mono h-7"
            />
            <span className="text-[9px] text-muted-foreground font-medium">Score min:</span>
            <input
              type="number"
              min={0}
              max={100}
              value={backtestMinScore}
              onChange={e => setBacktestMinScore(Number(e.target.value))}
              className="text-[10px] px-2 py-1 rounded border border-border bg-background text-foreground font-mono h-7 w-16"
            />
            <span className="text-[9px] text-muted-foreground font-medium">CFD:</span>
            <select
              value={backtestCfd}
              onChange={e => setBacktestCfd(e.target.value)}
              className="text-[10px] px-2 py-1 rounded border border-border bg-background text-foreground h-7"
            >
              {["all", "NAS100", "US30", "XAUUSD"].map(c => (
                <option key={c} value={c}>{c === "all" ? "Todos" : c}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              disabled={isDownloadingHist}
              onClick={async () => {
                setIsDownloadingHist(true);
                try {
                  await fetchHistoricalRange.mutateAsync({ startDate: backtestStart, endDate: backtestEnd });
                  await refetchHistorical();
                  toast.success("Datos historicos descargados");
                } catch (e: any) {
                  toast.error(`Error: ${e.message}`);
                } finally {
                  setIsDownloadingHist(false);
                }
              }}
              className="flex items-center gap-1 text-[9px] px-3 py-1.5 rounded border border-cyan-500/40 text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Download size={10} />
              {isDownloadingHist ? "Descargando..." : "Descargar Datos"}
            </button>
            <button
              onClick={() => refetchBacktest()}
              className="flex items-center gap-1 text-[9px] px-3 py-1.5 rounded border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 font-bold transition-colors"
            >
              <PlayCircle size={10} />
              Correr Backtest
            </button>
          </div>

          {/* Summary stats */}
          {backtestData && (
            <div className="space-y-2">
              <div className="grid grid-cols-5 gap-2">
                {[
                  { label: "Dias", value: backtestData.totalDays },
                  { label: "Con Setup", value: backtestData.daysWithSetups },
                  { label: "Tasa Victoria", value: `${backtestData.winRate}%`, color: backtestData.winRate >= 60 ? "text-emerald-400" : backtestData.winRate >= 40 ? "text-yellow-400" : "text-red-400" },
                  { label: "Ganadas", value: backtestData.wins, color: "text-emerald-400" },
                  { label: "Perdidas", value: backtestData.losses, color: "text-red-400" },
                ].map(s => (
                  <Card key={s.label} className="bg-muted/30 border-border">
                    <CardContent className="p-2 text-center">
                      <div className="text-[8px] text-muted-foreground mb-0.5">{s.label}</div>
                      <div className={`font-mono text-sm font-bold ${(s as any).color || "text-foreground"}`}>{s.value}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* By CFD */}
              <div className="grid grid-cols-3 gap-2">
                {["NAS100", "US30", "XAUUSD"].map(c => {
                  const cs = (backtestData.byCfd as any)?.[c] || { total: 0, wins: 0, losses: 0, winRate: 0 };
                  return (
                    <Card key={c} className="bg-muted/20 border-border">
                      <CardContent className="p-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-bold text-foreground">{c}</span>
                        <div className="text-right">
                          <span className="text-[9px] text-muted-foreground">{cs.total} ops · </span>
                          <span className={`text-[10px] font-bold ${cs.winRate >= 60 ? "text-emerald-400" : cs.winRate >= 40 ? "text-yellow-400" : "text-muted-foreground"}`}>{cs.winRate}%</span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* By score range */}
              <div className="grid grid-cols-4 gap-1">
                {["90-100", "75-89", "60-74", "0-59"].map(r => {
                  const sr = (backtestData.byScoreRange as any)?.[r] || { total: 0, wins: 0, winRate: 0 };
                  return (
                    <div key={r} className="text-center px-1.5 py-1 rounded bg-muted/20 border border-border">
                      <div className="text-[8px] text-muted-foreground">Score {r}</div>
                      <div className={`text-[10px] font-bold ${sr.winRate >= 60 ? "text-emerald-400" : sr.winRate >= 40 ? "text-yellow-400" : "text-muted-foreground"}`}>{sr.winRate}%</div>
                      <div className="text-[8px] text-muted-foreground">{sr.total} dias</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results Table */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {backtestData && backtestData.results.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[9px]">
                <thead>
                  <tr className="border-b border-border bg-muted/20 text-muted-foreground">
                    <th className="px-2 py-1.5 text-left">Fecha</th>
                    <th className="px-2 py-1.5 text-left">CFD</th>
                    <th className="px-2 py-1.5 text-left">Dir</th>
                    <th className="px-2 py-1.5 text-right">Score</th>
                    <th className="px-2 py-1.5 text-right">Call Wall</th>
                    <th className="px-2 py-1.5 text-right">Put Wall</th>
                    <th className="px-2 py-1.5 text-right">{`Key \u03B3`}</th>
                    <th className="px-2 py-1.5 text-left">Tape</th>
                    <th className="px-2 py-1.5 text-left">HIRO</th>
                    <th className="px-2 py-1.5 text-right">Mov%</th>
                    <th className="px-2 py-1.5 text-left">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {backtestData.results.map((r: any, i: number) => (
                    <tr key={`${r.date}-${r.cfd}-${i}`} className="border-b border-border/50 hover:bg-muted/10">
                      <td className="px-2 py-1 font-mono text-muted-foreground">{r.date?.slice(5)}</td>
                      <td className="px-2 py-1 font-bold text-foreground">{r.cfd}</td>
                      <td className={`px-2 py-1 font-bold ${r.setupDirection === "LONG" ? "text-emerald-400" : "text-red-400"}`}>{r.setupDirection}</td>
                      <td className={`px-2 py-1 text-right font-mono font-bold ${r.score >= 75 ? "text-emerald-400" : r.score >= 50 ? "text-yellow-400" : "text-muted-foreground"}`}>{r.score}</td>
                      <td className="px-2 py-1 text-right font-mono text-foreground">{r.callWall?.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right font-mono text-foreground">{r.putWall?.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right font-mono text-cyan-400">{r.keyGamma?.toLocaleString()}</td>
                      <td className={`px-2 py-1 ${r.tapeFlow === "calls" ? "text-emerald-400" : r.tapeFlow === "puts" ? "text-red-400" : "text-muted-foreground"}`}>{r.tapeFlow || "\u2014"}</td>
                      <td className={`px-2 py-1 ${r.hiroTrend === "bullish" ? "text-emerald-400" : r.hiroTrend === "bearish" ? "text-red-400" : "text-muted-foreground"}`}>{r.hiroTrend || "\u2014"}</td>
                      <td className={`px-2 py-1 text-right font-mono ${(r.priceMove || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{r.priceMove !== undefined ? `${(r.priceMove as number) >= 0 ? "+" : ""}${(r.priceMove as number).toFixed(2)}%` : "\u2014"}</td>
                      <td className={`px-2 py-1 font-bold ${r.outcome === "win" ? "text-emerald-400" : r.outcome === "loss" ? "text-red-400" : "text-muted-foreground"}`}>
                        {r.outcome === "win" ? "GANÓ \u2713" : r.outcome === "loss" ? "PERDIÓ \u2717" : "?"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground text-xs">
              <Database size={28} className="mx-auto mb-2 opacity-30" />
              {backtestData ? "Sin resultados con los filtros actuales." : "Descarga datos historicos y ejecuta el backtest."}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Days downloaded summary */}
      {historicalData && historicalData.length > 0 && (
        <div className="text-[9px] text-muted-foreground px-1">
          {historicalData.length} dias descargados · ultimo: {(historicalData as any[])[0]?.date || "\u2014"}
        </div>
      )}
    </div>
  );
}
