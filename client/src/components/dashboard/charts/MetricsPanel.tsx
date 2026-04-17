import { formatNumber, formatPrice } from "../constants";

export function MetricsPanel({ asset }: { asset: any }) {
  if (!asset) return null;
  const metrics = [
    { label: "Precio Actual", value: formatPrice(asset.currentPrice), color: "text-foreground" },
    { label: "Cierre Anterior", value: formatPrice(asset.previousClose), color: "text-muted-foreground" },
    { label: "Cambio Diario", value: `${asset.dailyChangePct >= 0 ? '+' : ''}${asset.dailyChangePct?.toFixed(2) || 0}%`, color: asset.dailyChangePct >= 0 ? "text-emerald-400" : "text-red-400" },
    { label: "Gamma Flip", value: formatPrice(asset.gammaFlipLevel), color: "text-purple-400" },
    { label: "Call Gamma", value: formatNumber(asset.callGamma), color: "text-emerald-400" },
    { label: "Put Gamma", value: formatNumber(asset.putGamma), color: "text-red-400" },
    { label: "Total Gamma", value: formatNumber(asset.totalGamma), color: "text-blue-400" },
    { label: "Put/Call Ratio", value: asset.putCallRatio?.toFixed(2) || "—", color: "text-yellow-400" },
    { label: "0DTE Gamma", value: formatNumber(asset.zeroDteGamma), color: "text-orange-400" },
    { label: "Top Strike #1", value: asset.topStrikes?.[0] ? `$${asset.topStrikes[0].strike.toLocaleString()}` : "—", color: "text-cyan-400" },
    { label: "Top Strike #2", value: asset.topStrikes?.[1] ? `$${asset.topStrikes[1].strike.toLocaleString()}` : "—", color: "text-cyan-400" },
    { label: "Top Strike #3", value: asset.topStrikes?.[2] ? `$${asset.topStrikes[2].strike.toLocaleString()}` : "—", color: "text-cyan-400" },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {metrics.map((m, i) => (
        <div key={i} className="bg-card/50 rounded-lg p-2 border border-border/50">
          <div className="text-[9px] text-muted-foreground mb-0.5">{m.label}</div>
          <div className={`font-mono text-xs font-bold ${m.color}`}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}
