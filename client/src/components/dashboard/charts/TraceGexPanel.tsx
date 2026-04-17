import { Crosshair } from "lucide-react";
import { formatNumber } from "../constants";

export function TraceGexPanel({ traceData, currentPrice }: { traceData: any; currentPrice: number }) {
  if (!traceData || !traceData.zeroDteGex || traceData.zeroDteGex.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-xs py-8">
        <Crosshair size={24} className="mx-auto mb-2 opacity-30" />
        <p>Cargando datos de 0DTE GEX...</p>
        <p className="mt-1 opacity-70">Disponible desde las 1:50 AM hora Colombia</p>
      </div>
    );
  }

  const bars = traceData.zeroDteGex
    .filter((b: any) => Math.abs(b.strike - currentPrice) <= 150)
    .sort((a: any, b: any) => a.strike - b.strike);

  const maxMag = Math.max(...bars.map((b: any) => b.magnitude), 1);

  const biasColors: Record<string, string> = {
    bullish: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
    bearish: "text-red-400 bg-red-500/10 border-red-500/30",
    neutral: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <div className={`rounded-lg p-2 text-center border ${biasColors[traceData.netGexBias] || biasColors.neutral}`}>
          <div className="text-[10px] text-muted-foreground">Sesgo 0DTE</div>
          <div className="font-bold text-sm uppercase">{traceData.netGexBias === 'bullish' ? 'ALCISTA' : traceData.netGexBias === 'bearish' ? 'BAJISTA' : 'NEUTRAL'}</div>
        </div>
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted-foreground">Soporte GEX</div>
          <div className="font-mono text-sm font-bold text-emerald-400">{formatNumber(traceData.totalPositiveGex)}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted-foreground">Resistencia GEX</div>
          <div className="font-mono text-sm font-bold text-red-400">{formatNumber(traceData.totalNegativeGex)}</div>
        </div>
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2 text-center">
          <div className="text-[10px] text-muted-foreground">Ratio S/R</div>
          <div className="font-mono text-sm font-bold text-purple-400">{traceData.gexRatio?.toFixed(2) || '—'}</div>
        </div>
      </div>

      <div className="bg-card/50 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-muted-foreground">0DTE GEX por Strike</span>
          <span className="text-[10px] text-muted-foreground font-mono">{traceData.date}</span>
        </div>
        <div className="relative" style={{ minHeight: `${Math.max(bars.length * 18, 200)}px` }}>
          {bars.map((bar: any, idx: number) => {
            const widthPct = (bar.magnitude / maxMag) * 100;
            const isSupport = bar.netGex > 0;
            const isCurrentPrice = Math.abs(bar.strike - currentPrice) <= 5;
            const isTopSupport = traceData.topSupport?.some((s: any) => s.strike === bar.strike);
            const isTopResistance = traceData.topResistance?.some((r: any) => r.strike === bar.strike);

            return (
              <div key={bar.strike} className={`flex items-center gap-1 h-[16px] mb-[2px] ${isCurrentPrice ? 'bg-white/10 rounded' : ''}`}>
                <div className={`w-14 text-right text-[10px] font-mono flex-shrink-0 ${isCurrentPrice ? 'font-bold text-yellow-400' : 'text-muted-foreground'}`}>
                  {bar.strike.toLocaleString()}
                  {isCurrentPrice && ' ◄'}
                </div>
                <div className="flex-1 flex items-center relative h-full">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/50" />
                  {isSupport ? (
                    <div className="absolute left-1/2 h-full flex items-center">
                      <div className={`h-[12px] rounded-r-sm transition-all ${isTopSupport ? 'bg-emerald-400 shadow-emerald-400/30 shadow-sm' : 'bg-emerald-500/70'}`}
                        style={{ width: `${widthPct * 0.5}%` }} />
                    </div>
                  ) : (
                    <div className="absolute right-1/2 h-full flex items-center justify-end">
                      <div className={`h-[12px] rounded-l-sm transition-all ${isTopResistance ? 'bg-red-400 shadow-red-400/30 shadow-sm' : 'bg-red-500/70'}`}
                        style={{ width: `${widthPct * 0.5}%` }} />
                    </div>
                  )}
                </div>
                <div className={`w-14 text-[10px] font-mono flex-shrink-0 ${isSupport ? 'text-emerald-400' : 'text-red-400'} ${isTopSupport || isTopResistance ? 'font-bold' : 'opacity-70'}`}>
                  {formatNumber(bar.netGex)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-center gap-4 mt-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-red-500/70 rounded-sm" /> Resistencia</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-emerald-500/70 rounded-sm" /> Soporte</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 bg-yellow-400 rounded-full" /> Precio</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
          <div className="text-[10px] font-bold text-emerald-400 mb-1">Top Soportes</div>
          {traceData.topSupport?.slice(0, 5).map((s: any) => (
            <div key={s.strike} className="flex items-center justify-between text-[10px] py-0.5">
              <span className="font-mono text-foreground">${s.strike.toLocaleString()}</span>
              <span className="font-mono text-emerald-400">+{formatNumber(s.netGex)}</span>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-2">
          <div className="text-[10px] font-bold text-red-400 mb-1">Top Resistencias</div>
          {traceData.topResistance?.slice(0, 5).map((r: any) => (
            <div key={r.strike} className="flex items-center justify-between text-[10px] py-0.5">
              <span className="font-mono text-foreground">${r.strike.toLocaleString()}</span>
              <span className="font-mono text-red-400">{formatNumber(r.netGex)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Muro Cobertura</div>
          <div className="font-mono text-xs font-bold text-emerald-400">{traceData.hedgeWall > 0 ? `$${traceData.hedgeWall.toLocaleString()}` : '—'}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Muro Puts</div>
          <div className="font-mono text-xs font-bold text-red-400">{traceData.putWall > 0 ? `$${traceData.putWall.toLocaleString()}` : '—'}</div>
        </div>
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2 text-center">
          <div className="text-[9px] text-muted-foreground">Gamma Flip</div>
          <div className="font-mono text-xs font-bold text-purple-400">{traceData.gammaFlip > 0 ? `$${traceData.gammaFlip.toLocaleString()}` : '—'}</div>
        </div>
      </div>

      <div className="text-[9px] text-muted-foreground text-center">
        {traceData.lastUpdated ? new Date(traceData.lastUpdated).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : '—'}
      </div>
    </div>
  );
}
