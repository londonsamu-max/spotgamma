import { XCircle, AlertTriangle, Info, Zap } from "lucide-react";

export function AlertItem({ alert }: { alert: any }) {
  const config = {
    critical: { color: "border-red-500/50 bg-red-500/10", icon: XCircle, iconColor: "text-red-400", pulse: true },
    warning: { color: "border-yellow-500/50 bg-yellow-500/10", icon: AlertTriangle, iconColor: "text-yellow-400", pulse: false },
    info: { color: "border-blue-500/50 bg-blue-500/10", icon: Info, iconColor: "text-blue-400", pulse: false },
  };
  const c = config[alert.severity as keyof typeof config] || config.info;
  const Icon = c.icon;
  return (
    <div className={`p-2.5 rounded-lg border ${c.color} mb-2 ${c.pulse && !alert.isRead ? 'animate-pulse' : ''}`}>
      <div className="flex items-start gap-2">
        <Icon size={12} className={`mt-0.5 flex-shrink-0 ${c.iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-[10px] text-foreground">{alert.title}</span>
            <span className="text-[9px] text-muted-foreground font-mono flex-shrink-0">
              {new Date(alert.createdAt).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{alert.message}</p>
          {alert.analysis && (
            <div className="mt-1 p-1.5 bg-card/80 rounded border border-border/30">
              <div className="flex items-center gap-1 mb-0.5">
                <Zap size={8} className="text-purple-400" />
                <span className="text-[9px] font-bold text-purple-400">IA</span>
              </div>
              <p className="text-[10px] text-foreground leading-relaxed">{alert.analysis}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
