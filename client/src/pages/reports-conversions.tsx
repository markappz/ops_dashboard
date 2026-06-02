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

interface FunnelStep {
  label: string;
  count: number | null;
  source: string;
}

interface Funnel {
  key: string;
  label: string;
  step_from: FunnelStep;
  step_to: FunnelStep;
  rate_pct: number | null;
  note: string | null;
}

interface ConversionReport {
  connected: boolean;
  window_days: Days;
  generated_at?: string;
  error?: string;
  funnels?: Funnel[];
  meta?: {
    ga4_events_found: Record<string, number>;
    bucket_views: Record<string, number>;
  };
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
}

function toneForRate(rate: number | null): "good" | "warn" | "bad" | null {
  if (rate === null) return null;
  if (rate >= 30) return "good";
  if (rate >= 10) return "warn";
  return "bad";
}

function FunnelCard({ f }: { f: Funnel }) {
  const fromCount = f.step_from.count ?? 0;
  const toCount = f.step_to.count ?? 0;

  // Rate >100% means upstream and downstream are measured on different
  // surfaces (e.g. GA4 page-views miss signups that came via direct API).
  // Clamp the display and flag it instead of showing a misleading number.
  const rawRate = f.rate_pct;
  const measurementGap = rawRate !== null && rawRate > 100;
  const displayRate = rawRate === null ? null : measurementGap ? 100 : rawRate;
  const tone = toneForRate(displayRate);
  const toneCls =
    tone === "good"
      ? "text-emerald-500"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "bad"
          ? "text-red-400"
          : "text-ops-text-muted";

  const toBarPct = fromCount > 0 ? Math.min(100, Math.round((toCount / fromCount) * 100)) : 0;

  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-ops-text">{f.label}</div>
          <div className="text-[10.5px] text-ops-text-subtle mt-0.5">
            {f.step_from.label} → {f.step_to.label}
          </div>
        </div>
        <div className="flex items-baseline gap-1.5">
          {measurementGap && (
            <span className="text-[10px] tracking-wider uppercase font-bold text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
              ≈
            </span>
          )}
          <div className={`text-2xl font-bold tracking-tight tabular-nums ${toneCls}`}>
            {fmtPct(displayRate)}
          </div>
        </div>
      </div>

      {/* Funnel bars */}
      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between text-[10.5px] text-ops-text-muted mb-1">
            <span>{f.step_from.label}</span>
            <span className="tabular-nums">{fmtInt(f.step_from.count)}</span>
          </div>
          <div className="h-2 rounded-full bg-ops-bg overflow-hidden">
            <div className="h-full bg-brand-blue-500" style={{ width: "100%" }} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[10.5px] text-ops-text-muted mb-1">
            <span>{f.step_to.label}</span>
            <span className="tabular-nums">{fmtInt(f.step_to.count)}</span>
          </div>
          <div className="h-2 rounded-full bg-ops-bg overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand-blue-500 to-brand-blue-400 transition-all"
              style={{ width: `${toBarPct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[10.5px] text-ops-text-subtle gap-3">
        <span className="truncate">
          From: {f.step_from.source} · To: {f.step_to.source}
        </span>
      </div>
      {f.note && (
        <div className="mt-2 text-[11px] text-amber-500 bg-amber-500/5 border border-amber-500/20 rounded-md px-2.5 py-1.5">
          {f.note}
        </div>
      )}
      {measurementGap && (
        <div className="mt-2 text-[11px] text-amber-500 bg-amber-500/5 border border-amber-500/20 rounded-md px-2.5 py-1.5">
          Downstream ({fmtInt(toCount)}) exceeds upstream ({fmtInt(fromCount)}) — upstream measurement misses some events. True rate likely 100%; raw ratio was {fmtPct(rawRate)}.
        </div>
      )}
    </div>
  );
}

export default function ReportsConversions() {
  const [days, setDays] = useState<Days>(30);

  const query = useQuery<ConversionReport>({
    queryKey: ["reports-conversions", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/reports/conversions?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const r = query.data;

  return (
    <div>
      <PageHero
        eyebrow="Reports"
        title="Conversion Rates"
        subtitle="Five funnels from first touch to purchase, recomputed each load."
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
        <InlineError context="Conversion report" data={query.data} error={query.error} />
      )}

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading funnels…</div>
      )}

      {r && r.connected === false && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-500">
          GA4 isn't connected. Connect from Integrations to populate funnels.
        </div>
      )}

      {r && r.error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-400">
          {r.error}
        </div>
      )}

      {r && r.funnels && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-1">
            {r.funnels.map((f) => (
              <FunnelCard key={f.key} f={f} />
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-ops-border bg-ops-bg/40 p-4">
            <div className="text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500 mb-2">
              GA4 events detected
            </div>
            {r.meta && Object.values(r.meta.ga4_events_found).every((v) => v === 0) ? (
              <div className="text-[11.5px] text-ops-text-muted">
                None of these events have fired yet. To populate the funnel, wire GA4 event
                tracking on FitScript for:
                <code className="font-mono text-[11px] ml-1">
                  add_to_cart · begin_checkout · purchase · popup_view · popup_click
                </code>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
                {r.meta &&
                  Object.entries(r.meta.ga4_events_found).map(([name, count]) => (
                    <div
                      key={name}
                      className="rounded-md bg-ops-surface border border-ops-border px-2.5 py-1.5"
                    >
                      <div className="text-[10px] tracking-wider uppercase text-ops-text-subtle font-mono">
                        {name}
                      </div>
                      <div
                        className={`text-sm font-bold tabular-nums mt-0.5 ${
                          count > 0 ? "text-emerald-500" : "text-ops-text-subtle"
                        }`}
                      >
                        {fmtInt(count)}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {r.generated_at && (
            <div className="mt-4 text-[10.5px] text-ops-text-subtle">
              Generated {new Date(r.generated_at).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
