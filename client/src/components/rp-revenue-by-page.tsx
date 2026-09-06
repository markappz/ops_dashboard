import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

type Row = { page: string; utmSource: string | null; orders: number; revenueCents: number };
type Payload = { configured: boolean; error?: string; hint?: string; days: number; totalOrders: number; attributedOrders: number; totalRevenueCents?: number; attributedRevenueCents?: number; pages: Row[] };

const money = (c?: number) => `$${Math.round((c ?? 0) / 100).toLocaleString()}`;
const num = (n?: number) => (n ?? 0).toLocaleString();

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-2 text-xs uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className="text-2xl font-bold text-ops-text">{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

/** Revenue by the content page that started each buyer's first visit (first-touch, cookie-based). */
export function RpRevenueByPage() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["rp-attribution", days],
    queryFn: async () => (await fetch(`/api/ops/rp/attribution?days=${days}`, { credentials: "include" })).json(),
  });
  const coverage = data && data.totalOrders > 0 ? Math.round((data.attributedOrders / data.totalOrders) * 100) : null;
  const pages = (data?.pages ?? []).slice().sort((a, b) => b.revenueCents - a.revenueCents);
  const attributedRevenue = data?.attributedRevenueCents ?? pages.reduce((s, p) => s + p.revenueCents, 0);
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ops-text">Revenue by content page</h2>
          <p className="text-xs text-ops-text-muted">First touch: the page that started the buyer&apos;s first visit, remembered by cookie and stamped on the order at checkout.</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-ops-border bg-ops-surface p-0.5 text-xs">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded-md px-2.5 py-1 ${days === d ? "bg-ops-bg text-ops-text" : "text-ops-text-muted hover:text-ops-text"}`}>{d}d</button>
          ))}
        </div>
      </div>
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && <div className="mb-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">{data.error}</div>}
      {data?.configured === false && <div className="mb-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">{data.hint}</div>}
      {data && !data.error && data.configured !== false && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Attributed revenue" value={money(attributedRevenue)} sub={`${num(data.attributedOrders)} orders traced to a page`} />
            <Tile label="Orders in window" value={num(data.totalOrders)} sub={data.totalRevenueCents !== undefined ? `${money(data.totalRevenueCents)} total` : undefined} />
            <Tile label="Coverage" value={coverage === null ? "—" : `${coverage}%`} sub="orders with a first-touch record" />
            <Tile label="Pages with sales" value={num(pages.length)} />
          </div>
          {coverage !== null && coverage < 90 && (
            <div className="mb-3 rounded-xl border border-ops-border bg-ops-surface p-3 text-xs text-ops-text-muted">
              Coverage climbs toward 100% over the next 2 to 4 weeks: orders placed before the tracking deploy carry no first-touch record, and returning buyers only get one on their next visit.
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">{["Landing page", "Source", "Orders", "Revenue"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {pages.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-ops-text-muted">No attributed orders in this window yet.</td></tr>}
                {pages.slice(0, 25).map((p) => (
                  <tr key={`${p.page}|${p.utmSource}`} className="border-b border-ops-border/50 last:border-0">
                    <td className="px-4 py-2 text-ops-text"><a href={`https://www.realpeptides.co${p.page}`} target="_blank" rel="noreferrer" className="hover:underline">{p.page}</a></td>
                    <td className="px-4 py-2 text-ops-text-muted">{p.utmSource ?? "direct / organic"}</td>
                    <td className="px-4 py-2 text-ops-text-muted">{num(p.orders)}</td>
                    <td className="px-4 py-2 text-ops-text">{money(p.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
