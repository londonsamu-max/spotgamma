import { Layers, Shield, Clock, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FlowPanel, SGLevelsPanel } from "@/components/dashboard/charts";

export function FlowLevelsTab({ selectedAsset, selectedSymbol, marketData, sgLevels, displayPrice }: {
  selectedAsset: any; selectedSymbol: string; marketData: any; sgLevels: any; displayPrice: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Flow */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <Layers size={14} className="text-cyan-400" /> Flujo Tape — {selectedSymbol}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <FlowPanel asset={selectedAsset} tape={marketData?.tape} selectedSymbol={selectedSymbol} />
        </CardContent>
      </Card>

      {/* Levels */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <Shield size={14} className="text-purple-400" /> Niveles SG — {selectedSymbol}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <SGLevelsPanel levels={sgLevels} officialLevels={marketData?.officialLevels?.[selectedSymbol]} currentPrice={displayPrice || selectedAsset?.currentPrice || 0} />
          {!sgLevels && !marketData?.officialLevels?.[selectedSymbol] && (
            <div className="text-center text-muted-foreground text-xs py-4">
              <Shield size={20} className="mx-auto mb-1 opacity-30" />
              <p>Cargando niveles...</p>
            </div>
          )}

          {/* Expiration Concentration */}
          {selectedAsset && (() => {
            const zeroDteGamma = Math.abs(selectedAsset.zeroDteGamma || 0);
            const strikes = selectedAsset.topStrikes || [];
            let weeklyGamma = 0, monthlyGamma = 0;
            strikes.forEach((s: any) => { weeklyGamma += Math.abs(s.gammaWeekly || 0); monthlyGamma += Math.abs(s.gammaMonthly || 0); });
            const totalFromStrikes = zeroDteGamma + weeklyGamma + monthlyGamma;
            const pct0dte = totalFromStrikes > 0 ? (zeroDteGamma / totalFromStrikes) * 100 : 0;
            const pctWeekly = totalFromStrikes > 0 ? (weeklyGamma / totalFromStrikes) * 100 : 0;
            const pctMonthly = totalFromStrikes > 0 ? (monthlyGamma / totalFromStrikes) * 100 : 0;
            if (totalFromStrikes === 0) return null;
            return (
              <div className="mt-4">
                <div className="text-[10px] font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                  <Clock size={9} /> Concentracion por Expiracion
                </div>
                <div className="flex h-4 rounded-full overflow-hidden border border-border">
                  <div className="bg-orange-500/80 flex items-center justify-center" style={{ width: `${Math.max(pct0dte, 5)}%` }}>
                    <span className="text-[8px] font-bold text-white">{pct0dte.toFixed(0)}%</span>
                  </div>
                  <div className="bg-blue-500/60 flex items-center justify-center" style={{ width: `${Math.max(pctWeekly, 5)}%` }}>
                    <span className="text-[8px] font-bold text-white">{pctWeekly.toFixed(0)}%</span>
                  </div>
                  <div className="bg-purple-500/50 flex items-center justify-center" style={{ width: `${Math.max(pctMonthly, 5)}%` }}>
                    <span className="text-[8px] font-bold text-white">{pctMonthly.toFixed(0)}%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1 text-[8px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-orange-500/80" /> 0DTE</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500/60" /> Semanal</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500/50" /> Mensual</span>
                </div>
                {pct0dte > 40 && (
                  <div className="mt-1.5 p-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 text-[9px] text-orange-300 font-bold flex items-center gap-1">
                    <AlertTriangle size={10} /> 0DTE &gt;40% — Ultra-reactivo
                  </div>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}
