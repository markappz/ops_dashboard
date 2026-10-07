import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Lock } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { StatCard } from "../../components/stat";
import { DateRangePicker, useDateRange } from "../../components/date-range-picker";
import { AddEntry, EntriesTable, QuickAdd } from "./brand-financials";
import { DollarSign, Repeat, TrendingUp, Scale } from "lucide-react";

/**
 * MASTER financials — cross-brand roll-up, finance:master only (Paul +
 * Michael; being role=admin is deliberately not enough — enforced
 * server-side on every route, this page just mirrors the refusal).
 */

interface Summary { from: string; to: string; brands: Record<string, { expenses: number; revenue: number; retainers: number; byCategory: Record<string, number> }>; note: string }
interface Entry { id: number; brand: string; kind: string; category: string; vendor: string | null; description: string | null; amount_cents: number; entry_date: string; recurring: string; ended_at: string | null; source: string; created_by: string }

const BRAND_LABEL: Record<string, string> = {
  fitscript: "FitScript", peptideu: "PeptideU", pawgen: "pawgen", realpeptides: "Real Peptides",
  northblu: "North Blu", reverra: "Reverra", clomark: "Clomark", shared: "Shared / company-wide",
};
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const d10 = (d: Date) => d.toISOString().slice(0, 10);

async function api<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
  return r.json();
}

export default function MasterFinancials() {
  const qc = useQueryClient();
  const [range, setRange] = useDateRange("master-financials");
  const from = d10(range.from), to = d10(range.to);

  const access = useQuery<{ level: string }>({ queryKey: ["fin-access"], queryFn: () => api("/api/ops/finance/access") });
  const master = access.data?.level === "master";
  const summary = useQuery<Summary>({
    queryKey: ["fin-summary", "all", from, to], enabled: master,
    queryFn: () => api(`/api/ops/finance/summary?brand=all&from=${from}&to=${to}`),
  });
  const entries = useQuery<{ entries: Entry[] }>({
    queryKey: ["fin-entries", "all", from, to], enabled: master,
    queryFn: () => api(`/api/ops/finance/entries?brand=all&from=${from}&to=${to}`),
  });

  if (access.data && !master) {
    return (
      <div>
        <PageHero eyebrow="Admin" title="Master Financials" />
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-ops-border bg-ops-surface p-12 text-center shadow-card">
          <Lock className="h-6 w-6 text-ops-text-muted" />
          <div className="text-sm text-ops-text-muted">This view is restricted to the <b>finance:master</b> grant — Paul & Michael only.</div>
        </div>
      </div>
    );
  }

  const brands = Object.entries(summary.data?.brands ?? {}).sort((a, b) => (b[1].revenue + b[1].retainers - b[1].expenses) - (a[1].revenue + a[1].retainers - a[1].expenses));
  const tot = brands.reduce((a, [, v]) => ({ expenses: a.expenses + v.expenses, revenue: a.revenue + v.revenue, retainers: a.retainers + v.retainers }), { expenses: 0, revenue: 0, retainers: 0 });
  const net = tot.revenue + tot.retainers - tot.expenses;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["fin-summary"] }); qc.invalidateQueries({ queryKey: ["fin-entries"] }); };

  return (
    <div>
      <PageHero
        eyebrow="Admin · Paul & Michael"
        title="Master Financials"
        subtitle="Every brand's tracked money in one place — expenses, retainers, manual revenue and the bottom line. Live storefront sales stay on each brand's tabs until the auto-join pass; Dirt files entries here too."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      <QuickAdd company="shared" onDone={refresh} />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard i={0} label={`Total expenses · ${range.label}`} icon={<DollarSign />} value={usd(tot.expenses)} tone="warn" />
        <StatCard i={1} label="Retainers (monthly, in window)" icon={<Repeat />} value={usd(tot.retainers)} />
        <StatCard i={2} label={`Tracked revenue · ${range.label}`} icon={<TrendingUp />} value={usd(tot.revenue)} />
        <StatCard i={3} label={`Bottom line · ${range.label}`} icon={<Scale />} value={usd(net)} tone={net >= 0 ? "good" : "bad"} accent />
      </div>

      <div className="mb-4 overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ops-border text-left text-[10.5px] uppercase tracking-[0.1em] text-ops-text-muted">
              <th className="px-4 py-2.5">Brand</th>
              <th className="px-4 py-2.5 text-right">Expenses</th>
              <th className="px-4 py-2.5 text-right">Retainers</th>
              <th className="px-4 py-2.5 text-right">Revenue (tracked)</th>
              <th className="px-4 py-2.5 text-right">Net</th>
              <th className="px-4 py-2.5">Top cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-ops-text-muted">Loading…</td></tr>}
            {!summary.isLoading && !brands.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-ops-text-muted">Nothing tracked yet — add below, on any brand's Financials tab, or tell Dirt.</td></tr>}
            {brands.map(([slug, v]) => {
              const bn = v.revenue + v.retainers - v.expenses;
              const topCat = Object.entries(v.byCategory).sort((a, b) => b[1] - a[1])[0];
              return (
                <tr key={slug} className="border-b border-ops-border/60 last:border-0">
                  <td className="px-4 py-2.5">
                    {slug === "shared" || slug === "clomark"
                      ? <span className="font-medium text-ops-text">{BRAND_LABEL[slug] ?? slug}</span>
                      : <Link href={`/${slug}/financials`} className="font-medium text-brand-blue-500 hover:underline">{BRAND_LABEL[slug] ?? slug}</Link>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ops-text">{usd(v.expenses)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ops-text">{usd(v.retainers)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ops-text">{usd(v.revenue)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${bn >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(bn)}</td>
                  <td className="px-4 py-2.5 text-xs text-ops-text-muted">{topCat ? `${topCat[0].replace("_", " ")} · ${usd(topCat[1])}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-4">
        <AddEntry company="shared" allowBrandPick onDone={refresh} />
        <EntriesTable entries={entries.data?.entries ?? []} loading={entries.isLoading} me={null} master showBrand onChanged={refresh} />
      </div>
    </div>
  );
}
