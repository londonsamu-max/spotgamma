import { BarChart2 } from "lucide-react";
import {
  Bar, Cell, ComposedChart, CartesianGrid, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || isNaN(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(decimals) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(decimals) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(decimals) + "K";
  return n.toFixed(decimals);
}

// ====== GAMMA BAR CHART - PUT & CALL IMPACT ======
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

  const currentPrice = asset.currentPrice || 0;

  // Build bar data: show Call Gamma and Put Gamma separately (Put & Call Impact style)
  const data = chartData.map((s: any) => {
    const callGamma = s.callGammaByStrike || 0;
    const putGamma = s.putGammaByStrike || 0;
    const totalGamma = callGamma + putGamma;
    
    return {
      strike: s.strike,
      callGamma: callGamma,
      putGamma: putGamma,
      totalGamma: totalGamma,
      isOutlier: s.isOutlier,
      outlierScore: s.outlierScore || 0,
    };
  });

  // Calculate cumulative total gamma line
  let cumulativeGamma = 0;
  const cumulativeData = data.map((d: any) => {
    cumulativeGamma += d.totalGamma;
    return {
      strike: d.strike,
      callGamma: d.callGamma,
      putGamma: d.putGamma,
      cumulativeGamma,
      totalGamma: d.totalGamma,
      isOutlier: d.isOutlier,
    };
  });

  // Find the nearest strike to current price for the reference line
  const nearestStrike = data.reduce((best: any, d: any) =>
    Math.abs(d.strike - currentPrice) < Math.abs(best.strike - currentPrice) ? d : best
  , data[0]);

  return (
    <ResponsiveContainer width="100%" height={380}>
      <ComposedChart data={cumulativeData} margin={{ top: 20, right: 70, left: 5, bottom: 25 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.2 0.01 240)" />
        <XAxis
          dataKey="strike"
          tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }}
          tickFormatter={(v) => Number(v) >= 1000 ? Number(v).toLocaleString() : Number(v).toFixed(0)}
          angle={-35} textAnchor="end" height={45}
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: "oklch(0.55 0.02 240)", fontSize: 9 }}
          tickFormatter={(v) => formatNumber(v)}
          width={55}
          label={{ value: "Gamma", angle: -90, position: "insideLeft", style: { fontSize: 9, fill: "oklch(0.55 0.02 240)" } }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: "#a855f7", fontSize: 9 }}
          tickFormatter={(v) => formatNumber(v)}
          width={60}
          label={{ value: "Total Gamma (Línea)", angle: 90, position: "insideRight", style: { fontSize: 9, fill: "#a855f7" } }}
        />
        <Tooltip
          contentStyle={{
            background: "oklch(0.11 0.01 240)", border: "1px solid oklch(0.2 0.01 240)",
            borderRadius: "8px", color: "oklch(0.92 0.02 240)", fontSize: "11px",
          }}
          formatter={(v: any, name: string) => {
            const absVal = Math.abs(Number(v));
            if (name === "callGamma") return [formatNumber(absVal), "Call Gamma"];
            if (name === "putGamma") return [formatNumber(absVal), "Put Gamma"];
            if (name === "cumulativeGamma") return [formatNumber(absVal), "Total Gamma"];
            return [formatNumber(absVal), name];
          }}
          labelFormatter={(l) => `Strike: ${Number(l).toLocaleString()}`}
        />
        <Legend wrapperStyle={{ fontSize: "10px" }} />
        
        {/* Call Gamma bars (positive, green) */}
        <Bar yAxisId="left" dataKey="callGamma" radius={[2, 2, 0, 0]} fillOpacity={0.85} name="Call Gamma">
          {cumulativeData.map((entry: any, index: number) => (
            <Cell key={`call-${index}`} fill="#22c55e" />
          ))}
        </Bar>
        
        {/* Put Gamma bars (negative, red) */}
        <Bar yAxisId="left" dataKey="putGamma" radius={[0, 0, 2, 2]} fillOpacity={0.85} name="Put Gamma">
          {cumulativeData.map((entry: any, index: number) => (
            <Cell key={`put-${index}`} fill="#ef4444" />
          ))}
        </Bar>
        
        {/* Total Gamma cumulative line */}
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="cumulativeGamma"
          stroke="#a855f7"
          strokeWidth={2.5}
          dot={false}
          isAnimationActive={false}
          name="Total Gamma (Línea)"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
