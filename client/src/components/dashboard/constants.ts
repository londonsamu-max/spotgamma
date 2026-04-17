export const SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "VIX", "DIA"];

export const SYMBOL_COLORS: Record<string, string> = {
  SPX: "#22c55e", SPY: "#3b82f6", QQQ: "#a855f7",
  GLD: "#f59e0b", VIX: "#ef4444", DIA: "#06b6d4",
};

export function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(decimals);
}

export function formatPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n) || n === 0) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
