export function VixCorrelationPanel({ correlation }: { correlation: any }) {
  if (!correlation) return null;
  const corrConfig = {
    normal: { color: "bg-emerald-500/10 border-emerald-500/30", text: "text-emerald-400", label: "NORMAL" },
    divergence: { color: "bg-yellow-500/10 border-yellow-500/30", text: "text-yellow-400", label: "DIVERGENCIA" },
    extreme: { color: "bg-red-500/10 border-red-500/30", text: "text-red-400", label: "EXTREMO" },
  };
  const c = corrConfig[correlation.correlation as keyof typeof corrConfig] || corrConfig.normal;
  return (
    <div className={`rounded-lg p-2.5 border ${c.color}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-bold text-foreground">VIX-SPX</span>
        <span className={`text-[10px] font-bold ${c.text}`}>{c.label}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <span className="text-muted-foreground">SPX </span>
          <span className={`font-mono ${(correlation.spxChangePct || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {(correlation.spxChangePct || 0) >= 0 ? "+" : ""}{(correlation.spxChangePct || 0).toFixed(2)}%
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">VIX </span>
          <span className={`font-mono ${(correlation.vixChangePct || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {(correlation.vixChangePct || 0) >= 0 ? "+" : ""}{(correlation.vixChangePct || 0).toFixed(2)}%
          </span>
        </div>
      </div>
      <p className="text-[9px] text-muted-foreground mt-1.5 leading-relaxed">{correlation.description}</p>
    </div>
  );
}
