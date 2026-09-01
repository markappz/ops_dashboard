import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Upload, RefreshCw, Bell, Plus, Search, X, Download, Layers, FlaskConical } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { api, ui, atLab, needsSend, type Sku, type Family } from "./coa/api";
import { groupFamilies } from "./coa/families";
import { StatusDonut } from "./coa/StatusDonut";
import { FamilyGrid } from "./coa/FamilyGrid";
import { FamilyDetail } from "./coa/FamilyDetail";
import { ActionSummary } from "./coa/ActionSummary";
import { AlertSettings } from "./coa/AlertSettings";
import { BulkUpload } from "./coa/BulkUpload";
import { LabOrder } from "./coa/LabOrder";
import { exportSummaryCsv } from "./coa/export";

/**
 * Real Peptides COA Tracker — the one place certificates are managed.
 *
 * The tracker service (coa.realpeptides.co) still owns the data — database,
 * S3 vault, Slack schedulers — and runs headless; its UI redirects here. Every
 * call goes through ops' token-gated proxy. The tracker's public feed
 * (/api/public/products) is what the storefront will read.
 */

export default function RealPeptidesCoa() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Family | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showLabOrder, setShowLabOrder] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const { data: me } = useQuery<{ role: string; permissions?: string[] }>({
    queryKey: ["ops-me"],
    queryFn: async () => (await fetch("/api/ops/auth/me", { credentials: "include" })).json(),
    staleTime: Infinity,
  });
  const canEdit = me?.role === "admin" || (me?.permissions ?? []).includes("realpeptides:coa-upload");

  const skus = useQuery({
    queryKey: ["coa-skus"],
    queryFn: () => api<{ skus: Sku[]; counts: Record<string, number> }>("/skus"),
    retry: false,
  });

  const families = useMemo(() => groupFamilies(skus.data?.skus ?? []), [skus.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of families) {
      c[f.status] = (c[f.status] || 0) + 1;
      if (f.variants.some(atLab)) c.atlab = (c.atlab || 0) + 1;
      if (f.variants.some(needsSend)) c.tosend = (c.tosend || 0) + 1;
    }
    return c;
  }, [families]);
  const shown = useMemo(() => {
    let list = families;
    if (filter === "atlab") list = families.filter((f) => f.variants.some(atLab));
    else if (filter === "tosend") list = families.filter((f) => f.variants.some(needsSend));
    else if (filter !== "all") list = families.filter((f) => f.status === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((f) => f.label.toLowerCase().includes(q) || f.variants.some((v) => v.product_name.toLowerCase().includes(q) || v.sku_code.toLowerCase().includes(q)));
    return list;
  }, [families, filter, query]);

  // Keep the open modal pointed at fresh data after an edit.
  const openFamily = open ? families.find((f) => f.key === open.key) ?? null : null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["coa-skus"] });
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 6000); };

  async function onCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ inserted: number; updated: number; skipped: number }>("/skus/import", { method: "POST", body: fd });
      say(`Imported: ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped.`);
      refresh();
    } catch (err: any) { say(`Import failed: ${err.message}`); }
    finally { if (csvRef.current) csvRef.current.value = ""; }
  }

  const err = skus.error as Error | null;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="COA Tracker"
        subtitle={`90-day retest automation · ${families.length} products. Certificates, product pages and lab send-outs live here; Slack alerts run on their own.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input ref={csvRef} type="file" accept=".csv" hidden onChange={onCsv} />
            <button type="button" onClick={() => setShowSummary(true)} className={ui.ghost}><ClipboardList size={15} /> Action Summary</button>
            <button type="button" onClick={() => exportSummaryCsv(skus.data?.skus ?? [])} disabled={!skus.data?.skus?.length} className={ui.ghost} title="Download every SKU's status as a spreadsheet"><Download size={15} /> Export</button>
            {canEdit && <button type="button" onClick={() => csvRef.current?.click()} className={ui.ghost}><Upload size={15} /> Import CSV</button>}
            <button type="button" onClick={() => setShowAlerts(true)} className={ui.ghost} title="Alerts"><Bell size={15} /></button>
            <button type="button" onClick={refresh} className={ui.ghost} title="Refresh"><RefreshCw size={15} /></button>
            {canEdit && <button type="button" onClick={() => setShowLabOrder(true)} className={ui.ghost}><FlaskConical size={15} /> Send to lab</button>}
            {canEdit && <button type="button" onClick={() => setShowBulk(true)} className={ui.ghost}><Layers size={15} /> Bulk upload</button>}
            {canEdit && <button type="button" onClick={() => setShowAdd(true)} className={ui.primary}><Plus size={15} /> Add product</button>}
          </div>
        }
      />

      {flash && <div className="mb-5 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}
      {err && (
        <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Couldn't reach the COA tracker: {err.message}
        </div>
      )}

      <div className="space-y-5">
        <StatusDonut counts={counts} total={families.length} active={filter} onPick={setFilter} />

        <div className="relative max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search peptides, SKUs…" className={`${ui.input} pl-9`} />
        </div>

        {skus.isLoading ? <div className="py-16 text-center text-sm text-ops-text-muted">Loading products…</div> : <FamilyGrid families={shown} onOpen={setOpen} />}
      </div>

      {openFamily && <FamilyDetail family={openFamily} onClose={() => setOpen(null)} onChanged={refresh} />}
      {showSummary && <ActionSummary families={families} onClose={() => setShowSummary(false)} />}
      {showAlerts && <AlertSettings onClose={() => setShowAlerts(false)} />}
      {showBulk && <BulkUpload skus={skus.data?.skus ?? []} onClose={() => setShowBulk(false)} onDone={(m) => { setShowBulk(false); say(m); refresh(); }} />}
      {showLabOrder && <LabOrder skus={skus.data?.skus ?? []} onClose={() => setShowLabOrder(false)} onSay={say} onChanged={refresh} />}
      {showAdd && <AddProduct onClose={() => setShowAdd(false)} onDone={(m) => { setShowAdd(false); say(m); refresh(); }} />}
    </div>
  );
}

function AddProduct({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/skus", { method: "POST", body: JSON.stringify({ product_name: name.trim(), sku_code: code.trim(), product_url: url.trim() || null }) });
      onDone(`Added ${name.trim()} (${code.trim()}). It shows as "Needs COA" until a certificate is filed.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className={ui.modal} onClick={onClose}>
      <form onSubmit={submit} className={`${ui.sheet} max-w-lg`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <h2 className="text-base font-semibold text-ops-text">Add a product</h2>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-4 p-5">
          <div><label className={ui.label}>Product name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={ui.input} placeholder="BPC-157 - 10mg (Injectable)" required /></div>
          <div><label className={ui.label}>SKU code</label><input value={code} onChange={(e) => setCode(e.target.value)} className={ui.input} placeholder="RP-BPC10V" required /></div>
          <div><label className={ui.label}>Product page URL (optional)</label><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={ui.input} placeholder="https://realpeptides.co/product/bpc-157-10mg" /></div>
          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={ui.ghost}>Cancel</button>
            <button type="submit" disabled={busy || !name.trim() || !code.trim()} className={ui.primary}>{busy ? "Adding…" : "Add product"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
