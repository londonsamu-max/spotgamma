import { ArrowLeftRight } from "lucide-react";

export function UvixGldDivergencePanel({ vannaContext, cfdPrices }: { vannaContext: any; cfdPrices: any }) {
  const div = vannaContext?.uvixGldDivergence;
  if (!div && !cfdPrices?.uvix) return null;

  const uvixPrice = cfdPrices?.uvix?.price || 0;
  const uvixPct = cfdPrices?.uvix?.changePct || vannaContext?.uvixChangePct || 0;
  const gldPrice = vannaContext?.gldPrice || cfdPrices?.gld?.price || 0;
  const gldPct = vannaContext?.gldChangePct || cfdPrices?.gld?.changePct || 0;
  const uvxyPrice = cfdPrices?.uvxy?.price || vannaContext?.uvxyPrice || 0;
  const uvxyPct = cfdPrices?.uvxy?.changePct || vannaContext?.uvxyChangePct || 0;

  const divColor = div?.type === 'uvix_up_gld_down' ? 'border-yellow-500/50 bg-yellow-500/10' :
    div?.type === 'uvix_down_gld_up' ? 'border-orange-500/50 bg-orange-500/10' :
    div?.type === 'both_up' ? 'border-emerald-500/30 bg-emerald-500/5' :
    div?.type === 'both_down' ? 'border-red-500/30 bg-red-500/5' :
    'border-slate-500/30 bg-slate-500/5';

  const signalBadge = div?.signal === 'buy_gold' ? { color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', label: 'COMPRAR ORO' } :
    div?.signal === 'sell_gold' ? { color: 'bg-red-500/20 text-red-400 border-red-500/30', label: 'VENDER ORO' } :
    { color: 'bg-slate-500/20 text-slate-400 border-slate-500/30', label: 'NEUTRAL' };

  return (
    <div className={`rounded-xl border-2 p-3 ${divColor}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight size={14} className="text-yellow-400" />
          <span className="text-xs font-bold text-foreground">UVIX-GLD</span>
        </div>
        {div?.isDiverging && (
          <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[9px] font-bold animate-pulse ${signalBadge.color}`}>
            {signalBadge.label}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="bg-background/50 rounded-lg p-1.5 border border-border/30">
          <div className="text-[8px] text-muted-foreground">UVIX</div>
          <div className="font-mono text-[10px] font-bold text-foreground">${uvixPrice.toFixed(2)}</div>
          <div className={`font-mono text-[9px] font-bold ${uvixPct >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {uvixPct >= 0 ? '+' : ''}{uvixPct.toFixed(2)}%
          </div>
        </div>
        <div className="bg-background/50 rounded-lg p-1.5 border border-border/30">
          <div className="text-[8px] text-muted-foreground">UVXY</div>
          <div className="font-mono text-[10px] font-bold text-foreground">${uvxyPrice.toFixed(2)}</div>
          <div className={`font-mono text-[9px] font-bold ${uvxyPct >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {uvxyPct >= 0 ? '+' : ''}{uvxyPct.toFixed(2)}%
          </div>
        </div>
        <div className="bg-background/50 rounded-lg p-1.5 border border-border/30">
          <div className="text-[8px] text-muted-foreground">GLD</div>
          <div className="font-mono text-[10px] font-bold text-yellow-400">${gldPrice.toFixed(2)}</div>
          <div className={`font-mono text-[9px] font-bold ${gldPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {gldPct >= 0 ? '+' : ''}{gldPct.toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="relative h-6 bg-background/30 rounded-lg overflow-hidden mb-2">
        <div className="absolute left-0 top-0 h-full flex items-center justify-center"
          style={{ width: `${Math.min(Math.max(50 + uvixPct * 5, 5), 95)}%`, background: 'linear-gradient(90deg, rgba(239,68,68,0.3), rgba(239,68,68,0.1))' }}>
          <span className="text-[9px] font-bold text-red-400">UVIX {uvixPct >= 0 ? '+' : ''}{uvixPct.toFixed(1)}%</span>
        </div>
        <div className="absolute right-0 top-0 h-full flex items-center justify-center"
          style={{ width: `${Math.min(Math.max(50 + gldPct * 5, 5), 95)}%`, background: 'linear-gradient(270deg, rgba(245,158,11,0.3), rgba(245,158,11,0.1))' }}>
          <span className="text-[9px] font-bold text-yellow-400">GLD {gldPct >= 0 ? '+' : ''}{gldPct.toFixed(1)}%</span>
        </div>
      </div>

      {div?.description && <p className="text-[10px] text-foreground leading-relaxed">{div.description}</p>}
      {div?.strength && div.strength !== 'none' && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[9px] text-muted-foreground">Fuerza:</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
            div.strength === 'strong' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
            div.strength === 'moderate' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' :
            'bg-slate-500/20 text-slate-400 border-slate-500/30'
          }`}>{div.strength.toUpperCase()}</span>
        </div>
      )}
    </div>
  );
}
