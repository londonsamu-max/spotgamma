import { Thermometer, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricsPanel } from "@/components/dashboard/charts";
import { SYMBOL_COLORS } from "@/components/dashboard/constants";
import { TabsContent } from "@/components/ui/tabs";

export function MetricsVolTab({ selectedAsset, selectedSymbol, marketData, setSelectedSymbol }: {
  selectedAsset: any; selectedSymbol: string; marketData: any;
  setSelectedSymbol: (s: string) => void;
}) {
  return (
              <TabsContent value="metrics-vol" className="mt-3 space-y-3">
                {/* Metrics */}
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
                      <Eye size={14} className="text-blue-400" /> Metricas — {selectedSymbol}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <MetricsPanel asset={selectedAsset} />
                  </CardContent>
                </Card>

              {/* Volatility - inside metrics-vol tab */}
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="flex items-center gap-2 text-sm font-bold">
                      <Thermometer size={14} className="text-orange-400" /> Volatilidad
                      {marketData?.volContext && (
                        <Badge variant="outline" className={`ml-1 text-[9px] ${
                          marketData.volContext.overallRegime === 'extreme_vol' ? 'border-red-500/50 text-red-400 bg-red-500/10' :
                          marketData.volContext.overallRegime === 'high_vol' ? 'border-orange-500/50 text-orange-400 bg-orange-500/10' :
                          marketData.volContext.overallRegime === 'low_vol' ? 'border-blue-500/50 text-blue-400 bg-blue-500/10' :
                          'border-emerald-500/50 text-emerald-400 bg-emerald-500/10'
                        }`}>
                          {marketData.volContext.overallRegime === 'extreme_vol' ? 'EXTREMA' :
                           marketData.volContext.overallRegime === 'high_vol' ? 'ALTA' :
                           marketData.volContext.overallRegime === 'low_vol' ? 'BAJA' : 'NORMAL'}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {marketData?.volContext ? (() => {
                      const vc = marketData.volContext;
                      const assets = Object.values(vc.perAsset).sort((a: any, b: any) => b.atmIV - a.atmIV);
                      return (
                        <div className="space-y-3">
                          <div className={`rounded-lg p-2.5 border text-[10px] leading-relaxed ${
                            vc.overallRegime === 'extreme_vol' ? 'bg-red-500/10 border-red-500/30 text-red-300' :
                            vc.overallRegime === 'high_vol' ? 'bg-orange-500/10 border-orange-500/30 text-orange-300' :
                            vc.overallRegime === 'low_vol' ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' :
                            'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          }`}>
                            <div className="flex items-center gap-1.5 mb-1 font-bold text-[11px]">
                              <Thermometer size={10} /> Resumen
                            </div>
                            {vc.marketSummary}
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <div className="rounded-lg bg-muted/30 p-2 text-center">
                              <div className="text-[9px] text-muted-foreground">Estructura Temporal</div>
                              <div className={`text-xs font-bold ${vc.avgTermStructure === 'backwardation' ? 'text-red-400' : 'text-emerald-400'}`}>
                                {vc.avgTermStructure === 'backwardation' ? '⚠ Backw.' : '✓ Contango'}
                              </div>
                            </div>
                            <div className="rounded-lg bg-muted/30 p-2 text-center">
                              <div className="text-[9px] text-muted-foreground">P/C Skew Prom.</div>
                              <div className={`text-xs font-bold ${vc.avgPutCallSkew > 3 ? 'text-red-400' : vc.avgPutCallSkew < -3 ? 'text-emerald-400' : 'text-slate-300'}`}>
                                {vc.avgPutCallSkew > 0 ? '+' : ''}{vc.avgPutCallSkew}%
                              </div>
                            </div>
                            <div className="rounded-lg bg-muted/30 p-2 text-center">
                              <div className="text-[9px] text-muted-foreground">Activos</div>
                              <div className="text-xs font-bold text-slate-200">{assets.length}</div>
                            </div>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full text-[10px]">
                              <thead>
                                <tr className="border-b border-border text-muted-foreground">
                                  <th className="text-left py-1 px-1.5">Activo</th>
                                  <th className="text-right py-1 px-1.5">ATM IV</th>
                                  <th className="text-right py-1 px-1.5">Nivel</th>
                                  <th className="text-right py-1 px-1.5">Term</th>
                                  <th className="text-right py-1 px-1.5">P/C Skew</th>
                                </tr>
                              </thead>
                              <tbody>
                                {assets.map((a: any) => {
                                  const ivColor = a.ivLevel === 'very_high' ? 'text-red-400' :
                                    a.ivLevel === 'high' ? 'text-orange-400' :
                                    a.ivLevel === 'normal' ? 'text-slate-200' :
                                    a.ivLevel === 'low' ? 'text-blue-400' : 'text-blue-300';
                                  const levelLabel = a.ivLevel === 'very_high' ? 'MUY ALTA' :
                                    a.ivLevel === 'high' ? 'ALTA' :
                                    a.ivLevel === 'normal' ? 'NORMAL' :
                                    a.ivLevel === 'low' ? 'BAJA' : 'MUY BAJA';
                                  return (
                                    <tr key={a.symbol} className={`border-b border-border/30 hover:bg-muted/20 cursor-pointer ${selectedSymbol === a.symbol ? 'bg-yellow-500/10' : ''}`}
                                        onClick={() => setSelectedSymbol(a.symbol)}>
                                      <td className="py-1 px-1.5 font-bold" style={{ color: (SYMBOL_COLORS as any)[a.symbol] || '#fff' }}>{a.symbol}</td>
                                      <td className={`py-1 px-1.5 text-right font-mono font-bold ${ivColor}`}>{a.atmIV}%</td>
                                      <td className="py-1 px-1.5 text-right"><span className={`px-1 py-0.5 rounded text-[8px] font-bold ${ivColor}`}>{levelLabel}</span></td>
                                      <td className={`py-1 px-1.5 text-right font-mono ${a.termStructure === 'backwardation' ? 'text-red-400' : 'text-emerald-400'}`}>
                                        {a.termStructure === 'backwardation' ? '⚠ Backw.' : '✓ Cont.'}
                                      </td>
                                      <td className={`py-1 px-1.5 text-right font-mono ${a.putCallSkew > 3 ? 'text-red-400' : a.putCallSkew < -3 ? 'text-emerald-400' : 'text-slate-400'}`}>
                                        {a.putCallSkew > 0 ? '+' : ''}{a.putCallSkew}%
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {(() => {
                            const sel = vc.perAsset[selectedSymbol];
                            if (!sel) return null;
                            return (
                              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-2.5">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="text-xs font-bold" style={{ color: (SYMBOL_COLORS as any)[selectedSymbol] || '#fff' }}>{selectedSymbol}</span>
                                  <span className="text-[10px] text-muted-foreground">Detalle</span>
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                  <div>
                                    <div className="text-[8px] text-muted-foreground">IV ATM Cercana</div>
                                    <div className="font-mono text-xs font-bold text-foreground">{sel.atmIV}%</div>
                                  </div>
                                  <div>
                                    <div className="text-[8px] text-muted-foreground">IV ATM Lejana</div>
                                    <div className="font-mono text-xs font-bold text-foreground">{sel.farTermIV}%</div>
                                  </div>
                                  <div>
                                    <div className="text-[8px] text-muted-foreground">Spread Temporal</div>
                                    <div className={`font-mono text-xs font-bold ${sel.termSpread < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                                      {sel.termSpread > 0 ? '+' : ''}{sel.termSpread}%
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[8px] text-muted-foreground">P/C Skew</div>
                                    <div className={`font-mono text-xs font-bold ${sel.putCallSkew > 3 ? 'text-red-400' : sel.putCallSkew < -3 ? 'text-emerald-400' : 'text-slate-300'}`}>
                                      {sel.putCallSkew > 0 ? '+' : ''}{sel.putCallSkew}%
                                    </div>
                                  </div>
                                </div>
                                <div className="mt-2">
                                  <div className="flex items-center justify-between text-[8px] text-muted-foreground mb-0.5">
                                    <span>Baja</span><span>Normal</span><span>Alta</span>
                                  </div>
                                  <div className="h-2.5 rounded-full bg-gradient-to-r from-blue-600 via-emerald-500 via-yellow-500 to-red-600 relative">
                                    {(() => {
                                      const thresholds = [12, 16, 22, 30, 40];
                                      const pct = Math.min(100, Math.max(0, ((sel.atmIV - thresholds[0]) / (thresholds[4] - thresholds[0])) * 100));
                                      return <div className="absolute top-[-1px] w-0.5 h-[calc(100%+2px)] bg-white rounded-full shadow-lg" style={{ left: `${pct}%` }} />;
                                    })()}
                                  </div>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })() : (
                      <div className="text-center text-muted-foreground text-xs py-8">
                        <Thermometer size={24} className="mx-auto mb-2 opacity-30" /> Cargando...
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
  );
}
