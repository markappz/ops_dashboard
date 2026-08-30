import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ChevronDown, ChevronRight, Mail, Phone, Building2, Loader2 } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { ui } from "./coa/api";

/**
 * Real Peptides wholesale inquiries — the queue that used to be Paul's inbox.
 * Every request from the site's wholesale tab, with the buyer's order,
 * contact details, and a workable status (NEW → CONTACTED → APPROVED/DECLINED).
 */

interface Item { sku?: string; product?: string; strength?: string; category?: string; boxes?: number; vials?: number; tier?: string; unitPriceCents?: number; lineTotalCents?: number }
interface Inquiry {
  id: string; ref: string; status: string;
  businessName: string; businessType: string;
  contactName: string; contactEmail: string; contactPhone: string;
  state: string | null; labelPref: string; timeline: string;
  repName: string | null; notes: string | null;
  totalSkus: number; totalVials: number; subtotalCents: number | null;
  items: Item[] | null; createdAt: string;
}
interface Payload { configured: boolean; hint?: string; inquiries: Inquiry[] }

const STATUS: Record<string, { label: string; cls: string; next?: { to: string; label: string }[] }> = {
  NEW: { label: "New", cls: "bg-fitscript-green/15 text-fitscript-green", next: [{ to: "CONTACTED", label: "Mark contacted" }, { to: "DECLINED", label: "Decline" }] },
  CONTACTED: { label: "Contacted", cls: "bg-amber-500/15 text-amber-500", next: [{ to: "APPROVED", label: "Approve" }, { to: "DECLINED", label: "Decline" }] },
  APPROVED: { label: "Approved", cls: "bg-sky-500/15 text-sky-400" },
  DECLINED: { label: "Declined", cls: "bg-ops-border text-ops-text-muted" },
};
const ORDER = ["NEW", "CONTACTED", "APPROVED", "DECLINED"];
const money = (c: number | null | undefined) => (c == null ? "—" : "$" + (c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }));

export default function RealPeptidesWholesale() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState(90);

  const q = useQuery({
    queryKey: ["rp-wholesale", range],
    queryFn: async () => {
      const r = await fetch(`/api/ops/realpeptides/wholesale?range=${range}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json() as Promise<Payload>;
    },
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const r = await fetch(`/api/ops/realpeptides/wholesale/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rp-wholesale"] }),
  });

  const inquiries = q.data?.inquiries ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: inquiries.length };
    for (const i of inquiries) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [inquiries]);
  const shown = useMemo(() => {
    let list = filter === "all" ? inquiries : inquiries.filter((i) => i.status === filter);
    const s = query.trim().toLowerCase();
    if (s) list = list.filter((i) =>
      [i.ref, i.businessName, i.contactName, i.contactEmail, i.contactPhone].some((v) => v?.toLowerCase().includes(s)));
    return list;
  }, [inquiries, filter, query]);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Wholesale"
        subtitle={`${counts.all ?? 0} inquiries in the last ${range} days — the queue that used to be an inbox. Work them right here.`}
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[30, 90, 365].map((n) => (
              <button key={n} type="button" onClick={() => setRange(n)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${range === n ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>{n}d</button>
            ))}
          </div>
        }
      />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading inquiries…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {q.data && !q.data.configured && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-8 text-center shadow-card">
          <div className="mx-auto max-w-md text-sm text-ops-text-muted">{q.data.hint}</div>
        </div>
      )}

      {q.data?.configured && (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            <Chip label="All" count={counts.all ?? 0} active={filter === "all"} onClick={() => setFilter("all")} />
            {ORDER.map((s) => (
              <Chip key={s} label={STATUS[s].label} count={counts[s] ?? 0} active={filter === s} onClick={() => setFilter(s)} />
            ))}
          </div>

          <div className="relative mb-4 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ref, business, contact…" className={`${ui.input} pl-9`} />
          </div>

          <div className="space-y-2">
            {shown.map((i) => (
              <InquiryCard key={i.id} i={i} busy={setStatus.isPending}
                onStatus={(status) => setStatus.mutate({ id: i.id, status })} />
            ))}
            {!shown.length && <div className="rounded-2xl border border-ops-border bg-ops-surface py-14 text-center text-sm text-ops-text-muted shadow-card">No inquiries match.</div>}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition ${active ? "border-fitscript-green bg-fitscript-green/10 text-ops-text" : "border-ops-border bg-ops-surface text-ops-text-muted hover:text-ops-text"}`}>
      <span className="font-semibold tabular-nums">{count}</span> {label}
    </button>
  );
}

function InquiryCard({ i, busy, onStatus }: { i: Inquiry; busy: boolean; onStatus: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[i.status] ?? STATUS.NEW;
  const items: Item[] = Array.isArray(i.items) ? i.items : [];
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface shadow-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 p-4 text-left">
        {open ? <ChevronDown size={15} className="shrink-0 text-ops-text-muted" /> : <ChevronRight size={15} className="shrink-0 text-ops-text-muted" />}
        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-2">
            <Building2 size={14} className="shrink-0 text-ops-text-muted" />
            <span className="truncate font-semibold text-ops-text">{i.businessName}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${st.cls}`}>{st.label}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ops-text-muted">
            {i.ref} · {i.businessType}{i.state ? ` · ${i.state}` : ""} · {new Date(i.createdAt).toLocaleDateString()}{i.repName ? ` · rep: ${i.repName}` : ""}
          </div>
        </div>
        <div className="min-w-[200px]">
          <div className="text-sm text-ops-text">{i.contactName}</div>
          <div className="flex flex-wrap gap-x-3 text-[11px]">
            <a href={`mailto:${i.contactEmail}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-fitscript-green hover:underline"><Mail size={10} /> {i.contactEmail}</a>
            <a href={`tel:${i.contactPhone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-fitscript-green hover:underline"><Phone size={10} /> {i.contactPhone}</a>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold tabular-nums text-ops-text">{money(i.subtotalCents)}</div>
          <div className="text-[11px] text-ops-text-muted">{i.totalSkus} SKUs · {i.totalVials} vials</div>
        </div>
      </button>

      {open && (
        <div className="border-t border-ops-border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-ops-text-muted">
              Label preference: <span className="text-ops-text">{i.labelPref}</span> · Timeline: <span className="text-ops-text">{i.timeline}</span>
              {i.notes && <span className="mt-1 block">Notes: <span className="text-ops-text">{i.notes}</span></span>}
            </div>
            <div className="flex gap-2">
              {(st.next ?? []).map((n) => (
                <button key={n.to} type="button" disabled={busy} onClick={() => onStatus(n.to)}
                  className={n.to === "DECLINED" ? `${ui.ghost} px-3 py-1.5 text-xs hover:text-red-400` : `${ui.primary} px-3 py-1.5 text-xs`}>
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null} {n.label}
                </button>
              ))}
            </div>
          </div>
          {items.length ? (
            <div className="overflow-x-auto rounded-xl border border-ops-border">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-ops-border bg-ops-bg/40 text-[10px] uppercase tracking-wider text-ops-text-muted">
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-left font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">Boxes</th>
                    <th className="px-3 py-2 text-right font-medium">Vials</th>
                    <th className="px-3 py-2 text-right font-medium">Unit</th>
                    <th className="px-3 py-2 text-right font-medium">Line</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ops-border/50">
                  {items.map((it, n) => (
                    <tr key={n}>
                      <td className="px-3 py-2 text-ops-text">{it.product ?? "—"}{it.strength ? ` · ${it.strength}` : ""}</td>
                      <td className="px-3 py-2 text-ops-text-muted">{it.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{it.boxes ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ops-text">{it.vials ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{money(it.unitPriceCents)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-ops-text">{money(it.lineTotalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs text-ops-text-muted">No line items on this inquiry.</div>
          )}
        </div>
      )}
    </div>
  );
}
