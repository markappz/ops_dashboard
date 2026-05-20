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
            Search Console performance · last {range} days
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
