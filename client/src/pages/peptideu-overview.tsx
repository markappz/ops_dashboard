import { useQuery } from "@tanstack/react-query";
import { PuKpi, PuLoading, PuUnavailable, SignupsChart, PU_GOLD } from "../components/peptideu/ui";

interface Snapshot {
  totalUsers: number;
  signups7d: number;
  signups30d: number;
  premiumUsers: number;
  freeUsers: number;
  onboarded: number;
  graduates: number;
  activeUsers7d: number;
  conversionRate: number;
  mrrEstimate: number;
  arrEstimate: number;
  error?: string;
}

interface FunnelStage { label: string; count: number; pct: number; }
interface RankRow { rank: string; count: number; }

const RANK_LABELS: Record<string, string> = {
  freshman: "Freshman", sophomore: "Sophomore", junior: "Junior", senior: "Senior", graduate: "Graduate",
};

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }

function Funnel({ stages }: { stages: FunnelStage[] }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <h3 className="text-sm font-semibold text-ops-text mb-4">Signup → Premium funnel</h3>
      <div className="space-y-3">
        {stages.map((s) => (
          <div key={s.label}>
            <div className="flex justify-between text-xs text-ops-text-muted mb-1">
              <span>{s.label}</span>
              <span>{s.count.toLocaleString()} &middot; {pct(s.pct)}</span>
            </div>
            <div className="h-2.5 rounded-full bg-ops-bg overflow-hidden">
              <div className="h-full rounded-full bg-fitscript-green" style={{ width: `${Math.max(s.pct * 100, s.count > 0 ? 3 : 0)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Ranks({ rows }: { rows: RankRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <h3 className="text-sm font-semibold text-ops-text mb-4">Rank distribution</h3>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.rank}>
            <div className="flex justify-between text-xs text-ops-text-muted mb-1">
              <span>{RANK_LABELS[r.rank] || r.rank}</span>
              <span>{r.count.toLocaleString()}</span>
            </div>
            <div className="h-2.5 rounded-full bg-ops-bg overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max((r.count / max) * 100, r.count > 0 ? 3 : 0)}%`, backgroundColor: PU_GOLD }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PeptideuOverview() {
  const { data: snapshot, isLoading } = useQuery<Snapshot>({
    queryKey: ["peptideu-snapshot"],
    queryFn: () => fetch("/api/ops/peptideu/snapshot").then((r) => r.json()),
    refetchInterval: 30_000,
  });
  const { data: funnel } = useQuery<FunnelStage[]>({
    queryKey: ["peptideu-funnel"],
    queryFn: () => fetch("/api/ops/peptideu/funnel").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const { data: ranks } = useQuery<RankRow[]>({
    queryKey: ["peptideu-ranks"],
    queryFn: () => fetch("/api/ops/peptideu/ranks").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  if (isLoading || !snapshot) return <PuLoading />;
  if (snapshot.error) return (
    <div>
      <div className="mb-8"><h1 className="text-2xl font-bold text-ops-text">PeptideU</h1></div>
      <PuUnavailable message={snapshot.error} />
    </div>
  );

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">PeptideU Overview</h1>
        <p className="text-sm text-ops-text-muted mt-1">Education &amp; research app &middot; by Real Peptides</p>
      </div>

      {/* Revenue estimate row */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <PuKpi label="MRR (est.)" value={money(snapshot.mrrEstimate)} sub="premium × yearly plan" accent />
        <PuKpi label="ARR (est.)" value={money(snapshot.arrEstimate)} />
        <PuKpi label="Premium members" value={snapshot.premiumUsers.toLocaleString()} accent />
        <PuKpi label="Free → Premium" value={pct(snapshot.conversionRate)} sub={`${snapshot.premiumUsers} of ${snapshot.totalUsers}`} />
      </div>

      {/* Users row */}
      <div className="grid grid-cols-6 gap-4 mb-6">
        <PuKpi label="Total Users" value={snapshot.totalUsers.toLocaleString()} />
        <PuKpi label="Free" value={snapshot.freeUsers.toLocaleString()} />
        <PuKpi label="Signups (7d)" value={snapshot.signups7d.toLocaleString()} />
        <PuKpi label="Signups (30d)" value={snapshot.signups30d.toLocaleString()} />
        <PuKpi label="Active (7d)" value={snapshot.activeUsers7d.toLocaleString()} sub="completed a lesson" />
        <PuKpi label="Graduates" value={snapshot.graduates.toLocaleString()} />
      </div>

      {/* Signups chart */}
      <div className="mb-6">
        <SignupsChart />
      </div>

      {/* Funnel + Ranks */}
      <div className="grid grid-cols-2 gap-4">
        <Funnel stages={funnel || []} />
        <Ranks rows={ranks || []} />
      </div>
    </div>
  );
}
