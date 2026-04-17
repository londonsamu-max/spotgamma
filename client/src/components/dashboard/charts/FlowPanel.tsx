import { Layers } from "lucide-react";
import { formatNumber } from "../constants";

export function FlowPanel({ asset, tape, selectedSymbol }: { asset: any; tape: any; selectedSymbol: string }) {
  const assetTape = tape?.perAsset?.[selectedSymbol];
  if (!assetTape) {
    return (
      <div className="text-center text-muted-foreground text-xs py-4">
        <Layers size={20} className="mx-auto mb-1 opacity-30" />
        <p>Sin datos de flujo para {selectedSymbol}</p>
      </div>
    );
  }

  const sentimentColor = assetTape.sentiment === "bullish" ? "text-emerald-400" : assetTape.sentiment === "bearish" ? "text-red-400" : "text-yellow-400";
  const sentimentBg = assetTape.sentiment === "bullish" ? "bg-emerald-500/10 border-emerald-500/30" : assetTape.sentiment === "bearish" ? "bg-red-500/10 border-red-500/30" : "bg-yellow-500/10 border-yellow-500/30";
  const sentimentLabel = assetTape.sentiment === "bullish" ? "ALCISTA" : assetTape.sentiment === "bearish" ? "BAJISTA" : "NEUTRAL";

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border p-3 ${sentimentBg}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-muted-foreground">Sentimiento {selectedSymbol}</div>
            <div className={`text-lg font-black ${sentimentColor}`}>{sentimentLabel}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted-foreground">Puntuacion</div>
            <div className={`text-xl font-black font-mono ${sentimentColor}`}>{assetTape.sentimentScore > 0 ? "+" : ""}{assetTape.sentimentScore}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Calls</div>
          <div className="font-mono text-sm font-bold text-emerald-400">{assetTape.callCount}</div>
          <div className="font-mono text-[9px] text-emerald-400/70">{formatNumber(assetTape.callPremium)}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Puts</div>
          <div className="font-mono text-sm font-bold text-red-400">{assetTape.putCount}</div>
          <div className="font-mono text-[9px] text-red-400/70">{formatNumber(assetTape.putPremium)}</div>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">P/C Ratio</div>
          <div className="font-mono text-sm font-bold text-blue-400">{assetTape.putCallRatio.toFixed(2)}</div>
        </div>
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Delta Neto</div>
          <div className={`font-mono text-sm font-bold ${assetTape.netDelta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {formatNumber(assetTape.netDelta)}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-muted-foreground mb-1">Premium Calls vs Puts</div>
        <div className="flex h-3 rounded-full overflow-hidden bg-card/50 border border-border/50">
          {assetTape.totalPremium > 0 && (
            <>
              <div className="bg-emerald-500/60 h-full transition-all" style={{ width: `${(assetTape.callPremium / assetTape.totalPremium) * 100}%` }} />
              <div className="bg-red-500/60 h-full transition-all" style={{ width: `${(assetTape.putPremium / assetTape.totalPremium) * 100}%` }} />
            </>
          )}
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
          <span className="text-emerald-400">Calls: {formatNumber(assetTape.callPremium)}</span>
          <span className="text-red-400">Puts: {formatNumber(assetTape.putPremium)}</span>
        </div>
      </div>

      {assetTape.strikeFlow && assetTape.strikeFlow.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-muted-foreground mb-1">Flujo por Strike (Top Premium)</div>
          <div className="space-y-0.5 max-h-44 overflow-y-auto">
            {assetTape.strikeFlow.slice(0, 10).map((sf: any, i: number) => {
              const total = sf.callPremium + sf.putPremium;
              const callPct = total > 0 ? (sf.callPremium / total) * 100 : 50;
              return (
                <div key={i} className="flex items-center gap-2 bg-card/30 rounded px-2 py-0.5 text-[10px]">
                  <span className="font-mono font-bold text-foreground w-14">${sf.strike?.toLocaleString()}</span>
                  <div className="flex-1 flex h-2.5 rounded-full overflow-hidden bg-card/50">
                    <div className="bg-emerald-500/50 h-full" style={{ width: `${callPct}%` }} />
                    <div className="bg-red-500/50 h-full" style={{ width: `${100 - callPct}%` }} />
                  </div>
                  <span className={`w-8 text-right font-mono ${sf.direction === "bullish" ? "text-emerald-400" : sf.direction === "bearish" ? "text-red-400" : "text-yellow-400"}`}>
                    {sf.direction === "bullish" ? "▲" : sf.direction === "bearish" ? "▼" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {assetTape.largestTrades && assetTape.largestTrades.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-muted-foreground mb-1">Top Ordenes</div>
          <div className="space-y-0.5">
            {assetTape.largestTrades.slice(0, 5).map((t: any, i: number) => (
              <div key={i} className="flex items-center justify-between bg-card/30 rounded px-2 py-0.5 text-[10px]">
                <div className="flex items-center gap-1.5">
                  <span className={`px-1 py-0.5 rounded font-bold ${t.callPut === "CALL" ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>{t.callPut}</span>
                  <span className="font-mono text-foreground">${t.strike?.toLocaleString()}</span>
                  <span className="text-muted-foreground">{t.expiration}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-bold text-yellow-400">{t.premiumFormatted}</span>
                  <span className={t.buySell === "BUY" ? "text-emerald-400" : "text-red-400"}>{t.buySell}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[9px] text-muted-foreground text-center">
        {assetTape.totalTrades} ordenes | {new Date(assetTape.lastUpdated).toLocaleTimeString("es-CO")}
      </div>
    </div>
  );
}
