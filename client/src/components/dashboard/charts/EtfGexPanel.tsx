import { BarChart2 } from "lucide-react";
import { formatNumber } from "../constants";

export function EtfGexPanel({ gexData, symbol, currentPrice, color }: {
  gexData: any; symbol: string; currentPrice: number; color: "yellow" | "cyan";
}) {
  if (!gexData || !gexData.gexByStrike || gexData.gexByStrike.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-xs py-6">
        <BarChart2 size={20} className="mx-auto mb-2 opacity-30" />
        <p>Sin datos GEX para {symbol}</p>
      </div>
    );
  }

  const price = currentPrice || gexData.underlyingPrice || 0;
  const rangePercent = 0.04;
  const bars = gexData.gexByStrike
    .filter((b: any) => price === 0 || Math.abs(b.strike - price) / price <= rangePercent)
    .sort((a: any, b: any) => a.strike - b.strike);

  const maxMag = Math.max(...bars.map((b: any) => Math.abs(b.netGex)), 1);
  const totalGex = gexData.totalGex || 0;
  const bias = gexData.netBias || "neutral";
  const biasColor = bias === "bullish" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
    : bias === "bearish" ? "text-red-400 bg-red-500/10 border-red-500/30"
    : "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className={`rounded-lg p-2 text-center border ${biasColor}`}>
          <div className="text-[9px] text-muted-foreground">Sesgo</div>
          <div className="font-bold text-[10px] uppercase">
            {bias === "bullish" ? "ALCISTA" : bias === "bearish" ? "BAJISTA" : "NEUTRAL"}
          </div>
        </div>
        <div className="bg-card/50 border border-border rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">GEX Total</div>
          <div className={`font-mono text-xs font-bold ${totalGex >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {formatNumber(totalGex)}
          </div>
        </div>
        <div className="bg-card/50 border border-border rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Precio</div>
          <div className="font-mono text-xs font-bold text-foreground">${price.toFixed(2)}</div>
        </div>
      </div>

      <div className="space-y-0.5 max-h-48 overflow-y-auto">
        {bars.slice(0, 20).map((bar: any) => {
          const widthPct = (Math.abs(bar.netGex) / maxMag) * 100;
          const isPositive = bar.netGex > 0;
          const isClose = price > 0 && Math.abs(bar.strike - price) / price < 0.005;
          return (
            <div key={bar.strike} className={`flex items-center gap-1 text-[10px] ${isClose ? 'bg-white/5 rounded' : ''}`}>
              <span className={`w-12 text-right font-mono ${isClose ? 'text-yellow-400 font-bold' : 'text-muted-foreground'}`}>{bar.strike}</span>
              <div className="flex-1 h-3 bg-card/30 rounded-sm overflow-hidden">
                <div className={`h-full rounded-sm ${isPositive ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
                  style={{ width: `${widthPct}%` }} />
              </div>
              <span className={`w-12 text-right font-mono ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatNumber(bar.netGex)}
              </span>
            </div>
          );
        })}
      </div>

      {gexData.topLevels && (
        <div className="grid grid-cols-2 gap-1">
          {gexData.topLevels.slice(0, 4).map((l: any) => (
            <div key={l.strike} className="flex items-center justify-between text-[10px] px-1">
              <span className="font-mono text-foreground">${l.strike}</span>
              <span className={`font-mono ${l.netGex > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatNumber(l.netGex)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
