import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Upload, RefreshCw, Bell, Plus, Search, X, Download, Layers, FlaskConical } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { api, ui, atLab, needsSend, type Sku, type Family } from "./coa/api";
import { groupFamilies, familyCounts } from "./coa/families";
import { AddProduct } from "./coa/AddProduct";
import { RequestChangeButton } from "../components/change-request";
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
  const counts = useMemo(() => familyCounts(families), [families]);
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
            <RequestChangeButton area="coa" company="realpeptides" className={ui.ghost} />
            <button type="button" onClick={() => setShowSummary(true)} className={ui.ghost}><ClipboardList size={15} /> Action Summary</button>
            <button type="button" onClick={() => exportSummaryCsv(skus.data?.skus ?? [])} disabled={!skus.data?.skus?.length} className={ui.ghost} title="Download every SKU's status as a spreadsheet"><Download size={15} /> Export</button>
            {canEdit && <button type="button" onClick={() => csvRef.current?.click()} className={ui.ghost}><Upload size={15} /> Import CSV</button>}
            <button type="button" onClick={() => setShowAlerts(true)} className={ui.ghost} title="Alerts"><Bell size={15} /></button>
            <button type="button" onClick={refresh} className={ui.ghost} title="Refresh"><RefreshCw size={15} /></button>
            {canEdit && <button type="button" onClick={() => setShowLabOrder(true)} className={ui.ghost}><FlaskConical size={15} /> Send to lab</button>}
            {canEdit && <button type="button" onClick={() => setShowBulk(true)} className={ui.ghost}><Layers size={15} /> Bulk upload</button>}
            {canEdit && <button type="button" onClick={() => setShowAdd(true)} className={ui.primary}><Plus size={15} /> Add SKU</button>}
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
      {showAdd && <AddProduct skus={skus.data?.skus ?? []} onClose={() => setShowAdd(false)} onDone={(m) => { setShowAdd(false); say(m); refresh(); }} />}
    </div>
  );
}

