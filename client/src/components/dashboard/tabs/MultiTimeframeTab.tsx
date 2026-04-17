import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Clock, TrendingUp, TrendingDown, Minus, GitBranch, Layers, Activity } from "lucide-react";
import { SYMBOL_COLORS, formatNumber } from "../constants";

const HIRO_SYMBOLS = ["SPX", "QQQ", "GLD", "DIA"];

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit",
  });
}

export function MultiTimeframeTab() {
  const { data } = trpc.market.getMultiTimeframe.useQuery(undefined, {
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  if (!data || data.count < 2) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock size={32} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm font-bold mb-1">Acumulando datos multi-timeframe...</p>
        <p className="text-xs">Se necesitan al menos 2 snapshots (30 min de mercado abierto).</p>
        <p className="text-xs mt-1">Snapshots actuales: {data?.count ?? 0}/16</p>
      </div>
    );
  }

  const { snapshots, hiroDeltas, gexFlips4h, tapeAccumulation, priceRanges } = data;

  // ─── Build HIRO trend chart data ───
  const hiroChartData = snapshots.map((snap: any) => {
    const point: any = { time: formatTime(snap.timestamp) };
    for (const sym of HIRO_SYMBOLS) {
      point[sym] = snap.hiro[sym]?.percentile ?? null;
    }
    return point;
  });

  // ─── Build GEX bias timeline ───
  const gexTimelineData = snapshots.map((snap: any, i: number) => ({
    time: formatTime(snap.timestamp),
    bias: snap.trace?.netGexBias === "bullish" ? 1 : snap.trace?.netGexBias === "bearish" ? -1 : 0,
    ratio: snap.trace?.gexRatio ?? 0,
    label: snap.trace?.netGexBias?.toUpperCase() ?? "N/A",
  }));

  // ─── Build tape accumulation chart ───
  const tapeChartData = snapshots.map((snap: any) => {
    const point: any = { time: formatTime(snap.timestamp) };
    for (const sym of HIRO_SYMBOLS) {
      point[sym] = snap.tape[sym]?.sentimentScore ?? 0;
    }
    return point;
  });

  // ─── Build CFD price chart ───
  const priceChartData = snapshots.map((snap: any) => ({
    time: formatTime(snap.timestamp),
    NAS100: snap.cfdPrices?.nas100?.price ?? null,
    US30: snap.cfdPrices?.us30?.price ?? null,
    XAUUSD: snap.cfdPrices?.xauusd?.price ?? null,
  }));

  return (
    <div className="space-y-3">
      {/* ═══ SUMMARY CARDS ═══ */}
      <div className="grid grid-cols-4 gap-2">
        <Card className="bg-card border-border">
          <CardContent className="p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground mb-0.5">Snapshots</div>
            <div className="font-mono text-lg font-bold text-foreground">{data.count}/16</div>
            <div className="text-[8px] text-muted-foreground">
              {data.oldestAt ? formatTime(data.oldestAt) : "—"} → {data.newestAt ? formatTime(data.newestAt) : "—"}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground mb-0.5">GEX Flips (4h)</div>
            <div className={`font-mono text-lg font-bold ${gexFlips4h > 2 ? "text-red-400" : gexFlips4h > 0 ? "text-yellow-400" : "text-emerald-400"}`}>
              {gexFlips4h}
            </div>
            <div className="text-[8px] text-muted-foreground">
              {gexFlips4h === 0 ? "Estable" : gexFlips4h <= 2 ? "Normal" : "Inestable"}
            </div>
          </CardContent>
        </Card>
        {/* HIRO Delta cards for SPX and QQQ */}
        {["SPX", "QQQ"].map(sym => {
          const delta = hiroDeltas[sym];
          if (!delta) return null;
          const d1h = delta.delta1h;
          const trend = delta.trend1h;
          const TrendIcon = trend === "rising" ? TrendingUp : trend === "falling" ? TrendingDown : Minus;
          const trendColor = trend === "rising" ? "text-emerald-400" : trend === "falling" ? "text-red-400" : "text-yellow-400";
          return (
            <Card key={sym} className="bg-card border-border">
              <CardContent className="p-2.5 text-center">
                <div className="text-[9px] text-muted-foreground mb-0.5">HIRO {sym} (1h)</div>
                <div className={`font-mono text-lg font-bold ${trendColor}`}>
                  <TrendIcon size={14} className="inline mr-1" />
                  {d1h !== null ? `${d1h >= 0 ? "+" : ""}${d1h.toFixed(1)}` : "—"}
                </div>
                <div className="text-[8px] text-muted-foreground">
                  Percentil: {delta.currentPercentile.toFixed(0)}%
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ═══ HIRO TREND CHART ═══ */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <Activity size={12} className="text-yellow-400" /> HIRO Percentil (4H)
            <Badge variant="outline" className="text-[8px] border-yellow-500/30 text-yellow-400 ml-auto">
              15min intervals
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={hiroChartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.2 0.01 240)" />
              <XAxis dataKey="time" tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} />
              <YAxis domain={[0, 100]} tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} />
              <Tooltip
                contentStyle={{ background: "oklch(0.11 0.01 240)", border: "1px solid oklch(0.2 0.01 240)", borderRadius: "8px", color: "#fff", fontSize: "11px" }}
                formatter={(v: any, name: string) => [`${Number(v).toFixed(1)}%`, name]}
              />
              <ReferenceLine y={50} stroke="oklch(0.35 0.01 240)" strokeDasharray="3 3" />
              {HIRO_SYMBOLS.map(sym => (
                <Line key={sym} type="monotone" dataKey={sym} stroke={SYMBOL_COLORS[sym] || "#888"}
                  strokeWidth={2} dot={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {/* HIRO Delta Summary */}
          <div className="grid grid-cols-4 gap-2 mt-2">
            {HIRO_SYMBOLS.map(sym => {
              const delta = hiroDeltas[sym];
              if (!delta) return null;
              return (
                <div key={sym} className="text-center">
                  <span className="text-[9px] font-bold" style={{ color: SYMBOL_COLORS[sym] }}>{sym}</span>
                  <div className="flex items-center justify-center gap-1 text-[9px]">
                    <span className="text-muted-foreground">1h:</span>
                    <span className={`font-mono font-bold ${(delta.delta1h ?? 0) > 0 ? "text-emerald-400" : (delta.delta1h ?? 0) < 0 ? "text-red-400" : "text-slate-400"}`}>
                      {delta.delta1h !== null ? `${delta.delta1h >= 0 ? "+" : ""}${delta.delta1h.toFixed(1)}` : "—"}
                    </span>
                    <span className="text-muted-foreground">4h:</span>
                    <span className={`font-mono font-bold ${(delta.delta4h ?? 0) > 0 ? "text-emerald-400" : (delta.delta4h ?? 0) < 0 ? "text-red-400" : "text-slate-400"}`}>
                      {delta.delta4h !== null ? `${delta.delta4h >= 0 ? "+" : ""}${delta.delta4h.toFixed(1)}` : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        {/* ═══ GEX BIAS TIMELINE ═══ */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <GitBranch size={12} className="text-purple-400" /> GEX Bias (4H)
              <Badge variant="outline" className="text-[8px] border-purple-500/30 text-purple-400 ml-auto">
                {gexFlips4h} flip{gexFlips4h !== 1 ? "s" : ""}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={gexTimelineData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.2 0.01 240)" />
                <XAxis dataKey="time" tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} />
                <YAxis domain={[-1.5, 1.5]} tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }}
                  tickFormatter={(v) => v === 1 ? "Bull" : v === -1 ? "Bear" : v === 0 ? "Neut" : ""} />
                <Tooltip
                  contentStyle={{ background: "oklch(0.11 0.01 240)", border: "1px solid oklch(0.2 0.01 240)", borderRadius: "8px", color: "#fff", fontSize: "11px" }}
                  formatter={(v: any) => [Number(v) > 0 ? "ALCISTA" : Number(v) < 0 ? "BAJISTA" : "NEUTRAL", "GEX Bias"]}
                />
                <ReferenceLine y={0} stroke="oklch(0.35 0.01 240)" strokeDasharray="3 3" />
                <Area type="stepAfter" dataKey="bias" stroke="#a855f7" fill="#a855f7" fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
            {/* GEX Ratio over time */}
            <div className="mt-2 space-y-0.5">
              {gexTimelineData.slice(-4).map((d: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-[9px]">
                  <span className="text-muted-foreground font-mono">{d.time}</span>
                  <span className={`font-bold ${d.bias > 0 ? "text-emerald-400" : d.bias < 0 ? "text-red-400" : "text-yellow-400"}`}>
                    {d.label}
                  </span>
                  <span className="font-mono text-foreground">Ratio: {d.ratio.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ═══ TAPE SENTIMENT CHART ═══ */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <Layers size={12} className="text-cyan-400" /> Tape Sentiment (4H)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={tapeChartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.2 0.01 240)" />
                <XAxis dataKey="time" tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} />
                <YAxis tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} />
                <Tooltip
                  contentStyle={{ background: "oklch(0.11 0.01 240)", border: "1px solid oklch(0.2 0.01 240)", borderRadius: "8px", color: "#fff", fontSize: "11px" }}
                />
                <ReferenceLine y={0} stroke="oklch(0.35 0.01 240)" strokeDasharray="3 3" />
                {HIRO_SYMBOLS.map(sym => (
                  <Line key={sym} type="monotone" dataKey={sym} stroke={SYMBOL_COLORS[sym] || "#888"}
                    strokeWidth={1.5} dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {/* Tape accumulation summary */}
            <div className="grid grid-cols-4 gap-2 mt-2">
              {HIRO_SYMBOLS.map(sym => {
                const acc = tapeAccumulation[sym];
                if (!acc) return null;
                const net = acc.net4h;
                return (
                  <div key={sym} className="text-center">
                    <span className="text-[9px] font-bold" style={{ color: SYMBOL_COLORS[sym] }}>{sym}</span>
                    <div className={`font-mono text-[10px] font-bold ${net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : "text-slate-400"}`}>
                      {net > 0 ? "+" : ""}{net.toFixed(0)}
                    </div>
                    <div className="text-[8px] text-muted-foreground">acum. 4h</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ═══ CFD PRICE RANGES ═══ */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="flex items-center gap-2 text-xs font-bold">
            <TrendingUp size={12} className="text-emerald-400" /> Rango de Precios CFD (4H)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-3 gap-3">
            {(["nas100", "us30", "xauusd"] as const).map(key => {
              const range = priceRanges[key];
              if (!range) return null;
              const label = key === "nas100" ? "NAS100" : key === "us30" ? "US30" : "XAUUSD";
              const decimals = key === "xauusd" ? 2 : 0;
              const color = key === "nas100" ? "text-cyan-400" : key === "us30" ? "text-blue-400" : "text-yellow-400";
              const bgColor = key === "nas100" ? "bg-cyan-400" : key === "us30" ? "bg-blue-400" : "bg-yellow-400";

              return (
                <div key={key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-bold ${color}`}>{label}</span>
                    <span className="font-mono text-xs font-bold text-foreground">{range.current.toFixed(decimals)}</span>
                  </div>
                  {/* Range bar */}
                  <div className="relative h-3 bg-card/50 rounded-full border border-border/30">
                    <div className={`absolute top-0 h-full w-1 ${bgColor} rounded-full`}
                      style={{ left: `${Math.max(2, Math.min(98, range.positionInRange))}%`, transform: "translateX(-50%)" }} />
                  </div>
                  <div className="flex justify-between text-[8px] text-muted-foreground font-mono">
                    <span>L: {range.low4h.toFixed(decimals)}</span>
                    <span className={`font-bold ${range.positionInRange > 70 ? "text-emerald-400" : range.positionInRange < 30 ? "text-red-400" : "text-yellow-400"}`}>
                      {range.positionInRange.toFixed(0)}%
                    </span>
                    <span>H: {range.high4h.toFixed(decimals)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
