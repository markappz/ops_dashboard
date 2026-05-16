import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RevenueChart } from "../components/charts/revenue-chart";

interface Snapshot {
  totalUsers: number;
  tiers: Record<string, number>;
  activeSubscribers: number;
  signupsToday: number;
  signupsWeek: number;
  signupsMonth: number;
  cancelledMonth: number;
  churnRate: string;
  totalLabs: number;
  totalConsultations: number;
  totalAtlasChats: number;
  waitlistCount: number;
  mrr: number;
  arr: number;
  revenueMonth: number;
}

interface ActivityItem {
  type: "signup" | "lab_upload";
  email?: string;
  name?: string;
  tier?: string;
  userId?: string;
  status?: string;
  timestamp: string | null;
}

function MetricCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
      <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">
        {label}
      </div>
      <div className={`text-2xl font-bold ${accent ? "text-fitscript-green" : "text-ops-text"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ops-text-muted mt-1">{sub}</div>}
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl">
      <div className="px-5 py-4 border-b border-ops-border">
        <h3 className="text-sm font-semibold text-ops-text">Recent Activity</h3>
      </div>
      <div className="divide-y divide-ops-border max-h-96 overflow-y-auto">
        {items.map((item, i) => (
          <div key={i} className="px-5 py-3 flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              item.type === "signup" ? "bg-fitscript-green" : "bg-blue-400"
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-ops-text truncate">
                {item.type === "signup" ? (
                  <>New signup: <span className="text-ops-text-muted">{item.email}</span></>
                ) : (
                  <>Lab uploaded<span className="text-ops-text-muted"> — {item.status}</span></>
                )}
              </div>
            </div>
            <div className="text-xs text-ops-text-muted shrink-0">
              {item.timestamp ? formatTimeAgo(new Date(item.timestamp)) : "—"}
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-ops-text-muted">No recent activity</div>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export default function CommandCenter() {
  const { data: snapshot, isLoading } = useQuery<Snapshot>({
    queryKey: ["ops-snapshot"],
    queryFn: () => fetch("/api/ops/snapshot").then((r) => r.json()),
    refetchInterval: 30_000, // refresh every 30s
  });

  const { data: activityData } = useQuery<{ activity: ActivityItem[] }>({
    queryKey: ["ops-activity"],
    queryFn: () => fetch("/api/ops/activity").then((r) => r.json()),
    refetchInterval: 15_000,
  });

  const { data: economics } = useQuery<{
    coverage: string;
    cost_mtd: number;
    revenue_mtd: number;
    gross_margin_pct: number | null;
    users_mtd: number;
    top_users: { user_id: string; email: string; cost_usd: number; calls: number; revenue_usd: number }[];
  }>({
    queryKey: ["ops-economics-platform"],
    queryFn: () => fetch("/api/ops/economics/platform?days=30").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  if (isLoading || !snapshot) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="w-8 h-8 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Command Center</h1>
        <p className="text-sm text-ops-text-muted mt-1">FitScript business at a glance</p>
      </div>

      {/* Revenue Row */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <MetricCard label="MRR" value={formatCurrency(snapshot.mrr)} accent />
        <MetricCard label="ARR" value={formatCurrency(snapshot.arr)} />
        <MetricCard label="Revenue (30d)" value={formatCurrency(snapshot.revenueMonth)} />
        <MetricCard
          label="Churn Rate"
          value={`${snapshot.churnRate}%`}
          sub={`${snapshot.cancelledMonth} cancelled this month`}
        />
      </div>

      {/* Subscribers Row */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <MetricCard label="Total Users" value={snapshot.totalUsers.toLocaleString()} />
        <MetricCard
          label="Active Subscribers"
          value={snapshot.activeSubscribers}
          accent
        />
        <MetricCard
          label="Free"
          value={snapshot.tiers.free || 0}
        />
        <MetricCard
          label="Essentials"
          value={snapshot.tiers.essentials || 0}
        />
        <MetricCard
          label="Complete"
          value={snapshot.tiers.complete || 0}
        />
      </div>

      {/* Signups + Engagement Row */}
      <div className="grid grid-cols-6 gap-4 mb-6">
        <MetricCard label="Signups Today" value={snapshot.signupsToday} />
        <MetricCard label="Signups (7d)" value={snapshot.signupsWeek} />
        <MetricCard label="Signups (30d)" value={snapshot.signupsMonth} />
        <MetricCard label="Lab Uploads" value={snapshot.totalLabs} />
        <MetricCard label="Atlas Chats" value={snapshot.totalAtlasChats} />
        <MetricCard label="Waitlist" value={snapshot.waitlistCount} />
      </div>

      {/* Unit Economics */}
      {economics && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-sm font-semibold text-ops-text">Unit Economics — Last 30 Days</h3>
            <div className="text-xs text-ops-text-muted">
              {economics.coverage === "atlas_only"
                ? "Atlas chat only · other AI surfaces pending instrumentation"
                : "All AI surfaces"}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4 mb-5">
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Revenue MTD</div>
              <div className="text-2xl font-bold text-fitscript-green">
                {formatCurrency(economics.revenue_mtd)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">AI Cost MTD</div>
              <div className="text-2xl font-bold text-amber-300">
                {economics.cost_mtd < 1
                  ? `$${economics.cost_mtd.toFixed(4)}`
                  : formatCurrency(economics.cost_mtd)}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">{economics.users_mtd} active users</div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Gross Margin</div>
              <div
                className={`text-2xl font-bold ${
                  economics.gross_margin_pct === null
                    ? "text-ops-text-muted"
                    : economics.gross_margin_pct >= 70
                    ? "text-fitscript-green"
                    : economics.gross_margin_pct >= 40
                    ? "text-amber-400"
                    : "text-red-400"
                }`}
              >
                {economics.gross_margin_pct === null
                  ? "—"
                  : `${economics.gross_margin_pct.toFixed(1)}%`}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">
                Rev − AI cost
              </div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Cost / User</div>
              <div className="text-2xl font-bold text-ops-text">
                {economics.users_mtd > 0
                  ? `$${(economics.cost_mtd / economics.users_mtd).toFixed(4)}`
                  : "—"}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">avg AI cost MTD</div>
            </div>
          </div>

          {/* Top costly users */}
          {economics.top_users.length > 0 && (
            <div className="pt-4 border-t border-ops-border">
              <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
                Highest AI Cost (MTD)
              </div>
              <div className="space-y-2">
                {economics.top_users.map((u) => {
                  const ratio = u.revenue_usd > 0 ? (u.cost_usd / u.revenue_usd) * 100 : null;
                  return (
                    <Link
                      key={u.user_id}
                      href={`/members/${u.user_id}`}
                      className="flex items-center justify-between text-sm py-1.5 hover:bg-ops-surface-hover rounded px-2 -mx-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-ops-text truncate">{u.email || u.user_id.slice(0, 8)}</div>
                        <div className="text-xs text-ops-text-muted">{u.calls} calls</div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-fitscript-green font-medium">${u.revenue_usd.toFixed(2)}</div>
                          <div className="text-[10px] text-ops-text-muted">revenue</div>
                        </div>
                        <div className="text-right w-20">
                          <div className="text-amber-300 font-medium">${u.cost_usd.toFixed(4)}</div>
                          <div className="text-[10px] text-ops-text-muted">cost</div>
                        </div>
                        <div className="text-right w-16">
                          <div
                            className={
                              ratio === null
                                ? "text-ops-text-muted"
                                : ratio < 20
                                ? "text-fitscript-green"
                                : ratio < 50
                                ? "text-amber-400"
                                : "text-red-400"
                            }
                          >
                            {ratio === null ? "—" : `${ratio.toFixed(1)}%`}
                          </div>
                          <div className="text-[10px] text-ops-text-muted">cost/rev</div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Revenue Chart */}
      <div className="mb-6">
        <RevenueChart />
      </div>

      {/* Activity Feed */}
      <ActivityFeed items={activityData?.activity || []} />
    </div>
  );
}
