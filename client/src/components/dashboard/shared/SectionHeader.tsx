import type { ReactNode } from "react";

export function SectionHeader({ icon: Icon, title, badge, children }: { icon: any; title: string; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <h2 className="text-sm font-bold text-foreground tracking-wide">{title}</h2>
        {badge}
      </div>
      {children}
    </div>
  );
}
