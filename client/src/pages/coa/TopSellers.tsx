import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { thumbUrl, type Sku } from "./api";

/**
 * Top sellers — live units-sold ranking over a selectable trailing window.
 * One continuous sales timeline behind it: Woo history up to the Aug 24
 * relaunch, the new site's orders from then on (archived every 10 minutes),
 * so the year view is as honest as the day view.
 */

const RANGES = [
  { days: 1, label: "24h" },
  { days: 7, label: "Week" },
  { days: 30, label: "Month" },
  { days: 180, label: "6 mo" },
  { days: 365, label: "Year" },
] as const;

interface Stats { bySku?: Record<string, { units: Record<number, number>; weekly: number }>; error?: string }

export function TopSellers({ skus }: { skus: Sku[] }) {
  const [days, setDays] = useState<number>(30);
  const [count, setCount] = useState(20);

  const q = useQuery({
    queryKey: ["rp-top-sellers", days],
    queryFn: async () =>
      (await fetch(`/api/ops/realpeptides/inventory-stats?windows=${days}`, { credentials: "include" })).json() as Promise<Stats>,
    staleTime: 5 * 60_000,
  });

  const bySkuCode = useMemo(() => new Map(skus.map((s) => [s.sku_code, s])), [skus]);
  const rows = useMemo(() => {
    const data = q.data?.bySku ?? {};
    return Object.entries(data)
      .map(([code, v]) => ({ code, units: v.units[days] ?? 0, sku: bySkuCode.get(code) }))
      .filter((r) => r.units > 0)
      .sort((a, b) => b.units - a.units)
      .slice(0, count);
  }, [q.data, days, count, bySkuCode]);
  const max = rows[0]?.units ?? 1;

  return (
    <div className="mt-6 rounded-2xl border border-ops-border bg-ops-surface p-4 shadow-card sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ops-text"><TrendingUp size={15} /> Top sellers</h3>
          <p className="text-[11px] text-ops-text-muted">Units sold — Woo history + live site orders, one timeline.</p>
        </div>
        <div className="inline-flex rounded-lg border border-ops-border bg-ops-bg p-0.5">
          {RANGES.map((r) => (
            <button key={r.days} type="button" onClick={() => setDays(r.days)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                days === r.days ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"
              }`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <div className="py-10 text-center text-sm text-ops-text-muted">Crunching sales…</div>
      ) : q.data?.error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{q.data.error}</div>
      ) : !rows.length ? (
        <div className="py-10 text-center text-sm text-ops-text-muted">No sales recorded in this window yet.</div>
      ) : (
        <>
          <ol className="space-y-1.5">
            {rows.map((r, i) => {
              const img = r.sku ? thumbUrl(r.sku) : null;
              return (
                <li key={r.code} className="flex items-center gap-2.5">
                  <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-ops-text-muted">{i + 1}</span>
                  <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md border border-ops-border bg-ops-bg">
                    {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs text-ops-text">{r.sku?.product_name ?? r.code}</span>
                      <span className="shrink-0 text-xs font-bold tabular-nums text-ops-text">{r.units.toLocaleString()}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-ops-bg">
                      <div className="h-full rounded-full bg-gradient-to-r from-fitscript-green/70 to-fitscript-green"
                        style={{ width: `${Math.max(2, (r.units / max) * 100)}%` }} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {count === 20 && (
            <button type="button" onClick={() => setCount(50)}
              className="mt-3 w-full rounded-lg py-1.5 text-xs text-ops-text-muted transition hover:bg-ops-bg hover:text-ops-text">
              Show top 50
            </button>
          )}
        </>
      )}
    </div>
  );
}
