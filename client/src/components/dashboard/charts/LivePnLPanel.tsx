import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown } from "lucide-react";

export function LivePnLPanel() {
  const { data } = trpc.market.getLivePnL.useQuery(undefined, {
    refetchInterval: 2000,
    staleTime: 1500,
  });

  if (!data || (data as any).count === 0) return null;

  const positions = (data as any).positions || [];
  const totalPnl = positions.reduce((sum: number, p: any) => sum + (p.pnlPoints || 0), 0);
  const isPositive = totalPnl >= 0;

  return (
    <Card className={`border-2 ${isPositive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="flex items-center justify-between text-xs font-bold">
          <div className="flex items-center gap-2">
            <DollarSign size={12} className={isPositive ? "text-emerald-400" : "text-red-400"} />
            P&L EN VIVO
          </div>
          <div className={`font-mono text-lg font-black ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
            {isPositive ? '+' : ''}{totalPnl.toFixed(1)} pts
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="space-y-1.5">
          {positions.map((pos: any, i: number) => {
            const pnl = pos.pnlPoints || 0;
            const pnlPct = pos.pnlPct || 0;
            const isPosPositive = pnl >= 0;
            const Icon = isPosPositive ? TrendingUp : TrendingDown;

            return (
              <div key={i} className="flex items-center justify-between rounded-lg border border-border/50 bg-card/50 p-2">
                <div className="flex items-center gap-2">
                  <Icon size={12} className={isPosPositive ? 'text-emerald-400' : 'text-red-400'} />
                  <span className="text-xs font-bold text-cyan-400">{pos.cfd}</span>
                  <span className={`text-[10px] font-bold ${pos.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pos.direction}
                  </span>
                  <span className="text-[9px] text-muted-foreground font-mono">
                    @ {pos.entryPrice?.toFixed(pos.cfd === 'XAUUSD' ? 2 : 0)}
                  </span>
                </div>
                <div className="text-right">
                  <div className={`font-mono text-sm font-bold ${isPosPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {isPosPositive ? '+' : ''}{pnl.toFixed(1)} pts
                  </div>
                  <div className={`font-mono text-[9px] ${isPosPositive ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                    {isPosPositive ? '+' : ''}{pnlPct.toFixed(2)}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
