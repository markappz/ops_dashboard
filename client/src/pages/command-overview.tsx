import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Crown, Rocket, DollarSign, Scale, Lightbulb } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { StatCard, Sparkline } from "../components/stat";
import { DateRangePicker, rangeQuery, rangeKey, useDateRange } from "../components/date-range-picker";

/**
 * Global Command Center (2026-10-10, Paul): every brand's vitals on one page.
 * Numbers come from /api/ops/command/overview, which reuses each brand's own
 * tab feeds — so nothing here can disagree with a brand page. Expenses/net
 * render only for finance-grant holders (the server strips them otherwise).
 */

interface Brand {
  key: string; label: string; configured: boolean; error?: string; basis?: string;
  revenueKind?: "window" | "mrr";
  revenue: number; revenuePrev: number; growth: number | null; orders?: number;
  sessions?: number | null; sessionsPrev?: number | null;
  leads?: number | null; leadsPrev?: number | null;
  series?: number[]; expenses: number | null; net: number | null;
}
interface Overview {
  window: { from: string; to: string; days: number };
  brands: Brand[];
  totals: { revenue: number; revenuePrev: number; growth: number | null; mrr: number; expenses: number | null };
  best: { key: string; label: string; revenue: number } | null;
  fastestGrowth: { key: string; label: string; growth: number } | null;
  opportunities: Array<{ brand: string; kind: string; note: string }>;
  notes: string[];
}

const HUES: Record<string, string> = {
  fitscript: "46,91,255", peptideu: "139,92,246", pawgen: "16,185,129",
  realpeptides: "212,166,47", northblu: "34,211,238", reverra: "244,114,182",
};
const MONO: Record<string, string> = { fitscript: "FS", peptideu: "PU", pawgen: "PW", realpeptides: "RP", northblu: "NB", reverra: "RV" };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const delta = (g: number | null) => g == null ? null : (
  <span className={`ml-1.5 text-xs font-semibold ${g >= 0 ? "text-emerald-400" : "text-red-400"}`}>{g >= 0 ? "+" : ""}{g}%</span>
);
const n0 = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());
const rev = (b: Brand) => b.revenueKind === "mrr" ? <span>{usd(b.revenue)}<span className="text-xs text-ops-text-muted">/mo</span></span> : usd(b.revenue);

export default function CommandOverview() {
  const [range, setRange] = useDateRange("global-command");
  const q = useQuery<Overview>({
    queryKey: ["global-command", rangeKey(range)],
    queryFn: async () => {
      const r = await fetch(`/api/ops/command/overview?${rangeQuery(range)}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const d = q.data;
  const showMoney = d?.totals.expenses != null;
  const brands = (d?.brands ?? []).slice().sort((a, b) => b.revenue - a.revenue);
  const netTotal = showMoney ? d!.totals.revenue - (d!.totals.expenses ?? 0) : null;

  return (
    <div>
      <PageHero
        eyebrow="All brands"
        title="Command Center"
        subtitle="The whole portfolio on one page — revenue, growth, traffic and leads per brand, with tracked expenses folded in. Every tile reads the same feed as that brand's own tabs."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Pulling every brand's feed…</div>}

      {d && (
        <>
          <div className={`mb-6 grid grid-cols-2 gap-3 ${showMoney ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
            <StatCard i={0} label={`Portfolio revenue · ${range.label}`} icon={<DollarSign />} value={<span>{usd(d.totals.revenue)}{delta(d.totals.growth)}</span>} sub={d.totals.mrr > 0 ? `+ ${usd(d.totals.mrr)}/mo recurring (subscriptions)` : undefined} accent />
            <StatCard i={1} label="Best brand" icon={<Crown />} value={d.best?.label ?? "—"} sub={d.best ? usd(d.best.revenue) : undefined} tone="good" to={d.best ? `/${d.best.key}` : undefined} />
            <StatCard i={2} label="Fastest growth" icon={<Rocket />} value={d.fastestGrowth ? d.fastestGrowth.label : "—"}
              sub={d.fastestGrowth ? `+${d.fastestGrowth.growth}% vs prior ${d.window.days}d` : "needs ≥$500 prior-window revenue"} to={d.fastestGrowth ? `/${d.fastestGrowth.key}` : undefined} />
            {showMoney && <StatCard i={3} label={`Net after tracked expenses`} icon={<Scale />} value={usd(netTotal!)} sub={`${usd(d.totals.expenses!)} tracked spend`} tone={netTotal! >= 0 ? "good" : "bad"} />}
          </div>

          <div className="mb-4 hidden overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ops-border text-left text-[10.5px] uppercase tracking-[0.1em] text-ops-text-muted">
                  <th className="px-4 py-2.5">Brand</th>
                  <th className="px-4 py-2.5 text-right">Revenue · {range.label}</th>
                  <th className="px-4 py-2.5">Trend</th>
                  <th className="px-4 py-2.5 text-right">Sessions</th>
                  <th className="px-4 py-2.5 text-right">Leads</th>
                  {showMoney && <th className="px-4 py-2.5 text-right">Expenses</th>}
                  {showMoney && <th className="px-4 py-2.5 text-right">Net</th>}
                  <th className="px-4 py-2.5">Basis</th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.key} className="border-b border-ops-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/${b.key}`} className="flex items-center gap-2 font-medium text-ops-text hover:text-brand-blue-500">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md text-[9px] font-black" style={{ backgroundColor: `rgba(${HUES[b.key]},0.16)`, color: `rgb(${HUES[b.key]})` }}>{MONO[b.key]}</span>
                        {b.label}
                      </Link>
                    </td>
                    {b.configured ? (
                      <>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{rev(b)}{delta(b.growth)}</td>
                        <td className="px-4 py-3">{b.series && b.series.length > 1 ? <span style={{ color: `rgb(${HUES[b.key]})` }}><Sparkline points={b.series} /></span> : <span className="text-xs text-ops-text-muted">—</span>}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{n0(b.sessions)}{b.sessions != null && b.sessionsPrev != null && delta(b.sessionsPrev > 0 ? Math.round(((b.sessions - b.sessionsPrev) / b.sessionsPrev) * 1000) / 10 : null)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{n0(b.leads)}{b.leads != null && b.leadsPrev != null && delta(b.leadsPrev > 0 ? Math.round(((b.leads - b.leadsPrev) / b.leadsPrev) * 1000) / 10 : null)}</td>
                        {showMoney && <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{b.expenses ? usd(b.expenses) : "—"}</td>}
                        {showMoney && <td className={`px-4 py-3 text-right font-semibold tabular-nums ${(b.net ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{b.net != null ? usd(b.net) : "—"}</td>}
                        <td className="max-w-[220px] px-4 py-3 text-xs text-ops-text-muted">{b.basis}</td>
                      </>
                    ) : (
                      <td colSpan={showMoney ? 7 : 5} className="px-4 py-3 text-xs text-amber-500">Not connected — {b.error}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: stacked brand cards — the 8-column table is desktop-only. */}
          <div className="mb-4 space-y-2.5 md:hidden">
            {brands.map((b) => (
              <Link key={b.key} href={`/${b.key}`} className="block rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-black" style={{ backgroundColor: `rgba(${HUES[b.key]},0.16)`, color: `rgb(${HUES[b.key]})` }}>{MONO[b.key]}</span>
                  <span className="min-w-0 truncate font-semibold text-ops-text">{b.label}</span>
                  {b.configured
                    ? <span className="ml-auto shrink-0 tabular-nums text-ops-text">{rev(b)}{delta(b.growth)}</span>
                    : <span className="ml-auto shrink-0 text-xs text-amber-500">not connected</span>}
                </div>
                {b.configured && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ops-text-muted">
                    {b.series && b.series.length > 1 && <span style={{ color: `rgb(${HUES[b.key]})` }}><Sparkline points={b.series} className="h-[22px] w-[84px]" /></span>}
                    {b.sessions != null && <span>{n0(b.sessions)} sessions</span>}
                    {b.leads != null && <span>{n0(b.leads)} leads</span>}
                    {showMoney && b.net != null && <span className={b.net >= 0 ? "text-emerald-400" : "text-red-400"}>net {usd(b.net)}</span>}
                  </div>
                )}
              </Link>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
              <div className="mb-3 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted"><Lightbulb className="h-3.5 w-3.5" />Opportunities & flags · {range.label}</div>
              {!d.opportunities.length && <div className="py-4 text-sm text-ops-text-muted">Nothing flagged in this window — steady as she goes.</div>}
              <div className="space-y-2.5">
                {d.opportunities.map((o, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${o.kind === "momentum" ? "bg-emerald-400" : o.kind === "connect" ? "bg-ops-border" : "bg-amber-500"}`} />
                    <div className="min-w-0"><span className="font-medium text-ops-text">{o.brand}</span><span className="ml-2 text-ops-text-muted">{o.note}</span></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="self-start rounded-xl border border-ops-border bg-ops-surface p-5 text-xs text-ops-text-muted shadow-card">
              <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em]">How to read this</div>
              <ul className="list-disc space-y-1.5 pl-4">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
