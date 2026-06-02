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

interface MetaSummary {
  configured: boolean;
  connected: boolean;
  account_name: string | null;
  currency: string | null;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_pct: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  conversions: number;
  conversion_value_usd: number;
  roas: number | null;
  error?: string;
  hint?: string;
}

interface ConnectorStub {
  configured: boolean;
  connected: boolean;
  hint: string;
}

interface FirstPartyChannel {
  channel: string;
  sessions: number;
  users: number;
}

interface AttributionRow {
  source: string;
  medium: string | null;
  events: number;
}

interface AdsReport {
  window_days: Days;
  generated_at: string;
  meta: MetaSummary;
  google_ads: ConnectorStub;
  hyros: ConnectorStub;
  campaign_refiners: ConnectorStub;
  first_party: {
    sessions: number;
    users: number;
    channels: FirstPartyChannel[];
    top_sources: AttributionRow[];
    signups_in_window: number | null;
    note: string;
  };
}

function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString();
}
function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  return v < 100
    ? `$${v.toFixed(2)}`
    : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtMoneyDecimal(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
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

function ConnectorBadge({ stub, name }: { stub: ConnectorStub; name: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="text-sm font-semibold text-ops-text">{name}</div>
        <div
          className={`text-[10px] tracking-wider uppercase font-bold px-1.5 py-0.5 rounded border ${
            stub.connected
              ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/30"
              : stub.configured
                ? "text-amber-500 bg-amber-500/10 border-amber-500/30"
                : "text-ops-text-subtle bg-ops-bg border-ops-border"
          }`}
        >
          {stub.connected ? "Connected" : stub.configured ? "Configured" : "Not connected"}
        </div>
      </div>
      <div className="text-[11.5px] text-ops-text-muted">{stub.hint}</div>
    </div>
  );
}

export default function ReportsAds() {
  const [days, setDays] = useState<Days>(30);

  const query = useQuery<AdsReport>({
    queryKey: ["reports-ads", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/reports/ads?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const r = query.data;
  const meta = r?.meta;
  const fp = r?.first_party;
  const maxChannel = fp?.channels?.length ? Math.max(...fp.channels.map((c) => c.sessions), 1) : 1;

  return (
    <div>
      <PageHero
        eyebrow="Reports"
        title="Ads & Attribution"
        subtitle="Paid spend across platforms + first-party tracking attribution."
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
        <InlineError context="Ads report" data={query.data} error={query.error} />
      )}

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading ads…</div>
      )}

      {r && (
        <>
          <SectionTitle
            subtitle={
              meta?.connected
                ? `${meta.account_name} (${meta.currency}) · Last ${days}d`
                : meta?.hint || "Meta Ads connector pending credentials"
            }
          >
            Meta Ads
          </SectionTitle>
          {meta?.connected ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <StatCard
                label="Spend"
                value={fmtMoney(meta.spend_usd)}
                hint={`${fmtInt(meta.impressions)} impressions`}
              />
              <StatCard
                label="Clicks"
                value={fmtInt(meta.clicks)}
                hint={`${fmtPct(meta.ctr_pct)} CTR`}
              />
              <StatCard
                label="CPC"
                value={fmtMoneyDecimal(meta.cpc_usd)}
                hint={`${fmtMoneyDecimal(meta.cpm_usd)} CPM`}
              />
              <StatCard
                label="ROAS"
                value={meta.roas !== null ? `${meta.roas.toFixed(2)}×` : "—"}
                hint={`${fmtInt(meta.conversions)} purchases · ${fmtMoney(meta.conversion_value_usd)}`}
                tone={(meta.roas ?? 0) >= 2 ? "good" : (meta.roas ?? 0) >= 1 ? "warn" : "bad"}
              />
            </div>
          ) : (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-[12px] text-amber-500">
              {meta?.error || meta?.hint || "Meta Ads not connected"}
            </div>
          )}

          <SectionTitle subtitle="Other ad platforms — scaffolded, waiting on credentials">
            Other platforms
          </SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            <ConnectorBadge stub={r.google_ads} name="Google Ads" />
            <ConnectorBadge stub={r.hyros} name="Hyros" />
            <ConnectorBadge stub={r.campaign_refiners} name="Campaign Refiners" />
          </div>

          <SectionTitle subtitle={fp?.note}>First-party attribution</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4">
            <StatCard label="Sessions" value={fmtInt(fp?.sessions)} hint={`Last ${days}d`} />
            <StatCard label="Unique visitors" value={fmtInt(fp?.users)} hint="Visitor + user dedup" />
            <StatCard
              label="Signups in window"
              value={fmtInt(fp?.signups_in_window)}
              hint="From RDS"
              tone={(fp?.signups_in_window ?? 0) > 0 ? "good" : null}
            />
            <StatCard
              label="Top channel"
              value={fp?.channels?.[0]?.channel || "—"}
              hint={fp?.channels?.[0] ? `${fmtInt(fp.channels[0].sessions)} sessions` : "—"}
            />
          </div>

          {fp && fp.channels.length > 0 && (
            <div className="rounded-xl border border-ops-border bg-ops-surface p-4">
              <div className="text-[10px] tracking-[0.14em] uppercase font-semibold text-ops-text-subtle mb-3">
                Channel mix
              </div>
              <div className="space-y-2">
                {fp.channels.map((c) => (
                  <div key={c.channel}>
                    <div className="flex items-center justify-between text-[11.5px] mb-1">
                      <span className="font-mono text-ops-text">{c.channel}</span>
                      <span className="tabular-nums text-ops-text-muted">
                        {fmtInt(c.sessions)} sess · {fmtInt(c.users)} users
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-ops-bg overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-brand-blue-500 to-brand-blue-400"
                        style={{ width: `${Math.max(2, Math.round((c.sessions / maxChannel) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {r.generated_at && (
            <div className="mt-6 text-[10.5px] text-ops-text-subtle">
              Generated {new Date(r.generated_at).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
