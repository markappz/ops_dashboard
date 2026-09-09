import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, FileDown, PackageCheck, Send, Trash2, ClipboardList, Loader2,
  Plus, Minus, ClipboardPaste, Search, ChevronDown, ChevronUp, Wand2, Truck,
} from "lucide-react";
import { api, ui, thumbUrl, type Po, type PoItem, type ParsedCheckinLine, type Sku } from "./api";
import { downloadPoPdf, orderQty, isLow, stockNum } from "./order-pdf";

/**
 * Purchase orders, per supplier. "New PO" opens a review list pre-filled with
 * every product below target for the chosen supplier (recommended quantity =
 * target − stock − on-order, rounded up to boxes of ten) that the team can
 * edit, trim or add to, then Save → PDF → Mark ordered. Ordered quantities
 * show as on-order in the inventory table and come off the reorder math;
 * check-ins are per line and audited; the paste box turns the fulfilment
 * team's "Product - qty" text into a check-in.
 */

const remainingOf = (i: PoItem) => Math.max(0, Number(i.qty) - Number(i.received_qty));
const poRemaining = (po: Po) => po.items.reduce((a, i) => a + remainingOf(i), 0);

type Velocity = Record<string, { units: Record<number, number>; weekly: number }>;

export function PurchaseOrders({ skus, velocity = {}, onClose, onSay }: { skus: Sku[]; velocity?: Velocity; onClose: () => void; onSay: (m: string) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | "new" | "paste" | null>(null);
  const [mode, setMode] = useState<"list" | "new" | "paste">("list");
  const posQ = useQuery({ queryKey: ["coa-pos"], queryFn: () => api<{ pos: Po[] }>("/pos") });
  const supQ = useQuery({ queryKey: ["coa-suppliers"], queryFn: () => api<{ suppliers: string[]; counts: { supplier: string | null; products: number }[] }>("/suppliers") });
  const pos = posQ.data?.pos ?? [];

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["coa-pos"] });
    qc.invalidateQueries({ queryKey: ["coa-skus"] });
    qc.invalidateQueries({ queryKey: ["coa-suppliers"] });
  };
  async function run(key: number | "new" | "paste", fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try { await fn(); bump(); if (done) onSay(done); }
    catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(null); }
  }

  const lowCount = skus.filter((s) => isLow(s) && (orderQty(s) ?? 0) > 0).length;

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-4xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Purchase orders</h2>
            <p className="text-xs text-ops-text-muted">One PO per supplier. Ordered quantities count as on-order; check-ins stock in what actually arrived, box by box.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-3 p-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setMode(mode === "new" ? "list" : "new")} className={mode === "new" ? ui.ghost : ui.primary}>
              <Plus size={15} /> New PO{lowCount ? ` · ${lowCount} below target` : ""}
            </button>
            <button type="button" onClick={() => setMode(mode === "paste" ? "list" : "paste")}
              className={mode === "paste" ? ui.primary : ui.ghost}><ClipboardPaste size={15} /> Paste check-in</button>
          </div>

          {mode === "new" && (
            <PoBuilder skus={skus} velocity={velocity} suppliers={supQ.data?.suppliers ?? ["Mike", "Caleb", "Ming", "Max"]} busy={busy !== null} onSay={onSay} bump={bump}
              onCreate={async (items, supplier, note) => {
                let created: Po | null = null;
                await run("new", async () => { created = await api<Po>("/pos", { method: "POST", body: JSON.stringify({ supplier, note, items }) }); },
                  `Draft PO for ${supplier} saved — ${items.length} line${items.length === 1 ? "" : "s"}, ${items.reduce((a, i) => a + i.qty, 0)} units. Download the PDF, then mark it ordered when it's sent.`);
                if (created) setMode("list");
              }} />
          )}

          {mode === "paste" && (
            <PasteCheckin busy={busy === "paste"}
              onApply={async (byPo, totalUnits) => {
                await run("paste", async () => {
                  let lastRemaining: { po: number; left: number } | null = null;
                  for (const [poId, lines] of byPo) {
                    const r = await api<{ remaining: number }>(`/pos/${poId}/checkin`, {
                      method: "POST", body: JSON.stringify({ lines }),
                    });
                    lastRemaining = { po: poId, left: r.remaining };
                  }
                  if (byPo.size === 1 && lastRemaining) {
                    onSay(lastRemaining.left > 0
                      ? `Checked in ${totalUnits} units against PO #${lastRemaining.po} — ${lastRemaining.left} still open on it.`
                      : `Checked in ${totalUnits} units — PO #${lastRemaining.po} is now fully received.`);
                  } else {
                    onSay(`Checked in ${totalUnits} units across ${byPo.size} POs.`);
                  }
                });
                setMode("list");
              }} />
          )}

          {posQ.isLoading && <div className="py-8 text-center text-sm text-ops-text-muted">Loading POs…</div>}
          {!posQ.isLoading && !pos.length && mode === "list" && <div className="py-8 text-center text-sm text-ops-text-muted">No purchase orders yet — start with New PO.</div>}

          {pos.map((po) => (
            <PoCard key={po.id} po={po} busy={busy} run={run} onSay={onSay} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── One PO card, with per-line check-in for ordered POs ───────────

const CHIP: Record<string, string> = {
  draft: "bg-ops-border text-ops-text-muted",
  ordered: "bg-amber-500/15 text-amber-500",
  received: "bg-fitscript-green/15 text-fitscript-green",
  cancelled: "bg-red-500/15 text-red-400",
};

function PoCard({ po, busy, run, onSay }: {
  po: Po; busy: number | "new" | "paste" | null;
  run: (key: number, fn: () => Promise<unknown>, done?: string) => Promise<void>;
  onSay: (m: string) => void;
}) {
  const [checkin, setCheckin] = useState(false);
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [draftQtys, setDraftQtys] = useState<Record<number, string>>({});

  const saveDraftQty = (item: PoItem) => {
    const v = Number(draftQtys[item.id]);
    if (!Number.isFinite(v) || v <= 0 || v === Number(item.qty)) return;
    run(po.id, () => api(`/pos/${po.id}/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ qty: v }) }));
  };
  const removeLine = (item: PoItem) =>
    run(po.id, () => api(`/pos/${po.id}/items/${item.id}`, { method: "DELETE" }),
      `${item.product_name} removed from PO #${po.id}.`);

  const units = po.items.reduce((a, i) => a + Number(i.qty), 0);
  const received = po.items.reduce((a, i) => a + Number(i.received_qty), 0);
  const remaining = poRemaining(po);
  const partly = po.status === "ordered" && received > 0;

  const setStatus = (status: string, done: string) =>
    run(po.id, () => api(`/pos/${po.id}`, { method: "PATCH", body: JSON.stringify({ status }) }), done);
  const removeDraft = () =>
    run(po.id, () => api(`/pos/${po.id}`, { method: "DELETE" }), `Draft PO #${po.id} deleted.`);

  const lines = () => po.items
    .map((i) => ({ item_id: i.id, qty: Number(qtys[i.id] ?? "") }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);

  const doCheckin = (close: boolean) => {
    const ls = lines();
    if (!ls.length && !close) return onSay("Enter what arrived first.");
    run(po.id, async () => {
      const r = await api<{ checkedIn: number; remaining: number }>(`/pos/${po.id}/checkin`, {
        method: "POST", body: JSON.stringify({ lines: ls, close }),
      });
      setCheckin(false); setQtys({});
      onSay(close && r.remaining === 0 && r.checkedIn < remaining
        ? `PO #${po.id} closed — ${r.checkedIn} units stocked in, ${remaining - r.checkedIn} never received.`
        : r.remaining > 0
          ? `Checked in ${r.checkedIn} units — ${r.remaining} still open on PO #${po.id}.`
          : `PO #${po.id} fully received — ${r.checkedIn} units stocked in.`);
    });
  };

  return (
    <div className="rounded-xl border border-ops-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ops-border bg-ops-bg/40 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="whitespace-nowrap text-sm font-semibold text-ops-text">PO #{po.id}</span>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${CHIP[po.status]}`}>
            {partly ? "partly received" : po.status}
          </span>
          <span className="text-xs text-ops-text-muted">
            {po.items.length} lines · {partly ? `${received}/${units} in` : `${units} units`} · {new Date(po.created_at).toLocaleDateString()}
            {po.supplier ? ` · ${po.supplier}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => downloadPoPdf(po)} title="Download PDF" className={`${ui.ghost} px-2 py-1.5 text-xs`}><FileDown size={13} /> PDF</button>
          {po.status === "draft" && (
            <>
              <button type="button" disabled={busy !== null} onClick={() => setStatus("ordered", `PO #${po.id} marked ordered — items now show as on-order.`)}
                className={`${ui.primary} px-2.5 py-1.5 text-xs`}><Send size={13} /> Mark ordered</button>
              <button type="button" disabled={busy !== null} onClick={removeDraft} title="Delete draft"
                className="p-1.5 text-ops-text-muted hover:text-red-400"><Trash2 size={14} /></button>
            </>
          )}
          {po.status === "ordered" && (
            <button type="button" disabled={busy !== null} onClick={() => setCheckin(!checkin)}
              className={`${checkin ? ui.ghost : ui.primary} px-2.5 py-1.5 text-xs`}>
              {busy === po.id ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />}
              Check in {checkin ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>

      <ul className="max-h-56 divide-y divide-ops-border/50 overflow-y-auto px-4 py-1 text-xs">
        {po.items.map((i) => {
          const left = remainingOf(i);
          return (
            <li key={i.id} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate text-ops-text">{i.product_name} <span className="text-ops-text-muted">({i.sku_code})</span></span>
              <span className="flex shrink-0 items-center gap-2">
                {po.status === "ordered" && Number(i.received_qty) > 0 && (
                  <span className={`tabular-nums ${left ? "text-amber-500" : "text-fitscript-green"}`}>{Number(i.received_qty)} in{left ? ` · ${left} open` : ""}</span>
                )}
                {po.status === "received" && Number(i.received_qty) < Number(i.qty) && (
                  <span className="tabular-nums text-red-400">{Number(i.qty) - Number(i.received_qty)} short</span>
                )}
                {checkin && po.status === "ordered" ? (
                  <input value={qtys[i.id] ?? ""} inputMode="numeric" placeholder={left ? `${left} open` : "done"} disabled={!left}
                    onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value.replace(/[^\d]/g, "") })}
                    className="h-7 w-20 rounded-md border border-ops-border bg-ops-bg px-1 text-center tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none disabled:opacity-40" />
                ) : po.status === "draft" ? (
                  <>
                    <input value={draftQtys[i.id] ?? String(Number(i.qty))} inputMode="numeric"
                      onChange={(e) => setDraftQtys({ ...draftQtys, [i.id]: e.target.value.replace(/[^\d]/g, "") })}
                      onBlur={() => saveDraftQty(i)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveDraftQty(i); }}
                      disabled={busy !== null}
                      className="h-7 w-16 rounded-md border border-ops-border bg-ops-bg px-1 text-center font-semibold tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
                    <button type="button" disabled={busy !== null} onClick={() => removeLine(i)} title="Remove from this PO"
                      className="p-1 text-ops-text-muted hover:text-red-400"><Trash2 size={13} /></button>
                  </>
                ) : (
                  <span className="font-semibold tabular-nums text-ops-text">{Number(i.qty)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {checkin && po.status === "ordered" && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ops-border bg-ops-bg/40 px-4 py-2.5">
          <button type="button" className="text-xs text-ops-text-muted underline-offset-2 hover:underline"
            onClick={() => setQtys(Object.fromEntries(po.items.filter((i) => remainingOf(i) > 0).map((i) => [i.id, String(remainingOf(i))])))}>
            Fill all open quantities
          </button>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={busy !== null} onClick={() => doCheckin(false)} className={`${ui.primary} px-2.5 py-1.5 text-xs`}>
              <PackageCheck size={13} /> Check in
            </button>
            <button type="button" disabled={busy !== null} onClick={() => doCheckin(true)}
              title="Stock in what's entered and close the PO — anything left never arrived and stops counting as on-order"
              className={`${ui.ghost} px-2.5 py-1.5 text-xs hover:text-red-400`}>
              Check in & close short
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Custom PO builder: Justin picks the lines, he knows the demand ─

// ─── New PO builder: supplier → prefilled review list → save ────────

const ALL = "__all__";

function weeksOf(s: Sku, velocity: Velocity): string {
  const v = velocity[s.sku_code];
  if (!v?.weekly) return "—";
  const cur = Math.max(0, stockNum(s.current_stock) ?? 0);
  return `${(cur / v.weekly).toFixed(1)}w · ${Math.round(v.weekly)}/wk`;
}

function PoBuilder({ skus, velocity, suppliers, busy, onCreate, onSay, bump }: {
  skus: Sku[]; velocity: Velocity; suppliers: string[]; busy: boolean;
  onCreate: (items: { sku_id: number; qty: number }[], supplier: string, note: string) => void;
  onSay: (m: string) => void; bump: () => void;
}) {
  const unassigned = skus.filter((s) => !s.supplier).length;
  const firstWithNeed = suppliers.find((sp) => skus.some((s) => s.supplier === sp && isLow(s) && (orderQty(s) ?? 0) > 0));
  const [supplier, setSupplier] = useState<string>(firstWithNeed ?? (unassigned === skus.length ? ALL : suppliers[0]));
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<{ sku: Sku; qty: string }[]>([]);
  const [assigning, setAssigning] = useState(false);

  // Pre-fill: everything below target for this supplier, with the recommended quantity.
  useEffect(() => {
    const pick = skus.filter((s) => (supplier === ALL || s.supplier === supplier) && isLow(s) && (orderQty(s) ?? 0) > 0);
    setLines(pick.map((s) => ({ sku: s, qty: String(orderQty(s) ?? "") })));
  }, [supplier, skus]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const chosen = new Set(lines.map((l) => l.sku.id));
    return skus.filter((s) => !chosen.has(s.id) && (s.product_name.toLowerCase().includes(needle) || s.sku_code.toLowerCase().includes(needle))).slice(0, 6);
  }, [q, skus, lines]);

  const items = lines.map((l) => ({ sku_id: l.sku.id, qty: Number(l.qty) })).filter((i) => i.qty > 0);
  const units = items.reduce((a, i) => a + i.qty, 0);
  const setQty = (id: number, qty: string) => setLines(lines.map((l) => (l.sku.id === id ? { ...l, qty } : l)));
  const setSku = async (s: Sku, sup: string) => {
    try { await api(`/skus/${s.id}`, { method: "PATCH", body: JSON.stringify({ supplier: sup }) }); bump(); }
    catch (e: any) { onSay(`Couldn't set supplier: ${e.message}`); }
  };
  const autoAssign = async () => {
    setAssigning(true);
    try {
      const r = await api<{ assigned: number; bySupplier: Record<string, number> }>("/skus/assign-suppliers", { method: "POST", body: JSON.stringify({}) });
      bump();
      onSay(`Assigned ${r.assigned} products by type: ${Object.entries(r.bySupplier).map(([k, v]) => `${k} ${v}`).join(", ")}. Change any product's supplier in the list below.`);
    } catch (e: any) { onSay(`Auto-assign failed: ${e.message}`); }
    finally { setAssigning(false); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-ops-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-ops-text-muted"><Truck size={13} /> Supplier</span>
        {suppliers.map((sp) => {
          const need = skus.filter((s) => s.supplier === sp && isLow(s) && (orderQty(s) ?? 0) > 0).length;
          return (
            <button key={sp} type="button" onClick={() => setSupplier(sp)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${supplier === sp ? "border-fitscript-green bg-fitscript-green/10 text-fitscript-green" : "border-ops-border text-ops-text hover:border-ops-text-muted"}`}>
              {sp}{need ? <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-500">{need}</span> : null}
            </button>
          );
        })}
        <button type="button" onClick={() => setSupplier(ALL)} className={`rounded-lg border px-3 py-1.5 text-sm ${supplier === ALL ? "border-fitscript-green bg-fitscript-green/10 text-fitscript-green" : "border-ops-border text-ops-text-muted hover:border-ops-text-muted"}`}>All</button>
        {unassigned > 0 && (
          <button type="button" onClick={autoAssign} disabled={assigning} className={`${ui.ghost} ml-auto px-2.5 py-1.5 text-xs`} title="Capsules & tablets → Mike, sprays & serums → Caleb, vials → Ming. Editable per product afterwards.">
            {assigning ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Assign {unassigned} unassigned by type
          </button>
        )}
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a product that isn't below target — search name or SKU…" className={`${ui.input} pl-8`} />
        {hits.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-ops-border bg-ops-surface shadow-card">
            {hits.map((s) => {
              const img = thumbUrl(s);
              return (
                <button key={s.id} type="button" onClick={() => { setLines([...lines, { sku: s, qty: String(orderQty(s) || "") }]); setQ(""); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ops-bg">
                  <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md border border-ops-border bg-ops-bg">{img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}</span>
                  <span className="min-w-0 flex-1 truncate text-ops-text">{s.product_name}</span>
                  <span className="shrink-0 text-[11px] text-ops-text-muted">{s.sku_code}{s.supplier ? ` · ${s.supplier}` : ""}{s.do_not_replenish ? " · no-reorder" : ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ops-border p-6 text-center text-sm text-ops-text-muted">
          Nothing below target for {supplier === ALL ? "any supplier" : supplier}. Add products above if you still want to order.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ops-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-2 py-2 text-right font-medium">Stock</th>
                <th className="px-2 py-2 text-right font-medium">Target</th>
                <th className="px-2 py-2 text-right font-medium">On order</th>
                <th className="px-2 py-2 text-right font-medium">Cover</th>
                <th className="px-2 py-2 font-medium">Supplier</th>
                <th className="px-2 py-2 text-right font-medium">Order qty</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border/50">
              {lines.map((l) => {
                const s = l.sku; const img = thumbUrl(s);
                return (
                  <tr key={s.id}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <span className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-ops-border bg-ops-bg">{img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}</span>
                        <div className="min-w-0"><div className="truncate text-ops-text">{s.product_name}</div><div className="text-[11px] text-ops-text-muted">{s.sku_code}</div></div>
                      </div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${(stockNum(s.current_stock) ?? 0) <= 0 ? "text-red-400 font-semibold" : "text-ops-text"}`}>{stockNum(s.current_stock) ?? "—"}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ops-text-muted">{stockNum(s.ideal_stock) ?? "—"}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-ops-text-muted">{stockNum(s.on_order) || "—"}</td>
                    <td className="px-2 py-2 text-right text-xs text-ops-text-muted">{weeksOf(s, velocity)}</td>
                    <td className="px-2 py-2">
                      <select value={s.supplier ?? ""} onChange={(e) => setSku(s, e.target.value)} className="h-8 rounded-md border border-ops-border bg-ops-bg px-2 text-xs text-ops-text focus:border-fitscript-green focus:outline-none">
                        <option value="">—</option>
                        {suppliers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <input value={l.qty} inputMode="numeric" onChange={(e) => setQty(s.id, e.target.value.replace(/[^\d]/g, ""))}
                        className="h-8 w-20 rounded-md border border-ops-border bg-ops-bg text-center tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button type="button" onClick={() => setLines(lines.filter((x) => x.sku.id !== s.id))} title="Remove from this PO" className="p-1 text-ops-text-muted hover:text-red-400"><Minus size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the supplier (optional)" className={`${ui.input} flex-1`} />
        <button type="button" disabled={busy || !items.length || supplier === ALL} title={supplier === ALL ? "Pick a supplier — POs are per supplier" : undefined}
          onClick={() => onCreate(items, supplier, note.trim())} className={ui.primary}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
          Save PO for {supplier === ALL ? "…" : supplier} ({items.length} line{items.length === 1 ? "" : "s"} · {units} units)
        </button>
      </div>
      <p className="text-[11px] text-ops-text-muted">Recommended quantity = target − (stock − held) − on order, rounded up to boxes of ten. Targets follow the "Stock up for" setting on the Inventory tab. Saving creates a draft; download the PDF from its card, then mark it ordered.</p>
    </div>
  );
}

// ─── Paste check-in: fulfilment text → preview → apply ─────────────

const EXAMPLE = "Klow 80mg - 440 Total\nMots-C 10mg - 60 Total\nSS31 50mg - 160 Total";

function PasteCheckin({ busy, onApply }: {
  busy: boolean;
  onApply: (byPo: Map<number, { item_id: number; qty: number }[]>, totalUnits: number) => void;
}) {
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<{ lines: ParsedCheckinLine[]; pos: { id: number; supplier: string | null; units: string; received: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function parse() {
    setParsing(true); setError(null); setPreview(null);
    try {
      setPreview(await api("/pos/checkin-parse", { method: "POST", body: JSON.stringify({ text }) }));
    } catch (e: any) { setError(e.message); }
    finally { setParsing(false); }
  }

  const apply = preview?.lines.filter((l) => l.item && l.item.apply > 0) ?? [];
  const misses = preview?.lines.filter((l) => !l.item || l.item.apply <= 0) ?? [];
  const totalUnits = apply.reduce((a, l) => a + l.item!.apply, 0);

  function confirm() {
    const byPo = new Map<number, { item_id: number; qty: number }[]>();
    for (const l of apply) {
      if (!byPo.has(l.item!.po_id)) byPo.set(l.item!.po_id, []);
      byPo.get(l.item!.po_id)!.push({ item_id: l.item!.item_id, qty: l.item!.apply });
    }
    onApply(byPo, totalUnits);
  }

  return (
    <div className="space-y-3 rounded-xl border border-ops-border p-4">
      <textarea value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={6}
        placeholder={`Paste the fulfilment update, e.g.\n\n${EXAMPLE}`}
        className={`${ui.input} font-mono text-xs leading-relaxed`} />
      <button type="button" disabled={parsing || !text.trim()} onClick={parse} className={`w-full ${ui.ghost}`}>
        {parsing ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Find in open POs
      </button>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400">{error}</div>}

      {preview && (
        <>
          <ul className="divide-y divide-ops-border/50 rounded-xl border border-ops-border text-xs">
            {preview.lines.map((l, idx) => (
              <li key={idx} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ops-text">{l.sku ? l.sku.product_name : l.raw}</span>
                  {l.sku && <span className="text-[10px] text-ops-text-muted">{l.sku.sku_code}</span>}
                </span>
                {l.item && l.item.apply > 0 ? (
                  <span className="shrink-0 text-right">
                    <span className="font-semibold tabular-nums text-fitscript-green">+{l.item.apply}</span>
                    <span className="text-ops-text-muted"> → PO #{l.item.po_id}</span>
                    <span className="block text-[10px] text-ops-text-muted">
                      {l.item.remaining - l.item.apply > 0 ? `${l.item.remaining - l.item.apply} stays open` : "line complete"}
                      {l.item.overflow > 0 ? ` · ${l.item.overflow} over the PO — add manually` : ""}
                    </span>
                  </span>
                ) : (
                  <span className="shrink-0 text-[11px] font-semibold text-red-400">
                    {l.sku ? "not on any open PO" : "no product match"}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {preview.pos.map((p) => (
            <div key={p.id} className="text-[11px] text-ops-text-muted">
              PO #{p.id}{p.supplier ? ` (${p.supplier})` : ""}: {Number(p.received)}/{Number(p.units)} received before this check-in.
            </div>
          ))}
          <button type="button" disabled={busy || !apply.length} onClick={confirm} className={`w-full ${ui.primary}`}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
            Check in {totalUnits} units{misses.length ? ` (${misses.length} line${misses.length === 1 ? "" : "s"} skipped)` : ""}
          </button>
        </>
      )}
    </div>
  );
}
