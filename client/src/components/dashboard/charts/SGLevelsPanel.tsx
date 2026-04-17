import { AlertTriangle } from "lucide-react";
import { formatNumber, formatPrice } from "../constants";

export function SGLevelsPanel({ levels, officialLevels, currentPrice }: { levels: any; officialLevels: any; currentPrice: number }) {
  const ol = officialLevels;
  const allLevels = [
    { name: "Muro Calls", value: ol?.callWall || levels?.callWall, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", prev: ol?.prevCallWall },
    { name: "Disparador Vol", value: ol?.volTrigger, color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
    { name: "Gamma Clave", value: ol?.keyGamma || levels?.keyGamma, color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", prev: ol?.prevKeyGamma },
    { name: "Gamma Max", value: ol?.maxGamma || levels?.maxGamma, color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/20", prev: ol?.prevMaxGamma },
    { name: "Gamma Flip", value: ol?.zeroGamma || levels?.zeroGamma, color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20" },
    { name: "Delta Clave", value: ol?.keyDelta || levels?.keyDelta, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
    { name: "Muro Puts", value: ol?.putWall || levels?.putWall, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", prev: ol?.prevPutWall },
    { name: "Control Puts", value: ol?.putControl, color: "text-red-300", bg: "bg-red-500/5 border-red-500/15" },
  ].filter((l) => l.value && l.value > 0);

  return (
    <div className="space-y-2">
      {ol?.gammaRegime && (
        <div className={`rounded-lg p-2.5 border text-xs leading-relaxed ${
          ol.gammaRegime === 'positive' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
          ol.gammaRegime === 'very_negative' ? 'bg-red-500/15 border-red-500/40 text-red-300' :
          ol.gammaRegime === 'negative' ? 'bg-orange-500/10 border-orange-500/30 text-orange-300' :
          'bg-slate-500/10 border-slate-500/30 text-slate-300'
        }`}>
          <div className="flex items-center justify-between mb-1">
            <span className="font-bold uppercase text-[11px]">
              Gamma {ol.gammaRegime === 'positive' ? 'POSITIVO' : ol.gammaRegime === 'very_negative' ? 'MUY NEGATIVO' : ol.gammaRegime === 'negative' ? 'NEGATIVO' : 'NEUTRAL'}
            </span>
            {ol.impliedMove > 0 && (
              <span className="font-mono font-bold text-[10px]">IM: {ol.impliedMove.toFixed(1)}pts ({ol.impliedMovePct?.toFixed(2)}%)</span>
            )}
          </div>
          <p className="text-[10px] opacity-80">{ol.regimeDescription}</p>
        </div>
      )}

      <div className="space-y-1">
        {allLevels.map((l, i) => {
          const isAbove = l.value > currentPrice;
          const dist = currentPrice > 0 ? ((l.value - currentPrice) / currentPrice * 100).toFixed(2) : "0";
          const changed = l.prev && l.prev !== l.value;
          return (
            <div key={i} className={`flex items-center justify-between rounded-lg p-1.5 border ${l.bg}`}>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-foreground">{l.name}</span>
                <span className="text-[9px] text-muted-foreground">{isAbove ? "▲" : "▼"} {dist}%</span>
                {changed && <span className="text-[8px] px-1 rounded bg-yellow-500/20 text-yellow-400 font-bold">CAMBIO</span>}
              </div>
              <div className="text-right">
                <span className={`font-mono text-xs font-bold ${l.color}`}>${l.value.toLocaleString()}</span>
                {changed && <div className="text-[8px] text-muted-foreground font-mono">prev: ${l.prev?.toLocaleString()}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {ol && (ol.atmIV30 > 0 || ol.activityFactor > 0) && (
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          {ol.atmIV30 > 0 && (
            <div className="bg-muted/30 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-muted-foreground">IV30</div>
              <div className="font-mono text-[10px] font-bold text-foreground">{(ol.atmIV30 * 100).toFixed(1)}%</div>
            </div>
          )}
          {ol.rv30 > 0 && (
            <div className="bg-muted/30 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-muted-foreground">RV30</div>
              <div className="font-mono text-[10px] font-bold text-foreground">{(ol.rv30 * 100).toFixed(1)}%</div>
            </div>
          )}
          {ol.vrp !== undefined && (
            <div className={`rounded-lg p-1.5 text-center ${ol.vrp > 0.05 ? 'bg-red-500/10' : ol.vrp < -0.02 ? 'bg-emerald-500/10' : 'bg-muted/30'}`}>
              <div className="text-[8px] text-muted-foreground">VRP</div>
              <div className={`font-mono text-[10px] font-bold ${ol.vrp > 0.05 ? 'text-red-400' : ol.vrp < -0.02 ? 'text-emerald-400' : 'text-foreground'}`}>
                {(ol.vrp * 100).toFixed(1)}%
              </div>
            </div>
          )}
          {ol.gammaRatio > 0 && (
            <div className="bg-muted/30 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-muted-foreground">Ratio Gamma</div>
              <div className="font-mono text-[10px] font-bold text-foreground">{ol.gammaRatio.toFixed(2)}</div>
            </div>
          )}
          {ol.activityFactor > 0 && (
            <div className="bg-muted/30 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-muted-foreground">Actividad</div>
              <div className="font-mono text-[10px] font-bold text-foreground">{ol.activityFactor.toFixed(0)}</div>
            </div>
          )}
          {ol.positionFactor > 0 && (
            <div className="bg-muted/30 rounded-lg p-1.5 text-center">
              <div className="text-[8px] text-muted-foreground">Posicion</div>
              <div className="font-mono text-[10px] font-bold text-foreground">{ol.positionFactor.toFixed(0)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
