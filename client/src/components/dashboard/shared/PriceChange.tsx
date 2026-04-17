import { TrendingUp, TrendingDown } from "lucide-react";
import { formatPrice } from "../constants";

export function PriceChange({ value, pct }: { value?: number; pct?: number }) {
  const isUp = (pct ?? value ?? 0) >= 0;
  const color = isUp ? "text-emerald-400" : "text-red-400";
  const Icon = isUp ? TrendingUp : TrendingDown;
  return (
    <span className={`flex items-center gap-1 text-xs font-mono ${color}`}>
      <Icon size={12} />
      {pct !== undefined ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : formatPrice(value)}
    </span>
  );
}
