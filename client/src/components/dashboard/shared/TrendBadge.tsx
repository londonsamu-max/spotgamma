import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export function TrendBadge({ trend }: { trend?: string }) {
  if (!trend) return null;
  const config = {
    bullish: { color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", label: "ALCISTA", icon: TrendingUp },
    bearish: { color: "bg-red-500/20 text-red-400 border-red-500/30", label: "BAJISTA", icon: TrendingDown },
    neutral: { color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", label: "NEUTRAL", icon: Minus },
  };
  const c = config[trend as keyof typeof config] || config.neutral;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-bold ${c.color}`}>
      <Icon size={10} /> {c.label}
    </span>
  );
}
