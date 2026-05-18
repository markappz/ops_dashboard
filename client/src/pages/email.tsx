import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";

interface KlaviyoStatus {
  configured: boolean;
  connected: boolean;
  organization?: string | null;
  defaultSenderEmail?: string | null;
  defaultSenderName?: string | null;
  timezone?: string | null;
  error?: string;
}

interface Campaign {
  id: string;
  name: string;
  status: string | null;
  archived: boolean;
  sendTime: string | null;
  scheduledAt: string | null;
  createdAt: string | null;
}

interface Flow {
  id: string;
  name: string;
  status: string | null;
  triggerType: string | null;
  updatedAt: string | null;
}

interface List {
  id: string;
  name: string;
  updatedAt: string | null;
}

interface Segment extends List {
  isActive: boolean;
}

type Tab = "campaigns" | "flows" | "lists" | "sends";

interface CampaignStats {
  opens?: number;
  opens_unique?: number;
  clicks?: number;
  clicks_unique?: number;
  delivered?: number;
  bounced?: number;
  unsubscribes?: number;
  recipients?: number;
  open_rate?: number;
  click_rate?: number;
  click_to_open_rate?: number;
  bounce_rate?: number;
  unsubscribe_rate?: number;
  conversions?: number;
  conversion_value?: number;
  revenue_per_recipient?: number;
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function fmtInt(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  return v.toLocaleString();
}
function fmtMoney(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  if (v === 0) return "$0";
  return v < 1 ? `$${v.toFixed(2)}` : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface DashboardSend {
  id: number;
  admin_email: string;
  klaviyo_campaign_id: string | null;
  name: string;
  subject: string;
  recipient_count: number;
  send_method: string;
  scheduled_for: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  Sent: "text-fitscript-green",
  Sending: "text-fitscript-green",
  Live: "text-fitscript-green",
  Draft: "text-ops-text-muted",
  Scheduled: "text-yellow-400",
  Manual: "text-yellow-400",
  Cancelled: "text-red-400",
  "Cancelled by error": "text-red-400",
  paused: "text-yellow-400",
  draft: "text-ops-text-muted",
  live: "text-fitscript-green",
};

function fmtDate(s: string | null) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-ops-text-muted text-xs">—</span>;
  const cls = STATUS_COLORS[status] ?? "text-ops-text-muted";
  return <span className={`text-xs font-medium ${cls}`}>{status}</span>;
}

function NotConfigured() {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center">
      <h2 className="text-lg font-semibold text-ops-text mb-2">
        Klaviyo not connected
      </h2>
      <p className="text-sm text-ops-text-muted mb-4 max-w-md mx-auto">
        Add a Klaviyo private API key to your environment to surface campaigns,
        flows, and lists here.
      </p>
      <code className="block bg-ops-bg px-3 py-2 rounded text-xs font-mono text-ops-text-muted max-w-md mx-auto">
        KLAVIYO_API_KEY=pk_...
      </code>
    </div>
  );
}

function summarizeKlaviyoError(raw: string): { headline: string; hint: string; detail: string } {
  // Klaviyo errors come back as "Klaviyo 401: {\"errors\":[{...}]}" from our wrapper.
  // Pull the first errors[].detail and pair it with an actionable hint.
  let status: number | null = null;
  let detail = "";
  const statusMatch = raw.match(/Klaviyo (\d{3})/);
  if (statusMatch) status = parseInt(statusMatch[1]);
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart));
      detail = body?.errors?.[0]?.detail || body?.message || "";
    } catch {
      /* fall through */
    }
  }
  if (status === 401 || /incorrect.*credentials/i.test(detail)) {
    return {
      headline: "Klaviyo rejected the API key",
      hint: "Generate a new private key in Klaviyo (Account → Settings → API Keys) and update KLAVIYO_API_KEY in the ops .env. Required scopes: Campaigns + Templates + Lists + Segments + Flows + Profiles + Accounts.",
      detail: detail || "401 Unauthorized",
    };
  }
  if (status === 403) {
    return {
      headline: "Klaviyo key is missing a required scope",
      hint: "Edit the key in Klaviyo and add the missing permission. Restart isn't needed for scope changes.",
      detail,
    };
  }
  if (status === 429) {
    return {
      headline: "Klaviyo rate-limited the request",
      hint: "Will retry automatically. If this persists, the account-level limits may be exhausted.",
      detail,
    };
  }
  return {
    headline: status ? `Klaviyo returned ${status}` : "Klaviyo connection failed",
    hint: "Check the Klaviyo status page or verify the API key.",
    detail: detail || raw.slice(0, 200),
  };
}

function ConnectionError({ message }: { message: string }) {
  const { headline, hint, detail } = summarizeKlaviyoError(message);
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 max-w-3xl">
      <div className="text-sm font-medium text-red-300 mb-1">{headline}</div>
      <div className="text-xs text-red-200/80 mb-3">{hint}</div>
      <details>
        <summary className="text-[11px] text-red-300/60 cursor-pointer hover:text-red-300/90">
          Show raw error
        </summary>
        <div className="mt-2 text-[11px] font-mono text-red-300/60 bg-red-500/5 rounded p-2 break-all">
          {detail}
        </div>
      </details>
    </div>
  );
}

export default function Email() {
  const [tab, setTab] = useState<Tab>("campaigns");

  const { data: status, isLoading: statusLoading } = useQuery<KlaviyoStatus>({
    queryKey: ["klaviyo-status"],
    queryFn: () => fetch("/api/ops/klaviyo/status").then((r) => r.json()),
  });

  const enabled = !!status?.connected;

  const { data: campaignsData, isLoading: campaignsLoading } = useQuery<{
    campaigns: Campaign[];
  }>({
    queryKey: ["klaviyo-campaigns"],
    queryFn: () => fetch("/api/ops/klaviyo/campaigns").then((r) => r.json()),
    enabled,
  });

  const { data: flowsData } = useQuery<{ flows: Flow[] }>({
    queryKey: ["klaviyo-flows"],
    queryFn: () => fetch("/api/ops/klaviyo/flows").then((r) => r.json()),
    enabled,
  });

  const { data: listsData } = useQuery<{ lists: List[] }>({
    queryKey: ["klaviyo-lists"],
    queryFn: () => fetch("/api/ops/klaviyo/lists").then((r) => r.json()),
    enabled,
  });

  const { data: segmentsData } = useQuery<{ segments: Segment[] }>({
    queryKey: ["klaviyo-segments"],
    queryFn: () => fetch("/api/ops/klaviyo/segments").then((r) => r.json()),
    enabled,
  });

  const { data: sendsData } = useQuery<{ sends: DashboardSend[] }>({
    queryKey: ["klaviyo-dashboard-sends"],
    queryFn: () => fetch("/api/ops/klaviyo/sends").then((r) => r.json()),
    enabled,
    refetchInterval: 30_000,
  });

  const { data: metricsData } = useQuery<{
    metrics: Record<string, CampaignStats>;
    timeframe: string;
    campaignCount: number;
    revenueAvailable: boolean;
    conversionMetricName: string | null;
    warning: string | null;
  }>({
    queryKey: ["klaviyo-campaign-metrics"],
    queryFn: () =>
      fetch("/api/ops/klaviyo/campaign-metrics?days=30").then((r) => r.json()),
    enabled,
    staleTime: 60_000 * 5,
  });

  const { data: flowMetricsData } = useQuery<{
    metrics: Record<string, CampaignStats>;
    revenueAvailable: boolean;
    warning: string | null;
  }>({
    queryKey: ["klaviyo-flow-metrics"],
    queryFn: () =>
      fetch("/api/ops/klaviyo/flow-metrics?days=30").then((r) => r.json()),
    enabled,
    staleTime: 60_000 * 5,
  });

  if (statusLoading) {
    return (
      <div className="text-sm text-ops-text-muted">Loading Klaviyo…</div>
    );
  }

  if (!status?.configured) {
    return (
      <>
        <Header canSend={false} />
        <NotConfigured />
      </>
    );
  }

  if (!status.connected) {
    return (
      <>
        <Header canSend={false} />
        <ConnectionError message={status.error || "Unknown error"} />
      </>
    );
  }

  const campaigns = campaignsData?.campaigns ?? [];
  const flows = flowsData?.flows ?? [];
  const lists = listsData?.lists ?? [];
  const segments = segmentsData?.segments ?? [];

  const recentSent = campaigns.filter((c) => c.status === "Sent").slice(0, 30);
  const liveFlows = flows.filter(
    (f) => f.status?.toLowerCase() === "live"
  ).length;

  return (
    <div>
      <Header canSend />

      {/* Connection chip */}
      <div className="bg-ops-surface border border-ops-border rounded-xl px-5 py-4 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
          <div>
            <div className="text-sm font-medium text-ops-text">
              {status.organization || "Klaviyo"} — Connected
            </div>
            {status.defaultSenderEmail && (
              <div className="text-xs text-ops-text-muted">
                Default sender:{" "}
                {status.defaultSenderName
                  ? `${status.defaultSenderName} <${status.defaultSenderEmail}>`
                  : status.defaultSenderEmail}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Stat label="Campaigns" value={campaigns.length} />
        <Stat label="Sent (recent)" value={recentSent.length} />
        <Stat label="Live flows" value={liveFlows} />
        <Stat label="Lists / Segments" value={lists.length + segments.length} />
      </div>

      {/* Tabs */}
      <div className="border-b border-ops-border mb-4 flex gap-6">
        {(
          [
            { v: "campaigns", label: "Campaigns" },
            { v: "flows", label: "Flows" },
            { v: "lists", label: "Lists" },
            { v: "sends", label: "Recent sends" },
          ] as { v: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.v
                ? "border-fitscript-green text-fitscript-green"
                : "border-transparent text-ops-text-muted hover:text-ops-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "campaigns" && (
        <CampaignsTable
          campaigns={campaigns}
          loading={campaignsLoading}
          metrics={metricsData?.metrics ?? {}}
          revenueAvailable={metricsData?.revenueAvailable ?? false}
          metricsWarning={metricsData?.warning ?? null}
        />
      )}
      {tab === "flows" && (
        <FlowsTable
          flows={flows}
          metrics={flowMetricsData?.metrics ?? {}}
          revenueAvailable={flowMetricsData?.revenueAvailable ?? false}
          metricsWarning={flowMetricsData?.warning ?? null}
        />
      )}
      {tab === "lists" && (
        <ListsAndSegments lists={lists} segments={segments} />
      )}
      {tab === "sends" && (
        <DashboardSendsTable
          sends={sendsData?.sends ?? []}
          metrics={metricsData?.metrics ?? {}}
          revenueAvailable={metricsData?.revenueAvailable ?? false}
        />
      )}
    </div>
  );
}

function DashboardSendsTable({
  sends,
  metrics,
  revenueAvailable,
}: {
  sends: DashboardSend[];
  metrics: Record<string, CampaignStats>;
  revenueAvailable: boolean;
}) {
  if (sends.length === 0) {
    return (
      <div className="text-sm text-ops-text-muted">
        No sends from this dashboard yet. Hit{" "}
        <span className="text-ops-text font-medium">Send campaign</span> in the top right to send your first one.
      </div>
    );
  }
  const statusColor: Record<string, string> = {
    submitted: "text-fitscript-green",
    queued: "text-yellow-400",
    failed: "text-red-400",
  };
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
          <tr>
            <th className="text-left px-5 py-3 font-medium">Subject</th>
            <th className="text-left px-5 py-3 font-medium">Sent by</th>
            <th className="text-right px-5 py-3 font-medium">Recipients</th>
            <th className="text-right px-5 py-3 font-medium">Delivered</th>
            <th className="text-right px-5 py-3 font-medium">Open</th>
            <th className="text-right px-5 py-3 font-medium">Click</th>
            <th className="text-right px-5 py-3 font-medium">
              {revenueAvailable ? "Revenue" : "Conv."}
            </th>
            <th className="text-left px-5 py-3 font-medium">Status</th>
            <th className="text-left px-5 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ops-border">
          {sends.map((s) => {
            const m = s.klaviyo_campaign_id ? metrics[s.klaviyo_campaign_id] : undefined;
            const ageMin = (Date.now() - new Date(s.created_at).getTime()) / 60000;
            const tooFresh = ageMin < 30 && !m;
            return (
            <tr key={s.id}>
              <td className="px-5 py-3 text-ops-text">
                <div className="truncate max-w-[260px]">{s.subject}</div>
                <div className="text-xs text-ops-text-muted truncate max-w-[260px]">
                  {s.name}
                </div>
              </td>
              <td className="px-5 py-3 text-ops-text-muted text-xs">{s.admin_email}</td>
              <td className="px-5 py-3 text-ops-text text-right">
                {s.recipient_count.toLocaleString()}
              </td>
              <td className="px-5 py-3 text-right text-ops-text-muted">
                {m ? fmtInt(m.delivered) : tooFresh ? <span className="opacity-50">pending</span> : "—"}
              </td>
              <td className="px-5 py-3 text-right text-ops-text">
                {m ? fmtPct(m.open_rate) : "—"}
              </td>
              <td className="px-5 py-3 text-right text-ops-text">
                {m ? fmtPct(m.click_rate) : "—"}
              </td>
              <td className="px-5 py-3 text-right text-fitscript-green font-medium">
                {m
                  ? revenueAvailable
                    ? fmtMoney(m.conversion_value)
                    : fmtInt(m.conversions)
                  : "—"}
              </td>
              <td className={`px-5 py-3 text-xs font-medium ${statusColor[s.status] || "text-ops-text-muted"}`}>
                {s.status}
                {s.error && (
                  <div className="text-xs text-red-400/80 truncate max-w-[180px]" title={s.error}>
                    {s.error}
                  </div>
                )}
              </td>
              <td className="px-5 py-3 text-ops-text-muted text-xs">
                {fmtDate(s.created_at)}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Header({ canSend = false }: { canSend?: boolean }) {
  return (
    <div className="mb-8 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-ops-text">Email</h1>
        <p className="text-sm text-ops-text-muted mt-1">
          Klaviyo campaigns, flows, and audiences
        </p>
      </div>
      {canSend && (
        <div className="flex gap-2">
          <Link href="/email/compose">
            <button className="px-4 py-2 text-sm font-medium rounded-lg bg-ops-surface border border-ops-border text-ops-text hover:bg-ops-surface-hover">
              Compose with Claude
            </button>
          </Link>
          <Link href="/email/send">
            <button className="px-4 py-2 text-sm font-medium rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90">
              Send campaign
            </button>
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
      <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">
        {label}
      </div>
      <div className="text-2xl font-bold text-ops-text">{value}</div>
    </div>
  );
}

function CampaignsTable({
  campaigns,
  loading,
  metrics,
  revenueAvailable,
  metricsWarning,
}: {
  campaigns: Campaign[];
  loading: boolean;
  metrics: Record<string, CampaignStats>;
  revenueAvailable: boolean;
  metricsWarning: string | null;
}) {
  if (loading) {
    return <div className="text-sm text-ops-text-muted">Loading campaigns…</div>;
  }
  if (campaigns.length === 0) {
    return (
      <div className="text-sm text-ops-text-muted">No campaigns found.</div>
    );
  }

  // Leaderboards over campaigns that have metrics in the window
  const withMetrics = campaigns
    .map((c) => ({ c, m: metrics[c.id] }))
    .filter((x) => x.m && (x.m.recipients ?? 0) > 0);
  const topOpens = [...withMetrics]
    .sort((a, b) => (b.m.open_rate ?? 0) - (a.m.open_rate ?? 0))
    .slice(0, 3);
  const topRevenue = revenueAvailable
    ? [...withMetrics]
        .sort((a, b) => (b.m.conversion_value ?? 0) - (a.m.conversion_value ?? 0))
        .slice(0, 3)
    : [];

  return (
    <>
      {metricsWarning && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 mb-4 text-xs text-amber-200/90">
          {metricsWarning}
        </div>
      )}

      {(topOpens.length > 0 || topRevenue.length > 0) && (
        <div className="grid grid-cols-2 gap-4 mb-5">
          <Leaderboard
            title="Top open rate (last 30d)"
            rows={topOpens.map((x) => ({
              name: x.c.name,
              primary: fmtPct(x.m.open_rate),
              secondary: `${fmtInt(x.m.delivered)} delivered`,
            }))}
          />
          {revenueAvailable ? (
            <Leaderboard
              title="Top revenue (last 30d)"
              rows={topRevenue.map((x) => ({
                name: x.c.name,
                primary: fmtMoney(x.m.conversion_value),
                secondary: `${fmtInt(x.m.conversions)} conversions`,
              }))}
            />
          ) : (
            <div className="bg-ops-surface border border-ops-border rounded-xl p-4 text-xs text-ops-text-muted">
              Revenue leaderboard unavailable until a store integration
              (Shopify/Stripe) is connected in Klaviyo.
            </div>
          )}
        </div>
      )}

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
              <th className="text-right px-5 py-3 font-medium">Sent</th>
              <th className="text-right px-5 py-3 font-medium">Open</th>
              <th className="text-right px-5 py-3 font-medium">Click</th>
              <th className="text-right px-5 py-3 font-medium">
                {revenueAvailable ? "Revenue" : "Conv."}
              </th>
              <th className="text-left px-5 py-3 font-medium">Send time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {campaigns.map((c) => {
              const m = metrics[c.id];
              return (
                <tr key={c.id}>
                  <td className="px-5 py-3 text-ops-text max-w-[300px] truncate" title={c.name}>
                    {c.name}
                  </td>
                  <td className="px-5 py-3">
                    <StatusPill status={c.status} />
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text-muted">
                    {fmtInt(m?.delivered)}
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text">
                    {fmtPct(m?.open_rate)}
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text">
                    {fmtPct(m?.click_rate)}
                  </td>
                  <td className="px-5 py-3 text-right text-fitscript-green font-medium">
                    {revenueAvailable
                      ? fmtMoney(m?.conversion_value)
                      : fmtInt(m?.conversions)}
                  </td>
                  <td className="px-5 py-3 text-ops-text-muted">
                    {fmtDate(c.sendTime || c.scheduledAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Leaderboard({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; primary: string; secondary: string }[];
}) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-4">
      <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-ops-text-muted">No data yet.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex-1 min-w-0 pr-3">
                <div className="text-ops-text truncate" title={r.name}>
                  <span className="text-ops-text-muted mr-2">{i + 1}.</span>
                  {r.name}
                </div>
                <div className="text-[10px] text-ops-text-muted">{r.secondary}</div>
              </div>
              <div className="text-fitscript-green font-medium">{r.primary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlowsTable({
  flows,
  metrics,
  revenueAvailable,
  metricsWarning,
}: {
  flows: Flow[];
  metrics: Record<string, CampaignStats>;
  revenueAvailable: boolean;
  metricsWarning: string | null;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ flow: Flow; nextStatus: "live" | "draft" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (args: { id: string; status: "live" | "draft" }) => {
      const r = await fetch(`/api/ops/klaviyo/flows/${args.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: args.status }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body as { id: string; status: string };
    },
    onMutate: (args) => {
      setPendingId(args.id);
      setActionError(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["klaviyo-flows"] });
    },
    onError: (e: Error) => {
      setActionError(e.message);
    },
    onSettled: () => {
      setPendingId(null);
    },
  });

  if (flows.length === 0) {
    return <div className="text-sm text-ops-text-muted">No flows found.</div>;
  }

  return (
    <>
      {metricsWarning && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 mb-4 text-xs text-amber-200/90">
          {metricsWarning}
        </div>
      )}
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 mb-4 text-xs text-red-300">
          {actionError}
        </div>
      )}

      {confirm && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setConfirm(null)}
        >
          <div
            className="bg-ops-surface border border-ops-border rounded-xl p-6 max-w-md w-full shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-ops-text mb-2">
              {confirm.nextStatus === "draft" ? "Pause this flow?" : "Activate this flow?"}
            </h3>
            <p className="text-sm text-ops-text-muted mb-1">{confirm.flow.name}</p>
            <p className="text-xs text-ops-text-muted mb-5">
              {confirm.nextStatus === "draft"
                ? "Klaviyo will stop firing this flow for any new triggers until it's re-activated. Subscribers already in the flow continue."
                : "Klaviyo will start firing this flow on its trigger immediately. Make sure the email content is ready."}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirm(null)}
                className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  mutation.mutate({ id: confirm.flow.id, status: confirm.nextStatus });
                  setConfirm(null);
                }}
                className={`px-4 py-2 text-sm rounded-lg text-white font-medium ${
                  confirm.nextStatus === "draft"
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-fitscript-green hover:bg-fitscript-green/90"
                }`}
              >
                {confirm.nextStatus === "draft" ? "Pause Flow" : "Activate Flow"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
              <th className="text-left px-5 py-3 font-medium">Trigger</th>
              <th className="text-right px-5 py-3 font-medium">Sent</th>
              <th className="text-right px-5 py-3 font-medium">Open</th>
              <th className="text-right px-5 py-3 font-medium">Click</th>
              <th className="text-right px-5 py-3 font-medium">
                {revenueAvailable ? "Revenue" : "Conv."}
              </th>
              <th className="text-right px-5 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {flows.map((f) => {
              const m = metrics[f.id];
              const isLive = f.status?.toLowerCase() === "live";
              const isPending = pendingId === f.id;
              const next: "live" | "draft" = isLive ? "draft" : "live";
              return (
                <tr key={f.id}>
                  <td className="px-5 py-3 text-ops-text max-w-[280px] truncate" title={f.name}>
                    {f.name}
                  </td>
                  <td className="px-5 py-3">
                    <StatusPill status={f.status} />
                  </td>
                  <td className="px-5 py-3 text-ops-text-muted text-xs">
                    {f.triggerType || "—"}
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text-muted">
                    {fmtInt(m?.delivered)}
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text">
                    {fmtPct(m?.open_rate)}
                  </td>
                  <td className="px-5 py-3 text-right text-ops-text">
                    {fmtPct(m?.click_rate)}
                  </td>
                  <td className="px-5 py-3 text-right text-fitscript-green font-medium">
                    {revenueAvailable ? fmtMoney(m?.conversion_value) : fmtInt(m?.conversions)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      disabled={isPending}
                      onClick={() => setConfirm({ flow: f, nextStatus: next })}
                      className={`px-3 py-1 text-xs rounded font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        isLive
                          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                          : "bg-fitscript-green/10 text-fitscript-green hover:bg-fitscript-green/20"
                      }`}
                    >
                      {isPending ? "…" : isLive ? "Pause" : "Activate"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ListsAndSegments({
  lists,
  segments,
}: {
  lists: List[];
  segments: Segment[];
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl">
        <div className="px-5 py-3 border-b border-ops-border text-xs uppercase tracking-wider text-ops-text-muted font-medium">
          Lists
        </div>
        <div className="divide-y divide-ops-border">
          {lists.length === 0 ? (
            <div className="px-5 py-4 text-sm text-ops-text-muted">No lists.</div>
          ) : (
            lists.map((l) => (
              <div key={l.id} className="px-5 py-3 flex items-center justify-between">
                <span className="text-sm text-ops-text">{l.name}</span>
                <span className="text-xs text-ops-text-muted">
                  {fmtDate(l.updatedAt)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl">
        <div className="px-5 py-3 border-b border-ops-border text-xs uppercase tracking-wider text-ops-text-muted font-medium">
          Segments
        </div>
        <div className="divide-y divide-ops-border">
          {segments.length === 0 ? (
            <div className="px-5 py-4 text-sm text-ops-text-muted">No segments.</div>
          ) : (
            segments.map((s) => (
              <div key={s.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm text-ops-text">{s.name}</div>
                  {!s.isActive && (
                    <div className="text-xs text-ops-text-muted">Inactive</div>
                  )}
                </div>
                <span className="text-xs text-ops-text-muted">
                  {fmtDate(s.updatedAt)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
