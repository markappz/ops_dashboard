import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Minus, Plus, FileDown, Tag, Upload, History, X, Loader2,
  PackageOpen, AlertTriangle, CheckCircle2, Package, Tags, ClipboardList, RefreshCw, FileUp, TrendingUp, ImageIcon,
} from "lucide-react";
import { PageHero } from "../components/page-hero";
import { API, api, ui, thumbUrl, type Sku } from "./coa/api";
import { downloadOrderPdf, isLow, orderQty, stockOf, idealOf, stockNum, type InvItem } from "./coa/order-pdf";
import { PurchaseOrders } from "./coa/PurchaseOrders";
import { Forecast } from "./coa/Forecast";
import { TopSellers } from "./coa/TopSellers";
import { InventoryImport, exportInventoryCsv } from "./coa/InventoryImport";

/**
 * Real Peptides Inventory — the Shelf Planner replacement.
 *
 * Stock lives on the COA tracker and is decremented live as website orders
 * sync in (every 10 min, audited per order). Two views: "Vials" (feeds the
 * public feed's stock, which the storefront reads) and "Printed labels".
 * Velocity comes from the site's own order feed; POs track what's already
 * ordered from the manufacturer. Tap any product to manage it — that's also
 * the mobile path, where the table's inline steppers don't fit.
 */

type Filter = "all" | "low" | "out" | "nofile";
type Velocity = Record<string, { units: Record<number, number>; weekly: number }>;

const ITEM_TEXT: Record<InvItem, { unit: string; order: string; out: string }> = {
  product: { unit: "units", order: "Order PDF", out: "Out of stock" },
  label: { unit: "labels", order: "Label print order", out: "Out of labels" },
};

interface Stats {
  configured: boolean;
  bySku?: Velocity;
  lastSync?: { at: string; applied: number; error?: string; unmatched?: string[] } | null;
}

export default function RealPeptidesInventory() {
  const qc = useQueryClient();
  const [item, setItem] = useState<InvItem>("product");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [showPos, setShowPos] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [openSku, setOpenSku] = useState<number | null>(null);

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
  const statsQ = useQuery({
    queryKey: ["rp-inventory-stats", "28,56"],
    queryFn: async () => (await fetch("/api/ops/realpeptides/inventory-stats?windows=28,56", { credentials: "include" })).json() as Promise<Stats>,
    staleTime: 5 * 60_000,
  });
  const velocity = statsQ.data?.bySku ?? {};

  const rawSkus = useMemo(
    () => (skusQ.data?.skus ?? []).filter((s) => s.requires_coa).sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [skusQ.data],
  );

  // Target mode: "manual" uses each product's saved target; a weeks mode
  // derives it from real velocity (weekly rate × weeks of cover), so the
  // whole report — Target, To order, Below target, Order PDF, shortfall PO —
  // answers "how far out do we want to stock up?" in one click.
  const [targetWeeks, setTargetWeeks] = useState<number | null>(() => {
    try { const v = localStorage.getItem("rp-target-weeks"); return v ? Number(v) : null; } catch { return null; }
  });
  const pickTargetWeeks = (w: number | null) => {
    setTargetWeeks(w);
    try { w === null ? localStorage.removeItem("rp-target-weeks") : localStorage.setItem("rp-target-weeks", String(w)); } catch { /* private mode */ }
  };
  const skus = useMemo(() => {
    if (targetWeeks === null || item !== "product") return rawSkus;
    return rawSkus.map((s) => {
      const weekly = velocity[s.sku_code]?.weekly ?? 0;
      return { ...s, ideal_stock: weekly > 0 ? Math.ceil(weekly * targetWeeks) : null };
    });
  }, [rawSkus, targetWeeks, item, velocity]);

  const counts = useMemo(() => ({
    all: skus.length,
    low: skus.filter((s) => isLow(s, item)).length,
    out: skus.filter((s) => stockOf(s, item) !== null && stockOf(s, item)! <= 0).length,
    nofile: skus.filter((s) => !s.label_doc_id).length,
    units: skus.reduce((a, s) => a + (stockOf(s, item) ?? 0), 0),
    onOrder: skus.reduce((a, s) => a + (stockNum(s.on_order) ?? 0), 0),
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
  const sync = statsQ.data?.lastSync;
  const noImage = useMemo(() => skus.filter((s) => !thumbUrl(s)).length, [skus]);
  const [imgBusy, setImgBusy] = useState(false);
  async function syncImages() {
    setImgBusy(true);
    try {
      const r = await fetch("/api/ops/realpeptides/inventory/images/sync", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      qc.invalidateQueries({ queryKey: ["coa-skus"] });
      say(`Images: ${j.uploaded} filled from the website${j.missing?.length ? ` · ${j.missing.length} have no photo on the site yet (${j.missing.slice(0, 4).join(", ")}${j.missing.length > 4 ? "…" : ""})` : ""}.`);
    } catch (e: any) { say(`Image sync failed: ${e.message}`); }
    finally { setImgBusy(false); }
  }

  function orderPdf() {
    const n = downloadOrderPdf(skus, item);
    say(n
      ? `${t.order} downloaded — ${n} product${n === 1 ? "" : "s"} below target.`
      : `Nothing is below target — no ${item === "label" ? "reprint" : "order"} needed.`);
  }

  const err = skusQ.error as Error | null;
  const opened = openSku !== null ? skus.find((s) => s.id === openSku) ?? null : null;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Inventory"
        subtitle={`${counts.all} products · ${counts.units.toLocaleString()} ${t.unit} on hand${counts.onOrder ? ` · ${counts.onOrder.toLocaleString()} on order` : ""}. Website orders sync in automatically; every change is logged.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { exportInventoryCsv(skus); say("Inventory CSV downloaded — it round-trips through Import."); }} disabled={!skus.length} className={ui.ghost} title="Download all inventory as a spreadsheet"><FileDown size={15} /> Export</button>
            {canEdit && <button type="button" onClick={() => setShowImport(true)} className={ui.ghost} title="Upload a spreadsheet to update counts and targets"><FileUp size={15} /> Import</button>}
            {canEdit && <button type="button" onClick={() => setShowPos(true)} className={ui.ghost}><ClipboardList size={15} /> POs</button>}
            {canEdit && noImage > 0 && (
              <button type="button" onClick={syncImages} disabled={imgBusy} className={ui.ghost} title="Copy each product's photo from realpeptides.co into the tracker (runs on its own every 6 hours)">
                {imgBusy ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />} Fill {noImage} missing image{noImage === 1 ? "" : "s"}
              </button>
            )}
            <button type="button" onClick={() => setShowForecast(true)} disabled={!skus.length} className={ui.ghost}><TrendingUp size={15} /> Forecast</button>
            <button type="button" onClick={orderPdf} disabled={!skus.length} className={ui.primary}>
              <FileDown size={15} /> {t.order}{counts.low ? ` (${counts.low})` : ""}
            </button>
          </div>
        }
      />

      {flash && <div className="mb-5 rounded-xl border border-fitscript-green/30 bg-fitscript-green/10 p-3 text-sm text-fitscript-green">{flash}</div>}
      {(sync?.unmatched?.length ?? 0) > 0 && (
        <div className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-400">
          <strong>Sales are NOT deducting for {sync!.unmatched!.length} product name{sync!.unmatched!.length === 1 ? "" : "s"}:</strong>{" "}
          {sync!.unmatched!.join(" · ")}. The website sells these under a name ops doesn't recognize — rename the product here to match the site
          (or set its alias), or stock will drift like Bromantane did.
        </div>
      )}
      {err && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">Couldn't reach the COA tracker: {err.message}</div>}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl border border-ops-border bg-ops-surface p-1">
            <ViewTab active={item === "product"} onClick={() => { setItem("product"); setFilter("all"); }} icon={<Package size={14} />} label="Vials & units" />
            <ViewTab active={item === "label"} onClick={() => { setItem("label"); setFilter("all"); }} icon={<Tags size={14} />} label="Printed labels" />
          </div>
          {item === "product" && (
            <label className="flex items-center gap-2 text-[11px] text-ops-text-muted" title="Manual = each product's saved target. A weeks setting derives targets from the live sales rate — weekly velocity × weeks of cover.">
              Stock up for
              <span className="inline-flex rounded-lg border border-ops-border bg-ops-surface p-0.5">
                <button type="button" onClick={() => pickTargetWeeks(null)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${targetWeeks === null ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
                  Manual
                </button>
                {[4, 6, 8, 12].map((w) => (
                  <button key={w} type="button" onClick={() => pickTargetWeeks(w)}
                    className={`rounded-md px-2 py-1 text-[11px] font-semibold tabular-nums transition ${targetWeeks === w ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
                    {w}w
                  </button>
                ))}
              </span>
            </label>
          )}
        </div>
        {sync && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ops-text-muted" title="Website orders are applied to stock automatically every 10 minutes.">
            <RefreshCw size={11} className={sync.error ? "text-red-400" : "text-fitscript-green"} />
            {sync.error ? `order sync error: ${sync.error}` : `orders synced ${new Date(sync.at).toLocaleTimeString()}`}
          </span>
        )}
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

      <RecentMoves />

      {skusQ.isLoading ? (
        <div className="py-16 text-center text-sm text-ops-text-muted">Loading inventory…</div>
      ) : (
        <>
          {/* Mobile: cards, tap to manage. Desktop: full table. */}
          <div className="space-y-2 md:hidden">
            {shown.map((s) => <MobileCard key={`${item}-${s.id}`} sku={s} item={item} velocity={velocity} onOpen={() => setOpenSku(s.id)} />)}
            {!shown.length && <div className="py-12 text-center text-sm text-ops-text-muted">No products match.</div>}
          </div>
          <div className="hidden overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card md:block">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Label file</th>
                  <th className="px-4 py-3 text-right font-medium">{item === "label" ? "Labels on hand" : "In stock"}</th>
                  {item === "product" && <th className="px-4 py-3 text-right font-medium">On order</th>}
                  <th className="px-4 py-3 text-right font-medium">Target</th>
                  <th className="px-4 py-3 text-right font-medium">{item === "label" ? "To print" : "To order"}</th>
                  {item === "product" && <th className="px-4 py-3 text-right font-medium">Sold 4w · 8w</th>}
                  {item === "product" && <th className="px-4 py-3 text-right font-medium">Selling</th>}
                  {canEdit && <th className="px-4 py-3 text-center font-medium">Adjust</th>}
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {shown.map((s) => (
                  <Row key={`${item}-${s.id}`} sku={s} item={item} canEdit={canEdit} velocity={velocity}
                    onChanged={refresh} onSay={say} onOpen={() => setOpenSku(s.id)} />
                ))}
                {!shown.length && (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-ops-text-muted">No products match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {item === "product" && !skusQ.isLoading && <TopSellers skus={skus} />}

      {showPos && <PurchaseOrders skus={skus} onClose={() => setShowPos(false)} onSay={say} />}
      {showForecast && <Forecast skus={skus} canEdit={canEdit} onClose={() => setShowForecast(false)} onSay={say} onCreated={refresh} />}
      {showImport && <InventoryImport skus={skus} onClose={() => setShowImport(false)} onDone={(m) => { setShowImport(false); say(m); refresh(); }} />}
      {opened && <SkuSheet sku={opened} item={item} canEdit={canEdit} velocity={velocity}
        onClose={() => setOpenSku(null)} onChanged={refresh} onSay={say} />}
    </div>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────

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

function useAdjust(sku: Sku, item: InvItem, onChanged: () => void, onSay: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const noun = item === "label" ? "labels" : "stock";
  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); onChanged(); if (done) onSay(done); }
    catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(false); }
  }
  const adjust = (delta: number) =>
    run(() => api(`/skus/${sku.id}/stock`, { method: "POST", body: JSON.stringify({ delta, item, note: delta > 0 ? "manual add" : "manual remove" }) }),
      `${sku.product_name}: ${delta > 0 ? "+" : ""}${delta} ${noun}.`);
  const setExact = (n: number) =>
    run(() => api(`/skus/${sku.id}/stock`, { method: "POST", body: JSON.stringify({ set: n, item, note: "manual count" }) }),
      `${sku.product_name}: ${noun} counted at ${n}.`);
  const setTarget = (v: number | null) =>
    run(() => api(`/skus/${sku.id}`, { method: "PATCH", body: JSON.stringify({ [item === "label" ? "label_ideal" : "ideal_stock"]: v }) }),
      "Target saved.");
  return { busy, run, adjust, setExact, setTarget, noun };
}

/** Weeks of stock left at the current sales rate. */
function weeksLeft(sku: Sku, velocity: Velocity): { weekly: number; weeks: number | null } | null {
  const v = velocity[sku.sku_code];
  if (!v || !v.weekly) return v ? { weekly: 0, weeks: null } : null;
  const cur = stockNum(sku.current_stock) ?? 0;
  return { weekly: v.weekly, weeks: Math.round((cur / v.weekly) * 10) / 10 };
}

// ─── Desktop row ───────────────────────────────────────────────────

function Row({ sku, item, canEdit, velocity, onChanged, onSay, onOpen }: {
  sku: Sku; item: InvItem; canEdit: boolean; velocity: Velocity;
  onChanged: () => void; onSay: (m: string) => void; onOpen: () => void;
}) {
  const [qty, setQty] = useState("1");
  const [showLog, setShowLog] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const { busy, run, adjust } = useAdjust(sku, item, onChanged, onSay);

  const cur = stockOf(sku, item);
  const ideal = idealOf(sku, item);
  const need = orderQty(sku, item);
  const onOrder = stockNum(sku.on_order) ?? 0;
  const out = cur !== null && cur <= 0;
  const low = isLow(sku, item);
  const img = thumbUrl(sku);
  const vel = item === "product" ? weeksLeft(sku, velocity) : null;
  const sold = item === "product" ? velocity[sku.sku_code]?.units ?? null : null;

  function onLabelFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f); fd.append("sku_id", String(sku.id)); fd.append("category", "label");
    run(() => api("/documents", { method: "POST", body: fd }), `Label file saved for ${sku.product_name}.`)
      .finally(() => { if (labelRef.current) labelRef.current.value = ""; });
  }

  return (
    <>
      <tr data-sku={sku.sku_code} className={out ? "bg-red-500/[0.04]" : low ? "bg-yellow-500/[0.04]" : undefined}>
        <td className="px-4 py-3">
          <button type="button" onClick={onOpen} className="flex items-center gap-3 text-left" title="Open product">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
              {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium text-ops-text hover:underline">{sku.product_name}</div>
              <div className="text-[11px] text-ops-text-muted">{sku.sku_code}{sku.form ? ` · ${sku.form}` : ""}</div>
            </div>
          </button>
        </td>
        <td className="px-4 py-3">
          <input ref={labelRef} type="file" hidden onChange={onLabelFile} />
          {sku.label_doc_id ? (
            <span className="inline-flex items-center gap-2">
              <a href={`${API}/skus/${sku.id}/label-download`} className="inline-flex items-center gap-1 rounded-full bg-fitscript-green/10 px-2.5 py-1 text-[11px] font-semibold text-fitscript-green hover:bg-fitscript-green/20"><Tag size={11} /> Label</a>
              {canEdit && <button type="button" onClick={() => labelRef.current?.click()} disabled={busy} title="Replace label file" className="text-ops-text-muted hover:text-ops-text"><Upload size={13} /></button>}
            </span>
          ) : canEdit ? (
            <button type="button" onClick={() => labelRef.current?.click()} disabled={busy}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-ops-border px-2.5 py-1 text-[11px] text-ops-text-muted hover:border-fitscript-green/50 hover:text-ops-text"><Upload size={11} /> Add label</button>
          ) : <span className="text-[11px] text-ops-text-muted">—</span>}
        </td>
        <td className="px-4 py-3 text-right">
          <span className={`text-base font-bold tabular-nums ${out ? "text-red-400" : low ? "text-yellow-500" : "text-ops-text"}`}>{cur ?? "—"}</span>
          {item === "product" && (stockNum(sku.held) ?? 0) > 0 && (
            <span className="block text-[10px] text-brand-blue-400" title="Reserved by paid orders that haven't shipped yet">{stockNum(sku.held)} held</span>
          )}
        </td>
        {item === "product" && (
          <td className="px-4 py-3 text-right tabular-nums">
            {onOrder > 0 ? <span className="font-semibold text-amber-500">{onOrder}</span> : <span className="text-ops-text-muted">—</span>}
          </td>
        )}
        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{ideal ?? "—"}</td>
        <td className="px-4 py-3 text-right">
          {sku.do_not_replenish
            ? <span className="rounded-full bg-ops-border px-2.5 py-1 text-[10px] font-bold uppercase text-ops-text-muted">no reorder</span>
            : need && need > 0
              ? <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-[11px] font-bold text-yellow-500">{need}</span>
              : low && !onOrder
                ? <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-bold text-red-400">no target</span>
                : <CheckCircle2 size={15} className="ml-auto inline text-fitscript-green/60" />}
        </td>
        {item === "product" && (
          <td className="px-4 py-3 text-right text-[11px] tabular-nums text-ops-text-muted">
            {sold ? <>{sold[28] ?? 0} <span className="text-ops-border">·</span> {sold[56] ?? 0}</> : "—"}
          </td>
        )}
        {item === "product" && (
          <td className="px-4 py-3 text-right text-[11px] tabular-nums">
            {vel === null ? <span className="text-ops-text-muted">—</span> : vel.weeks === null
              ? <span className="text-ops-text-muted">0/wk</span>
              : <span className={vel.weeks < 4 ? "font-semibold text-red-400" : "text-ops-text-muted"}>{vel.weekly}/wk · {vel.weeks}w left</span>}
          </td>
        )}
        {canEdit && (
          <td className="px-4 py-3">
            <div className="flex items-center justify-center gap-1">
              <button type="button" onClick={() => adjust(-Math.abs(Number(qty) || 1))} disabled={busy || (cur ?? 0) <= 0} title="Remove"
                className="grid h-7 w-7 place-items-center rounded-md border border-ops-border text-ops-text-muted hover:border-red-400/60 hover:text-red-400 disabled:opacity-30"><Minus size={13} /></button>
              <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric"
                className="h-7 w-12 rounded-md border border-ops-border bg-ops-bg text-center text-xs tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
              <button type="button" onClick={() => adjust(Math.abs(Number(qty) || 1))} disabled={busy} title="Add"
                className="grid h-7 w-7 place-items-center rounded-md border border-ops-border text-ops-text-muted hover:border-fitscript-green/60 hover:text-fitscript-green disabled:opacity-30">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              </button>
            </div>
          </td>
        )}
        <td className="px-3 py-3 text-right">
          <button type="button" onClick={() => setShowLog(!showLog)} title="Movement history"
            className={`p-1 ${showLog ? "text-fitscript-green" : "text-ops-text-muted hover:text-ops-text"}`}><History size={14} /></button>
        </td>
      </tr>
      {showLog && <LogRow skuId={sku.id} colSpan={item === "product" ? (canEdit ? 10 : 9) : (canEdit ? 7 : 6)} />}
    </>
  );
}

// ─── Mobile card ───────────────────────────────────────────────────

function MobileCard({ sku, item, velocity, onOpen }: {
  sku: Sku; item: InvItem; velocity: Velocity; onOpen: () => void;
}) {
  const cur = stockOf(sku, item);
  const need = orderQty(sku, item);
  const out = cur !== null && cur <= 0;
  const low = isLow(sku, item);
  const img = thumbUrl(sku);
  const vel = item === "product" ? weeksLeft(sku, velocity) : null;
  return (
    <button type="button" onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left shadow-card ${out ? "border-red-500/30" : low ? "border-yellow-500/30" : "border-ops-border"} bg-ops-surface active:bg-ops-bg`}>
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
        {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ops-text">{sku.product_name}</div>
        <div className="text-[11px] text-ops-text-muted">
          {sku.sku_code}{vel?.weeks != null ? ` · ${vel.weekly}/wk · ${vel.weeks}w left` : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-lg font-bold tabular-nums ${out ? "text-red-400" : low ? "text-yellow-500" : "text-ops-text"}`}>{cur ?? "—"}</div>
        {need && need > 0 ? <div className="text-[10px] font-semibold text-yellow-500">order {need}</div> : null}
      </div>
    </button>
  );
}

// ─── Product sheet: the tap-to-manage surface (works everywhere, built for phones) ───

function SkuSheet({ sku, item, canEdit, velocity, onClose, onChanged, onSay }: {
  sku: Sku; item: InvItem; canEdit: boolean; velocity: Velocity;
  onClose: () => void; onChanged: () => void; onSay: (m: string) => void;
}) {
  const [qty, setQty] = useState("1");
  const [count, setCount] = useState("");
  const [target, setTarget] = useState("");
  const [cover, setCover] = useState("");
  const labelRef = useRef<HTMLInputElement>(null);
  const { busy, run, adjust, setExact, setTarget: saveTarget, noun } = useAdjust(sku, item, onChanged, onSay);

  const cur = stockOf(sku, item);
  const ideal = idealOf(sku, item);
  const onOrder = stockNum(sku.on_order) ?? 0;
  const img = thumbUrl(sku);
  const vel = item === "product" ? weeksLeft(sku, velocity) : null;
  const n = Math.abs(Number(qty) || 1);

  function onLabelFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f); fd.append("sku_id", String(sku.id)); fd.append("category", "label");
    run(() => api("/documents", { method: "POST", body: fd }), `Label file saved.`)
      .finally(() => { if (labelRef.current) labelRef.current.value = ""; });
  }

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-md`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-ops-border p-4">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
            {img && <img src={img} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ops-text">{sku.product_name}</div>
            <div className="text-[11px] text-ops-text-muted">{sku.sku_code}{vel?.weeks != null ? ` · selling ${vel.weekly}/wk · ${vel.weeks}w left` : ""}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-4 p-4">
          <div className="rounded-xl border border-ops-border bg-ops-bg/40 p-4 text-center">
            <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{item === "label" ? "Labels on hand" : "In stock"}</div>
            <div className="mt-1 text-4xl font-bold tabular-nums text-ops-text">{cur ?? "—"}</div>
            <div className="mt-1 text-[11px] text-ops-text-muted">
              target {ideal ?? "not set"}{item === "product" && onOrder > 0 ? ` · +${onOrder} on order` : ""}
              {item === "product" && (stockNum(sku.held) ?? 0) > 0 ? ` · ${stockNum(sku.held)} held by paid orders` : ""}
            </div>
          </div>

          {canEdit && (
            <>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => adjust(-n)} disabled={busy || (cur ?? 0) <= 0}
                  className="grid h-14 flex-1 place-items-center rounded-xl border-2 border-red-400/40 text-red-400 active:bg-red-500/10 disabled:opacity-30"><Minus size={22} /></button>
                <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" aria-label="Quantity"
                  className="h-14 w-20 rounded-xl border border-ops-border bg-ops-bg text-center text-xl font-bold tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
                <button type="button" onClick={() => adjust(n)} disabled={busy}
                  className="grid h-14 flex-1 place-items-center rounded-xl border-2 border-fitscript-green/50 text-fitscript-green active:bg-fitscript-green/10 disabled:opacity-30">
                  {busy ? <Loader2 size={22} className="animate-spin" /> : <Plus size={22} />}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex gap-1.5">
                  <input value={count} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="Exact count"
                    className={`${ui.input} py-2.5`} />
                  <button type="button" disabled={busy || count === ""} onClick={() => { setExact(Number(count)); setCount(""); }}
                    className={`${ui.ghost} shrink-0 px-3`}>Set</button>
                </div>
                <div className="flex gap-1.5">
                  <input value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder={`Target (${ideal ?? "none"})`}
                    className={`${ui.input} py-2.5`} />
                  <button type="button" disabled={busy || target === ""} onClick={() => { saveTarget(Number(target)); setTarget(""); }}
                    className={`${ui.ghost} shrink-0 px-3`}>Set</button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-ops-border px-3 py-2.5">
                <div className="min-w-0 pr-3">
                  <span className="block text-sm text-ops-text">Do not replenish</span>
                  <span className="text-[11px] text-ops-text-muted">Sell what's left — never suggest a reorder for this product.</span>
                </div>
                <button type="button" disabled={busy} aria-pressed={sku.do_not_replenish}
                  onClick={() => run(
                    () => api(`/skus/${sku.id}`, { method: "PATCH", body: JSON.stringify({ do_not_replenish: !sku.do_not_replenish }) }),
                    sku.do_not_replenish ? `${sku.product_name} back in the reorder rotation.` : `${sku.product_name} marked do-not-replenish — it won't be reordered.`)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${sku.do_not_replenish ? "bg-red-400" : "bg-ops-border"}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${sku.do_not_replenish ? "left-[22px]" : "left-0.5"}`} />
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ops-border px-3 py-2.5">
                <div className="min-w-[180px] flex-1">
                  <span className="block text-sm text-ops-text">Forecast cover</span>
                  <span className="text-[11px] text-ops-text-muted">Weeks of demand to keep on hand (blank = 6).</span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <input value={cover} onChange={(e) => setCover(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric"
                    placeholder={sku.cover_weeks != null ? String(Number(sku.cover_weeks)) : "6"}
                    className={`${ui.input} w-16 py-2 text-center`} />
                  <button type="button" disabled={busy || cover === ""} onClick={() => {
                    run(() => api(`/skus/${sku.id}`, { method: "PATCH", body: JSON.stringify({ cover_weeks: Number(cover) }) }), "Cover weeks saved.");
                    setCover("");
                  }} className={`${ui.ghost} px-3 py-1.5 text-xs`}>Set</button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-ops-border px-3 py-2.5">
                <span className="text-sm text-ops-text">Label file</span>
                <input ref={labelRef} type="file" hidden onChange={onLabelFile} />
                <span className="flex items-center gap-2">
                  {sku.label_doc_id && <a href={`${API}/skus/${sku.id}/label-download`} className="text-[12px] font-semibold text-fitscript-green">Download</a>}
                  <button type="button" onClick={() => labelRef.current?.click()} disabled={busy} className={`${ui.ghost} px-2.5 py-1.5 text-xs`}>
                    <Upload size={12} /> {sku.label_doc_id ? "Replace" : "Add"}
                  </button>
                </span>
              </div>
            </>
          )}

          <SheetLog skuId={sku.id} />
        </div>
      </div>
    </div>
  );
}

// ─── Movement history ──────────────────────────────────────────────

interface MoveRow { id: number; sku_id: number; sku_code: string; product_name: string; item: string; delta: string; new_stock: string; note: string | null; changed_by: string | null; created_at: string }

/** What a movement was, in words: who did it and why, never just a number. */
function describeMove(l: MoveRow): { label: string; who: string } {
  const d = Number(l.delta);
  const note = (l.note || "").toLowerCase();
  const who = l.changed_by === "site-sync" || note.startsWith("order #") ? "website order" : l.changed_by || "system";
  let label = l.note || "";
  if (note === "manual add") label = `Manual add +${d}`;
  else if (note === "manual remove") label = `Manual remove ${d}`;
  else if (note === "manual count") label = `Counted at ${Number(l.new_stock)}`;
  else if (!label) label = d > 0 ? `+${d}` : d < 0 ? `${d}` : `Set to ${Number(l.new_stock)}`;
  return { label, who };
}

/** Every stock change across the shelf, newest first — the audit trail Justin asked for. */
function RecentMoves() {
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: ["coa-stock-log-all"],
    queryFn: () => api<{ log: MoveRow[] }>("/stock-log?limit=40"),
    refetchInterval: 60_000,
  });
  const log = q.data?.log ?? [];
  return (
    <div className="mb-5 rounded-2xl border border-ops-border bg-ops-surface shadow-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold text-ops-text"><History size={15} /> Recent stock moves</span>
        <span className="text-xs text-ops-text-muted">{log.length ? `last ${log.length} · ${open ? "hide" : "show"}` : ""}</span>
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-ops-border px-4 py-2">
          {!q.data ? <div className="py-3 text-xs text-ops-text-muted">Loading…</div> : !log.length ? <div className="py-3 text-xs text-ops-text-muted">No movements yet.</div> : (
            <ul className="divide-y divide-ops-border/50 text-xs">
              {log.map((l) => {
                const d = Number(l.delta);
                const { label, who } = describeMove(l);
                return (
                  <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-ops-text-muted">
                    <span className="w-28 shrink-0 tabular-nums">{new Date(l.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span className="min-w-0 flex-1 truncate text-ops-text" title={l.product_name}>{l.product_name}</span>
                    <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${d > 0 ? "text-fitscript-green" : d < 0 ? "text-red-400" : "text-ops-text"}`}>{d > 0 ? `+${d}` : d === 0 ? "set" : d}</span>
                    <span className="w-16 shrink-0 tabular-nums text-ops-text">→ {Number(l.new_stock)}{l.item === "label" ? " lbl" : ""}</span>
                    <span className="w-44 shrink-0 truncate">{label}</span>
                    <span className="w-44 shrink-0 truncate" title={who}>by {who}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function useStockLog(skuId: number) {
  return useQuery({
    queryKey: ["coa-stock-log", skuId],
    queryFn: () => api<{ log: { id: number; item: string; delta: string; new_stock: string; note: string | null; changed_by: string | null; created_at: string }[] }>(`/skus/${skuId}/stock-log`),
  });
}

function LogList({ log }: { log: { id: number; item: string; delta: string; new_stock: string; note: string | null; changed_by: string | null; created_at: string }[] }) {
  if (!log.length) return <span className="text-xs text-ops-text-muted">No movements recorded yet.</span>;
  return (
    <ul className="space-y-1 text-xs">
      {log.map((l) => {
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
            <span>· {describeMove({ ...l, sku_id: 0, sku_code: "", product_name: "" }).label}</span>
            <span>· by {describeMove({ ...l, sku_id: 0, sku_code: "", product_name: "" }).who}</span>
          </li>
        );
      })}
    </ul>
  );
}

function SheetLog({ skuId }: { skuId: number }) {
  const q = useStockLog(skuId);
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ops-text-muted">Recent movements</div>
      <div className="max-h-48 overflow-y-auto rounded-xl border border-ops-border p-3">
        {!q.data ? <span className="text-xs text-ops-text-muted">Loading…</span> : <LogList log={q.data.log} />}
      </div>
    </div>
  );
}

function LogRow({ skuId, colSpan }: { skuId: number; colSpan: number }) {
  const q = useStockLog(skuId);
  return (
    <tr className="bg-ops-bg/30">
      <td colSpan={colSpan} className="px-4 py-3">
        {!q.data ? <span className="text-xs text-ops-text-muted">Loading history…</span> : <LogList log={q.data.log} />}
      </td>
    </tr>
  );
}
