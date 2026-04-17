import { GitBranch, Flame } from "lucide-react";
import { formatNumber } from "../constants";

export function GexChangeTrackerPanel({ gexTracker }: { gexTracker: any }) {
  if (!gexTracker) return null;

  const snap = gexTracker.currentSnapshot;
  const changes = gexTracker.changes;
  const tpAdj = gexTracker.tpAdjustment;

  const biasColor = snap?.netBias === 'bullish' ? 'text-emerald-400' : snap?.netBias === 'bearish' ? 'text-red-400' : 'text-yellow-400';
  const biasBg = snap?.netBias === 'bullish' ? 'bg-emerald-500/10 border-emerald-500/30' : snap?.netBias === 'bearish' ? 'bg-red-500/10 border-red-500/30' : 'bg-yellow-500/10 border-yellow-500/30';

  const actionColors: Record<string, string> = {
    hold: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
    tighten_tp: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    extend_tp: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    close_now: 'bg-red-500/20 text-red-400 border-red-500/30 animate-pulse',
    move_to_breakeven: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  };
  const actionLabels: Record<string, string> = {
    hold: 'MANTENER', tighten_tp: 'APRETAR TP', extend_tp: 'EXTENDER TP',
    close_now: 'CERRAR AHORA', move_to_breakeven: 'MOVER A BE',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch size={12} className="text-purple-400" />
          <span className="text-xs font-bold text-foreground">Rastreador GEX</span>
        </div>
        {changes?.biasChanged && (
          <span className="text-[9px] font-bold px-2 py-0.5 rounded border bg-red-500/20 text-red-400 border-red-500/30 animate-pulse">CAMBIO</span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className={`rounded-lg p-1.5 border ${biasBg}`}>
          <div className="text-[8px] text-muted-foreground">Sesgo 0DTE</div>
          <div className={`font-mono text-[10px] font-bold ${biasColor}`}>{snap?.netBias?.toUpperCase() || 'N/A'}</div>
        </div>
        <div className="bg-background/50 rounded-lg p-1.5 border border-border/30">
          <div className="text-[8px] text-muted-foreground">Razon GEX</div>
          <div className="font-mono text-[10px] font-bold text-foreground">{snap?.gexRatio?.toFixed(2) || '—'}</div>
          {changes?.ratioChange !== undefined && changes.ratioChange !== 0 && (
            <div className={`font-mono text-[8px] font-bold ${changes.ratioChange > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {changes.ratioChange > 0 ? '+' : ''}{changes.ratioChange.toFixed(2)}
            </div>
          )}
        </div>
        <div className="bg-background/50 rounded-lg p-1.5 border border-border/30">
          <div className="text-[8px] text-muted-foreground">Sesgo Anterior</div>
          <div className={`font-mono text-[10px] font-bold ${
            changes?.prevBias === 'bullish' ? 'text-emerald-400' : changes?.prevBias === 'bearish' ? 'text-red-400' : 'text-yellow-400'
          }`}>{changes?.prevBias?.toUpperCase() || '—'}</div>
        </div>
      </div>

      <div className="bg-background/50 rounded-lg p-2 border border-border/30">
        <p className="text-[10px] text-foreground leading-relaxed">{changes?.description || 'Sin datos previos'}</p>
      </div>

      {(changes?.newLevels?.length > 0 || changes?.removedLevels?.length > 0) && (
        <div className="grid grid-cols-2 gap-2">
          {changes.newLevels?.length > 0 && (
            <div className="bg-emerald-500/5 rounded-lg p-1.5 border border-emerald-500/20">
              <div className="text-[9px] text-emerald-400 font-bold">Nuevos</div>
              {changes.newLevels.map((l: number) => (
                <div key={l} className="font-mono text-[10px] text-emerald-400">${l.toLocaleString()}</div>
              ))}
            </div>
          )}
          {changes.removedLevels?.length > 0 && (
            <div className="bg-red-500/5 rounded-lg p-1.5 border border-red-500/20">
              <div className="text-[9px] text-red-400 font-bold">Removidos</div>
              {changes.removedLevels.map((l: number) => (
                <div key={l} className="font-mono text-[10px] text-red-400">${l.toLocaleString()}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {tpAdj && (
        <div className={`rounded-lg p-2 border ${actionColors[tpAdj.suggestedAction] || actionColors.hold}`}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1">
              <Flame size={10} className="text-orange-400" />
              <span className="text-[10px] font-bold text-foreground">TP Dinamico</span>
            </div>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${actionColors[tpAdj.suggestedAction] || actionColors.hold}`}>
              {actionLabels[tpAdj.suggestedAction] || 'MANTENER'}
            </span>
          </div>
          <p className="text-[10px] text-foreground leading-relaxed">{tpAdj.reason}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[8px] text-muted-foreground">Confianza:</span>
            <div className="flex-1 h-1 bg-background/50 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${
                tpAdj.confidence >= 70 ? 'bg-emerald-400' : tpAdj.confidence >= 50 ? 'bg-yellow-400' : 'bg-red-400'
              }`} style={{ width: `${tpAdj.confidence}%` }} />
            </div>
            <span className="font-mono text-[8px] text-foreground">{tpAdj.confidence}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
