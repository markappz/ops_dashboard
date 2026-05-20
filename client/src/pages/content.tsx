import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ops-text">Content &amp; SEO</h1>
          <p className="text-sm text-ops-text-muted mt-1">
            Search Console performance + Clomark content pipeline · last {range} days
          </p>
        </div>
        <div className="flex gap-1 bg-ops-bg rounded-lg p-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setRange(d as 7 | 30 | 90)}
              className={`px-3 py-1 text-xs rounded ${
                range === d
                  ? "bg-ops-surface text-ops-text"
                  : "text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

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
      <div className="grid grid-cols-4 gap-4 mb-6">
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
                  stroke="#0EA57A"
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
                  stroke="#0EA57A"
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
      <div className="grid grid-cols-2 gap-5 mb-6">
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

function ClomarkSection() {
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

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
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
        {!ready && (
          <span className="text-xs text-ops-text-muted">
            {status?.configured ? "Business not selected" : "Not configured"}
          </span>
        )}
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
        <ClomarkBody data={data} />
      )}
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
      <div className="grid grid-cols-4 gap-4 mb-5">
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
      <div className="grid grid-cols-3 gap-5 pt-4 border-t border-ops-border">
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
