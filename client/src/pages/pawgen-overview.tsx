import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHero } from "../components/page-hero";

// Optional everywhere: a 503 "not connected" or 500 carries only `error`, and the
// fetch resolves it like any other body. Optional fields force a guard at each read
// — the same bug class that white-screened the orders tab in August.
interface Overview {
  window?: { days: number };
  totals?: {
    revenueAllTime: number;
    ordersAllTime: number;
    revenueWindow: number;
    ordersWindow: number;
    aov: number;
    pendingPayments: number;
    refunded: number;
    customers: number;
    repeatCustomers: number;
  };
  backlog?: { count: number; value: number; oldestAt: string | null };
  series?: { date: string; revenue: number; orders: number }[];
  byPack?: { key: string; orders: number; revenue: number }[];
  byMethod?: { key: string; orders: number; revenue: number }[];
  error?: string;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PACK_LABEL: Record<string, string> = { "1-pack": "1 pack", "2-pack": "2 packs", "4-pack": "4 packs" };

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "warn" | "good"; hint?: string }) {
  const color = tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ops-text-muted">{hint}</div>}
    </div>
  );
}

/** Pure-CSS bars — no chart dependency for what is a sparkline. */
function RevenueBars({ series }: { series: { date: string; revenue: number }[] }) {
  const max = Math.max(...series.map((d) => d.revenue), 1);
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">Revenue by day</div>
      <div className="flex h-32 items-end gap-[3px]">
        {series.map((d) => (
          <div
            key={d.date}
            className="flex-1 rounded-sm bg-fitscript-green/70 hover:bg-fitscript-green transition-colors"
            style={{ height: `${Math.max(2, (d.revenue / max) * 100)}%` }}
            title={`${d.date} · ${usd(d.revenue)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ops-text-muted">
        <span>{series[0]?.date}</span>
        <span>peak {usd(max)}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { key: string; orders: number; revenue: number }[] }) {
  const total = rows.reduce((s, r) => s + r.revenue, 0) || 1;
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-ops-text-muted">{title}</div>
      <div className="space-y-2">
        {rows.length === 0 && <div className="text-sm text-ops-text-muted">No paid orders yet.</div>}
        {rows.map((r) => (
          <div key={r.key}>
            <div className="flex justify-between text-sm">
              <span className="text-ops-text">{PACK_LABEL[r.key] ?? r.key}</span>
              <span className="text-ops-text-muted">
                {usd(r.revenue)} · {r.orders}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-ops-border">
              <div className="h-1.5 rounded-full bg-fitscript-green/70" style={{ width: `${(r.revenue / total) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PawgenOverview() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery<Overview>({
    queryKey: ["pawgen-overview", days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/pawgen/overview?days=${days}`, { credentials: "include" });
      try {
        return await r.json();
      } catch {
        return { error: `Overview request failed (HTTP ${r.status})` };
      }
    },
  });

  const t = data?.totals;

  return (
    <div>
      <PageHero
        eyebrow="pawgen"
        title="Overview"
        subtitle="K9-REPAIR revenue, fulfilment backlog and product mix."
        actions={
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-ops-border bg-ops-surface px-3 py-1.5 text-sm text-ops-text"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />

      {data?.error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <div className="font-medium text-red-400">pawgen overview unavailable</div>
          <div className="text-sm text-red-400/80">{data.error}</div>
        </div>
      )}

      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}

      {t && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label={`Revenue (${data?.window?.days ?? days}d)`} value={usd(t.revenueWindow)} hint={`${t.ordersWindow} orders`} />
            <Stat label="Revenue (all time)" value={usd(t.revenueAllTime)} hint={`${t.ordersAllTime} paid orders`} />
            <Stat label="Average order" value={usd(t.aov)} />
            <Stat
              label="To fulfil"
              value={String(data?.backlog?.count ?? 0)}
              tone={(data?.backlog?.count ?? 0) > 0 ? "warn" : undefined}
              hint={data?.backlog?.count ? `${usd(data.backlog.value)} waiting to ship` : "all shipped"}
            />
          </div>

          {(data?.backlog?.count ?? 0) > 0 && data?.backlog?.oldestAt && (
            <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm">
              <span className="font-medium text-yellow-500">{data.backlog.count} paid orders are still unfulfilled</span>
              <span className="text-ops-text-muted">
                {" "}
                — oldest placed {new Date(data.backlog.oldestAt).toLocaleDateString()}. That's {usd(data.backlog.value)} of
                product customers have paid for and not received.
              </span>
            </div>
          )}

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">{data?.series && <RevenueBars series={data.series} />}</div>
            <div className="grid gap-4">
              <Stat label="Customers" value={String(t.customers)} hint={`${t.repeatCustomers} bought more than once`} />
              <Stat label="Pending payments" value={String(t.pendingPayments)} hint={t.refunded ? `${t.refunded} refunded` : undefined} />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown title="By pack" rows={data?.byPack ?? []} />
            <Breakdown title="By payment method" rows={data?.byMethod ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
