export function MarketStatusBadge({ status }: { status?: string }) {
  const config = {
    open: { color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40", label: "ABIERTO", dot: "bg-emerald-400" },
    pre_market: { color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40", label: "PRE-MARKET", dot: "bg-yellow-400" },
    closed: { color: "bg-slate-500/20 text-slate-400 border-slate-500/40", label: "CERRADO", dot: "bg-slate-400" },
  };
  const c = config[status as keyof typeof config] || config.closed;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold ${c.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} live-indicator`} /> {c.label}
    </span>
  );
}
