import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function BotConfigTab({
  autoTradingData, setAutoTradingConfig, mlStats,
}: {
  autoTradingData: any; setAutoTradingConfig: any; mlStats: any;
}) {
  return (
    <>
      {/* Status Bar */}
      <div className={`rounded-lg border p-3 flex items-center justify-between ${
        autoTradingData?.killSwitch?.triggered ? 'border-red-500/50 bg-red-500/10' :
        autoTradingData?.effectiveEnabled ? 'border-emerald-500/50 bg-emerald-500/10' :
        'border-border bg-card'
      }`}>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${
            autoTradingData?.killSwitch?.triggered ? 'bg-red-500 animate-pulse' :
            autoTradingData?.effectiveEnabled ? 'bg-emerald-400 animate-pulse' :
            'bg-yellow-500'
          }`} />
          <span className="text-sm font-bold">
            {autoTradingData?.killSwitch?.triggered ? '\uD83D\uDD34 KILL SWITCH ACTIVO' :
             autoTradingData?.effectiveEnabled ? '\uD83D\uDFE2 AUTO-TRADING ACTIVO' :
             '\uD83D\uDFE1 AUTO-TRADING PAUSADO'}
          </span>
          {autoTradingData?.killSwitch?.triggered && (
            <span className="text-xs text-red-400">
              Live WR={autoTradingData.killSwitch.liveWR}% &lt; {autoTradingData.config?.killSwitchMinWR}% minimo
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {autoTradingData?.killSwitch?.triggered && (
            <Button size="sm" variant="destructive" className="text-[10px] h-6"
              onClick={() => setAutoTradingConfig.mutate({ resetKillSwitch: true })}>
              Resetear Kill Switch
            </Button>
          )}
          <Button size="sm"
            className={`text-[10px] h-6 px-3 font-bold ${autoTradingData?.config?.enabled ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            disabled={setAutoTradingConfig.isPending}
            onClick={() => setAutoTradingConfig.mutate({ enabled: !autoTradingData?.config?.enabled })}>
            {autoTradingData?.config?.enabled ? 'PAUSAR' : 'ACTIVAR'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* Models */}
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Modelos IA</div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs">MLP Multi-Head</span>
              <Badge variant={mlStats?.models?.mlp?.available ? "default" : "secondary"} className="text-[9px]">
                {mlStats?.models?.mlp?.available ? "\u2705 Activo" : "\u274C No cargado"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs">LSTM Dual-Input</span>
              <Badge variant={mlStats?.models?.lstm?.available ? "default" : "secondary"} className="text-[9px]">
                {mlStats?.models?.lstm?.available ? "\u2705 Activo" : "\u23F3 Entrenando..."}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Ensemble activo</span>
              <span className="font-mono">{mlStats?.models?.active ?? "\u2014"}</span>
            </div>
          </div>
          <Separator className="my-1" />
          <div className="space-y-1">
            <div className="text-[9px] text-muted-foreground uppercase">Aprendizaje en Linea</div>
            <div className="flex justify-between text-[10px]">
              <span>Buffer</span>
              <span className="font-mono">{mlStats?.onlineLearning?.bufferSize ?? 0} exp</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span>WR buffer</span>
              <span className={`font-mono ${(mlStats?.onlineLearning?.bufferWinRate ?? 0) >= 0.5 ? 'text-emerald-400' : 'text-red-400'}`}>
                {mlStats?.onlineLearning?.bufferWinRate ? `${(mlStats.onlineLearning.bufferWinRate * 100).toFixed(0)}%` : "\u2014"}
              </span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span>Banco episodios</span>
              <span className="font-mono">{mlStats?.episodeBank?.total ?? 0}</span>
            </div>
          </div>
        </div>

        {/* Live Win Rate */}
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Tasa Victoria Live (MT5)</div>
          <div className="space-y-2">
            {[
              { label: "Total trades live", value: mlStats?.liveStats?.total ?? 0, pct: null },
              { label: "WR ultimos 10", value: mlStats?.liveStats?.wr10, pct: true },
              { label: "WR ultimos 20", value: mlStats?.liveStats?.wr20, pct: true },
              { label: "WR historico", value: mlStats?.liveStats?.wrAll, pct: true },
            ].map(({ label, value, pct }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{label}</span>
                <span className={`text-xs font-bold font-mono ${
                  pct && value !== null ?
                    (Number(value) >= 60 ? 'text-emerald-400' : Number(value) >= 40 ? 'text-yellow-400' : 'text-red-400')
                    : ''
                }`}>
                  {value === null || value === undefined ? "\u2014" : pct ? `${value}%` : String(value)}
                </span>
              </div>
            ))}
          </div>
          <Separator className="my-1" />
          <div className="text-[9px] text-muted-foreground">
            Solo trades ejecutados en MT5 (con ticket real)
          </div>
          {mlStats?.lastRetrain && (
            <div className="text-[9px] text-muted-foreground">
              Ultimo retrain: {mlStats.lastRetrain.date?.slice(0,10)} {"\u2014"}
              MLP: {mlStats.lastRetrain.mlp?.metrics?.dirAcc ?? "?"}% precision dir.
            </div>
          )}
        </div>

        {/* Config */}
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Configuracion Auto</div>
          <div className="space-y-1.5">
            {[
              { label: "Confianza min. PPO", key: "confidenceThreshold", suffix: "%" },
              { label: "Trades/dia max", key: "maxDailyTrades", suffix: "" },
              { label: "Posiciones simultaneas", key: "maxConcurrentPositions", suffix: "" },
              { label: "Kill switch historial", key: "killSwitchLookback", suffix: " trades" },
              { label: "Kill switch WR min", key: "killSwitchMinWR", suffix: "%" },
            ].map(({ label, key, suffix }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{label}</span>
                <span className="text-[10px] font-mono">{(autoTradingData?.config as any)?.[key]}{suffix}</span>
              </div>
            ))}
          </div>
          <Separator className="my-1" />
          <div className="space-y-1">
            <div className="text-[9px] text-muted-foreground uppercase">Hoy</div>
            <div className="flex justify-between text-[10px]">
              <span>Trades ejecutados</span>
              <span className="font-mono">{autoTradingData?.todayTrades ?? 0}/{autoTradingData?.config?.maxDailyTrades ?? 3}</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span>Posiciones abiertas</span>
              <span className="font-mono">{autoTradingData?.openPositions ?? 0}/{autoTradingData?.config?.maxConcurrentPositions ?? 1}</span>
            </div>
          </div>
          <Separator className="my-1" />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="flex-1 text-[9px] h-6"
              onClick={() => setAutoTradingConfig.mutate({ confidenceThreshold: 65 })}>
              Conf 65%
            </Button>
            <Button size="sm" variant="outline" className="flex-1 text-[9px] h-6"
              onClick={() => setAutoTradingConfig.mutate({ confidenceThreshold: 75 })}>
              Conf 75%
            </Button>
          </div>
        </div>
      </div>

      {/* Kill switch info */}
      <div className="rounded-lg border border-border/50 bg-card/50 p-2 text-[10px] text-muted-foreground">
        <span className="font-semibold text-foreground">Kill Switch:</span>{" "}
        Se activa automaticamente si el WR de los ultimos {autoTradingData?.config?.killSwitchLookback ?? 10} trades MT5 cae
        por debajo de {autoTradingData?.config?.killSwitchMinWR ?? 30}%. El cron retrain corre cada noche a las 5:00 AM ET.
        {mlStats?.nightlyRetrainSchedule && ` Schedule: ${mlStats.nightlyRetrainSchedule}`}
      </div>
    </>
  );
}
