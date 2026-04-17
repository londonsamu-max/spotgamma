import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { BarChart2 } from "lucide-react";
import { formatNumber } from "../constants";

export function GammaChart({ asset, chartTab }: { asset: any; chartTab: string }) {
  const chartData = asset?.chartData || [];
  if (!chartData || chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-56 text-muted-foreground text-sm">
        <div className="text-center">
          <BarChart2 size={32} className="mx-auto mb-2 opacity-30" />
          <p>Cargando datos de gamma...</p>
        </div>
      </div>
    );
  }

  const data = chartData.map((s: any) => {
    const callGN = s.callGammaNotional ?? 0;
    const putGN = s.putGammaNotional ?? 0;
    const total = s.totalGamma ?? (callGN + putGN);
    return { strike: s.strike, callGammaNotional: callGN, putGammaNotional: putGN, totalGamma: total, isOutlier: s.isOutlier, outlierScore: s.outlierScore || 0 };
  });

  let cumulativeGamma = 0;
  const cumulativeData = data.map((d: any) => {
    cumulativeGamma += d.totalGamma;
    return { ...d, cumulativeGamma };
  });

  return (
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={cumulativeData} margin={{ top: 15, right: 65, left: 5, bottom: 25 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.2 0.01 240)" />
        <XAxis dataKey="strike" tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} tickFormatter={(v) => Number(v) >= 1000 ? Number(v).toLocaleString() : Number(v).toFixed(0)} angle={-35} textAnchor="end" height={45} />
        <YAxis yAxisId="left" tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }} tickFormatter={(v) => formatNumber(v)} width={65} />
        <YAxis yAxisId="right" orientation="right" tick={{ fill: "#a855f7", fontSize: 9 }} tickFormatter={(v) => formatNumber(v)} width={65} />
        <Tooltip contentStyle={{ background: "oklch(0.11 0.01 240)", border: "1px solid oklch(0.2 0.01 240)", borderRadius: "8px", color: "oklch(0.92 0.02 240)", fontSize: "11px" }}
          formatter={(v: any, name: string) => {
            const val = Number(v);
            if (name === "Total Gamma (bar)" && val >= 0) return [formatNumber(val), "Call Gamma"];
            if (name === "Total Gamma (bar)" && val < 0) return [formatNumber(val), "Put Gamma"];
            if (name === "Total Gamma (line)") return [formatNumber(val), "Total Gamma (line)"];
            return [formatNumber(val), name];
          }}
          labelFormatter={(l) => `Strike: ${Number(l).toLocaleString()}`}
        />
        <Legend wrapperStyle={{ fontSize: "10px" }} />
        <Bar yAxisId="left" dataKey="callGammaNotional" stackId="gamma" fill="#22c55e" fillOpacity={0.85} name="Total Gamma (bar)" />
        <Bar yAxisId="left" dataKey="putGammaNotional" stackId="gamma" fill="#ef4444" fillOpacity={0.85} name="Total Gamma (bar)" />
        <Line yAxisId="right" type="monotone" dataKey="cumulativeGamma" stroke="#a855f7" strokeWidth={2.5} dot={false} isAnimationActive={false} name="Total Gamma (line)" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
