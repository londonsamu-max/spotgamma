import { Target, Gauge, CheckCircle, DollarSign, Layers, BookOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AnalyticsTab({ setupAnalytics }: { setupAnalytics: any }) {
  return (
    <div className="space-y-3">
      {/* Header Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Card className="bg-card border-border">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-foreground">{setupAnalytics?.totalTracked ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">Setups Registrados</div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-foreground">{setupAnalytics?.totalResolved ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">Resueltos</div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-3 text-center">
            <div className="text-2xl font-bold text-green-400">
              {setupAnalytics && setupAnalytics.totalResolved > 0
                ? `${Math.round(Object.values(setupAnalytics.byEntryMode?.ENTRADA ?? {}).length > 0
                    ? (setupAnalytics.byEntryMode?.ENTRADA?.winRate ?? 0)
                    : 0)}%`
                : "\u2014"}
            </div>
            <div className="text-[10px] text-muted-foreground">Win Rate (ENTRADA)</div>
          </CardContent>
        </Card>
      </div>

      {/* Por tipo de setup */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
            <Target size={12} className="text-blue-400" /> Por Tipo de Setup
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left pb-1">Tipo</th>
                <th className="text-right pb-1">Total</th>
                <th className="text-right pb-1">TP1</th>
                <th className="text-right pb-1">TP2</th>
                <th className="text-right pb-1">TP3</th>
                <th className="text-right pb-1">SL</th>
                <th className="text-right pb-1">Exp</th>
                <th className="text-right pb-1">Win%</th>
              </tr>
            </thead>
            <tbody>
              {setupAnalytics && Object.entries(setupAnalytics.byTradeType).map(([type, stats]: [string, any]) => (
                <tr key={type} className="border-b border-border/30">
                  <td className="py-1 font-mono text-foreground">{type}</td>
                  <td className="text-right text-muted-foreground">{stats.total}</td>
                  <td className="text-right text-green-400">{stats.tp1 || 0}</td>
                  <td className="text-right text-green-300">{stats.tp2 || 0}</td>
                  <td className="text-right text-emerald-400">{stats.tp3 || 0}</td>
                  <td className="text-right text-red-400">{stats.sl || 0}</td>
                  <td className="text-right text-gray-500">{stats.expired || 0}</td>
                  <td className="text-right font-bold" style={{ color: (stats.winRate || 0) >= 60 ? '#4ade80' : (stats.winRate || 0) >= 40 ? '#facc15' : '#f87171' }}>
                    {stats.winRate ? `${stats.winRate.toFixed(0)}%` : "\u2014"}
                  </td>
                </tr>
              ))}
              {(!setupAnalytics || Object.keys(setupAnalytics.byTradeType).length === 0) && (
                <tr><td colSpan={8} className="py-3 text-center text-muted-foreground">Sin datos a\u00FAn</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        {/* Por rango de score */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
              <Gauge size={12} className="text-purple-400" /> Por Score
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left pb-1">Rango</th>
                  <th className="text-right pb-1">Total</th>
                  <th className="text-right pb-1">Wins</th>
                  <th className="text-right pb-1">Win%</th>
                  <th className="text-right pb-1">Avg PnL</th>
                </tr>
              </thead>
              <tbody>
                {setupAnalytics && Object.entries(setupAnalytics.byScoreRange).map(([range, stats]: [string, any]) => (
                  <tr key={range} className="border-b border-border/30">
                    <td className="py-1 font-mono text-foreground">{range}</td>
                    <td className="text-right text-muted-foreground">{stats.total}</td>
                    <td className="text-right text-green-400">{stats.wins}</td>
                    <td className="text-right font-bold" style={{ color: (stats.winRate || 0) >= 60 ? '#4ade80' : (stats.winRate || 0) >= 40 ? '#facc15' : '#f87171' }}>
                      {stats.total > 0 ? `${stats.winRate.toFixed(0)}%` : "\u2014"}
                    </td>
                    <td className="text-right" style={{ color: (stats.avgPnl || 0) >= 0 ? '#4ade80' : '#f87171' }}>
                      {stats.total > 0 ? `$${stats.avgPnl.toFixed(1)}` : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Por confirmaciones */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
              <CheckCircle size={12} className="text-green-400" /> Por Confirmaciones
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left pb-1">Conf.</th>
                  <th className="text-right pb-1">Total</th>
                  <th className="text-right pb-1">Wins</th>
                  <th className="text-right pb-1">Win%</th>
                  <th className="text-right pb-1">Avg PnL</th>
                </tr>
              </thead>
              <tbody>
                {setupAnalytics && Object.entries(setupAnalytics.byConfirmationCount).map(([count, stats]: [string, any]) => (
                  <tr key={count} className="border-b border-border/30">
                    <td className="py-1 font-mono text-foreground">{count}/6</td>
                    <td className="text-right text-muted-foreground">{stats.total}</td>
                    <td className="text-right text-green-400">{stats.wins}</td>
                    <td className="text-right font-bold" style={{ color: (stats.winRate || 0) >= 60 ? '#4ade80' : (stats.winRate || 0) >= 40 ? '#facc15' : '#f87171' }}>
                      {stats.total > 0 ? `${stats.winRate.toFixed(0)}%` : "\u2014"}
                    </td>
                    <td className="text-right" style={{ color: (stats.avgPnl || 0) >= 0 ? '#4ade80' : '#f87171' }}>
                      {stats.total > 0 ? `$${stats.avgPnl.toFixed(1)}` : "\u2014"}
                    </td>
                  </tr>
                ))}
                {(!setupAnalytics || Object.keys(setupAnalytics.byConfirmationCount).length === 0) && (
                  <tr><td colSpan={5} className="py-3 text-center text-muted-foreground">Sin datos a\u00FAn</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Por CFD y R\u00E9gimen */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
              <DollarSign size={12} className="text-yellow-400" /> Por CFD
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left pb-1">CFD</th>
                  <th className="text-right pb-1">Total</th>
                  <th className="text-right pb-1">W/L</th>
                  <th className="text-right pb-1">Win%</th>
                </tr>
              </thead>
              <tbody>
                {setupAnalytics && Object.entries(setupAnalytics.byCfd).map(([cfd, stats]: [string, any]) => (
                  <tr key={cfd} className="border-b border-border/30">
                    <td className="py-1 font-mono text-foreground">{cfd}</td>
                    <td className="text-right text-muted-foreground">{stats.total}</td>
                    <td className="text-right"><span className="text-green-400">{stats.wins}</span>/<span className="text-red-400">{stats.losses}</span></td>
                    <td className="text-right font-bold" style={{ color: (stats.winRate || 0) >= 60 ? '#4ade80' : (stats.winRate || 0) >= 40 ? '#facc15' : '#f87171' }}>
                      {stats.wins + stats.losses > 0 ? `${stats.winRate.toFixed(0)}%` : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
              <Layers size={12} className="text-orange-400" /> Por R\u00E9gimen
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left pb-1">R\u00E9gimen</th>
                  <th className="text-right pb-1">Total</th>
                  <th className="text-right pb-1">W/L</th>
                  <th className="text-right pb-1">Win%</th>
                </tr>
              </thead>
              <tbody>
                {setupAnalytics && Object.entries(setupAnalytics.byRegime).map(([regime, stats]: [string, any]) => (
                  <tr key={regime} className="border-b border-border/30">
                    <td className="py-1 font-mono text-foreground">{regime}</td>
                    <td className="text-right text-muted-foreground">{stats.total}</td>
                    <td className="text-right"><span className="text-green-400">{stats.wins}</span>/<span className="text-red-400">{stats.losses}</span></td>
                    <td className="text-right font-bold" style={{ color: (stats.winRate || 0) >= 60 ? '#4ade80' : (stats.winRate || 0) >= 40 ? '#facc15' : '#f87171' }}>
                      {stats.wins + stats.losses > 0 ? `${stats.winRate.toFixed(0)}%` : "\u2014"}
                    </td>
                  </tr>
                ))}
                {(!setupAnalytics || Object.keys(setupAnalytics.byRegime).length === 0) && (
                  <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">Sin datos a\u00FAn</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* \u00DAltimos 50 setups registrados */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-xs font-bold text-foreground flex items-center gap-2">
            <BookOpen size={12} className="text-blue-400" /> \u00DAltimos Setups Registrados
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left pb-1">Hora</th>
                  <th className="text-left pb-1">CFD</th>
                  <th className="text-left pb-1">Dir</th>
                  <th className="text-left pb-1">Tipo</th>
                  <th className="text-right pb-1">Score</th>
                  <th className="text-right pb-1">Conf</th>
                  <th className="text-left pb-1">Modo</th>
                  <th className="text-left pb-1">Outcome</th>
                  <th className="text-right pb-1">PnL pts</th>
                </tr>
              </thead>
              <tbody>
                {(setupAnalytics?.recentSetups ?? []).map((s: any) => {
                  const outcomeColor: Record<string, string> = {
                    open: '#94a3b8', tp1: '#4ade80', tp2: '#22c55e', tp3: '#16a34a',
                    sl: '#f87171', expired: '#6b7280'
                  };
                  const dirColor = s.direction === "LONG" ? '#4ade80' : '#f87171';
                  return (
                    <tr key={s.id} className="border-b border-border/20">
                      <td className="py-0.5 text-muted-foreground">
                        {new Date(s.trackedAt).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="font-mono text-foreground">{s.cfd}</td>
                      <td style={{ color: dirColor }}>{s.direction}</td>
                      <td className="text-muted-foreground">{s.tradeType}</td>
                      <td className="text-right text-foreground">{s.score}</td>
                      <td className="text-right text-muted-foreground">{s.confirmationCount}/6</td>
                      <td className="text-muted-foreground">{s.entryMode}</td>
                      <td style={{ color: outcomeColor[s.outcome] ?? '#94a3b8' }}>{s.outcome}</td>
                      <td className="text-right" style={{ color: s.pnlPoints > 0 ? '#4ade80' : s.pnlPoints < 0 ? '#f87171' : '#94a3b8' }}>
                        {s.outcome !== "open" && s.outcome !== "expired" ? s.pnlPoints.toFixed(1) : "\u2014"}
                      </td>
                    </tr>
                  );
                })}
                {(!setupAnalytics?.recentSetups || setupAnalytics.recentSetups.length === 0) && (
                  <tr><td colSpan={9} className="py-4 text-center text-muted-foreground">Sin setups registrados a\u00FAn. Se registrar\u00E1n autom\u00E1ticamente en el pr\u00F3ximo ciclo de 15s.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
