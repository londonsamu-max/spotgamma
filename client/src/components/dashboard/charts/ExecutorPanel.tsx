import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Clock, ArrowUpCircle, ArrowDownCircle } from "lucide-react";

export function ExecutorPanel() {
  const { data } = trpc.market.getExecutorState.useQuery(undefined, {
    refetchInterval: 2000,
    staleTime: 1500,
  });

  if (!data) return null;

  const { pendingOrders, managedPositions, running, lastCheck } = data as any;
  const hasPending = pendingOrders && pendingOrders.length > 0;
  const hasManaged = managedPositions && managedPositions.length > 0;

  if (!hasPending && !hasManaged) return null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="flex items-center gap-2 text-xs font-bold">
          <Zap size={12} className="text-cyan-400" />
          EJECUTOR
          {running ? (
            <Badge className="text-[8px] bg-emerald-600/80 border-0 animate-pulse">ACTIVO</Badge>
          ) : (
            <Badge variant="outline" className="text-[8px] border-slate-500/30 text-slate-400">INACTIVO</Badge>
          )}
          {lastCheck && (
            <span className="text-[8px] text-muted-foreground font-mono ml-auto">
              <Clock size={8} className="inline mr-0.5" />
              {new Date(lastCheck).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Pending Orders */}
        {hasPending && (
          <div>
            <div className="text-[10px] font-bold text-yellow-400 mb-1.5 flex items-center gap-1">
              <Clock size={9} /> ORDENES PENDIENTES ({pendingOrders.length})
            </div>
            <div className="space-y-1.5">
              {pendingOrders.map((order: any, i: number) => {
                const isLong = order.direction === 'LONG';
                const Icon = isLong ? ArrowUpCircle : ArrowDownCircle;
                const dirColor = isLong ? 'text-emerald-400' : 'text-red-400';
                const dirBg = isLong ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5';
                return (
                  <div key={i} className={`rounded-lg border p-2 ${dirBg}`}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <Icon size={14} className={dirColor} />
                        <span className={`text-xs font-bold ${dirColor}`}>{order.direction}</span>
                        <span className="text-xs font-bold text-cyan-400">{order.cfd}</span>
                      </div>
                      <span className="text-[9px] text-muted-foreground font-mono">{order.volume}L</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5 text-[9px]">
                      <div>
                        <span className="text-muted-foreground">Entrada: </span>
                        <span className="font-mono font-bold text-foreground">
                          {order.entryLow?.toFixed(order.cfd === 'XAUUSD' ? 2 : 0)}
                          {order.entryHigh ? ` - ${order.entryHigh.toFixed(order.cfd === 'XAUUSD' ? 2 : 0)}` : ''}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">SL: </span>
                        <span className="font-mono font-bold text-red-400">{order.sl?.toFixed(order.cfd === 'XAUUSD' ? 2 : 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">TP1: </span>
                        <span className="font-mono font-bold text-emerald-400">{order.tp1?.toFixed(order.cfd === 'XAUUSD' ? 2 : 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">TP2: </span>
                        <span className="font-mono font-bold text-emerald-400">{order.tp2?.toFixed(order.cfd === 'XAUUSD' ? 2 : 0)}</span>
                      </div>
                    </div>
                    {order.reason && (
                      <div className="text-[9px] text-muted-foreground mt-1 leading-snug">{order.reason}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Managed Positions */}
        {hasManaged && (
          <div>
            <div className="text-[10px] font-bold text-emerald-400 mb-1.5 flex items-center gap-1">
              <Zap size={9} /> POSICIONES GESTIONADAS ({managedPositions.length})
            </div>
            <div className="space-y-1.5">
              {managedPositions.map((pos: any, i: number) => {
                const isLong = pos.direction === 'LONG';
                const dirColor = isLong ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div key={i} className="rounded-lg border border-border bg-card/50 p-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${dirColor}`}>{pos.direction}</span>
                        <span className="text-xs font-bold text-cyan-400">{pos.cfd}</span>
                        <span className="text-[9px] text-muted-foreground font-mono">#{pos.ticket}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {pos.breakEvenActive && (
                          <Badge variant="outline" className="text-[8px] border-emerald-500/30 text-emerald-400">BE</Badge>
                        )}
                        {pos.trailingActive && (
                          <Badge variant="outline" className="text-[8px] border-cyan-500/30 text-cyan-400">TRAIL</Badge>
                        )}
                        {pos.partialClosed && (
                          <Badge variant="outline" className="text-[8px] border-purple-500/30 text-purple-400">PARCIAL</Badge>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 mt-1 text-[9px]">
                      <div>
                        <span className="text-muted-foreground">Entrada: </span>
                        <span className="font-mono text-foreground">{pos.entryPrice?.toFixed(pos.cfd === 'XAUUSD' ? 2 : 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">SL: </span>
                        <span className="font-mono text-red-400">{pos.currentSL?.toFixed(pos.cfd === 'XAUUSD' ? 2 : 0)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Vol: </span>
                        <span className="font-mono text-foreground">{pos.volume}L</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
