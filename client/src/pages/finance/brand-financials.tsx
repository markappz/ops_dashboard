import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, Repeat, TrendingUp, Scale, Trash2 } from "lucide-react";
import { PageHero } from "../../components/page-hero";
import { StatCard } from "../../components/stat";
import { DateRangePicker, useDateRange } from "../../components/date-range-picker";

/**
 * Per-brand Financials (2026-10-07, Paul + Michael). Tracked entries only in
 * v1: expenses, monthly retainers and manual revenue — the brand's live sales
 * feed stays authoritative on its own tabs until the auto-join pass. Access
 * is grant-based (finance:entry / finance:master); the server enforces it,
 * this page just renders the refusal nicely.
 */

export const FIN_CATEGORIES = ["ai_credits", "ads", "software", "contractors", "payroll", "inventory", "shipping", "legal", "fees", "retainer", "sales", "other"] as const;
const CAT_LABEL: Record<string, string> = {
  ai_credits: "AI credits", ads: "Ads", software: "Software", contractors: "Contractors",
  payroll: "Payroll", inventory: "Inventory", shipping: "Shipping", legal: "Legal",
  fees: "Fees", retainer: "Retainer", sales: "Sales", other: "Other",
};

interface Entry {
  id: number; brand: string; kind: string; category: string; vendor: string | null;
  description: string | null; amount_cents: number; entry_date: string; recurring: string;
  ended_at: string | null; source: string; created_by: string;
}
interface Summary { from: string; to: string; brands: Record<string, { expenses: number; revenue: number; retainers: number; byCategory: Record<string, number> }>; note: string }

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...(init?.body ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || r.statusText);
  return r.json();
}

const d10 = (d: Date) => d.toISOString().slice(0, 10);

export default function BrandFinancials({ company, label }: { company: string; label: string }) {
  const qc = useQueryClient();
  const [range, setRange] = useDateRange(`${company}-financials`);
  const from = d10(range.from), to = d10(range.to);

  const access = useQuery<{ level: string }>({ queryKey: ["fin-access"], queryFn: () => api("/api/ops/finance/access") });
  const enabled = access.data != null && access.data.level !== "none";
  const summary = useQuery<Summary>({
    queryKey: ["fin-summary", company, from, to], enabled,
    queryFn: () => api(`/api/ops/finance/summary?brand=${company}&from=${from}&to=${to}`),
  });
  const entries = useQuery<{ entries: Entry[] }>({
    queryKey: ["fin-entries", company, from, to], enabled,
    queryFn: () => api(`/api/ops/finance/entries?brand=${company}&from=${from}&to=${to}`),
  });

  const b = summary.data?.brands?.[company];
  const net = (b?.revenue ?? 0) + (b?.retainers ?? 0) - (b?.expenses ?? 0);
  const cats = useMemo(() => Object.entries(b?.byCategory ?? {}).sort((x, y) => y[1] - x[1]), [b]);
  const maxCat = cats[0]?.[1] || 1;

  if (access.data?.level === "none") {
    return (
      <div>
        <PageHero eyebrow={label} title="Financials" subtitle="Grant-gated." />
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-10 text-center text-sm text-ops-text-muted shadow-card">
          Finance access is grant-based — ask Paul for <b>finance:entry</b> in Settings → Team.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHero
        eyebrow={label}
        title="Financials"
        subtitle="Tracked expenses, retainers and manual revenue. Live storefront sales stay on the sales tabs — the auto-join lands next pass. You can also just tell Dirt: “add a $500 Replicate bill to this brand”."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard i={0} label={`Expenses · ${range.label}`} icon={<DollarSign />} value={usd(b?.expenses ?? 0)} tone={b?.expenses ? "warn" : undefined} />
        <StatCard i={1} label="Retainers (counted monthly)" icon={<Repeat />} value={usd(b?.retainers ?? 0)} sub="within this window" />
        <StatCard i={2} label={`Tracked revenue · ${range.label}`} icon={<TrendingUp />} value={usd(b?.revenue ?? 0)} sub="manual entries only" />
        <StatCard i={3} label={`Bottom line · ${range.label}`} icon={<Scale />} value={usd(net)} tone={net >= 0 ? "good" : "bad"} accent />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <AddEntry company={company} onDone={() => { qc.invalidateQueries({ queryKey: ["fin-summary"] }); qc.invalidateQueries({ queryKey: ["fin-entries"] }); }} />
          <EntriesTable entries={entries.data?.entries ?? []} loading={entries.isLoading} me={null} master={access.data?.level === "master"}
            onChanged={() => { qc.invalidateQueries({ queryKey: ["fin-summary"] }); qc.invalidateQueries({ queryKey: ["fin-entries"] }); }} />
        </div>
        <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card self-start">
          <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Spend by category · {range.label}</div>
          {!cats.length && <div className="py-6 text-center text-sm text-ops-text-muted">{summary.isLoading ? "Loading…" : "No expenses in this window yet."}</div>}
          <div className="space-y-2">
            {cats.map(([cat, amt]) => (
              <div key={cat} className="flex items-center gap-3">
                <div className="w-24 truncate text-sm text-ops-text">{CAT_LABEL[cat] ?? cat}</div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ops-border">
                  <div className="h-full rounded-full bg-brand-blue-500/70" style={{ width: `${(amt / maxCat) * 100}%` }} />
                </div>
                <div className="w-20 text-right text-sm tabular-nums text-ops-text-muted">{usd(amt)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AddEntry({ company, onDone, allowBrandPick }: { company: string; onDone: () => void; allowBrandPick?: boolean }) {
  const [brand, setBrand] = useState(company);
  const [kind, setKind] = useState("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("other");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(d10(new Date()));
  const [recurring, setRecurring] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api("/api/ops/finance/entries", {
      method: "POST",
      body: JSON.stringify({ brand, kind, amount: Number(amount), category, vendor, description, date, recurring: recurring || kind === "retainer" ? "monthly" : "none" }),
    }),
    onSuccess: () => { setErr(null); setAmount(""); setVendor(""); setDescription(""); onDone(); },
    onError: (e: Error) => setErr(e.message),
  });

  const input = "rounded-lg border border-ops-border bg-ops-bg px-2.5 py-1.5 text-sm text-ops-text focus:border-brand-blue-500 focus:outline-none";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="mb-2.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Add entry</div>
      {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">{err}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {allowBrandPick && (
          <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand" className={input}>
            {["fitscript", "peptideu", "pawgen", "realpeptides", "northblu", "clomark", "shared"].map((x) => <option key={x}>{x}</option>)}
          </select>
        )}
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className={input}>
          <option value="expense">Expense</option><option value="retainer">Retainer</option><option value="revenue">Revenue</option>
        </select>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$ amount" inputMode="decimal" aria-label="Amount" className={`${input} w-24`} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className={input}>
          {FIN_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
        </select>
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor / client" aria-label="Vendor" className={`${input} w-36`} />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Note" aria-label="Note" className={`${input} min-w-0 flex-1`} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" className={input} />
        <label className="flex items-center gap-1.5 text-xs text-ops-text-muted">
          <input type="checkbox" checked={recurring || kind === "retainer"} disabled={kind === "retainer"} onChange={(e) => setRecurring(e.target.checked)} /> monthly
        </label>
        <button type="button" disabled={add.isPending || !Number(amount)} onClick={() => add.mutate()}
          className="rounded-lg bg-fitscript-green px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add</button>
      </div>
    </div>
  );
}

export function EntriesTable({ entries, loading, master, onChanged, showBrand }: {
  entries: Entry[]; loading: boolean; me: string | null; master: boolean; onChanged: () => void; showBrand?: boolean;
}) {
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/ops/finance/entries/${id}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });
  return (
    <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ops-border text-left text-[10.5px] uppercase tracking-[0.1em] text-ops-text-muted">
            <th className="px-4 py-2.5">Date</th>
            {showBrand && <th className="px-4 py-2.5">Brand</th>}
            <th className="px-4 py-2.5">Kind</th>
            <th className="px-4 py-2.5">Category</th>
            <th className="px-4 py-2.5">Vendor</th>
            <th className="px-4 py-2.5">Note</th>
            <th className="px-4 py-2.5 text-right">Amount</th>
            <th className="px-4 py-2.5">By</th>
            {master && <th className="px-2 py-2.5" />}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={9} className="px-4 py-8 text-center text-ops-text-muted">Loading…</td></tr>}
          {!loading && !entries.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-ops-text-muted">No entries in this window — add one above or tell Dirt.</td></tr>}
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-ops-border/60 last:border-0">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-ops-text-muted">{e.entry_date}{e.recurring === "monthly" && <span className="ml-1 rounded bg-ops-accent-soft px-1 text-[10px] text-ops-text-subtle">/mo</span>}</td>
              {showBrand && <td className="px-4 py-2 text-ops-text-muted">{e.brand}</td>}
              <td className="px-4 py-2 text-ops-text">{e.kind}</td>
              <td className="px-4 py-2 text-ops-text-muted">{CAT_LABEL[e.category] ?? e.category}</td>
              <td className="max-w-[140px] truncate px-4 py-2 text-ops-text">{e.vendor ?? "—"}</td>
              <td className="max-w-[220px] truncate px-4 py-2 text-ops-text-muted" title={e.description ?? ""}>{e.description ?? "—"}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${e.kind === "expense" ? "text-ops-text" : "text-emerald-400"}`}>{usd(e.amount_cents / 100)}</td>
              <td className="max-w-[120px] truncate px-4 py-2 text-xs text-ops-text-muted">{e.created_by}{e.source === "dirt" ? " · via Dirt" : ""}</td>
              {master && (
                <td className="px-2 py-2">
                  <button type="button" onClick={() => del.mutate(e.id)} aria-label="Delete entry" className="rounded p-1 text-ops-text-muted hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
