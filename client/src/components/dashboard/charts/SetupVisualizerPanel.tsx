import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Cell } from "recharts";
import { Eye } from "lucide-react";

export function SetupVisualizerPanel({ tradeSetups, cfdPrices }: { tradeSetups: any[]; cfdPrices: any }) {
  if (!tradeSetups || tradeSetups.length === 0) return null;

  const activeSetups = tradeSetups.filter((s: any) => s.direction !== 'NO_TRADE' && s.cfdEntryPrice > 0);
  if (activeSetups.length === 0) return null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="flex items-center gap-2 text-xs font-bold">
          <Eye size={12} className="text-blue-400" /> NIVELES DE TRADE
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-3 gap-3">
          {activeSetups.map((setup: any) => {
            const cfdKey = setup.cfd === 'NAS100' ? 'nas100' : setup.cfd === 'US30' ? 'us30' : 'xauusd';
            const currentPrice = cfdPrices?.[cfdKey]?.price || setup.cfdEntryPrice;
            const decimals = setup.cfd === 'XAUUSD' ? 2 : 0;
            const isLong = setup.direction === 'LONG';

            const levels = [
              { name: 'TP3', value: setup.takeProfit3, color: '#059669' },
              { name: 'TP2', value: setup.takeProfit2, color: '#10b981' },
              { name: 'TP1', value: setup.takeProfit1, color: '#34d399' },
              { name: 'Entry', value: setup.cfdEntryPrice, color: '#3b82f6' },
              { name: 'SL', value: setup.stopLoss, color: '#ef4444' },
            ].filter(l => l.value > 0).sort((a, b) => b.value - a.value);

            const minVal = Math.min(...levels.map(l => l.value), currentPrice) * 0.999;
            const maxVal = Math.max(...levels.map(l => l.value), currentPrice) * 1.001;

            const chartData = levels.map(l => ({
              name: l.name,
              value: l.value,
              diff: l.value - setup.cfdEntryPrice,
              color: l.color,
            }));

            return (
              <div key={setup.cfd} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-cyan-400">{setup.cfd}</span>
                  <span className={`text-[10px] font-bold ${isLong ? 'text-emerald-400' : 'text-red-400'}`}>
                    {setup.direction}
                  </span>
                </div>

                {/* Price levels visualization */}
                <div className="space-y-0.5">
                  {levels.map((level) => {
                    const pct = ((level.value - minVal) / (maxVal - minVal)) * 100;
                    const currentPct = ((currentPrice - minVal) / (maxVal - minVal)) * 100;
                    const isEntry = level.name === 'Entry';
                    const isSL = level.name === 'SL';

                    return (
                      <div key={level.name} className="flex items-center gap-1.5">
                        <span className={`text-[8px] w-8 text-right font-bold ${isSL ? 'text-red-400' : isEntry ? 'text-blue-400' : 'text-emerald-400'}`}>
                          {level.name}
                        </span>
                        <div className="flex-1 relative h-3 bg-card/50 rounded-sm border border-border/30">
                          {/* Level marker */}
                          <div
                            className="absolute top-0 h-full w-0.5 rounded-full"
                            style={{ left: `${pct}%`, backgroundColor: level.color }}
                          />
                          {/* Current price marker */}
                          <div
                            className="absolute top-0 h-full w-0.5 bg-yellow-400 rounded-full"
                            style={{ left: `${currentPct}%` }}
                          />
                        </div>
                        <span className={`text-[8px] font-mono w-16 text-right ${isSL ? 'text-red-400' : isEntry ? 'text-blue-400' : 'text-emerald-400'}`}>
                          {level.value.toFixed(decimals)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Current price indicator */}
                <div className="flex items-center justify-center gap-1 text-[9px]">
                  <span className="w-2 h-2 bg-yellow-400 rounded-full" />
                  <span className="text-muted-foreground">Precio:</span>
                  <span className="font-mono font-bold text-yellow-400">{currentPrice.toFixed(decimals)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
