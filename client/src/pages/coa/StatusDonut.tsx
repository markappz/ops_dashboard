import type { Status } from "./api";

const SEGMENTS: { key: Status; label: string; color: string }[] = [
  { key: "expired", label: "Expired", color: "#F87171" },
  { key: "expiring", label: "Expiring soon", color: "#EAB308" },
  { key: "untested", label: "Untested", color: "#64748B" },
  { key: "fresh", label: "Fresh", color: "#0EA57A" },
];

// Workflow filters cut across freshness: where each product physically is.
const WORKFLOW: { key: string; label: string; color: string }[] = [
  { key: "tosend", label: "Send to lab", color: "#F97316" },
  { key: "atlab", label: "At the lab", color: "#8B5CF6" },
];

export function StatusDonut({ counts, total, active, onPick }: {
  counts: Record<string, number>; total: number; active: string; onPick: (k: string) => void;
}) {
  const data = SEGMENTS.map((s) => ({ ...s, count: counts[s.key] || 0 }));
  const sum = data.reduce((a, b) => a + b.count, 0) || 1;
  let acc = 0;
  const stops = data.map((d) => {
    const start = (acc / sum) * 100;
    acc += d.count;
    return `${d.color} ${start}% ${(acc / sum) * 100}%`;
  }).join(", ");

  return (
    <div className="flex flex-col items-center gap-6 rounded-2xl border border-ops-border bg-ops-surface p-5 shadow-card sm:flex-row">
      <div className="relative shrink-0" style={{ width: 132, height: 132 }}>
        <div className="h-full w-full rounded-full" style={{ background: `conic-gradient(${stops})` }} />
        <div className="absolute inset-[14px] grid place-items-center rounded-full bg-ops-surface">
          <div className="text-center">
            <div className="text-2xl font-bold leading-none text-ops-text">{total}</div>
            <div className="mt-0.5 text-[11px] text-ops-text-muted">products</div>
          </div>
        </div>
      </div>
      <div className="grid w-full flex-1 grid-cols-2 gap-2">
        <Tile label="All" count={total} color="#94A3B8" active={active === "all"} onClick={() => onPick("all")} />
        {data.map((d) => (
          <Tile key={d.key} label={d.label} count={d.count} color={d.color} active={active === d.key} onClick={() => onPick(d.key)} />
        ))}
        {WORKFLOW.map((w) => (
          <Tile key={w.key} label={w.label} count={counts[w.key] || 0} color={w.color} active={active === w.key} onClick={() => onPick(w.key)} />
        ))}
      </div>
    </div>
  );
}

function Tile({ label, count, color, active, onClick }: { label: string; count: number; color: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${active ? "border-fitscript-green bg-fitscript-green/10" : "border-ops-border hover:border-ops-text-muted"}`}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-sm font-semibold tabular-nums text-ops-text">{count}</span>
      <span className="truncate text-xs text-ops-text-muted">{label}</span>
    </button>
  );
}
