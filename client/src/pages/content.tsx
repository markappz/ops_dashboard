import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHero } from "./../components/page-hero";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  LineChart,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ComposedChart,
} from "recharts";
import { InlineError, hasApiError } from "../components/query-error";

interface GSCQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: string;
  position: string;
}

interface GSCPage {
  page: string;
  clicks: number;
  impressions: number;
  ctr: string;
  position: string;
}

interface GSCDaily {
  date: string;
  clicks: number;
  impressions: number;
  ctr: string;
  position: string;
}

interface GSCOverview {
  connected: boolean;
  daily?: GSCDaily[];
  totals?: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries?: GSCQuery[];
  topPages?: GSCPage[];
  error?: string;
}

interface ConnectionsResp {
  google?: { connected: boolean; gscSiteUrl?: string };
}

function fmtPct(n: number): string {
  if (!isFinite(n) || n === 0) return "0%";
  return n < 1 ? `${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
}

export default function Content() {
  const [range, setRange] = useState<7 | 30 | 90>(30);

  const { data: connections } = useQuery<ConnectionsResp>({
    queryKey: ["ops-connections"],
    queryFn: () => fetch("/api/ops/connections").then((r) => r.json()),
  });
  const ready =
    !!connections?.google?.connected && !!connections.google.gscSiteUrl;

  const { data, isLoading, error } = useQuery<GSCOverview>({
    queryKey: ["ops-gsc-overview", range],
    queryFn: () => fetch(`/api/ops/gsc/overview?range=${range}`).then((r) => r.json()),
    enabled: ready,
    staleTime: 60_000 * 5,
  });

  return (
    <div>
      <PageHero
        eyebrow="Growth"
        title="Content & SEO"
        subtitle={`Search Console performance + Clomark content pipeline — last ${range} days.`}
        actions={
          <div className="flex gap-1 bg-ops-bg rounded-lg p-1">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setRange(d as 7 | 30 | 90)}
                className={`px-3 py-1 text-xs rounded ${
                  range === d
                    ? "bg-ops-surface text-ops-text shadow-card"
                    : "text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      {/* Clomark content pipeline */}
      <ClomarkSection />



      {!ready ? (
        <div className="bg-ops-bg border border-ops-border rounded-xl p-6 max-w-3xl">
          <h3 className="text-sm font-semibold text-ops-text mb-2">
            Connect Search Console to see content performance
          </h3>
          <p className="text-sm text-ops-text-muted mb-4">
            {connections?.google?.connected
              ? "Google account is connected but no Search Console site selected."
              : "Google account not connected."}
          </p>
          <a
            href="/integrations"
            className="inline-flex items-center px-4 py-2 text-sm rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90"
          >
            Configure →
          </a>
        </div>
      ) : (
        <ContentBody data={data} isLoading={isLoading} error={error as Error | null} range={range} />
      )}
    </div>
  );
}

function ContentBody({
  data,
  isLoading,
  error,
  range,
}: {
  data?: GSCOverview;
  isLoading: boolean;
  error: Error | null;
  range: number;
}) {
  if (error || hasApiError(data)) {
    return <InlineError context="Search Console" data={data} error={error} />;
  }
  if (data?.error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-300">
        {data.error}
      </div>
    );
  }
  if (isLoading || !data?.totals) {
    return <div className="text-sm text-ops-text-muted">Loading Search Console data…</div>;
  }

  const { totals, daily = [], topQueries = [], topPages = [] } = data;
  // GSC site host for display
  const dailyChartData = daily.map((d) => ({
    ...d,
    label: `${d.date.slice(5, 7)}/${d.date.slice(8, 10)}`,
    ctrNum: parseFloat(d.ctr),
    positionNum: parseFloat(d.position),
  }));

  return (
    <>
      {/* Top KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <KpiTile label="Total Clicks" value={totals.clicks.toLocaleString()} accent />
        <KpiTile
          label="Total Impressions"
          value={totals.impressions.toLocaleString()}
          sub={
            totals.impressions > 0
              ? `${((totals.clicks / totals.impressions) * 100).toFixed(2)}% CTR`
              : "—"
          }
        />
        <KpiTile
          label="Avg CTR"
          value={fmtPct(totals.ctr)}
          sub="weighted by day"
        />
        <KpiTile
          label="Avg Position"
          value={totals.position.toFixed(1)}
          sub={totals.position <= 10 ? "first page" : totals.position <= 20 ? "second page" : "deeper"}
        />
      </div>

      {/* Daily trend chart */}
      {dailyChartData.length > 0 && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
          <h3 className="text-sm font-semibold text-ops-text mb-3">
            Daily Search Performance ({range}d)
          </h3>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dailyChartData}>
                <defs>
                  <linearGradient id="gscImpressions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4285F4" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#4285F4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="label"
                  stroke="rgba(255,255,255,0.4)"
                  tick={{ fontSize: 10 }}
                  interval={Math.max(0, Math.floor(dailyChartData.length / 12))}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#4285F4"
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#2E5BFF"
                  tick={{ fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f1115",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="impressions"
                  name="Impressions"
                  stroke="#4285F4"
                  fill="url(#gscImpressions)"
                  strokeWidth={2}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="clicks"
                  name="Clicks"
                  stroke="#2E5BFF"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 text-[10px] text-ops-text-muted mt-2">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-1 bg-blue-500/70 rounded" />
              <span>Impressions (left axis)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-1 bg-fitscript-green rounded" />
              <span>Clicks (right axis)</span>
            </div>
          </div>
        </div>
      )}

      {/* Top queries + top pages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5 mb-6">
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Top Queries</h3>
          </div>
          {topQueries.length === 0 ? (
            <div className="p-8 text-center text-sm text-ops-text-muted">No query data yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-ops-text-muted">
                  <th className="text-left px-3 py-2 font-medium">Query</th>
                  <th className="text-right px-3 py-2 font-medium">Clicks</th>
                  <th className="text-right px-3 py-2 font-medium">Impr</th>
                  <th className="text-right px-3 py-2 font-medium">CTR</th>
                  <th className="text-right px-3 py-2 font-medium">Pos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/40">
                {topQueries.map((q) => (
                  <tr key={q.query}>
                    <td
                      className="px-3 py-2 text-ops-text max-w-[200px] truncate"
                      title={q.query}
                    >
                      {q.query}
                    </td>
                    <td className="px-3 py-2 text-right text-fitscript-green font-medium">
                      {q.clicks.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-ops-text-muted">
                      {q.impressions.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-ops-text">{q.ctr}%</td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        parseFloat(q.position) <= 10
                          ? "text-fitscript-green"
                          : parseFloat(q.position) <= 20
                            ? "text-amber-400"
                            : "text-ops-text-muted"
                      }`}
                    >
                      {q.position}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Top Pages</h3>
          </div>
          {topPages.length === 0 ? (
            <div className="p-8 text-center text-sm text-ops-text-muted">No page data yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-ops-text-muted">
                  <th className="text-left px-3 py-2 font-medium">Page</th>
                  <th className="text-right px-3 py-2 font-medium">Clicks</th>
                  <th className="text-right px-3 py-2 font-medium">Impr</th>
                  <th className="text-right px-3 py-2 font-medium">CTR</th>
                  <th className="text-right px-3 py-2 font-medium">Pos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/40">
                {topPages.map((p) => {
                  // Strip protocol + host for compact display, keep path
                  const path = p.page.replace(/^https?:\/\/[^/]+/, "") || "/";
                  return (
                    <tr key={p.page}>
                      <td
                        className="px-3 py-2 text-ops-text max-w-[220px] truncate"
                        title={p.page}
                      >
                        {path}
                      </td>
                      <td className="px-3 py-2 text-right text-fitscript-green font-medium">
                        {p.clicks.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text-muted">
                        {p.impressions.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text">{p.ctr}%</td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${
                          parseFloat(p.position) <= 10
                            ? "text-fitscript-green"
                            : parseFloat(p.position) <= 20
                              ? "text-amber-400"
                              : "text-ops-text-muted"
                        }`}
                      >
                        {p.position}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function KpiTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-2xl font-bold ${accent ? "text-fitscript-green" : "text-ops-text"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ops-text-muted mt-1">{sub}</div>}
    </div>
  );
}

// ─── Clomark Section ────────────────────────────────────────────────

interface ClomarkStatus {
  configured: boolean;
  connected?: boolean;
  businessIdConfigured?: boolean;
  businessId?: string | null;
  baseUrl?: string;
  error?: string;
  envHint?: string;
}

interface ClomarkOverview {
  keywords: { all: number; byStatus: Record<string, number> };
  content: {
    suggestions: { all: number; byStatus: Record<string, number> };
    generated: { all: number; byStatus: Record<string, number> };
  };
  seoScore: { overallScore?: number; createdAt?: string } | null;
  seoScoreTrend: { overallScore: number; createdAt: string }[];
  recentActivities: {
    id: string;
    activityType?: string;
    description?: string;
    createdAt: string;
  }[];
  error?: string;
}

interface ContentSuggestion {
  id: string;
  type: "blog" | "seo_page";
  title: string;
  keyword: string;
  status: string;
  searchVolume?: number;
  difficulty?: number;
  targetRegion?: string | null;
  createdAt?: string;
}

function ClomarkSection() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  const { data: status } = useQuery<ClomarkStatus>({
    queryKey: ["ops-clomark-status"],
    queryFn: () => fetch("/api/ops/clomark/status").then((r) => r.json()),
  });
  const ready = !!status?.connected && !!status.businessIdConfigured;

  const { data, isLoading, error } = useQuery<ClomarkOverview>({
    queryKey: ["ops-clomark-overview"],
    queryFn: () => fetch("/api/ops/clomark/overview").then((r) => r.json()),
    enabled: ready,
    staleTime: 60_000 * 5,
  });

  // Full content list — drives the queue table below the breakdowns.
  // Polls every 15s; bumps to 5s when anything is mid-generation so the
  // operator sees status flips without refreshing.
  const { data: contentData } = useQuery<{
    suggestions: ContentSuggestion[];
    generated: any[];
    totals: any;
  }>({
    queryKey: ["ops-clomark-content"],
    queryFn: () =>
      fetch("/api/ops/clomark/content?limit=200").then((r) => r.json()),
    enabled: ready,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 15_000;
      const inProgress =
        (d.suggestions ?? []).some((s: any) => s.status === "in_progress") ||
        (d.totals?.suggestions?.byStatus?.in_progress ?? 0) > 0;
      return inProgress ? 5_000 : 15_000;
    },
    refetchOnWindowFocus: true,
  });

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
      {addOpen && (
        <AddContentModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["ops-clomark-overview"] });
            queryClient.invalidateQueries({ queryKey: ["ops-clomark-content"] });
            setAddOpen(false);
          }}
        />
      )}
      {locationOpen && (
        <LocationPageModal
          onClose={() => setLocationOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["ops-clomark-overview"] });
            queryClient.invalidateQueries({ queryKey: ["ops-clomark-content"] });
            setLocationOpen(false);
          }}
        />
      )}

      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ops-text">
            Clomark — Content &amp; SEO Pipeline
          </h3>
          {ready && (
            <p className="text-xs text-ops-text-muted mt-0.5">
              Business {status!.businessId?.slice(0, 8)}… · keyword research, content
              drafts, SEO score
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ready && (
            <>
              <button
                onClick={() => setAddOpen(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-ops-bg border border-ops-border text-ops-text hover:bg-ops-surface-hover"
              >
                + Add Blog
              </button>
              <button
                onClick={() => setLocationOpen(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90"
              >
                + Add Location Page
              </button>
            </>
          )}
          {!ready && (
            <span className="text-xs text-ops-text-muted">
              {status?.configured ? "Business not selected" : "Not configured"}
            </span>
          )}
        </div>
      </div>

      {!status?.configured ? (
        <div className="bg-ops-bg border border-ops-border rounded-lg p-4 text-xs text-ops-text-muted">
          <div className="font-medium text-ops-text mb-2">Connect Clomark</div>
          <div className="space-y-2">
            <p>{status?.envHint || "Set CLOMARK_BASE_URL + CLOMARK_OPS_TOKEN in .env."}</p>
            <ol className="list-decimal list-inside space-y-1 text-ops-text-muted/80">
              <li>
                Generate a 32+ char random token. Set it as{" "}
                <code className="bg-ops-bg px-1 rounded">CLOMARK_OPS_TOKEN</code> in
                BOTH ops-dashboard's <code>.env</code> AND Clomark's <code>.env</code>
              </li>
              <li>
                Set <code className="bg-ops-bg px-1 rounded">CLOMARK_BASE_URL</code>{" "}
                in ops-dashboard (e.g.{" "}
                <code>https://app.clomark.com</code> or{" "}
                <code>http://localhost:5000</code> for local dev)
              </li>
              <li>Restart both servers</li>
              <li>
                Hit{" "}
                <code className="bg-ops-bg px-1 rounded">
                  /api/ops/clomark/discover?domain=fitscript.me
                </code>{" "}
                to find FitScript's business ID
              </li>
              <li>
                Add the returned ID as{" "}
                <code className="bg-ops-bg px-1 rounded">CLOMARK_BUSINESS_ID</code>{" "}
                in ops-dashboard, restart
              </li>
            </ol>
          </div>
        </div>
      ) : status?.configured && !status.connected ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-xs text-red-300">
          {status.error || "Could not reach Clomark."}
        </div>
      ) : !status.businessIdConfigured ? (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-xs text-amber-300/90">
          <div className="font-medium mb-1">Business ID not set</div>
          <div className="text-amber-200/70">
            Hit{" "}
            <a
              href="/api/ops/clomark/discover?domain=fitscript.me"
              target="_blank"
              rel="noreferrer"
              className="underline text-amber-200"
            >
              /api/ops/clomark/discover?domain=fitscript.me
            </a>{" "}
            and set the returned <code>id</code> as <code>CLOMARK_BUSINESS_ID</code>{" "}
            in <code>.env</code>, then restart.
          </div>
        </div>
      ) : (hasApiError(data) || error) ? (
        <InlineError context="Clomark" data={data} error={error as Error | null} />
      ) : isLoading || !data ? (
        <div className="text-sm text-ops-text-muted">Loading Clomark data…</div>
      ) : (
        <>
          <ClomarkBody data={data} />
          <QueueTable suggestions={contentData?.suggestions ?? []} />
          <DraftsSection
            generated={contentData?.generated ?? []}
            onChanged={() => {
              queryClient.invalidateQueries({ queryKey: ["ops-clomark-content"] });
              queryClient.invalidateQueries({ queryKey: ["ops-clomark-overview"] });
            }}
          />
        </>
      )}
    </div>
  );
}

function QueueTable({ suggestions }: { suggestions: ContentSuggestion[] }) {
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/ops/clomark/content-suggestions/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onMutate: (id) => setDeletingId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-clomark-content"] });
      queryClient.invalidateQueries({ queryKey: ["ops-clomark-overview"] });
    },
    onSettled: () => setDeletingId(null),
  });

  if (suggestions.length === 0) {
    return (
      <div className="mt-6 pt-4 border-t border-ops-border">
        <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">
          Queue
        </div>
        <div className="text-sm text-ops-text-muted py-3">
          Nothing in the queue yet. Click <span className="text-ops-text font-medium">+ Add Content</span> above.
        </div>
      </div>
    );
  }

  // Newest first
  const sorted = [...suggestions].sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  return (
    <div className="mt-6 pt-4 border-t border-ops-border">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs text-ops-text-muted uppercase tracking-wider">
          Queue ({suggestions.length})
        </div>
        <div className="text-[10px] text-ops-text-muted">
          Generation triggers next session — for now items wait at status=draft
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-ops-border">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Title</th>
              <th className="text-left px-4 py-2 font-medium">Keyword</th>
              <th className="text-left px-4 py-2 font-medium">Region</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Added</th>
              <th className="text-right px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {sorted.map((s) => {
              const isDeleting = deletingId === s.id;
              return (
                <tr key={s.id}>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                        s.type === "blog"
                          ? "bg-fitscript-green/10 text-fitscript-green"
                          : "bg-blue-500/10 text-blue-300"
                      }`}
                    >
                      {s.type === "blog" ? "Blog" : "SEO Page"}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 text-ops-text max-w-[300px] truncate"
                    title={s.title}
                  >
                    {s.title}
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted">{s.keyword}</td>
                  <td className="px-4 py-2 text-ops-text-muted text-xs">
                    {s.targetRegion || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                        s.status === "completed"
                          ? "bg-fitscript-green/10 text-fitscript-green"
                          : s.status === "in_progress"
                            ? "bg-amber-500/10 text-amber-300"
                            : "bg-ops-bg text-ops-text-muted"
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted text-xs">
                    {s.createdAt
                      ? new Date(s.createdAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Remove "${s.title}" from queue?`)) {
                          deleteMutation.mutate(s.id);
                        }
                      }}
                      disabled={isDeleting}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                    >
                      {isDeleting ? "…" : "Remove"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddContentModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; errors: number } | null>(
    null,
  );

  const submitSingle = async () => {
    setError(null);
    if (title.trim().length < 3) return setError("Title must be at least 3 chars");
    if (keyword.trim().length < 2) return setError("Keyword required");
    setSubmitting(true);
    try {
      const r = await fetch("/api/ops/clomark/content-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "blog",
          title: title.trim(),
          keyword: keyword.trim(),
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitBulk = async () => {
    setError(null);
    // Blog-only bulk: one per line, format "title | keyword". Location pages
    // need too many per-item fields to fit a CSV-style bulk add — they go
    // through the dedicated modal one at a time.
    const lines = bulkText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return setError("Paste at least one line");
    if (lines.length > 100) return setError("Max 100 items per upload");
    const items = lines.map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      return {
        type: "blog" as const,
        title: parts[0],
        keyword: parts[1] || parts[0],
      };
    });
    setSubmitting(true);
    try {
      const r = await fetch("/api/ops/clomark/content-suggestions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setResult({
        created: body.created?.length ?? 0,
        errors: body.errors?.length ?? 0,
      });
      if ((body.errors?.length ?? 0) === 0) {
        setTimeout(onSaved, 800);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-base font-bold text-ops-text">Add Blog Posts to Queue</h3>
          <button
            onClick={onClose}
            className="text-ops-text-muted hover:text-ops-text text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-ops-text-muted mb-4">
          For location/SEO pages, use the dedicated "+ Add Location Page" button.
        </p>

        {/* Mode toggle */}
        <div className="flex gap-1 bg-ops-bg rounded-lg p-1 mb-5 w-fit">
          {(["single", "bulk"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
                setResult(null);
              }}
              className={`px-4 py-1.5 text-xs rounded ${
                mode === m
                  ? "bg-ops-surface text-ops-text"
                  : "text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {m === "single" ? "Single" : "Bulk"}
            </button>
          ))}
        </div>

        {mode === "single" ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The Complete Guide to Functional Bloodwork"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Target Keyword
              </label>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="functional bloodwork analysis"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <button
              onClick={submitSingle}
              disabled={submitting || !title || !keyword}
              className="w-full py-2.5 rounded-lg bg-fitscript-green text-white font-medium text-sm hover:bg-fitscript-green/90 disabled:opacity-40 transition-colors"
            >
              {submitting ? "Adding…" : "Add to Queue"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
                Blog posts (one per line)
              </label>
              <div className="text-[10px] text-ops-text-muted mb-1.5">
                Format: <code className="bg-ops-bg px-1 rounded">title | keyword</code> — pipe-separated
              </div>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={`The Complete Guide to Functional Bloodwork | functional bloodwork analysis\n10 Biomarkers You Should Track Annually | annual biomarker testing\nWhy Your Resting Heart Rate Matters | resting heart rate optimization`}
                rows={10}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text font-mono text-xs focus:outline-none focus:border-fitscript-green"
              />
              <div className="text-[10px] text-ops-text-muted mt-1">
                Max 100 blog posts per upload. For location/SEO pages, use the dedicated + Add Location Page button.
              </div>
            </div>
            {result && (
              <div
                className={`rounded-lg px-3 py-2 text-xs ${
                  result.errors === 0
                    ? "bg-fitscript-green/10 text-fitscript-green border border-fitscript-green/30"
                    : "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                }`}
              >
                {result.created} added · {result.errors} failed
              </div>
            )}
            <button
              onClick={submitBulk}
              disabled={submitting || !bulkText.trim()}
              className="w-full py-2.5 rounded-lg bg-fitscript-green text-white font-medium text-sm hover:bg-fitscript-green/90 disabled:opacity-40 transition-colors"
            >
              {submitting ? "Adding…" : "Add All to Queue"}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function ClomarkBody({ data }: { data: ClomarkOverview }) {
  const kw = data.keywords;
  const sugg = data.content.suggestions;
  const gen = data.content.generated;
  const score = data.seoScore;
  const activities = data.recentActivities ?? [];

  return (
    <>
      {/* 4 KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <KpiTile
          label="SEO Score"
          value={
            score?.overallScore !== undefined
              ? String(Math.round(score.overallScore))
              : "—"
          }
          sub={
            score?.createdAt
              ? `as of ${new Date(score.createdAt).toLocaleDateString()}`
              : "no score yet"
          }
          accent
        />
        <KpiTile
          label="Keywords Tracked"
          value={kw.all.toLocaleString()}
          sub={`${kw.byStatus.approved ?? 0} approved`}
        />
        <KpiTile
          label="Content Suggestions"
          value={sugg.all.toLocaleString()}
          sub={`${sugg.byStatus.pending ?? 0} pending`}
        />
        <KpiTile
          label="Generated Content"
          value={gen.all.toLocaleString()}
          sub={`${gen.byStatus.published ?? gen.byStatus.completed ?? 0} published`}
        />
      </div>

      {/* Status breakdowns + recent activities */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5 pt-4 border-t border-ops-border">
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
            Keyword Pipeline
          </div>
          {Object.keys(kw.byStatus).length === 0 ? (
            <div className="text-xs text-ops-text-muted">No keywords yet.</div>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(kw.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => (
                  <div key={s} className="flex items-center justify-between text-sm">
                    <span className="text-ops-text-muted capitalize">{s}</span>
                    <span className="text-ops-text font-medium">{c}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
            Content Status
          </div>
          {Object.keys(sugg.byStatus).length + Object.keys(gen.byStatus).length === 0 ? (
            <div className="text-xs text-ops-text-muted">No content yet.</div>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(gen.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => (
                  <div key={`g-${s}`} className="flex items-center justify-between text-sm">
                    <span className="text-ops-text-muted capitalize">
                      <span className="w-1.5 h-1.5 rounded-full bg-fitscript-green inline-block mr-2" />
                      {s} (drafted)
                    </span>
                    <span className="text-ops-text font-medium">{c}</span>
                  </div>
                ))}
              {Object.entries(sugg.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => (
                  <div key={`s-${s}`} className="flex items-center justify-between text-sm">
                    <span className="text-ops-text-muted capitalize">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-300 inline-block mr-2" />
                      {s} (suggested)
                    </span>
                    <span className="text-ops-text font-medium">{c}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
            Recent AI Activity
          </div>
          {activities.length === 0 ? (
            <div className="text-xs text-ops-text-muted">No activity yet.</div>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {activities.slice(0, 6).map((a) => (
                <div key={a.id} className="text-xs">
                  <div className="text-ops-text truncate" title={a.description || a.activityType}>
                    {a.description || a.activityType || "(activity)"}
                  </div>
                  <div className="text-[10px] text-ops-text-muted">
                    {new Date(a.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Location Page Modal (Phase A-3a) ───────────────────────────────

interface LocationOptions {
  industryTypes: { value: string; label: string }[];
  marketTiers: { value: string; label: string }[];
}

interface CtaEntry {
  title: string;
  text: string;
  url: string;
}

interface ProfileItem {
  name: string;
  url?: string;
  source?: string;
}

interface NearbyArea {
  name: string;
  slug: string;
}

function LocationPageModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: opts } = useQuery<LocationOptions>({
    queryKey: ["ops-clomark-location-options"],
    queryFn: () =>
      fetch("/api/ops/clomark/location/options").then((r) => r.json()),
    staleTime: 60_000 * 60,
  });

  const [keyword, setKeyword] = useState("");
  const [secondaryKeywords, setSecondaryKeywords] = useState("");
  const [marketTier, setMarketTier] = useState<"1" | "2" | "3">("2");
  const [industryType, setIndustryType] = useState("general");
  const [locationCity, setLocationCity] = useState("");
  const [locationNeighborhood, setLocationNeighborhood] = useState("");
  const [stateAbbr, setStateAbbr] = useState("");
  const [zipCodes, setZipCodes] = useState("");
  const [zipLookupStatus, setZipLookupStatus] = useState<"idle" | "loading" | "error">("idle");
  const [ctas, setCtas] = useState<CtaEntry[]>([{ title: "", text: "", url: "" }]);

  // Section 4 — Local Data
  const [selectedProductIndices, setSelectedProductIndices] = useState<Set<number>>(new Set());
  const [bestSellersSearch, setBestSellersSearch] = useState("");
  const [nearbyAreas, setNearbyAreas] = useState<NearbyArea[]>([{ name: "", slug: "" }]);
  const [localStat, setLocalStat] = useState("");
  const [stateRegulationNote, setStateRegulationNote] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isT3 = marketTier === "3";

  // Business profile products/services for the Best Sellers picker
  const { data: profileData } = useQuery<{ items: ProfileItem[] }>({
    queryKey: ["ops-clomark-profile-items"],
    queryFn: () => fetch("/api/ops/clomark/profile-items").then((r) => r.json()),
    staleTime: 60_000 * 10,
  });
  const profileItems = profileData?.items ?? [];
  const filteredProfileItems = profileItems
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) =>
      item.name.toLowerCase().includes(bestSellersSearch.toLowerCase()),
    );

  const lookupZips = async () => {
    if (!locationCity.trim()) return;
    setZipLookupStatus("loading");
    try {
      const qs = new URLSearchParams({ city: locationCity.trim() });
      if (stateAbbr) qs.set("abbr", stateAbbr.trim().toUpperCase());
      const r = await fetch(`/api/ops/clomark/location/zip-lookup?${qs}`);
      const body = await r.json();
      if (r.ok && body.stateAbbr && !stateAbbr) setStateAbbr(body.stateAbbr);
      if (r.ok && Array.isArray(body.zipCodes) && body.zipCodes.length > 0) {
        setZipCodes(body.zipCodes.join(", "));
      }
      setZipLookupStatus("idle");
    } catch {
      setZipLookupStatus("error");
    }
  };

  const addCta = () => {
    if (ctas.length >= 3) return;
    setCtas([...ctas, { title: "", text: "", url: "" }]);
  };
  const removeCta = (i: number) => setCtas(ctas.filter((_, idx) => idx !== i));
  const updateCta = (i: number, k: keyof CtaEntry, v: string) => {
    setCtas(ctas.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)));
  };

  const toggleProduct = (idx: number) => {
    setSelectedProductIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else if (next.size < 5) next.add(idx);
      return next;
    });
  };

  const addNearbyArea = () =>
    setNearbyAreas([...nearbyAreas, { name: "", slug: "" }]);
  const removeNearbyArea = (i: number) =>
    setNearbyAreas(nearbyAreas.filter((_, idx) => idx !== i));
  const updateNearbyArea = (i: number, k: keyof NearbyArea, v: string) => {
    setNearbyAreas(
      nearbyAreas.map((a, idx) => (idx === i ? { ...a, [k]: v } : a)),
    );
  };

  const submit = async () => {
    setError(null);
    if (keyword.trim().length < 2) return setError("Primary keyword required");
    if (!locationCity.trim())
      return setError("City (or parent city for Tier 3) required");

    setSubmitting(true);
    try {
      const payload = {
        keyword: keyword.trim(),
        secondaryKeywords: secondaryKeywords
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        locationCity: locationCity.trim(),
        locationNeighborhood: isT3
          ? locationNeighborhood.trim() || undefined
          : undefined,
        stateAbbr: stateAbbr.trim().toUpperCase() || undefined,
        locationZipCodes: zipCodes
          .split(",")
          .map((z) => z.trim())
          .filter(Boolean),
        marketTier: parseInt(marketTier),
        industryType,
        ctas: ctas
          .filter((c) => c.text.trim() || c.url.trim())
          .map((c) => ({
            title: c.title.trim(),
            text: c.text.trim(),
            url: c.url.trim(),
          })),
        bestSellers: Array.from(selectedProductIndices)
          .map((idx) => profileItems[idx])
          .filter(Boolean)
          .map((item) => ({ title: item.name, url: item.url || "" })),
        nearbyAreas: nearbyAreas
          .filter((a) => a.name.trim() || a.slug.trim())
          .map((a) => ({ name: a.name.trim(), slug: a.slug.trim() })),
        localStat: localStat.trim() || undefined,
        stateRegulationNote: stateRegulationNote.trim() || undefined,
        licenseNumber: licenseNumber.trim() || undefined,
      };
      const r = await fetch("/api/ops/clomark/location-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-ops-surface border border-ops-border rounded-xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-base font-bold text-ops-text">Add Location Page</h3>
          <button
            onClick={onClose}
            className="text-ops-text-muted hover:text-ops-text text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-ops-text-muted mb-5">
          Sends to Clomark's generation queue immediately. Best Sellers, Nearby Areas, and
          Regulation/License fields use Clomark defaults — set them in Clomark directly if needed.
        </p>

        <section className="space-y-4 rounded-lg border border-ops-border bg-ops-bg/40 p-4 mb-4">
          <h4 className="text-xs font-semibold text-ops-text uppercase tracking-wider">
            1. Keyword & Tier
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                Primary Keyword *
              </label>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="e.g. functional medicine austin tx"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                Secondary Keywords <span className="opacity-60">(comma-separated)</span>
              </label>
              <input
                value={secondaryKeywords}
                onChange={(e) => setSecondaryKeywords(e.target.value)}
                placeholder="bloodwork, biomarker testing"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                Market Tier *
              </label>
              <select
                value={marketTier}
                onChange={(e) => setMarketTier(e.target.value as "1" | "2" | "3")}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              >
                {(opts?.marketTiers ?? []).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                Industry Type *
              </label>
              <select
                value={industryType}
                onChange={(e) => setIndustryType(e.target.value)}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              >
                {(opts?.industryTypes ?? []).map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-ops-border bg-ops-bg/40 p-4 mb-4">
          <h4 className="text-xs font-semibold text-ops-text uppercase tracking-wider">
            2. Location Details
          </h4>
          <div className={`grid gap-3 ${isT3 ? "grid-cols-2" : "grid-cols-1"}`}>
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                {isT3 ? "Parent City *" : "City *"}
              </label>
              <input
                value={locationCity}
                onChange={(e) => setLocationCity(e.target.value)}
                onBlur={lookupZips}
                placeholder={isT3 ? "e.g. Phoenix" : "e.g. Austin"}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            {isT3 && (
              <div>
                <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                  Neighborhood / Suburb
                </label>
                <input
                  value={locationNeighborhood}
                  onChange={(e) => setLocationNeighborhood(e.target.value)}
                  placeholder="e.g. Scottsdale"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                State Abbr
              </label>
              <input
                value={stateAbbr}
                onChange={(e) => setStateAbbr(e.target.value.toUpperCase())}
                onBlur={lookupZips}
                placeholder="TX"
                maxLength={2}
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text uppercase focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1 flex items-center justify-between">
                <span>
                  ZIP Codes
                  {zipLookupStatus === "loading" && (
                    <span className="ml-2 text-fitscript-green">loading…</span>
                  )}
                  {zipLookupStatus === "error" && (
                    <span className="ml-2 text-amber-400">lookup failed</span>
                  )}
                </span>
                <span className="opacity-60 normal-case">auto-fills on blur · 3-5 zips</span>
              </label>
              <input
                value={zipCodes}
                onChange={(e) => setZipCodes(e.target.value)}
                placeholder="e.g. 78701, 78702"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-ops-border bg-ops-bg/40 p-4 mb-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-ops-text uppercase tracking-wider">
              3. Calls to Action
            </h4>
            {ctas.length < 3 && (
              <button
                onClick={addCta}
                className="text-xs text-fitscript-green hover:underline"
              >
                + Add CTA
              </button>
            )}
          </div>
          {ctas.map((cta, i) => (
            <div
              key={i}
              className="space-y-2 bg-ops-bg/60 border border-ops-border/50 rounded-lg p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-ops-text-muted uppercase tracking-wider">
                  {i === 0 ? "Primary CTA" : i === 1 ? "Secondary CTA" : "Tertiary CTA"}
                </span>
                {i > 0 && (
                  <button
                    onClick={() => removeCta(i)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                value={cta.title}
                onChange={(e) => updateCta(i, "title", e.target.value)}
                placeholder="Banner headline (optional) — e.g. Ready to optimize?"
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={cta.text}
                  onChange={(e) => updateCta(i, "text", e.target.value)}
                  placeholder="Button text — e.g. Book Consult"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
                <input
                  value={cta.url}
                  onChange={(e) => updateCta(i, "url", e.target.value)}
                  placeholder="URL — e.g. /labs"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
              </div>
            </div>
          ))}
          <p className="text-[10px] text-ops-text-muted">
            Leave all blank to use business default CTAs from Clomark.
          </p>
        </section>

        {/* Section 4 — Local Data */}
        <section className="space-y-4 rounded-lg border border-ops-border bg-ops-bg/40 p-4 mb-4">
          <h4 className="text-xs font-semibold text-ops-text uppercase tracking-wider">
            4. Local Data
          </h4>

          {/* Best Sellers */}
          <div>
            <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1.5">
              Best Sellers
              <span className="ml-2 opacity-60 normal-case">
                ({selectedProductIndices.size}/5 — pick 3-5 to feature)
              </span>
            </label>
            {profileItems.length < 3 ? (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300/90">
                {profileItems.length === 0
                  ? "No products / services on the business profile."
                  : `Only ${profileItems.length} item(s) on the business profile — add at least 3 in Clomark's Products/Services tab.`}
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  value={bestSellersSearch}
                  onChange={(e) => setBestSellersSearch(e.target.value)}
                  placeholder="Search products / services…"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
                <div className="max-h-40 overflow-y-auto rounded-lg border border-ops-border/50 bg-ops-bg/60">
                  {filteredProfileItems.length === 0 ? (
                    <div className="text-xs text-ops-text-muted p-3 text-center">
                      No matches.
                    </div>
                  ) : (
                    filteredProfileItems.map(({ item, idx }) => {
                      const checked = selectedProductIndices.has(idx);
                      const disabled =
                        !checked && selectedProductIndices.size >= 5;
                      return (
                        <div
                          key={idx}
                          onClick={() => !disabled && toggleProduct(idx)}
                          className={`flex items-center gap-3 px-3 py-2 text-sm border-b border-ops-border/30 last:border-0 cursor-pointer ${
                            checked
                              ? "bg-fitscript-green/10"
                              : disabled
                                ? "opacity-40 cursor-not-allowed"
                                : "hover:bg-ops-surface-hover"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            readOnly
                            className="accent-fitscript-green pointer-events-none"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-ops-text truncate">
                              {item.name}
                            </div>
                            {item.url && (
                              <div className="text-[10px] text-ops-text-muted truncate">
                                {item.url}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Nearby Areas */}
          <div className="pt-3 border-t border-ops-border/50">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-medium text-ops-text-muted uppercase tracking-wider">
                Nearby Areas
              </label>
              <button
                onClick={addNearbyArea}
                className="text-xs text-fitscript-green hover:underline"
              >
                + Add Area
              </button>
            </div>
            <div className="space-y-2">
              {nearbyAreas.map((area, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
                  <input
                    value={area.name}
                    onChange={(e) =>
                      updateNearbyArea(i, "name", e.target.value)
                    }
                    placeholder={isT3 ? "Neighborhood — e.g. Arcadia" : "Area — e.g. Tempe"}
                    className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                  />
                  <input
                    value={area.slug}
                    onChange={(e) =>
                      updateNearbyArea(i, "slug", e.target.value)
                    }
                    placeholder="URL slug — e.g. /functional-medicine-tempe"
                    className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                  />
                  <button
                    onClick={() => removeNearbyArea(i)}
                    disabled={nearbyAreas.length <= 1}
                    className="text-ops-text-muted hover:text-red-400 disabled:opacity-30 px-2"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-ops-text-muted mt-1">
              Internal links to neighboring areas. Slugs must match existing pages on your site.
            </p>
          </div>

          {/* Local Stat / Regulation / License */}
          <div className="pt-3 border-t border-ops-border/50 space-y-3">
            <div>
              <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                Local Statistic <span className="opacity-60">(optional)</span>
              </label>
              <textarea
                value={localStat}
                onChange={(e) => setLocalStat(e.target.value)}
                rows={2}
                placeholder="e.g. 1 in 3 Austin residents have at least one biomarker outside the optimal range."
                className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                  Regulation Note <span className="opacity-60">(optional)</span>
                </label>
                <input
                  value={stateRegulationNote}
                  onChange={(e) => setStateRegulationNote(e.target.value)}
                  placeholder="e.g. Texas requires…"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-ops-text-muted uppercase tracking-wider mb-1">
                  License Number <span className="opacity-60">(optional)</span>
                </label>
                <input
                  value={licenseNumber}
                  onChange={(e) => setLicenseNumber(e.target.value)}
                  placeholder="e.g. TX-12345"
                  className="w-full bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
                />
              </div>
            </div>
          </div>
        </section>

        <button
          onClick={submit}
          disabled={submitting || !keyword || !locationCity}
          className="w-full py-2.5 rounded-lg bg-fitscript-green text-white font-medium text-sm hover:bg-fitscript-green/90 disabled:opacity-40 transition-colors"
        >
          {submitting ? "Adding to queue…" : "Add Location Page to Queue"}
        </button>

        {error && (
          <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Generated content drafts (Phase C) ─────────────────────────────

interface GeneratedRow {
  id: string;
  title: string;
  topic?: string;
  keyword: string;
  contentType?: string;
  wordCount?: number;
  approvalStatus?: string;
  approvedAt?: string | null;
  createdAt?: string;
  excerpt?: string;
}

function approvalStyle(status: string | undefined): { pill: string; label: string } {
  switch (status) {
    case "approved":
      return { pill: "bg-fitscript-green/10 text-fitscript-green", label: "Approved" };
    case "denied":
      return { pill: "bg-red-500/10 text-red-400", label: "Denied" };
    case "pending":
      return { pill: "bg-amber-500/10 text-amber-300", label: "Pending Review" };
    default:
      return { pill: "bg-ops-bg text-ops-text-muted", label: status || "—" };
  }
}

function DraftsSection({
  generated,
  onChanged,
}: {
  generated: GeneratedRow[];
  onChanged: () => void;
}) {
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPublishOpen, setBulkPublishOpen] = useState(false);

  if (generated.length === 0) {
    return (
      <div className="mt-6 pt-4 border-t border-ops-border">
        <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">
          Generated Drafts
        </div>
        <div className="text-sm text-ops-text-muted py-3">
          No drafts yet. They'll appear here as Clomark finishes generation.
        </div>
      </div>
    );
  }

  const sorted = [...generated].sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  const toggleAll = () => {
    if (selected.size === sorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((g) => g.id)));
    }
  };
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedRows = sorted.filter((g) => selected.has(g.id));

  return (
    <div className="mt-6 pt-4 border-t border-ops-border">
      {viewingId && (
        <ContentViewerModal
          contentId={viewingId}
          onClose={() => setViewingId(null)}
          onChanged={() => {
            onChanged();
            setViewingId(null);
          }}
        />
      )}
      {bulkPublishOpen && (
        <BulkPublishDialog
          selected={selectedRows}
          onClose={() => setBulkPublishOpen(false)}
          onDone={() => {
            setSelected(new Set());
            setBulkPublishOpen(false);
            onChanged();
          }}
        />
      )}

      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs text-ops-text-muted uppercase tracking-wider">
          Generated Drafts ({generated.length})
          {selected.size > 0 && (
            <span className="ml-2 text-fitscript-green normal-case">
              · {selected.size} selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <button
              onClick={() => setBulkPublishOpen(true)}
              className="px-3 py-1 text-xs font-medium rounded-lg bg-fitscript-green text-white hover:bg-fitscript-green/90"
            >
              Bulk Publish ({selected.size})
            </button>
          )}
          <div className="text-[10px] text-ops-text-muted">
            Check rows to enable bulk publish
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-ops-border">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={selected.size === sorted.length && sorted.length > 0}
                  onChange={toggleAll}
                  className="accent-fitscript-green"
                />
              </th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Title</th>
              <th className="text-left px-4 py-2 font-medium">Keyword</th>
              <th className="text-right px-4 py-2 font-medium">Words</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Generated</th>
              <th className="text-right px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {sorted.map((g) => {
              const style = approvalStyle(g.approvalStatus);
              const isLocation =
                g.contentType === "location_page" || g.contentType === "seo_page";
              return (
                <tr key={g.id} className={selected.has(g.id) ? "bg-fitscript-green/5" : ""}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(g.id)}
                      onChange={() => toggle(g.id)}
                      className="accent-fitscript-green"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                        isLocation
                          ? "bg-blue-500/10 text-blue-300"
                          : "bg-fitscript-green/10 text-fitscript-green"
                      }`}
                    >
                      {isLocation ? "Location" : "Blog"}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 text-ops-text max-w-[280px] truncate"
                    title={g.title}
                  >
                    {g.title}
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted text-xs">{g.keyword}</td>
                  <td className="px-4 py-2 text-right text-ops-text-muted">
                    {g.wordCount?.toLocaleString() || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${style.pill}`}
                    >
                      {style.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ops-text-muted text-xs">
                    {g.createdAt
                      ? new Date(g.createdAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => setViewingId(g.id)}
                      className="text-xs text-fitscript-green hover:underline"
                    >
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FullContent {
  id: string;
  title: string;
  topic?: string;
  keyword: string;
  contentType: string;
  seoTitle?: string;
  seoDescription?: string;
  excerpt?: string;
  slug?: string;
  focusKeyword?: string;
  mainContent: string;
  wordCount?: number;
  keywordDensity?: string;
  faqs?: { question: string; answer: string }[];
  approvalStatus?: string;
  approvedAt?: string | null;
  createdAt?: string;
}

function ContentViewerModal({
  contentId,
  onClose,
  onChanged,
}: {
  contentId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [modalError, setModalError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ content: FullContent }>({
    queryKey: ["ops-clomark-generated", contentId],
    queryFn: () =>
      fetch(`/api/ops/clomark/generated/${contentId}`).then((r) => r.json()),
  });

  const approvalMutation = useMutation({
    mutationFn: async (status: "approved" | "denied" | "pending") => {
      const r = await fetch(
        `/api/ops/clomark/generated/${contentId}/approval`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["ops-clomark-generated", contentId],
      });
      onChanged();
    },
    onError: (e: Error) => setModalError(e.message),
  });

  const content = data?.content;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-ops-border">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ops-text truncate">
              {content?.title || "Loading…"}
            </h3>
            {content && (
              <div className="text-xs text-ops-text-muted mt-0.5 flex gap-3">
                <span>{content.keyword}</span>
                {content.wordCount && (
                  <span>· {content.wordCount.toLocaleString()} words</span>
                )}
                {content.keywordDensity && (
                  <span>· {content.keywordDensity}% density</span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-ops-text-muted hover:text-ops-text text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {isLoading ? (
            <div className="text-sm text-ops-text-muted">Loading…</div>
          ) : !content ? (
            <div className="text-sm text-red-400">Failed to load.</div>
          ) : (
            <>
              <div className="bg-ops-bg/40 rounded-lg p-4 border border-ops-border/60 space-y-2">
                <div className="text-[10px] font-semibold text-ops-text-muted uppercase tracking-wider">
                  SEO Meta
                </div>
                {content.seoTitle && (
                  <div className="text-sm">
                    <span className="text-ops-text-muted text-xs">Title: </span>
                    <span className="text-ops-text">{content.seoTitle}</span>
                  </div>
                )}
                {content.seoDescription && (
                  <div className="text-sm">
                    <span className="text-ops-text-muted text-xs">Description: </span>
                    <span className="text-ops-text">{content.seoDescription}</span>
                  </div>
                )}
                {content.slug && (
                  <div className="text-sm">
                    <span className="text-ops-text-muted text-xs">Slug: </span>
                    <code className="text-ops-text bg-ops-bg px-1.5 py-0.5 rounded text-xs">
                      /{content.slug}
                    </code>
                  </div>
                )}
                {content.focusKeyword && (
                  <div className="text-sm">
                    <span className="text-ops-text-muted text-xs">Focus Keyword: </span>
                    <span className="text-ops-text">{content.focusKeyword}</span>
                  </div>
                )}
                {content.excerpt && (
                  <div className="text-sm">
                    <span className="text-ops-text-muted text-xs">Excerpt: </span>
                    <span className="text-ops-text">{content.excerpt}</span>
                  </div>
                )}
              </div>

              <div>
                <div className="text-[10px] font-semibold text-ops-text-muted uppercase tracking-wider mb-2">
                  Content
                </div>
                <div className="bg-ops-bg/30 rounded-lg p-5 border border-ops-border/60 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1]:font-bold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:my-2 [&_p]:text-sm [&_p]:text-ops-text [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1 [&_li]:text-sm [&_li]:text-ops-text [&_strong]:text-ops-text [&_a]:text-fitscript-green [&_code]:bg-ops-bg [&_code]:px-1 [&_code]:rounded [&_code]:text-xs [&_h1]:text-ops-text [&_h2]:text-ops-text [&_h3]:text-ops-text">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content.mainContent || "_(empty)_"}
                  </ReactMarkdown>
                </div>
              </div>

              {Array.isArray(content.faqs) && content.faqs.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-ops-text-muted uppercase tracking-wider mb-2">
                    FAQs ({content.faqs.length})
                  </div>
                  <div className="space-y-2">
                    {content.faqs.map((faq, i) => (
                      <details
                        key={i}
                        className="bg-ops-bg/40 border border-ops-border/60 rounded-lg p-3"
                      >
                        <summary className="text-sm text-ops-text font-medium cursor-pointer">
                          {faq.question}
                        </summary>
                        <p className="text-sm text-ops-text-muted mt-2">
                          {faq.answer}
                        </p>
                      </details>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {content && (
          <div className="flex items-center justify-between p-4 border-t border-ops-border bg-ops-bg/30">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ops-text-muted">Status:</span>
              <span
                className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                  approvalStyle(content.approvalStatus).pill
                }`}
              >
                {approvalStyle(content.approvalStatus).label}
              </span>
              {content.approvedAt && (
                <span className="text-[10px] text-ops-text-muted">
                  · {new Date(content.approvedAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {modalError && (
                <span className="text-xs text-red-400 mr-2">{modalError}</span>
              )}
              {content.approvalStatus !== "denied" && (
                <button
                  onClick={() => {
                    setModalError(null);
                    if (confirm("Deny this draft?")) {
                      approvalMutation.mutate("denied");
                    }
                  }}
                  disabled={approvalMutation.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-40"
                >
                  Deny
                </button>
              )}
              {content.approvalStatus !== "approved" && (
                <button
                  onClick={() => {
                    setModalError(null);
                    approvalMutation.mutate("approved");
                  }}
                  disabled={approvalMutation.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg bg-fitscript-green text-white font-medium hover:bg-fitscript-green/90 disabled:opacity-40"
                >
                  Approve
                </button>
              )}
              {(content.approvalStatus === "approved" ||
                content.approvalStatus === "denied") && (
                <button
                  onClick={() => {
                    setModalError(null);
                    approvalMutation.mutate("pending");
                  }}
                  disabled={approvalMutation.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg bg-ops-bg border border-ops-border text-ops-text-muted hover:text-ops-text"
                >
                  Reset to Pending
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bulk Publish Dialog (Phase D) ──────────────────────────────────

interface PublishingPlatform {
  id: "wordpress" | "shopify" | "webflow" | "wix";
  name: string;
  type: string;
  connected: boolean;
  url?: string;
}

type PublishItemStatus =
  | "pending"
  | "publishing"
  | "success"
  | "error";

interface PublishItem {
  id: string;
  title: string;
  keyword: string;
  status: PublishItemStatus;
  publishedUrl?: string;
  error?: string;
}

function BulkPublishDialog({
  selected,
  onClose,
  onDone,
}: {
  selected: GeneratedRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"platform" | "publishing" | "complete">(
    "platform",
  );
  const [selectedPlatform, setSelectedPlatform] =
    useState<PublishingPlatform | null>(null);
  const [publishStatus, setPublishStatus] = useState<"draft" | "publish">("draft");
  const [items, setItems] = useState<PublishItem[]>(() =>
    selected.map((g) => ({
      id: g.id,
      title: g.title,
      keyword: g.keyword,
      status: "pending" as const,
    })),
  );

  const { data: platformsData, isLoading: platformsLoading } = useQuery<{
    platforms: PublishingPlatform[];
  }>({
    queryKey: ["ops-clomark-publishing-platforms"],
    queryFn: () =>
      fetch("/api/ops/clomark/publishing/platforms").then((r) => r.json()),
    staleTime: 60_000 * 5,
  });

  const platforms = platformsData?.platforms ?? [];

  const startPublishing = async () => {
    if (!selectedPlatform) return;
    setStep("publishing");

    // Sequential loop, mirroring Clomark's BulkPublishDialog client-side pattern.
    // Avoids hammering the destination CMS in parallel.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: "publishing" as const } : it,
        ),
      );
      try {
        const r = await fetch(
          `/api/ops/clomark/publishing/${selectedPlatform.id}/${item.id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publishStatus }),
          },
        );
        const body = await r.json();
        if (!r.ok || body.success === false) {
          throw new Error(body.error || body.message || `HTTP ${r.status}`);
        }
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? {
                  ...it,
                  status: "success" as const,
                  publishedUrl: body.url,
                }
              : it,
          ),
        );
      } catch (e: any) {
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? { ...it, status: "error" as const, error: e?.message || "failed" }
              : it,
          ),
        );
      }
    }
    setStep("complete");
  };

  const successCount = items.filter((it) => it.status === "success").length;
  const errorCount = items.filter((it) => it.status === "error").length;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={step === "publishing" ? undefined : onClose}
    >
      <div
        className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-ops-border">
          <div>
            <h3 className="text-base font-bold text-ops-text">
              {step === "platform"
                ? "Bulk Publish"
                : step === "publishing"
                  ? "Publishing…"
                  : "Publish Complete"}
            </h3>
            <p className="text-xs text-ops-text-muted mt-0.5">
              {selected.length} draft{selected.length !== 1 ? "s" : ""} selected
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={step === "publishing"}
            className="text-ops-text-muted hover:text-ops-text text-xl leading-none px-2 disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {step === "platform" && (
            <div className="space-y-4">
              <div>
                <div className="text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-2">
                  Pick a destination
                </div>
                {platformsLoading ? (
                  <div className="text-sm text-ops-text-muted">Loading platforms…</div>
                ) : platforms.length === 0 ? (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-xs text-amber-300/90">
                    No publishing destinations connected in Clomark. Open Clomark →
                    Integrations to connect WordPress / Shopify / Webflow / Wix.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {platforms.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setSelectedPlatform(p)}
                        className={`text-left px-4 py-3 rounded-lg border transition-colors ${
                          selectedPlatform?.id === p.id
                            ? "border-fitscript-green bg-fitscript-green/8"
                            : "border-ops-border hover:border-ops-border/80"
                        }`}
                      >
                        <div className="text-sm font-medium text-ops-text">
                          {p.name}
                        </div>
                        {p.url && (
                          <div className="text-[10px] text-ops-text-muted truncate mt-0.5">
                            {p.url}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selectedPlatform && (
                <div>
                  <div className="text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-2">
                    Publish Status
                  </div>
                  <div className="flex gap-2">
                    {(["draft", "publish"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setPublishStatus(s)}
                        className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                          publishStatus === s
                            ? "border-fitscript-green text-fitscript-green bg-fitscript-green/8"
                            : "border-ops-border text-ops-text-muted hover:text-ops-text"
                        }`}
                      >
                        {s === "draft" ? "Draft" : "Live (Publish)"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-ops-text-muted mt-1">
                    {publishStatus === "draft"
                      ? "Creates as draft in the destination. Review before going live."
                      : "Goes live immediately on the destination CMS."}
                  </p>
                </div>
              )}

              <div className="pt-2">
                <div className="text-xs font-medium text-ops-text-muted uppercase tracking-wider mb-2">
                  Will publish ({selected.length})
                </div>
                <div className="max-h-40 overflow-y-auto bg-ops-bg/40 border border-ops-border/50 rounded-lg">
                  {selected.map((g) => (
                    <div
                      key={g.id}
                      className="px-3 py-1.5 text-xs text-ops-text border-b border-ops-border/30 last:border-0"
                    >
                      {g.title}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {(step === "publishing" || step === "complete") && (
            <div className="space-y-1">
              {items.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-3 px-3 py-2 bg-ops-bg/40 border border-ops-border/40 rounded text-sm"
                >
                  <span className="w-5 shrink-0 text-center">
                    {it.status === "pending" && (
                      <span className="text-ops-text-muted">·</span>
                    )}
                    {it.status === "publishing" && (
                      <span className="inline-block w-3 h-3 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
                    )}
                    {it.status === "success" && (
                      <span className="text-fitscript-green">✓</span>
                    )}
                    {it.status === "error" && (
                      <span className="text-red-400">×</span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-ops-text">
                    {it.title}
                  </span>
                  {it.status === "success" && it.publishedUrl && (
                    <a
                      href={it.publishedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-fitscript-green hover:underline"
                    >
                      Open ↗
                    </a>
                  )}
                  {it.status === "error" && (
                    <span
                      className="text-[10px] text-red-400/80 truncate max-w-[180px]"
                      title={it.error}
                    >
                      {it.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 p-4 border-t border-ops-border bg-ops-bg/30">
          {step === "platform" && (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-ops-text-muted hover:text-ops-text"
              >
                Cancel
              </button>
              <button
                onClick={startPublishing}
                disabled={!selectedPlatform}
                className="px-4 py-2 text-sm rounded-lg bg-fitscript-green text-white font-medium hover:bg-fitscript-green/90 disabled:opacity-40"
              >
                Publish {selected.length} →
              </button>
            </>
          )}
          {step === "publishing" && (
            <span className="text-xs text-ops-text-muted">
              Publishing {items.filter((it) => it.status === "success" || it.status === "error").length} of {items.length}…
            </span>
          )}
          {step === "complete" && (
            <>
              <span className="text-xs">
                <span className="text-fitscript-green">{successCount} succeeded</span>
                {errorCount > 0 && (
                  <span className="text-red-400 ml-3">{errorCount} failed</span>
                )}
              </span>
              <button
                onClick={onDone}
                className="px-4 py-2 text-sm rounded-lg bg-fitscript-green text-white font-medium hover:bg-fitscript-green/90"
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
