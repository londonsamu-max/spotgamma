import { Target, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "../constants";

export function StrikePanel({ asset, onAnalyze }: { asset: any; onAnalyze: (s: number) => void }) {
  if (!asset?.topStrikes || asset.topStrikes.length === 0) {
    return <div className="text-center text-muted-foreground text-xs py-4"><Target size={20} className="mx-auto mb-1 opacity-30" /><p>Sin strikes clave</p></div>;
  }
  return (
    <div className="space-y-2">
      {asset.topStrikes.map((s: any, i: number) => {
        const isAbove = s.strike > asset.currentPrice;
        return (
          <div key={i} className={`rounded-lg p-2.5 border ${s.isOutlier ? "border-yellow-500/50 bg-yellow-500/5" : "border-border bg-card/50"}`}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-muted-foreground">#{i + 1}</span>
                <span className="font-mono text-sm font-bold text-foreground">${s.strike.toLocaleString()}</span>
                {s.isOutlier && <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 font-bold">OUTLIER</span>}
                <span className={`text-[10px] ${isAbove ? "text-red-400" : "text-emerald-400"}`}>
                  {isAbove ? "▲ Resistencia" : "▼ Soporte"} ({s.distancePct?.toFixed(2)}%)
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={() => onAnalyze(s.strike)} className="h-5 text-[10px] px-2 border-border/50">
                <Zap size={8} className="mr-1" /> Analizar
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-2 mt-1">
              <div className="text-center"><div className="text-[9px] text-muted-foreground">Gamma Total</div><div className="font-mono text-[10px] font-bold text-foreground">{formatNumber(s.totalGamma)}</div></div>
              <div className="text-center"><div className="text-[9px] text-muted-foreground">0DTE</div><div className="font-mono text-[10px] font-bold text-orange-400">{formatNumber(s.gamma0DTE)}</div></div>
              <div className="text-center"><div className="text-[9px] text-muted-foreground">Mensual</div><div className="font-mono text-[10px] font-bold text-blue-400">{formatNumber(s.gammaMonthly)}</div></div>
              <div className="text-center"><div className="text-[9px] text-muted-foreground">Pos Neta</div><div className={`font-mono text-[10px] font-bold ${(s.netPosTotal || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatNumber(s.netPosTotal || 0)}</div></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
