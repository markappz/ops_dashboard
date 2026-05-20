import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { InlineError, hasApiError } from "../components/query-error";

type LeadStatus = "Cold" | "Engaged" | "Hot" | "Paid";

interface Lead {
  visitorId: string;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  status: LeadStatus;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  daysSinceFirstTouch: number;
  daysSinceLastTouch: number;
  sessions: number;
  touchpoints: number;
  revenue: number;
  signedUp: boolean;
}

interface LeadsResp {
  leads: Lead[];
  totals: { all: number; byStatus: Record<string, number> };
  sources: { source: string; count: number }[];
  tablesReady: boolean;
  note?: string;
  error?: string;
}

interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pctOfTop: number;
  pctOfPrev?: number;
}

interface FunnelResp {
  stages: FunnelStage[];
  tablesReady: boolean;
  windowDays: number;
  error?: string;
}

const STATUS_STYLES: Record<LeadStatus, { dot: string; pill: string; label: string }> = {
  Paid: { dot: "bg-fitscript-green", pill: "bg-fitscript-green/15 text-fitscript-green", label: "Paid" },
  Hot: { dot: "bg-amber-300", pill: "bg-amber-500/15 text-amber-300", label: "Hot" },
  Engaged: { dot: "bg-blue-400", pill: "bg-blue-500/15 text-blue-300", label: "Engaged" },
  Cold: { dot: "bg-ops-text-muted/50", pill: "bg-ops-text-muted/10 text-ops-text-muted", label: "Cold" },
};

const STAGE_COLOR: Record<string, string> = {
  visitors: "bg-ops-text-muted/30",
  quiz_started: "bg-blue-500/50",
  signups: "bg-purple-500/50",
  paid: "bg-fitscript-green/50",
};

function fmtPct(n: number): string {
  if (!isFinite(n) || n === 0) return "0%";
  return n < 1 ? `${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
}

function FunnelBar({ stage, total }: { stage: FunnelStage; total: number }) {
  const widthPct = total > 0 ? Math.max((stage.count / total) * 100, 2) : 0;
  const color = STAGE_COLOR[stage.key] || "bg-ops-text-muted/30";
  return (
    <div className="mb-3">
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-ops-text font-medium">{stage.label}</span>
        <span className="text-ops-text-muted">
          {stage.count.toLocaleString()}
          {stage.pctOfPrev !== undefined && (
            <span className="text-[10px] ml-2">
              ({fmtPct(stage.pctOfPrev)} of prev)
            </span>
          )}
          <span className="text-[10px] ml-2 opacity-60">
            {fmtPct(stage.pctOfTop)} of top
          </span>
        </span>
      </div>
      <div className="h-7 bg-ops-bg rounded-lg overflow-hidden">
        <div
          className={`h-full rounded-lg ${color} transition-all duration-500`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
    </div>
  );
}

export default function Leads() {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [source, setSource] = useState<string>("");
  const [days, setDays] = useState<number>(90);

  const params = new URLSearchParams({ days: String(days) });
  if (status) params.set("status", status);
  if (source) params.set("source", source);

  const { data, isLoading, error } = useQuery<LeadsResp>({
    queryKey: ["ops-leads", days, status, source],
    queryFn: () => fetch(`/api/ops/leads?${params.toString()}`).then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const { data: funnel } = useQuery<FunnelResp>({
    queryKey: ["ops-leads-funnel", days],
    queryFn: () => fetch(`/api/ops/leads/funnel?days=${days}`).then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const totals = data?.totals;
  const stages = funnel?.stages ?? [];
  const topStageCount = stages[0]?.count || 0;

  const tablesReady = data?.tablesReady !== false;

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold text-ops-text">Leads</h1>
          <p className="text-sm text-ops-text-muted mt-1">
            Tracked visitors and signups · classified by intent · last {days} days
          </p>
        </div>
        <div className="flex gap-2 bg-ops-bg rounded-lg p-1">
          {[7, 30, 90, 365].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 text-xs rounded ${
                days === d
                  ? "bg-ops-surface text-ops-text"
                  : "text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {d === 365 ? "1y" : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      {(hasApiError(data) || error) && (
        <div className="mb-4">
          <InlineError context="Leads" data={data} error={error as Error | null} />
        </div>
      )}

      {!tablesReady && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-6 mb-6 shadow-card">
          <h3 className="text-sm font-semibold text-amber-200 mb-2">
            Waiting on first visitor data
          </h3>
          <p className="text-sm text-amber-200/80 max-w-2xl">
            {data?.note ||
              "Tracking tables haven't been populated yet. The pixel was wired into FitScript and ops-dashboard; data flows in as soon as visitors land on fitscript.me."}
          </p>
          <Link href="/tracking" className="text-xs text-fitscript-green hover:underline mt-3 inline-block">
            View tracking setup →
          </Link>
        </div>
      )}

      {/* Status totals */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {(["Paid", "Hot", "Engaged", "Cold"] as LeadStatus[]).map((s) => {
          const count = totals?.byStatus[s] ?? 0;
          const style = STATUS_STYLES[s];
          return (
            <button
              key={s}
              onClick={() => setStatus(status === s ? "" : s)}
              className={`bg-ops-surface border rounded-xl p-5 shadow-card text-left transition-colors ${
                status === s
                  ? "border-fitscript-green"
                  : "border-ops-border hover:border-ops-border/80"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                <span className="text-xs text-ops-text-muted uppercase tracking-wider">
                  {style.label}
                </span>
              </div>
              <div className="text-2xl font-bold text-ops-text">
                {count.toLocaleString()}
              </div>
              <div className="text-[10px] text-ops-text-muted mt-1">
                {totals?.all
                  ? `${((count / totals.all) * 100).toFixed(0)}% of total`
                  : ""}
              </div>
            </button>
          );
        })}
      </div>

      {/* Funnel */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-6 shadow-card mb-6">
        <h3 className="text-sm font-semibold text-ops-text mb-4">
          Funnel — last {days} days
        </h3>
        {stages.length === 0 ? (
          <div className="text-sm text-ops-text-muted py-6 text-center">
            No funnel data yet.
          </div>
        ) : (
          stages.map((s) => <FunnelBar key={s.key} stage={s} total={topStageCount} />)
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="block text-[10px] text-ops-text-muted uppercase tracking-wider mb-1">
            Source
          </label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="bg-ops-bg border border-ops-border rounded-lg px-3 py-1.5 text-sm text-ops-text focus:outline-none focus:border-fitscript-green"
          >
            <option value="">All</option>
            {data?.sources.map((s) => (
              <option key={s.source} value={s.source}>
                {s.source} ({s.count})
              </option>
            ))}
          </select>
        </div>
        {(status || source) && (
          <div className="flex items-end">
            <button
              onClick={() => {
                setStatus("");
                setSource("");
              }}
              className="px-3 py-1.5 text-xs text-ops-text-muted hover:text-ops-text"
            >
              Clear filters
            </button>
          </div>
        )}
        <div className="ml-auto flex items-end">
          <span className="text-xs text-ops-text-muted">
            {data?.leads.length ?? 0} of {totals?.all ?? 0} shown
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : !data?.leads.length ? (
          <div className="p-12 text-center text-sm text-ops-text-muted">
            {tablesReady
              ? "No leads match these filters."
              : "No data yet. As visitors land on fitscript.me, they'll appear here."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-ops-bg/40 text-xs uppercase text-ops-text-muted tracking-wider">
              <tr>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Lead</th>
                <th className="text-left px-5 py-3 font-medium">Source</th>
                <th className="text-right px-5 py-3 font-medium">Sessions</th>
                <th className="text-right px-5 py-3 font-medium">Revenue</th>
                <th className="text-left px-5 py-3 font-medium">First Touch</th>
                <th className="text-left px-5 py-3 font-medium">Last Touch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border">
              {data.leads.map((l) => {
                const style = STATUS_STYLES[l.status];
                const cell = (
                  <>
                    <td className="px-5 py-3">
                      <span className={`text-[10px] font-medium uppercase px-2 py-0.5 rounded ${style.pill}`}>
                        {style.label}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {l.email ? (
                        <div>
                          <div className="text-ops-text">
                            {l.firstName || ""} {l.email && <span className="text-ops-text-muted text-xs">{l.email}</span>}
                          </div>
                          <div className="text-[10px] text-ops-text-muted font-mono">
                            {l.visitorId.slice(0, 12)}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="text-ops-text-muted italic">Anonymous visitor</div>
                          <div className="text-[10px] text-ops-text-muted font-mono">
                            {l.visitorId.slice(0, 12)}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ops-text-muted">
                      {l.source}
                      {l.campaign && (
                        <div className="text-[10px] opacity-60">{l.campaign}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-ops-text">
                      {l.sessions}
                      <div className="text-[10px] text-ops-text-muted">
                        {l.touchpoints} events
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right text-fitscript-green font-medium">
                      {l.revenue > 0 ? `$${l.revenue.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-ops-text-muted text-xs">
                      <div>
                        {l.firstTouchAt
                          ? new Date(l.firstTouchAt).toLocaleDateString()
                          : "—"}
                      </div>
                      <div className="text-[10px] opacity-60">
                        {l.daysSinceFirstTouch}d ago
                      </div>
                    </td>
                    <td className="px-5 py-3 text-ops-text-muted text-xs">
                      <div>
                        {l.lastTouchAt
                          ? new Date(l.lastTouchAt).toLocaleDateString()
                          : "—"}
                      </div>
                      <div className="text-[10px] opacity-60">
                        {l.daysSinceLastTouch}d ago
                      </div>
                    </td>
                  </>
                );
                // Signed-up leads link through to the member detail page
                if (l.userId) {
                  return (
                    <tr
                      key={l.visitorId}
                      onClick={() => (window.location.href = `/members/${l.userId}`)}
                      className="hover:bg-ops-surface-hover cursor-pointer"
                    >
                      {cell}
                    </tr>
                  );
                }
                return (
                  <tr key={l.visitorId} className="hover:bg-ops-surface-hover">
                    {cell}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
