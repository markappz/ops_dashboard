import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHero } from "../components/page-hero";
import { InlineError, hasApiError } from "../components/query-error";

type Days = 7 | 30 | 90 | 365;
const WINDOWS: Array<{ days: Days; label: string }> = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12m" },
];

interface BucketResult {
  key: string;
  label: string;
  views: number;
  samplePaths: Array<{ path: string; views: number }>;
}

interface TrafficReport {
  connected: boolean;
  window_days: Days;
  generated_at?: string;
  error?: string;
  overview?: {
    sessions: number;
    users: number;
    new_users: number;
    page_views: number;
    bounce_rate: number;
    avg_duration_sec: number;
  };
  buckets?: BucketResult[];
  popup?: {
    total_views: number;
    by_event: Record<string, number>;
    tracked_events: string[];
  };
  uncategorized_views?: number;
  total_pages_seen?: number;
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "bad" | null;
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-500"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "bad"
          ? "text-red-400"
          : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 sm:p-5 hover:border-brand-blue-400/40 transition-colors">
      <div className="text-[10px] tracking-[0.14em] uppercase font-semibold text-ops-text-subtle">
        {label}
      </div>
      <div className={`mt-2 text-2xl sm:text-[28px] font-bold tracking-tight ${toneCls}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function SectionTitle({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="mt-8 mb-3">
      <div className="text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500">{children}</div>
      {subtitle && <div className="mt-0.5 text-[11px] text-ops-text-subtle">{subtitle}</div>}
    </div>
  );
}

function BucketCard({ bucket, max }: { bucket: BucketResult; max: number }) {
  const widthPct = max > 0 ? Math.max(2, Math.round((bucket.views / max) * 100)) : 0;
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="text-sm font-semibold text-ops-text">{bucket.label}</div>
        <div className="text-xl font-bold text-ops-text tabular-nums">{fmtInt(bucket.views)}</div>
      </div>
      <div className="h-1.5 rounded-full bg-ops-bg overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-brand-blue-500 to-brand-blue-400"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      {bucket.samplePaths.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {bucket.samplePaths.map((s) => (
            <li
              key={s.path}
              className="flex items-center justify-between text-[11.5px] text-ops-text-muted tabular-nums gap-3"
            >
              <span className="truncate font-mono">{s.path}</span>
              <span>{fmtInt(s.views)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 text-[11px] text-ops-text-subtle italic">No pages matched yet</div>
      )}
    </div>
  );
}

export default function ReportsTraffic() {
  const [days, setDays] = useState<Days>(30);

  const query = useQuery<TrafficReport>({
    queryKey: ["reports-traffic", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/reports/traffic?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const r = query.data;
  const maxBucket = r?.buckets ? Math.max(...r.buckets.map((b) => b.views), 1) : 1;

  return (
    <div>
      <PageHero
        eyebrow="Reports"
        title="Site Traffic"
        subtitle="Page-view breakdown across landing, signup, product, checkout, and confirmation."
        actions={
          <div className="flex items-center gap-1.5 p-1 rounded-full bg-ops-bg border border-ops-border">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  days === w.days
                    ? "bg-brand-blue-500 text-white shadow-[0_2px_8px_-2px_rgba(46,91,255,0.45)]"
                    : "text-ops-text-muted hover:text-ops-text"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      {(query.isError || hasApiError(query.data)) && (
        <InlineError context="Traffic report" data={query.data} error={query.error} />
      )}

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading traffic…</div>
      )}

      {r && r.connected === false && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-500">
          GA4 isn't connected. Connect from Integrations to populate this report.
        </div>
      )}

      {r && r.error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-400">
          GA4 error: {r.error}
        </div>
      )}

      {r && r.overview && (
        <>
          <SectionTitle subtitle="Account-wide totals from GA4">Overview</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard label="Sessions" value={fmtInt(r.overview.sessions)} hint={`Last ${days}d`} />
            <StatCard label="Users" value={fmtInt(r.overview.users)} hint={`${fmtInt(r.overview.new_users)} new`} />
            <StatCard label="Page views" value={fmtInt(r.overview.page_views)} hint={`${fmtInt(r.total_pages_seen)} unique paths`} />
            <StatCard
              label="Avg session"
              value={fmtDuration(r.overview.avg_duration_sec)}
              hint={`${fmtPct(r.overview.bounce_rate)} bounce`}
            />
          </div>

          <SectionTitle
            subtitle={
              (r.uncategorized_views || 0) > 0
                ? `${fmtInt(r.uncategorized_views)} views didn't match any bucket`
                : "Pageviews bucketed by URL pattern"
            }
          >
            Page categories
          </SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {(r.buckets || []).map((b) => (
              <BucketCard key={b.key} bucket={b} max={maxBucket} />
            ))}
          </div>

          <SectionTitle
            subtitle={
              r.popup && r.popup.total_views > 0
                ? `Tracking: ${r.popup.tracked_events.join(", ")}`
                : `No popup events tracked yet. Fire one of: ${r.popup?.tracked_events.join(", ") || ""}`
            }
          >
            Popup views
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Total popup views"
              value={fmtInt(r.popup?.total_views ?? 0)}
              hint={`Last ${days}d`}
              tone={(r.popup?.total_views ?? 0) > 0 ? "good" : null}
            />
            {Object.entries(r.popup?.by_event || {}).map(([name, count]) => (
              <StatCard key={name} label={name} value={fmtInt(count)} hint="Custom event" />
            ))}
          </div>

          {r.generated_at && (
            <div className="mt-6 text-[10.5px] text-ops-text-subtle">
              Generated {new Date(r.generated_at).toLocaleString()} · GA4 property
            </div>
          )}
        </>
      )}
    </div>
  );
}
