import { useQuery } from "@tanstack/react-query";
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

function ConnectionError({ message }: { message: string }) {
  return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
      <div className="text-sm font-medium text-red-300 mb-1">
        Klaviyo connection failed
      </div>
      <div className="text-xs text-red-300/80 break-all">{message}</div>
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
        <CampaignsTable campaigns={campaigns} loading={campaignsLoading} />
      )}
      {tab === "flows" && <FlowsTable flows={flows} />}
      {tab === "lists" && (
        <ListsAndSegments lists={lists} segments={segments} />
      )}
      {tab === "sends" && <DashboardSendsTable sends={sendsData?.sends ?? []} />}
    </div>
  );
}

function DashboardSendsTable({ sends }: { sends: DashboardSend[] }) {
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
            <th className="text-left px-5 py-3 font-medium">Method</th>
            <th className="text-right px-5 py-3 font-medium">Recipients</th>
            <th className="text-left px-5 py-3 font-medium">Status</th>
            <th className="text-left px-5 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ops-border">
          {sends.map((s) => (
            <tr key={s.id}>
              <td className="px-5 py-3 text-ops-text">
                <div className="truncate max-w-[280px]">{s.subject}</div>
                <div className="text-xs text-ops-text-muted truncate max-w-[280px]">
                  {s.name}
                </div>
              </td>
              <td className="px-5 py-3 text-ops-text-muted text-xs">{s.admin_email}</td>
              <td className="px-5 py-3 text-ops-text-muted text-xs">{s.send_method}</td>
              <td className="px-5 py-3 text-ops-text text-right">
                {s.recipient_count.toLocaleString()}
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
          ))}
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
        <Link href="/email/send">
          <button className="px-4 py-2 text-sm font-medium rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90">
            Send campaign
          </button>
        </Link>
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
}: {
  campaigns: Campaign[];
  loading: boolean;
}) {
  if (loading) {
    return <div className="text-sm text-ops-text-muted">Loading campaigns…</div>;
  }
  if (campaigns.length === 0) {
    return (
      <div className="text-sm text-ops-text-muted">No campaigns found.</div>
    );
  }
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
          <tr>
            <th className="text-left px-5 py-3 font-medium">Name</th>
            <th className="text-left px-5 py-3 font-medium">Status</th>
            <th className="text-left px-5 py-3 font-medium">Send time</th>
            <th className="text-left px-5 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ops-border">
          {campaigns.map((c) => (
            <tr key={c.id}>
              <td className="px-5 py-3 text-ops-text">{c.name}</td>
              <td className="px-5 py-3">
                <StatusPill status={c.status} />
              </td>
              <td className="px-5 py-3 text-ops-text-muted">
                {fmtDate(c.sendTime || c.scheduledAt)}
              </td>
              <td className="px-5 py-3 text-ops-text-muted">
                {fmtDate(c.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlowsTable({ flows }: { flows: Flow[] }) {
  if (flows.length === 0) {
    return <div className="text-sm text-ops-text-muted">No flows found.</div>;
  }
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
          <tr>
            <th className="text-left px-5 py-3 font-medium">Name</th>
            <th className="text-left px-5 py-3 font-medium">Status</th>
            <th className="text-left px-5 py-3 font-medium">Trigger</th>
            <th className="text-left px-5 py-3 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ops-border">
          {flows.map((f) => (
            <tr key={f.id}>
              <td className="px-5 py-3 text-ops-text">{f.name}</td>
              <td className="px-5 py-3">
                <StatusPill status={f.status} />
              </td>
              <td className="px-5 py-3 text-ops-text-muted">
                {f.triggerType || "—"}
              </td>
              <td className="px-5 py-3 text-ops-text-muted">
                {fmtDate(f.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
