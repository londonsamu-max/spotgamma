export function CountdownRing({ seconds, total = 30 }: { seconds: number; total?: number }) {
  const pct = (seconds / total) * 100;
  const r = 14;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <div className="relative inline-flex items-center justify-center w-8 h-8">
      <svg className="absolute -rotate-90" width="32" height="32">
        <circle cx="16" cy="16" r={r} fill="none" stroke="oklch(0.2 0.01 240)" strokeWidth="2.5" />
        <circle cx="16" cy="16" r={r} fill="none" stroke="oklch(0.65 0.18 160)" strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 1s linear" }} />
      </svg>
      <span className="text-[10px] font-mono text-emerald-400 font-bold">{seconds}</span>
    </div>
  );
}
