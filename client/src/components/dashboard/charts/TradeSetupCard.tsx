import { ArrowUpCircle, ArrowDownCircle, PauseCircle, CheckCircle, XCircle, Zap, AlertTriangle, RotateCcw } from "lucide-react";
import { formatNumber, formatPrice, SYMBOL_COLORS } from "../constants";

export function TradeSetupCard({ setup }: { setup: any }) {
  if (!setup) return null;

  const dirConfig: Record<string, { bg: string; border: string; text: string; icon: any; glow: string; label: string }> = {
    LONG: { bg: "bg-emerald-500/8", border: "border-emerald-500/40", text: "text-emerald-400", icon: ArrowUpCircle, glow: "shadow-emerald-500/10 shadow-lg", label: "COMPRA" },
    SHORT: { bg: "bg-red-500/8", border: "border-red-500/40", text: "text-red-400", icon: ArrowDownCircle, glow: "shadow-red-500/10 shadow-lg", label: "VENTA" },
    NO_TRADE: { bg: "bg-slate-500/8", border: "border-slate-500/40", text: "text-slate-400", icon: PauseCircle, glow: "", label: "NO OPERAR" },
  };

  const cfg = dirConfig[setup.direction] || dirConfig.NO_TRADE;
  const Icon = cfg.icon;

  const scoreColor = setup.score >= 70 ? "text-emerald-400" : setup.score >= 50 ? "text-yellow-400" : setup.score >= 40 ? "text-orange-400" : "text-red-400";
  const scoreBg = setup.score >= 70 ? "bg-emerald-500/15 border-emerald-500/30" : setup.score >= 50 ? "bg-yellow-500/15 border-yellow-500/30" : setup.score >= 40 ? "bg-orange-500/15 border-orange-500/30" : "bg-red-500/15 border-red-500/30";

  const hierarchyConfig: Record<string, { color: string; label: string }> = {
    dominant: { color: "bg-red-500/20 text-red-400 border-red-500/30", label: "DOMINANTE" },
    reaction: { color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", label: "REACCION" },
    minor: { color: "bg-slate-500/20 text-slate-400 border-slate-500/30", label: "MENOR" },
  };
  const hierarchy = setup.entryZone?.hierarchy || "minor";
  const hCfg = hierarchyConfig[hierarchy] || hierarchyConfig.minor;

  // All 13 trade type badges
  const tradeTypeConfig: Record<string, { color: string; label: string }> = {
    gamma:          { color: "bg-purple-500/20 text-purple-400 border-purple-500/30", label: "GAMMA" },
    breakout:       { color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30", label: "BREAKOUT" },
    bounce:         { color: "bg-green-500/20 text-green-400 border-green-500/30", label: "BOUNCE" },
    vanna_index:    { color: "bg-blue-500/20 text-blue-400 border-blue-500/30", label: "VANNA IDX" },
    vanna_gold:     { color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", label: "VANNA GLD" },
    refuge:         { color: "bg-orange-500/20 text-orange-400 border-orange-500/30", label: "REFUGIO" },
    cross_asset:    { color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30", label: "CONSENSO" },
    im_exhaustion:  { color: "bg-pink-500/20 text-pink-400 border-pink-500/30", label: "IM EXHAUST" },
    opex_pin:       { color: "bg-violet-500/20 text-violet-400 border-violet-500/30", label: "OPEX PIN" },
    hiro_divergence:{ color: "bg-amber-500/20 text-amber-400 border-amber-500/30", label: "HIRO DIV" },
    gamma_squeeze:  { color: "bg-rose-500/20 text-rose-400 border-rose-500/30", label: "G-SQUEEZE" },
    charm_flow:     { color: "bg-teal-500/20 text-teal-400 border-teal-500/30", label: "CHARM" },
    news_reaction:  { color: "bg-sky-500/20 text-sky-400 border-sky-500/30", label: "NEWS" },
  };
  const ttCfg = tradeTypeConfig[setup.tradeType] || tradeTypeConfig.gamma;

  // 6 confirmations
  const isGold = setup.cfd === 'XAUUSD';
  const isDow = setup.cfd === 'US30';
  const gexLabel = isGold ? "GEX+VIX" : isDow ? "GEX DIA" : "GEX 0DTE";
  const confirmations = [
    { label: gexLabel, ok: setup.gexConfirmed },
    { label: "HIRO", ok: setup.hiroConfirmed },
    { label: "TAPE", ok: setup.tapeConfirmed },
    { label: "NIVEL", ok: setup.levelConfirmed },
    { label: "VANNA", ok: setup.vannaConfirmed },
    { label: "REGIMEN", ok: setup.regimeConfirmed },
  ];
  const confirmedCount = confirmations.filter(c => c.ok).length;

  const cfdDecimals = setup.cfd === 'XAUUSD' ? 2 : 0;
  const fmtCfd = (v: number) => v ? v.toFixed(cfdDecimals) : '—';

  return (
    <div className={`rounded-xl border-2 ${cfg.border} ${cfg.bg} ${cfg.glow} p-4 transition-all duration-300`}>
      {/* Row 1: Direction + CFD + Trade Type + Score */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Icon size={26} className={cfg.text} />
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xl font-black tracking-wider ${cfg.text}`}>{cfg.label}</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-bold ${ttCfg.color}`}>{ttCfg.label}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs font-bold text-cyan-400">{setup.cfd}</span>
              <span className="text-[10px] text-muted-foreground">({setup.cfdLabel})</span>
              {setup.cfdEntryPrice > 0 && (
                <span className="font-mono text-xs font-bold text-foreground">@ {fmtCfd(setup.cfdEntryPrice)}</span>
              )}
            </div>
            {/* Cross-asset consensus */}
            {setup.crossAssetConsensus && setup.crossAssetConsensus.consensusStrength !== 'none' && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-muted-foreground">Consenso:</span>
                {setup.crossAssetConsensus.assetsAnalyzed?.map((a: string) => (
                  <span key={a} className="text-[10px] font-bold" style={{ color: SYMBOL_COLORS[a] || '#888' }}>{a}</span>
                ))}
                <span className={`text-[10px] font-bold ${setup.crossAssetConsensus.consensusStrength === 'strong' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                  ({setup.crossAssetConsensus.consensusStrength?.toUpperCase()})
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className={`inline-flex items-center px-3 py-1 rounded-lg border text-lg font-black font-mono ${scoreBg} ${scoreColor}`}>
            {setup.score}/100
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">{confirmedCount}/6 conf.</div>
        </div>
      </div>

      {/* Entry Mode Banner */}
      {(() => {
        const em = (setup as any).entryMode as string | undefined;
        const eq = (setup as any).entryQuality as string | undefined;
        const enote = (setup as any).entryNote as string | undefined;
        const slabel = (setup as any).sessionLabel as string | undefined;
        if (!em || em === "NO_OPERAR") return null;
        const isEntrada = em === "ENTRADA";
        const isOptimal = eq === "optimal";
        const bannerCls = isEntrada
          ? isOptimal
            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
            : "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
          : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400";
        const icon = isEntrada ? (isOptimal ? "🎯" : "✅") : "⏳";
        return (
          <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border mb-3 ${bannerCls}`}>
            <span className="text-sm leading-none mt-0.5">{icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black tracking-wide">{em}</span>
                {slabel && <span className="text-[10px] opacity-70">{slabel}</span>}
              </div>
              {enote && <div className="text-[10px] opacity-80 mt-0.5 leading-snug">{enote.replace(/^[✅⏳⛔👁]\s*/,'')}</div>}
            </div>
          </div>
        );
      })()}

      {/* SG Levels + IV/Skew/VRP Context Badges */}
      {setup.sgLevels && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${
            setup.sgLevels.gammaRegime === 'positive' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
            setup.sgLevels.gammaRegime === 'negative' || setup.sgLevels.gammaRegime === 'very_negative' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
            'bg-slate-500/20 text-slate-400 border-slate-500/30'
          }`}>GAMMA {setup.sgLevels.gammaRegime?.toUpperCase()}</span>

          {(setup as any).ivRank > 0 && (
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${
              (setup as any).ivRegime === 'high_iv' ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' :
              (setup as any).ivRegime === 'low_iv'  ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
              'bg-slate-500/20 text-slate-400 border-slate-500/30'
            }`}>
              IV {(setup as any).ivRank?.toFixed(0)}%{' '}
              {(setup as any).ivRegime === 'high_iv' ? '▲' : (setup as any).ivRegime === 'low_iv' ? '▼' : '—'}
            </span>
          )}

          {(setup as any).skewBias && (setup as any).skewBias !== 'neutral' && (
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${
              (setup as any).skewBias === 'put_skew'
                ? 'bg-red-500/20 text-red-400 border-red-500/30'
                : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
            }`}>
              SKEW {(setup as any).skewBias === 'put_skew' ? 'PUTS' : 'CALLS'}
            </span>
          )}

          {setup.sgLevels.callWall > 0 && <span className="text-[10px] text-muted-foreground">CW:<span className="font-mono text-emerald-400 ml-0.5">${setup.sgLevels.callWall.toLocaleString()}</span></span>}
          {setup.sgLevels.putWall > 0 && <span className="text-[10px] text-muted-foreground">PW:<span className="font-mono text-red-400 ml-0.5">${setup.sgLevels.putWall.toLocaleString()}</span></span>}
          {setup.sgLevels.keyGamma > 0 && <span className="text-[10px] text-muted-foreground">KG:<span className="font-mono text-purple-400 ml-0.5">${setup.sgLevels.keyGamma.toLocaleString()}</span></span>}
          {setup.sgLevels.impliedMove > 0 && <span className="text-[10px] text-muted-foreground">IM:<span className="font-mono text-yellow-400 ml-0.5">{setup.sgLevels.impliedMove.toFixed(1)}pts</span></span>}

          {(setup as any).highVolPoint > 0 && (
            <span className="text-[10px] text-muted-foreground">HVP:<span className="font-mono text-orange-400 ml-0.5">${(setup as any).highVolPoint.toLocaleString()}</span></span>
          )}
          {(setup as any).lowVolPoint > 0 && (
            <span className="text-[10px] text-muted-foreground">LVP:<span className="font-mono text-sky-400 ml-0.5">${(setup as any).lowVolPoint.toLocaleString()}</span></span>
          )}
          {(setup as any).vrp !== 0 && (setup as any).vrp !== undefined && (
            <span className={`text-[10px] font-mono ${
              (setup as any).vrp > 0.05 ? 'text-orange-400' :
              (setup as any).vrp < -0.02 ? 'text-sky-400' :
              'text-muted-foreground'
            }`}>
              VRP {(setup as any).vrp > 0 ? '+' : ''}{((setup as any).vrp * 100).toFixed(1)}%
            </span>
          )}
        </div>
      )}

      {/* Entry Zone + Hierarchy */}
      {setup.entryZone && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-muted-foreground">Nivel:</span>
          <span className="font-mono text-sm font-bold text-foreground">${setup.entryZone.strike?.toLocaleString()}</span>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${hCfg.color}`}>{hCfg.label}</span>
          <span className="text-[10px] text-muted-foreground">({setup.entryZone.distancePct?.toFixed(2)}%)</span>
          {setup.entryZone.confluenceWithSG && <span className="text-cyan-400 font-bold text-[10px]">+ {setup.entryZone.sgLevelType}</span>}
          {setup.entryZone.distancePct < 0.15 && <span className="text-emerald-400 font-bold text-[10px] animate-pulse">EN ZONA</span>}
        </div>
      )}

      {/* Vanna Signal */}
      {setup.vannaSignal?.detected && (
        <div className={`rounded-lg p-2 mb-3 border ${setup.vannaSignal.type === 'bullish_vanna' ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
          <div className="flex items-center gap-1 mb-0.5">
            <Zap size={10} className={setup.vannaSignal.type === 'bullish_vanna' ? 'text-emerald-400' : 'text-red-400'} />
            <span className={`text-xs font-bold ${setup.vannaSignal.type === 'bullish_vanna' ? 'text-emerald-400' : 'text-red-400'}`}>VANNA ({setup.vannaSignal.strength?.toUpperCase()})</span>
          </div>
          <p className="text-[10px] text-foreground leading-relaxed">{setup.vannaSignal.description}</p>
        </div>
      )}

      {/* 6 Confirmation Grid */}
      <div className="grid grid-cols-6 gap-1 mb-3">
        {confirmations.map((c) => (
          <div key={c.label} className={`rounded-lg p-1.5 text-center border ${c.ok ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/5 border-red-500/20'}`}>
            <div className="flex items-center justify-center gap-0.5">
              {c.ok ? <CheckCircle size={8} className="text-emerald-400" /> : <XCircle size={8} className="text-red-400" />}
              <span className="text-[9px] font-bold text-foreground">{c.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* SL / TP / Management */}
      {setup.direction !== 'NO_TRADE' && setup.cfdEntryPrice > 0 && (
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-2">
              <div className="text-[10px] text-blue-400 font-bold mb-0.5">ENTRADA</div>
              <div className="font-mono text-base font-bold text-blue-400">{fmtCfd(setup.cfdEntryPrice)}</div>
              <div className="text-[9px] text-muted-foreground">{(setup as any).lotSize || ''} lotes</div>
            </div>
            <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-2">
              <div className="text-[10px] text-red-400 font-bold mb-0.5">STOP LOSS</div>
              <div className="font-mono text-base font-bold text-red-400">{fmtCfd(setup.stopLoss)}</div>
              <div className="text-[9px] text-muted-foreground">{setup.stopLossPoints?.toFixed(1)}pts | ${setup.stopLossRiskUSD?.toFixed(2)}</div>
            </div>
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-2">
              <div className="text-[10px] text-blue-400 font-bold mb-0.5">R:R</div>
              <div className={`font-mono text-base font-bold ${setup.riskRewardRatio >= 2 ? 'text-emerald-400' : setup.riskRewardRatio >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                1:{setup.riskRewardRatio?.toFixed(1)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-emerald-400 font-bold mb-0.5">TP1 (50%)</div>
              <div className="font-mono text-sm font-bold text-emerald-400">{fmtCfd(setup.takeProfit1)}</div>
              <div className="text-[9px] text-muted-foreground">+{setup.takeProfit1Points?.toFixed(1)}pts</div>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-emerald-400 font-bold mb-0.5">TP2 (30%)</div>
              <div className="font-mono text-sm font-bold text-emerald-400">{fmtCfd(setup.takeProfit2)}</div>
              <div className="text-[9px] text-muted-foreground">+{setup.takeProfit2Points?.toFixed(1)}pts</div>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-emerald-400 font-bold mb-0.5">TP3 (20%)</div>
              <div className="font-mono text-sm font-bold text-emerald-400">{fmtCfd(setup.takeProfit3)}</div>
              <div className="text-[9px] text-muted-foreground">+{setup.takeProfit3Points?.toFixed(1)}pts | trailing</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-2">
              <div className="text-[10px] text-purple-400 font-bold mb-0.5">GESTION</div>
              <div className="text-[10px] text-muted-foreground">BE: <span className="font-mono text-foreground">{fmtCfd(setup.breakEvenTrigger)}</span> | Trail: <span className="font-mono text-foreground">{fmtCfd(setup.trailingStopTrigger)}</span></div>
            </div>
            <div className="bg-slate-500/5 border border-slate-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-400 font-bold mb-0.5">SL RAZON</div>
              <div className="text-[9px] text-muted-foreground leading-tight">{setup.stopLossReason}</div>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic TP Adjustment */}
      {setup.dynamicTP?.shouldAdjust && (
        <div className={`rounded-lg p-2.5 mb-3 border ${
          setup.dynamicTP.action === 'close_now' ? 'bg-red-500/10 border-red-500/30 animate-pulse' :
          setup.dynamicTP.action === 'tighten_tp' ? 'bg-yellow-500/10 border-yellow-500/30' :
          setup.dynamicTP.action === 'extend_tp' ? 'bg-emerald-500/10 border-emerald-500/30' :
          'bg-orange-500/10 border-orange-500/30'
        }`}>
          <div className="flex items-center gap-1 mb-1">
            <RotateCcw size={10} className="text-orange-400" />
            <span className="text-xs font-bold text-foreground">TP DINAMICO: {({
              hold: 'MANTENER', tighten_tp: 'APRETAR TP', extend_tp: 'EXTENDER TP',
              close_now: 'CERRAR AHORA', move_to_breakeven: 'MOVER A BE'
            } as Record<string, string>)[setup.dynamicTP.action] || 'MANTENER'}</span>
          </div>
          <p className="text-[10px] text-foreground leading-relaxed">{setup.dynamicTP.reason}</p>
          {(setup.dynamicTP.adjustedTP1 > 0 || setup.dynamicTP.adjustedTP2 > 0) && (
            <div className="flex items-center gap-3 mt-1">
              {setup.dynamicTP.adjustedTP1 > 0 && <span className="text-[10px] text-muted-foreground">TP1: <span className="font-mono font-bold text-emerald-400">{fmtCfd(setup.dynamicTP.adjustedTP1)}</span></span>}
              {setup.dynamicTP.adjustedTP2 > 0 && <span className="text-[10px] text-muted-foreground">TP2: <span className="font-mono font-bold text-emerald-400">{fmtCfd(setup.dynamicTP.adjustedTP2)}</span></span>}
            </div>
          )}
        </div>
      )}

      {/* Invalidation Triggers */}
      {(setup as any).invalidation?.conditions?.length > 0 && (
        <div className="bg-orange-500/5 border border-orange-500/20 rounded-lg p-2.5 mb-3">
          <div className="flex items-center gap-1 mb-1">
            <AlertTriangle size={10} className="text-orange-400" />
            <span className="text-[10px] font-bold text-orange-400">INVALIDACION</span>
          </div>
          <div className="space-y-0.5">
            {(setup as any).invalidation.conditions.map((c: string, i: number) => (
              <div key={i} className="flex items-start gap-1">
                <span className="text-orange-400 text-[9px] mt-0.5">•</span>
                <span className="text-[9px] text-muted-foreground">{c}</span>
              </div>
            ))}
          </div>
          {(setup as any).invalidation.hiroReversed && (
            <div className="mt-1 text-[9px] font-bold text-orange-400 animate-pulse">⚠ HIRO revertido</div>
          )}
        </div>
      )}

      {/* Reason */}
      <div className="bg-background/50 rounded-lg p-2.5 border border-border/50">
        <p className="text-[11px] text-foreground leading-relaxed">{setup.reason}</p>
      </div>

      {/* Confirmation Details (collapsible) */}
      {setup.details && setup.details.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {setup.details.map((d: string, i: number) => (
            <div key={i} className={`text-[10px] pl-2 border-l ${
              d.startsWith('[') && d.includes('\u2713') ? 'text-emerald-400/80 border-emerald-500/50' :
              d.startsWith('[') && d.includes('\u2717') ? 'text-red-400/60 border-red-500/30' :
              d.startsWith('---') ? 'text-cyan-400 border-cyan-500/50 font-bold' :
              'text-muted-foreground border-border/50'
            }`}>{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}
