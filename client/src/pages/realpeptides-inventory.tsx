import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Minus, Plus, FileDown, Tag, Upload, History, X, Loader2,
  PackageOpen, AlertTriangle, CheckCircle2, Pencil, Package, Tags,
} from "lucide-react";
import { PageHero } from "../components/page-hero";
import { API, api, ui, thumbUrl, type Sku } from "./coa/api";
import { downloadOrderPdf, isLow, orderQty, stockOf, idealOf, stockNum, type InvItem } from "./coa/order-pdf";

/**
 * Real Peptides Inventory — vials AND printed labels, plus the restock orders.
 *
 * Two views of the same catalog: "Vials" counts finished product (feeds the
 * public feed's stock/inStock, which the Vercel storefront reads); "Labels"
 * counts printed vial labels so reprints get ordered before they run out.
 * Every movement of either goes through the tracker's audited stock route.
 */

type Filter = "all" | "low" | "out" | "nofile";

const ITEM_TEXT: Record<InvItem, { unit: string; order: string; out: string }> = {
  product: { unit: "units", order: "Order PDF", out: "Out of stock" },
  label: { unit: "labels", order: "Label print order", out: "Out of labels" },
};

export default function RealPeptidesInventory() {
  const qc = useQueryClient();
  const [item, setItem] = useState<InvItem>("product");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  const { data: me } = useQuery<{ role: string; permissions?: string[] }>({
    queryKey: ["ops-me"],
    queryFn: async () => (await fetch("/api/ops/auth/me", { credentials: "include" })).json(),
    staleTime: Infinity,
  });
  const canEdit = me?.role === "admin" || (me?.permissions ?? []).includes("realpeptides:coa-upload");

  const skusQ = useQuery({
    queryKey: ["coa-skus"],
    queryFn: () => api<{ skus: Sku[] }>("/skus"),
    retry: false,
  });
  const skus = useMemo(
    () => (skusQ.data?.skus ?? []).filter((s) => s.requires_coa).sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [skusQ.data],
  );

  const counts = useMemo(() => ({
    all: skus.length,
    low: skus.filter((s) => isLow(s, item)).length,
    out: skus.filter((s) => stockOf(s, item) !== null && stockOf(s, item)! <= 0).length,
    nofile: skus.filter((s) => !s.label_doc_id).length,
    units: skus.reduce((a, s) => a + (stockOf(s, item) ?? 0), 0),
  }), [skus, item]);

  const shown = useMemo(() => {
    let list = skus;
    if (filter === "low") list = list.filter((s) => isLow(s, item));
    else if (filter === "out") list = list.filter((s) => stockOf(s, item) !== null && stockOf(s, item)! <= 0);
    else if (filter === "nofile") list = list.filter((s) => !s.label_doc_id);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((s) => s.product_name.toLowerCase().includes(q) || s.sku_code.toLowerCase().includes(q));
    return list;
  }, [skus, item, filter, query]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["coa-skus"] });
  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 5000); };
  const t = ITEM_TEXT[item];

  function orderPdf() {
    const n = downloadOrderPdf(skus, item);
    say(n
      ? `${t.order} downloaded — ${n} product${n === 1 ? "" : "s"} below target.`
      : `Nothing is below target — no ${item === "label" ? "reprint" : "order"} needed.`);
  }

  const err = skusQ.error as Error | null;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Inventory"
        subtitle={`${counts.all} products · ${counts.units.toLocaleString()} ${t.unit} on hand. Vial stock feeds the live site; every change is logged.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={orderPdf} disabled={!skus.length} className={ui.primary}>
              <FileDown size={15} /> {t.order}{counts.low ? ` (${counts.low})` : ""}
            </button>
          </div>
        }
      />

      {flash && <div className="mb-5 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}
      {err && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">Couldn't reach the COA tracker: {err.message}</div>}

      <div className="mb-4 inline-flex rounded-xl border border-ops-border bg-ops-surface p-1">
        <ViewTab active={item === "product"} onClick={() => { setItem("product"); setFilter("all"); }} icon={<Package size={14} />} label="Vials & units" />
        <ViewTab active={item === "label"} onClick={() => { setItem("label"); setFilter("all"); }} icon={<Tags size={14} />} label="Printed labels" />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<PackageOpen size={17} />} label="Products" value={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
        <Kpi icon={<AlertTriangle size={17} />} label="Below target" value={counts.low} tone={counts.low ? "warn" : "ok"} active={filter === "low"} onClick={() => setFilter("low")} />
        <Kpi icon={<X size={17} />} label={t.out} value={counts.out} tone={counts.out ? "bad" : "ok"} active={filter === "out"} onClick={() => setFilter("out")} />
        <Kpi icon={<Tag size={17} />} label="No label file" value={counts.nofile} tone={counts.nofile ? "warn" : "ok"} active={filter === "nofile"} onClick={() => setFilter("nofile")} />
      </div>

      <div className="relative mb-4 max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products, SKUs…" className={`${ui.input} pl-9`} />
      </div>

      {skusQ.isLoading ? (
        <div className="py-16 text-center text-sm text-ops-text-muted">Loading inventory…</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">Label file</th>
                <th className="px-4 py-3 text-right font-medium">{item === "label" ? "Labels on hand" : "In stock"}</th>
                <th className="px-4 py-3 text-right font-medium">Target</th>
                <th className="px-4 py-3 text-right font-medium">{item === "label" ? "To print" : "To order"}</th>
                {canEdit && <th className="px-4 py-3 text-center font-medium">Adjust</th>}
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border/50">
              {shown.map((s) => (
                <Row key={`${item}-${s.id}`} sku={s} item={item} canEdit={canEdit} onChanged={refresh} onSay={say} />
              ))}
              {!shown.length && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-ops-text-muted">No products match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ViewTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${active ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
      {icon} {label}
    </button>
  );
}

function Kpi({ icon, label, value, tone = "neutral", active, onClick }: {
  icon: React.ReactNode; label: string; value: number; tone?: "neutral" | "ok" | "warn" | "bad"; active: boolean; onClick: () => void;
}) {
  const color = tone === "warn" ? "text-yellow-500" : tone === "bad" ? "text-red-400" : tone === "ok" ? "text-fitscript-green" : "text-ops-text";
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-3 rounded-2xl border p-4 text-left shadow-card transition ${active ? "border-fitscript-green bg-fitscript-green/10" : "border-ops-border bg-ops-surface hover:border-ops-text-muted"}`}>
      <span className={color}>{icon}</span>
      <span>
        <span className={`block text-xl font-bold leading-none tabular-nums ${color}`}>{value}</span>
        <span className="mt-1 block text-[11px] text-ops-text-muted">{label}</span>
      </span>
    </button>
  );
}

function Row({ sku, item, canEdit, onChanged, onSay }: {
  sku: Sku; item: InvItem; canEdit: boolean; onChanged: () => void; onSay: (m: string) => void;
}) {
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [edit, setEdit] = useState<null | "stock" | "ideal">(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const cur = stockOf(sku, item);
  const ideal = idealOf(sku, item);
  const need = orderQty(sku, item);
  const out = cur !== null && cur <= 0;
  const low = isLow(sku, item);
  const img = thumbUrl(sku);
  const noun = item === "label" ? "labels" : "stock";

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); onChanged(); if (done) onSay(done); }
    catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(false); }
  }
  const adjust = (sign: 1 | -1) => {
    const n = Math.abs(Number(qty) || 1) * sign;
    run(() => api(`/skus/${sku.id}/stock`, { method: "POST", body: JSON.stringify({ delta: n, item }) }),
      `${sku.product_name}: ${n > 0 ? "+" : ""}${n} ${noun}.`);
  };
  // Inline editors — a native prompt() freezes the whole tab while open.
  const saveStock = (v: string | null) => {
    setEdit(null);
    if (v === null || v.trim() === "") return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return onSay("Enter a non-negative number.");
    run(() => api(`/skus/${sku.id}/stock`, { method: "POST", body: JSON.stringify({ set: n, item, note: "manual count" }) }),
      `${sku.product_name}: ${noun} counted at ${n}.`);
  };
  const saveIdeal = (v: string | null) => {
    setEdit(null);
    if (v === null) return;
    const field = item === "label" ? "label_ideal" : "ideal_stock";
    if (v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) return onSay("Enter a non-negative number.");
    run(() => api(`/skus/${sku.id}`, { method: "PATCH", body: JSON.stringify({ [field]: v.trim() === "" ? null : Number(v) }) }),
      "Target saved.");
  };
  function onLabelFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    fd.append("sku_id", String(sku.id));
    fd.append("category", "label");
    run(() => api("/documents", { method: "POST", body: fd }), `Label file saved for ${sku.product_name}.`)
      .finally(() => { if (labelRef.current) labelRef.current.value = ""; });
  }

  return (
    <>
      <tr data-sku={sku.sku_code} className={out ? "bg-red-500/[0.04]" : low ? "bg-yellow-500/[0.04]" : undefined}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
              {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-ops-text">{sku.product_name}</div>
              <div className="text-[11px] text-ops-text-muted">{sku.sku_code}{sku.form ? ` · ${sku.form}` : ""}</div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <input ref={labelRef} type="file" hidden onChange={onLabelFile} />
          {sku.label_doc_id ? (
            <span className="inline-flex items-center gap-2">
              <a href={`${API}/skus/${sku.id}/label-download`} className="inline-flex items-center gap-1 rounded-full bg-fitscript-green/10 px-2.5 py-1 text-[11px] font-semibold text-fitscript-green hover:bg-fitscript-green/20">
                <Tag size={11} /> Label
              </a>
              {canEdit && <button type="button" onClick={() => labelRef.current?.click()} disabled={busy} title="Replace label file" className="text-ops-text-muted hover:text-ops-text"><Upload size={13} /></button>}
            </span>
          ) : canEdit ? (
            <button type="button" onClick={() => labelRef.current?.click()} disabled={busy}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-ops-border px-2.5 py-1 text-[11px] text-ops-text-muted hover:border-fitscript-green/50 hover:text-ops-text">
              <Upload size={11} /> Add label
            </button>
          ) : (
            <span className="text-[11px] text-ops-text-muted">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {edit === "stock" ? (
            <CellInput initial={String(cur ?? 0)} onDone={saveStock} />
          ) : (
            <button type="button" onClick={canEdit ? () => setEdit("stock") : undefined} title={canEdit ? "Click to set an exact count" : undefined}
              className={`inline-flex items-center gap-1.5 text-base font-bold tabular-nums ${out ? "text-red-400" : low ? "text-yellow-500" : "text-ops-text"} ${canEdit ? "hover:underline" : "cursor-default"}`}>
              {cur ?? "—"}{canEdit && <Pencil size={11} className="text-ops-text-muted" />}
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {edit === "ideal" ? (
            <CellInput initial={String(ideal ?? "")} onDone={saveIdeal} />
          ) : (
            <button type="button" onClick={canEdit ? () => setEdit("ideal") : undefined}
              className={`tabular-nums text-ops-text-muted ${canEdit ? "hover:text-ops-text hover:underline" : "cursor-default"}`}>
              {ideal ?? "set"}
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {need && need > 0
            ? <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-[11px] font-bold text-yellow-500">{need}</span>
            : low
              ? <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-bold text-red-400">no target</span>
              : <CheckCircle2 size={15} className="ml-auto inline text-fitscript-green/60" />}
        </td>
        {canEdit && (
          <td className="px-4 py-3">
            <div className="flex items-center justify-center gap-1">
              <button type="button" onClick={() => adjust(-1)} disabled={busy || (cur ?? 0) <= 0} title={`Remove ${noun}`}
                className="grid h-7 w-7 place-items-center rounded-md border border-ops-border text-ops-text-muted hover:border-red-400/60 hover:text-red-400 disabled:opacity-30">
                <Minus size={13} />
              </button>
              <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric"
                className="h-7 w-12 rounded-md border border-ops-border bg-ops-bg text-center text-xs tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
              <button type="button" onClick={() => adjust(1)} disabled={busy} title={`Add ${noun}`}
                className="grid h-7 w-7 place-items-center rounded-md border border-ops-border text-ops-text-muted hover:border-fitscript-green/60 hover:text-fitscript-green disabled:opacity-30">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              </button>
            </div>
          </td>
        )}
        <td className="px-3 py-3 text-right">
          <button type="button" onClick={() => setShowLog(!showLog)} title="Movement history"
            className={`p-1 ${showLog ? "text-fitscript-green" : "text-ops-text-muted hover:text-ops-text"}`}>
            <History size={14} />
          </button>
        </td>
      </tr>
      {showLog && <LogRow skuId={sku.id} colSpan={canEdit ? 7 : 6} />}
    </>
  );
}

/** Tiny in-cell number editor: Enter/blur saves, Escape cancels. */
function CellInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ""))}
      onKeyDown={(e) => { if (e.key === "Enter") onDone(v); if (e.key === "Escape") onDone(null); }}
      onBlur={() => onDone(v)}
      inputMode="numeric"
      className="h-8 w-20 rounded-md border border-fitscript-green bg-ops-bg text-right text-sm font-semibold tabular-nums text-ops-text focus:outline-none"
    />
  );
}

function LogRow({ skuId, colSpan }: { skuId: number; colSpan: number }) {
  const q = useQuery({
    queryKey: ["coa-stock-log", skuId],
    queryFn: () => api<{ log: { id: number; item: string; delta: string; new_stock: string; note: string | null; changed_by: string | null; created_at: string }[] }>(`/skus/${skuId}/stock-log`),
  });
  return (
    <tr className="bg-ops-bg/30">
      <td colSpan={colSpan} className="px-4 py-3">
        {!q.data ? <span className="text-xs text-ops-text-muted">Loading history…</span>
          : !q.data.log.length ? <span className="text-xs text-ops-text-muted">No movements recorded yet.</span>
          : (
            <ul className="space-y-1 text-xs">
              {q.data.log.map((l) => {
                const d = Number(l.delta);
                return (
                  <li key={l.id} className="flex flex-wrap items-center gap-2 text-ops-text-muted">
                    <span className="w-32 shrink-0">{new Date(l.created_at).toLocaleString()}</span>
                    <span className={`w-14 shrink-0 rounded-full px-1.5 text-center text-[10px] font-semibold ${l.item === "label" ? "bg-purple-500/15 text-purple-400" : "bg-ops-border text-ops-text-muted"}`}>
                      {l.item === "label" ? "labels" : "vials"}
                    </span>
                    <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${d > 0 ? "text-fitscript-green" : d < 0 ? "text-red-400" : "text-ops-text"}`}>
                      {d > 0 ? `+${d}` : d === 0 ? "set" : d}
                    </span>
                    <span className="tabular-nums text-ops-text">→ {Number(l.new_stock)}</span>
                    {l.note && <span>· {l.note}</span>}
                    {l.changed_by && <span>· {l.changed_by}</span>}
                  </li>
                );
              })}
            </ul>
          )}
      </td>
    </tr>
  );
}
