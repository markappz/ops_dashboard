import { StatCard } from "../components/stat";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RevenueChart } from "../components/charts/revenue-chart";
import { PageHero } from "../components/page-hero";
import { DateRangePicker, rangeDays, rangeKey, rangeQuery, useDateRange } from "../components/date-range-picker";

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

interface FsOverview {
  window: { from: string; to: string; days: number };
  revenue: {
    cents: number; prevCents: number; orders: number;
    byRail: Record<string, number>;
    series: { date: string; cents: number }[];
    paceDailyCents: number; paceMonthlyCents: number; paceAnnualCents: number; paceNote: string; basis: string;
  };
  mrr: { cents: number; arrCents: number };
  users: { total: number; newInWindow: number; newPrev: number; activeInWindow: number };
  subscribers: { activeNow: number; tiers: { free: number; essentials: number; complete: number }; newPayingInWindow: number; cancelsInWindow: number };
  sessions: { cur: number; prev: number };
  activity: { labUploads: number; atlasChats: number };
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

// Facelift P3: both legacy tiles ride the shared StatCard.
function MetricCard({ label, value, sub, accent, i }: { label: string; value: string | number; sub?: string; accent?: boolean; i?: number }) {
  return <StatCard label={label} value={value} sub={sub} accent={accent} i={i} />;
}

function GrowthCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <StatCard label={label} value={value} sub={sub} />;
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

function usdC(cents: number | undefined): string {
  return cents == null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function deltaPct(cur?: number, prev?: number): string | undefined {
  if (cur == null || prev == null || prev === 0) return undefined;
  const d = ((cur - prev) / prev) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs prior`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export default function CommandCenter() {
  // Same calendar widget as every other brand (Paul, 10-07: FitScript had
  // Today/7d/30d chips while RP/pawgen/PU/NB run the DateRangePicker). The
  // reports endpoints take a day count, so a custom calendar range maps to
  // its span ending today — presets behave identically to the other brands.
  const [growthRange, setGrowthRange] = useDateRange("fitscript-overview");
  const growthDays = rangeDays(growthRange);
  const { data: snapshot, isLoading } = useQuery<Snapshot>({
    queryKey: ["ops-snapshot"],
    queryFn: () => fetch("/api/ops/snapshot").then((r) => r.json()),
    refetchInterval: 30_000, // refresh every 30s
  });

  // THE window feed: every tile below the picker reads this one endpoint
  // (lib/fitscript-revenue three-rail — same numbers as the Command Center).
  const { data: ov } = useQuery<FsOverview>({
    queryKey: ["fs-overview", rangeKey(growthRange)],
    queryFn: () => fetch(`/api/ops/fitscript/overview?${rangeQuery(growthRange)}`).then((r) => r.json()),
    refetchInterval: 60_000,
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

  // Integration health strip — surfaces disconnects without forcing a trip to Settings.
  const { data: connections } = useQuery<{
    google: { connected: boolean; ga4PropertyId?: string; gscSiteUrl?: string };
  }>({
    queryKey: ["ops-connections"],
    queryFn: () => fetch("/api/ops/connections").then((r) => r.json()),
    refetchInterval: 60_000 * 5,
  });
  const { data: klaviyo } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["klaviyo-status"],
    queryFn: () => fetch("/api/ops/klaviyo/status").then((r) => r.json()),
    refetchInterval: 60_000 * 5,
  });
  const { data: metaStatus } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["meta-status"],
    queryFn: () => fetch("/api/ops/meta/status").then((r) => r.json()),
    refetchInterval: 60_000 * 5,
  });

  // Growth Overview — pulls top-line metrics from each report. 30d window.
  const { data: trafficSummary } = useQuery<{
    overview?: { sessions: number; users: number; page_views: number };
  }>({
    queryKey: ["growth-traffic", growthDays],
    queryFn: () => fetch(`/api/ops/reports/traffic?days=${growthDays}`).then((r) => r.json()),
    refetchInterval: 5 * 60_000,
  });
  const { data: emailSummary } = useQuery<{
    engagement?: { open_rate: number | null };
    subscribers?: { total: number | null; new_in_window: number | null };
  }>({
    queryKey: ["growth-email", growthDays],
    queryFn: () => fetch(`/api/ops/reports/email?days=${growthDays}`).then((r) => r.json()),
    refetchInterval: 5 * 60_000,
  });
  const { data: salesSummary } = useQuery<{
    window?: { revenue_usd: number; orders: number };
    lifetime?: { repeat_rate_pct: number | null; avg_ltv_usd: number | null };
  }>({
    queryKey: ["growth-sales", growthDays],
    queryFn: () => fetch(`/api/ops/reports/sales?days=${growthDays}`).then((r) => r.json()),
    refetchInterval: 5 * 60_000,
  });
  const { data: adsSummary } = useQuery<{
    meta?: { connected: boolean; spend_usd: number; roas: number | null };
  }>({
    queryKey: ["growth-ads", growthDays],
    queryFn: () => fetch(`/api/ops/reports/ads?days=${growthDays}`).then((r) => r.json()),
    refetchInterval: 5 * 60_000,
  });

  if (isLoading || !snapshot) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="w-8 h-8 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Build integration health array — only render strip when something's red.
  const integrations = [
    {
      name: "Google",
      connected: !!connections?.google?.connected,
      detail: connections?.google?.connected
        ? connections.google.ga4PropertyId && connections.google.gscSiteUrl
          ? "GA4 + GSC selected"
          : "Property/site not selected"
        : "Not connected",
    },
    {
      name: "Klaviyo",
      connected: !!klaviyo?.connected,
      detail: klaviyo?.connected ? "Live" : klaviyo?.configured ? "Auth failed" : "Not configured",
    },
    {
      name: "Meta Ads",
      connected: !!metaStatus?.connected,
      detail: metaStatus?.connected ? "Live" : metaStatus?.configured ? "Auth failed" : "Not configured",
    },
  ];
  const anyDisconnected = integrations.some((i) => !i.connected);

  return (
    <div>
      <PageHero
        eyebrow="FitScript"
        title="Overview"
        subtitle="FitScript business at a glance — revenue, subscribers, unit economics, and integration health."
        actions={
          anyDisconnected ? (
            <Link href="/settings">
              <div className="flex items-center gap-3 px-3 py-2 bg-ops-surface border border-ops-border rounded-xl shadow-card cursor-pointer hover:bg-ops-surface-hover transition-colors">
                {integrations.map((i) => (
                  <div key={i.name} className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${i.connected ? "bg-brand-blue-500" : "bg-red-400"}`} />
                    <span className="text-xs text-ops-text-muted">{i.name}</span>
                  </div>
                ))}
                <span className="text-xs text-brand-blue-500 ml-1">Fix →</span>
              </div>
            </Link>
          ) : undefined
        }
      />

      {/* Growth Overview — top-line from the Reports section */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-3">
            <div className="text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500">
              Growth Overview
            </div>
            <DateRangePicker value={growthRange} onChange={setGrowthRange} />
          </div>
          <Link href="/reports/traffic">
            <span className="text-[11px] text-ops-text-muted hover:text-brand-blue-500 cursor-pointer">
              See all reports →
            </span>
          </Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 sm:gap-4">
          <Link href="/reports/traffic">
            <GrowthCard
              label="Site sessions"
              value={
                trafficSummary?.overview
                  ? trafficSummary.overview.sessions.toLocaleString()
                  : "—"
              }
              sub={
                trafficSummary?.overview
                  ? `${trafficSummary.overview.users.toLocaleString()} users`
                  : undefined
              }
            />
          </Link>
          <Link href="/reports/conversions">
            <GrowthCard
              label="Email list signups"
              value={
                emailSummary?.subscribers?.new_in_window != null
                  ? emailSummary.subscribers.new_in_window.toLocaleString()
                  : "—"
              }
              sub={
                emailSummary?.subscribers?.total != null
                  ? `${emailSummary.subscribers.total.toLocaleString()} total`
                  : undefined
              }
            />
          </Link>
          <Link href="/reports/email">
            <GrowthCard
              label="Email open rate"
              value={
                emailSummary?.engagement?.open_rate != null
                  ? `${emailSummary.engagement.open_rate.toFixed(1)}%`
                  : "—"
              }
              sub="Engagement"
            />
          </Link>
          <Link href="/reports/sales">
            <GrowthCard
              label="Lab revenue"
              value={
                salesSummary?.window?.revenue_usd != null
                  ? formatCurrency(salesSummary.window.revenue_usd)
                  : "—"
              }
              sub={
                salesSummary?.window?.orders != null
                  ? `${salesSummary.window.orders} orders`
                  : undefined
              }
            />
          </Link>
          <Link href="/reports/ads">
            <GrowthCard
              label="Ad ROAS"
              value={
                adsSummary?.meta?.connected && adsSummary.meta.roas != null
                  ? `${adsSummary.meta.roas.toFixed(2)}×`
                  : "—"
              }
              sub={
                adsSummary?.meta?.connected
                  ? `${formatCurrency(adsSummary.meta.spend_usd)} spend`
                  : "Connect Meta"
              }
            />
          </Link>
        </div>
      </div>

      {/* Billing — the window the picker chose, with what it equals at pace */}
      <div className="mb-1 text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500">
        Billing · {growthRange.label}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6 mt-2">
        <MetricCard
          label={`Billed · ${growthRange.label}`}
          value={usdC(ov?.revenue.cents)}
          sub={ov ? deltaPct(ov.revenue.cents, ov.revenue.prevCents) ?? `${ov.revenue.orders} charges` : undefined}
          accent
        />
        <MetricCard label="≈ Monthly at this pace" value={usdC(ov?.revenue.paceMonthlyCents)} sub={ov?.revenue.paceNote} />
        <MetricCard label="≈ Annual at this pace" value={usdC(ov?.revenue.paceAnnualCents)} sub={ov?.revenue.paceNote} />
        <MetricCard label="MRR now" value={usdC(ov?.mrr.cents)} sub={ov ? `${usdC(ov.mrr.arrCents)} ARR` : undefined} />
      </div>

      {/* People — same window */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 mb-6">
        <MetricCard
          label={`New users · ${growthRange.label}`}
          value={ov?.users.newInWindow ?? "—"}
          sub={ov ? deltaPct(ov.users.newInWindow, ov.users.newPrev) : undefined}
          accent
        />
        <MetricCard label={`Active users · ${growthRange.label}`} value={ov?.users.activeInWindow ?? "—"} sub={ov ? `${ov.users.total.toLocaleString()} total` : undefined} />
        <MetricCard label={`Sessions · ${growthRange.label}`} value={ov?.sessions.cur ?? "—"} sub={ov ? deltaPct(ov.sessions.cur, ov.sessions.prev) : undefined} />
        <MetricCard label={`New paying · ${growthRange.label}`} value={ov?.subscribers.newPayingInWindow ?? "—"} />
        <MetricCard label={`Cancellations · ${growthRange.label}`} value={ov?.subscribers.cancelsInWindow ?? "—"} />
      </div>

      {/* Point-in-time — labeled "now", never window-scoped */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 mb-6">
        <MetricCard label="Active subscribers now" value={ov?.subscribers.activeNow ?? snapshot.activeSubscribers} accent />
        <MetricCard label="Free" value={ov?.subscribers.tiers.free ?? snapshot.tiers.free ?? 0} />
        <MetricCard label="Essentials" value={ov?.subscribers.tiers.essentials ?? snapshot.tiers.essentials ?? 0} />
        <MetricCard label="Complete" value={ov?.subscribers.tiers.complete ?? snapshot.tiers.complete ?? 0} />
        <MetricCard label={`Lab uploads · ${growthRange.label}`} value={ov?.activity.labUploads ?? "—"} />
        <MetricCard label={`Atlas chats · ${growthRange.label}`} value={ov?.activity.atlasChats ?? "—"} />
      </div>

      {/* Unit Economics */}      {/* Unit Economics */}
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
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
