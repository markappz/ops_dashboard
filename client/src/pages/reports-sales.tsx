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

interface SalesReport {
  window_days: Days;
  generated_at?: string;
  error?: string;
  window?: {
    customers_paid: number;
    new_customers: number;
    orders: number;
    revenue_usd: number;
    aov_usd: number | null;
  };
  lifetime?: {
    total_customers: number;
    repeat_customers: number;
    repeat_rate_pct: number | null;
    avg_orders_per_customer: number | null;
    avg_ltv_usd: number | null;
    avg_days_to_first_purchase: number | null;
  };
  subscriptions?: {
    mrr_estimate_usd: number;
    breakdown: Array<{ tier: string; period: string | null; count: number; monthly_value: number }>;
    note: string;
  };
  daily_series?: Array<{ date: string; revenue_usd: number; orders: number }>;
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

function fmtDays(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v < 1) return `${(v * 24).toFixed(1)}h`;
  return `${v.toFixed(1)}d`;
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

function RevenueSpark({ data }: { data: Array<{ date: string; revenue_usd: number }> }) {
  if (!data.length)
    return (
      <div className="rounded-xl border border-ops-border bg-ops-surface p-6 text-center text-[11.5px] text-ops-text-muted italic">
        No paid orders in this window yet.
      </div>
    );
  const max = Math.max(...data.map((d) => d.revenue_usd), 1);
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4">
      <div className="flex items-end gap-[3px] h-24">
        {data.map((d) => {
          const h = Math.max(2, Math.round((d.revenue_usd / max) * 96));
          return (
            <div
              key={d.date}
              className="flex-1 bg-gradient-to-t from-brand-blue-500/40 to-brand-blue-500 rounded-sm hover:from-brand-blue-500/60 hover:to-brand-blue-400 transition-colors"
              style={{ height: `${h}px` }}
              title={`${d.date}: $${d.revenue_usd}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-ops-text-subtle font-mono">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function ReportsSales() {
  const [days, setDays] = useState<Days>(30);

  const query = useQuery<SalesReport>({
    queryKey: ["reports-sales", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/reports/sales?days=${days}`);
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
        title="Sales"
        subtitle="Lab-order revenue, customer counts, LTV, and active subscription MRR."
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
        <InlineError context="Sales report" data={query.data} error={query.error} />
      )}

      {query.isLoading && (
        <div className="text-ops-text-muted text-sm py-12 text-center">Loading sales…</div>
      )}

      {r && r.window && (
        <>
          <SectionTitle subtitle={`Lab orders, last ${days}d`}>This window</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Revenue"
              value={fmtMoney(r.window.revenue_usd)}
              hint={`${fmtInt(r.window.orders)} paid orders`}
              tone={r.window.revenue_usd > 0 ? "good" : null}
            />
            <StatCard
              label="Paying customers"
              value={fmtInt(r.window.customers_paid)}
              hint={`${fmtInt(r.window.new_customers)} new`}
            />
            <StatCard label="AOV" value={fmtMoneyDecimal(r.window.aov_usd)} hint="Average order value" />
            <StatCard
              label="Orders"
              value={fmtInt(r.window.orders)}
              hint={
                r.window.customers_paid > 0
                  ? `${(r.window.orders / r.window.customers_paid).toFixed(2)} per customer`
                  : "—"
              }
            />
          </div>

          <div className="mt-4">
            <RevenueSpark data={r.daily_series || []} />
          </div>

          <SectionTitle subtitle="All-time across every customer">Lifetime</SectionTitle>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard
              label="Total customers"
              value={fmtInt(r.lifetime?.total_customers)}
              hint="Anyone with a paid lab order"
            />
            <StatCard
              label="Avg LTV"
              value={fmtMoney(r.lifetime?.avg_ltv_usd ?? null)}
              hint={`${fmtInt(r.lifetime?.avg_orders_per_customer ? Math.round(r.lifetime.avg_orders_per_customer * 100) / 100 : null)} avg orders`}
            />
            <StatCard
              label="Repeat-buy rate"
              value={fmtPct(r.lifetime?.repeat_rate_pct ?? null)}
              hint={`${fmtInt(r.lifetime?.repeat_customers)} customers bought more than once`}
              tone={(r.lifetime?.repeat_rate_pct ?? 0) >= 20 ? "good" : "warn"}
            />
            <StatCard
              label="Time to first purchase"
              value={fmtDays(r.lifetime?.avg_days_to_first_purchase ?? null)}
              hint="From signup to first paid order"
            />
          </div>

          <SectionTitle
            subtitle={r.subscriptions?.note}
          >
            Subscriptions (MRR)
          </SectionTitle>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            <StatCard
              label="Monthly run rate"
              value={fmtMoney(r.subscriptions?.mrr_estimate_usd ?? null)}
              hint="Active subs × list price"
              tone={(r.subscriptions?.mrr_estimate_usd ?? 0) > 0 ? "good" : null}
            />
            <div className="lg:col-span-2 rounded-xl border border-ops-border bg-ops-surface p-4">
              <div className="text-[10px] tracking-[0.14em] uppercase font-semibold text-ops-text-subtle mb-2">
                Tier breakdown
              </div>
              {!r.subscriptions || r.subscriptions.breakdown.length === 0 ? (
                <div className="text-[11.5px] text-ops-text-muted italic">No active paid subscriptions</div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="text-[10px] tracking-wider uppercase text-ops-text-subtle">
                    <tr>
                      <th className="text-left font-medium py-1">Tier</th>
                      <th className="text-left font-medium py-1">Period</th>
                      <th className="text-right font-medium py-1">Subs</th>
                      <th className="text-right font-medium py-1">Monthly value</th>
                    </tr>
                  </thead>
                  <tbody className="text-ops-text">
                    {r.subscriptions.breakdown.map((b) => (
                      <tr key={`${b.tier}-${b.period}`} className="border-t border-ops-border">
                        <td className="py-1.5 font-mono">{b.tier}</td>
                        <td className="py-1.5 text-ops-text-muted">{b.period || "—"}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtInt(b.count)}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtMoney(b.monthly_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {r.generated_at && (
            <div className="mt-6 text-[10.5px] text-ops-text-subtle">
              Generated {new Date(r.generated_at).toLocaleString()} · From RDS lab_orders + users
            </div>
          )}
        </>
      )}
    </div>
  );
}
