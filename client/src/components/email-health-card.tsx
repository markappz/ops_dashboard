import { Info, ShieldCheck } from "lucide-react";

/**
 * Deliverability health card — the "quick grade" for a brand's email program.
 * Renders the server-computed EmailHealth (server/email-health.ts): big letter
 * grade, the component rates as small labeled stats, flags underneath. States:
 * graded, low-volume (grade withheld), and not-connected. Never invents a
 * grade — no health from the server means no letter.
 */

export type EmailGrade = "A" | "B" | "C" | "D" | "F";

export interface EmailHealthData {
  grade: EmailGrade;
  score: number;
  lowVolume: boolean;
  components: {
    deliveredRate: number | null;
    openRate: number | null;
    clickRate: number | null;
    bounceRate: number | null;
    complaintRate: number | null;
    unsubRate: number | null;
    trackedSends: number;
    totalSends: number;
  };
  flags: string[];
}

const GRADE_TONE: Record<EmailGrade, string> = {
  A: "bg-fitscript-green/15 text-fitscript-green border-fitscript-green/30",
  B: "bg-teal-500/15 text-teal-400 border-teal-500/30",
  C: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  D: "bg-red-500/15 text-red-400 border-red-500/30",
  F: "bg-red-500/20 text-red-400 border-red-500/40",
};

const BASIS =
  "Graded on bulk-sender thresholds: complaints <0.1%, bounces <2%, delivered ≥98%, tracked opens ≥30% excellent, unsubs <0.5%. Complaints and bounces weigh heaviest — they are sending-domain health — then opens.";

const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);

function RateStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-[88px]">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums ${warn ? "text-red-400" : "text-ops-text"}`}>{value}</div>
    </div>
  );
}

export function EmailHealthCard({ health, rangeLabel, notConnectedHint }: {
  health: EmailHealthData | null | undefined;
  rangeLabel: string;
  /** Shown when the brand's summary endpoint isn't wired — never a made-up grade. */
  notConnectedHint?: string;
}) {
  if (!health) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-ops-border bg-ops-bg/40 text-lg font-bold text-ops-text-muted">—</div>
        <div>
          <div className="text-sm font-semibold text-ops-text">Deliverability health</div>
          <div className="text-xs text-ops-text-muted">{notConnectedHint ?? "Not connected — no send data to grade yet."}</div>
        </div>
      </div>
    );
  }
  const c = health.components;
  const low = health.lowVolume;
  return (
    <div className="mb-4 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start gap-4">
        <div
          className={`flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl border text-center ${low ? "border-ops-border bg-ops-bg/40 text-ops-text-muted" : GRADE_TONE[health.grade]}`}
          title={low ? "Not enough volume to grade" : `${health.score}/100 — ${BASIS}`}
        >
          <span className="text-2xl font-extrabold leading-none">{low ? "·" : health.grade}</span>
          <span className="mt-1 text-[10px] font-semibold tabular-nums opacity-80">{low ? "low vol" : `${health.score}/100`}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ops-text">
            <ShieldCheck size={15} className="text-ops-text-muted" /> Deliverability health · {rangeLabel}
          </div>
          {low && (
            <div className="mt-1 text-xs font-medium text-yellow-500">
              Not enough volume to grade — {c.trackedSends.toLocaleString()} tracked sends in this window (need 100+).
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            <RateStat label="Delivered" value={pct(c.deliveredRate)} warn={c.deliveredRate !== null && c.deliveredRate < 0.98} />
            <RateStat label="Opens" value={pct(c.openRate)} warn={c.openRate !== null && c.openRate < 0.1} />
            <RateStat label="Clicks" value={pct(c.clickRate)} />
            <RateStat label="Bounces" value={pct(c.bounceRate, 2)} warn={c.bounceRate !== null && c.bounceRate >= 0.02} />
            <RateStat label="Spam" value={pct(c.complaintRate, 2)} warn={c.complaintRate !== null && c.complaintRate >= 0.001} />
            <RateStat label="Unsubs" value={pct(c.unsubRate, 2)} warn={c.unsubRate !== null && c.unsubRate >= 0.005} />
            <RateStat label="Tracked / sends" value={`${c.trackedSends.toLocaleString()} / ${c.totalSends.toLocaleString()}`} />
          </div>
          {health.flags.length > 0 && (
            <ul className="mt-2.5 space-y-1">
              {health.flags.map((f) => (
                <li key={f} className="flex items-start gap-1.5 text-xs text-yellow-500">
                  <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current" />{f}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2.5 flex items-start gap-1.5 text-[11px] text-ops-text-muted">
            <Info size={12} className="mt-0.5 shrink-0" /><span>{BASIS}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Compact per-brand grade chip for the blended rows. */
export function HealthChip({ health }: { health: EmailHealthData | null | undefined }) {
  if (!health) return <span className="text-xs text-ops-text-muted" title="Not connected — no grade">—</span>;
  if (health.lowVolume) {
    return (
      <span className="rounded-md border border-ops-border bg-ops-bg/40 px-1.5 py-0.5 text-[11px] font-semibold text-ops-text-muted"
        title={`Not enough volume to grade (${health.components.trackedSends} tracked sends)`}>
        low vol
      </span>
    );
  }
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${GRADE_TONE[health.grade]}`}
      title={health.flags.length ? `${health.score}/100\n${health.flags.join("\n")}` : `${health.score}/100 — no flags`}>
      {health.grade} <span className="font-semibold opacity-75">{health.score}</span>
    </span>
  );
}
