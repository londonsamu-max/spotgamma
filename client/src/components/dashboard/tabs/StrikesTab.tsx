import { Target, RefreshCw, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StrikePanel } from "@/components/dashboard/charts";
import { TabsContent } from "@/components/ui/tabs";

export function StrikesTab({ selectedAsset, selectedSymbol, handleAnalyzeStrike, analyzingStrike, analysisResult }: {
  selectedAsset: any; selectedSymbol: string;
  handleAnalyzeStrike: (strike: number) => void;
  analyzingStrike: number | null; analysisResult: string | null;
}) {
  return (
              <TabsContent value="strikes" className="mt-3">
                <Card className="bg-card border-border">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
                      <Target size={14} className="text-yellow-400" /> Top Strikes — {selectedSymbol}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <StrikePanel asset={selectedAsset} onAnalyze={handleAnalyzeStrike} />
                    {analyzingStrike && (
                      <div className="mt-3 p-2.5 bg-card/50 border border-emerald-500/30 rounded-lg">
                        <div className="flex items-center gap-2 text-[10px] text-emerald-400">
                          <RefreshCw size={10} className="animate-spin" /> Analizando {analyzingStrike?.toLocaleString()}...
                        </div>
                      </div>
                    )}
                    {analysisResult && (
                      <div className="mt-3 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                        <div className="text-[10px] font-bold text-emerald-400 mb-1 flex items-center gap-1"><Zap size={9} /> Analisis</div>
                        <p className="text-[10px] text-foreground leading-relaxed">{analysisResult}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
  );
}
