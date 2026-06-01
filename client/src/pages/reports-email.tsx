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

interface EmailReport {
  configured: boolean;
  window_days: Days;
  generated_at: string;
  subscribers: {
    total: number | null;
    total_estimated: boolean;
    new_in_window: number | null;
    lost_in_window: number | null;
    net_growth: number | null;
    growth_rate_pct: number | null;
  };
  engagement: {
    messages_sent: number;
    campaigns_sent: number;
    flows_active: number;
    delivered: number;
    opens_unique: number;
    clicks_unique: number;
    unsubscribes: number;
    bounced: number;
    spam_complaints: number;
    open_rate: number | null;
    click_rate: number | null;
    click_to_open_rate: number | null;
    unsubscribe_rate: number | null;
    bounce_rate: number | null;
    spam_rate: number | null;
  };
  revenue: {
    available: boolean;
    campaigns_attributed_usd: number | null;
    flows_attributed_usd: number | null;
    total_attributed_usd: number | null;
    per_subscriber_usd: number | null;
    conversions: number | null;
  };
  meta: {
    campaign_conversion_metric: string | null;
    flow_conversion_metric: string | null;
    signup_source: string;
    unsub_metric_found: boolean;
  };
  error?: string;
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
}
function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  return v < 1
    ? `$${v.toFixed(2)}`
    : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtMoneyDecimal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}
function fmtSigned(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toLocaleString()}`;
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
      <div className={`mt-2 text-2xl sm:text-[28px] font-bold tracking-tight ${toneCls}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ops-text-muted">{hint}</div>}
    </div>
  );
}

function SectionTitle({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="mt-8 mb-3">
      <div className="text-[11px] tracking-[0.14em] uppercase font-semibold text-brand-blue-500">
        {children}
      </div>
      {subtitle && <div className="mt-0.5 text-[11px] text-ops-text-subtle">{subtitle}</div>}
    </div>
  );
}

function toneForOpenRate(v: number | null): "good" | "warn" | "bad" | null {
  if (v === null) return null;
  if (v >= 25) return "good";
  if (v >= 15) return "warn";
  return "bad";
}
function toneForClickRate(v: number | null): "good" | "warn" | "bad" | null {
  if (v === null) return null;
  if (v >= 3) return "good";
  if (v >= 1.5) return "warn";
  return "bad";
}
function toneForUnsubRate(v: number | null): "good" | "warn" | "bad" | null {
  if (v === null) return null;
  if (v <= 0.3) return "good";
  if (v <= 0.5) return "warn";
  return "bad";
}
function toneForBounceRate(v: number | null): "good" | "warn" | "bad" | null {
  if (v === null) return null;
  if (v <= 1) return "good";
  if (v <= 2) return "warn";
  return "bad";
}

export default function ReportsEmail() {
  const [days, setDays] = useState<Days>(30);

  const query = useQuery<EmailReport>({
    queryKey: ["reports-email", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/reports/email?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const r = query.data;
  const eng = r?.engagement;
  const subs = r?.subscribers;
  const rev = r?.revenue;

  return (
    <div>
      <PageHero
        eyebrow="Reports"
        title="Email"
        subtitle="Klaviyo-powered subscriber growth, engagement, and revenue."
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
        <InlineError context="Email report" data={query.data} error={query.error} />
      )}

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading report…</div>
      )}

      {r && r.configured === false && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-500">
          Klaviyo isn't configured. Set <code className="font-mono">KLAVIYO_API_KEY</code> in env to populate this report.
        </div>
      )}

      {r && r.configured && (
        <>
          <SectionTitle subtitle="Active email subscribers across the account">
            Subscribers
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Active subscribers"
              value={fmtInt(subs?.total)}
              hint="From FitScript users table"
            />
            <StatCard
              label="New in window"
              value={fmtInt(subs?.new_in_window)}
              hint={`Last ${days}d signups`}
              tone="good"
            />
            <StatCard
              label="Unsubs in window"
              value={fmtInt(subs?.lost_in_window)}
              hint={
                r.meta.unsub_metric_found
                  ? `Last ${days}d`
                  : "“Unsubscribed from Email Marketing” metric not found"
              }
              tone="bad"
            />
            <StatCard
              label="Net growth"
              value={fmtSigned(subs?.net_growth)}
              hint={
                subs?.growth_rate_pct !== null && subs?.growth_rate_pct !== undefined
                  ? `${fmtPct(subs.growth_rate_pct)} growth rate`
                  : "Set subscriber + unsub metrics in Klaviyo"
              }
              tone={(subs?.net_growth ?? 0) >= 0 ? "good" : "bad"}
            />
          </div>

          <SectionTitle subtitle="Aggregated across all campaigns + flows in the window">
            Engagement
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Open rate"
              value={fmtPct(eng?.open_rate ?? null)}
              hint={`${fmtInt(eng?.opens_unique)} of ${fmtInt(eng?.delivered)} delivered`}
              tone={toneForOpenRate(eng?.open_rate ?? null)}
            />
            <StatCard
              label="Click rate"
              value={fmtPct(eng?.click_rate ?? null)}
              hint={`${fmtInt(eng?.clicks_unique)} unique clicks`}
              tone={toneForClickRate(eng?.click_rate ?? null)}
            />
            <StatCard
              label="Unsubscribe rate"
              value={fmtPct(eng?.unsubscribe_rate ?? null)}
              hint={`${fmtInt(eng?.unsubscribes)} in window`}
              tone={toneForUnsubRate(eng?.unsubscribe_rate ?? null)}
            />
            <StatCard
              label="Bounce rate"
              value={fmtPct(eng?.bounce_rate ?? null)}
              hint={`${fmtInt(eng?.bounced)} bounces · ${fmtInt(eng?.spam_complaints)} spam`}
              tone={toneForBounceRate(eng?.bounce_rate ?? null)}
            />
          </div>

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4 text-xs">
            <div className="rounded-xl border border-ops-border bg-ops-bg/40 p-3">
              <div className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold">
                Click-to-open
              </div>
              <div className="mt-1 text-base font-bold text-ops-text">
                {fmtPct(eng?.click_to_open_rate ?? null)}
              </div>
              <div className="text-[10.5px] text-ops-text-muted mt-0.5">
                Clicks ÷ Opens — measures interest of those who opened
              </div>
            </div>
            <div className="rounded-xl border border-ops-border bg-ops-bg/40 p-3">
              <div className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold">
                Campaigns sent
              </div>
              <div className="mt-1 text-base font-bold text-ops-text">
                {fmtInt(eng?.campaigns_sent)}
              </div>
              <div className="text-[10.5px] text-ops-text-muted mt-0.5">
                One-off broadcasts in the window
              </div>
            </div>
            <div className="rounded-xl border border-ops-border bg-ops-bg/40 p-3">
              <div className="text-[10px] tracking-[0.14em] uppercase text-ops-text-subtle font-semibold">
                Flows reporting
              </div>
              <div className="mt-1 text-base font-bold text-ops-text">
                {fmtInt(eng?.flows_active)}
              </div>
              <div className="text-[10.5px] text-ops-text-muted mt-0.5">
                Automations contributing engagement
              </div>
            </div>
          </div>

          <SectionTitle
            subtitle={
              rev?.available
                ? `Conversion metric: ${r.meta.campaign_conversion_metric || "—"}`
                : "Set up a revenue metric in Klaviyo (e.g. Placed Order) to populate"
            }
          >
            Revenue
          </SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Total attributed"
              value={fmtMoney(rev?.total_attributed_usd ?? null)}
              hint={rev?.available ? `Last ${days}d` : "—"}
              tone={rev?.available ? "good" : null}
            />
            <StatCard
              label="From campaigns"
              value={fmtMoney(rev?.campaigns_attributed_usd ?? null)}
              hint="Broadcast sends"
            />
            <StatCard
              label="From flows"
              value={fmtMoney(rev?.flows_attributed_usd ?? null)}
              hint="Automations"
            />
            <StatCard
              label="Per subscriber"
              value={fmtMoneyDecimal(rev?.per_subscriber_usd ?? null)}
              hint={
                rev?.available && subs?.total
                  ? `${fmtMoney(rev.total_attributed_usd ?? null)} ÷ ${fmtInt(subs.total)}`
                  : "Needs subscriber count + revenue metric"
              }
            />
          </div>

          <div className="mt-6 text-[10.5px] text-ops-text-subtle">
            Generated {new Date(r.generated_at).toLocaleString()} · Klaviyo
            {r.meta.campaign_conversion_metric &&
              ` · Campaigns measured by “${r.meta.campaign_conversion_metric}”`}
            {r.meta.flow_conversion_metric &&
              ` · Flows by “${r.meta.flow_conversion_metric}”`}
          </div>
        </>
      )}
    </div>
  );
}
