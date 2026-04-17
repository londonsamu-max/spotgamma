import { Crosshair, BarChart2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TraceGexPanel, GammaChart, EtfGexPanel } from "@/components/dashboard/charts";
import { formatNumber, formatPrice } from "@/components/dashboard/constants";

export function GexTab({ marketData, selectedAsset, selectedSymbol, displayPrice, etfGexData }: {
  marketData: any; selectedAsset: any; selectedSymbol: string; displayPrice: number; etfGexData: any;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {/* 0DTE GEX */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <Crosshair size={14} className="text-cyan-400" /> 0DTE GEX — SPX
              <Badge variant="outline" className="ml-1 text-[9px] border-cyan-500/30 text-cyan-400">TRACE</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <TraceGexPanel traceData={marketData?.traceData} currentPrice={displayPrice || selectedAsset?.currentPrice || 0} />
          </CardContent>
        </Card>

        {/* Gamma Chart */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <BarChart2 size={14} /> Gamma — {selectedSymbol}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <GammaChart asset={selectedAsset} chartTab="total" />
            <div className="mt-3 grid grid-cols-4 gap-2">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
                <div className="text-[9px] text-muted-foreground">Gamma Calls</div>
                <div className="font-mono text-xs font-bold text-emerald-400">{formatNumber(selectedAsset?.callGamma)}</div>
              </div>
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
                <div className="text-[9px] text-muted-foreground">Gamma Puts</div>
                <div className="font-mono text-xs font-bold text-red-400">{formatNumber(selectedAsset?.putGamma)}</div>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2 text-center">
                <div className="text-[9px] text-muted-foreground">P/C Ratio</div>
                <div className="font-mono text-xs font-bold text-blue-400">{selectedAsset?.putCallRatio?.toFixed(2) || "—"}</div>
              </div>
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2 text-center">
                <div className="text-[9px] text-muted-foreground">Gamma Flip</div>
                <div className="font-mono text-xs font-bold text-purple-400">{formatPrice(selectedAsset?.gammaFlipLevel)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ETF GEX Row */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <span className="text-yellow-400 font-bold">GLD</span> GEX
              {etfGexData?.["GLD"]?.is0DTE && <Badge variant="outline" className="text-[8px] border-yellow-500/30 text-yellow-400">0DTE</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <EtfGexPanel gexData={etfGexData?.["GLD"]} symbol="GLD" currentPrice={marketData?.assets?.find((a: any) => a.symbol === "GLD")?.currentPrice || 0} color="yellow" />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="flex items-center gap-2 text-xs font-bold">
              <span className="text-cyan-400 font-bold">DIA</span> GEX
              {etfGexData?.["DIA"]?.is0DTE && <Badge variant="outline" className="text-[8px] border-cyan-500/30 text-cyan-400">0DTE</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <EtfGexPanel gexData={etfGexData?.["DIA"]} symbol="DIA" currentPrice={marketData?.assets?.find((a: any) => a.symbol === "DIA")?.currentPrice || 0} color="cyan" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
