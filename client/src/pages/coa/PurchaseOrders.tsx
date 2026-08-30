import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, FileDown, PackageCheck, Send, Trash2, ClipboardList, Loader2 } from "lucide-react";
import { api, ui, type Po, type Sku } from "./api";
import { downloadPoPdf, orderQty, isLow } from "./order-pdf";

/**
 * Purchase orders: what's been ordered from the manufacturer and when it
 * arrives. "Ordered" quantities show as on-order in the inventory table and
 * come off the reorder math; receiving a PO stocks everything in, audited.
 */
export function PurchaseOrders({ skus, onClose, onSay }: { skus: Sku[]; onClose: () => void; onSay: (m: string) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const posQ = useQuery({ queryKey: ["coa-pos"], queryFn: () => api<{ pos: Po[] }>("/pos") });
  const pos = posQ.data?.pos ?? [];

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["coa-pos"] });
    qc.invalidateQueries({ queryKey: ["coa-skus"] });
  };
  async function run(key: number | "new", fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try { await fn(); bump(); if (done) onSay(done); }
    catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(null); }
  }

  const shortfall = skus.filter((s) => isLow(s)).map((s) => ({ sku_id: s.id, qty: orderQty(s) ?? 0 })).filter((i) => i.qty > 0);
  const createFromShortfall = () =>
    run("new", () => api("/pos", { method: "POST", body: JSON.stringify({ supplier: "Manufacturer", items: shortfall }) }),
      `Draft PO created — ${shortfall.length} line${shortfall.length === 1 ? "" : "s"}. Mark it ordered when it's sent.`);

  const setStatus = (po: Po, status: string, done: string) =>
    run(po.id, () => api(`/pos/${po.id}`, { method: "PATCH", body: JSON.stringify({ status }) }), done);
  const removeDraft = (po: Po) =>
    run(po.id, () => api(`/pos/${po.id}`, { method: "DELETE" }), `Draft PO #${po.id} deleted.`);

  const CHIP: Record<string, string> = {
    draft: "bg-ops-border text-ops-text-muted",
    ordered: "bg-amber-500/15 text-amber-500",
    received: "bg-fitscript-green/15 text-fitscript-green",
    cancelled: "bg-red-500/15 text-red-400",
  };

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Purchase orders</h2>
            <p className="text-xs text-ops-text-muted">Ordered quantities count as on-order; receiving stocks everything in.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-3 p-5">
          <button type="button" onClick={createFromShortfall} disabled={busy !== null || !shortfall.length} className={`w-full ${ui.primary}`}>
            {busy === "new" ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
            New PO from current shortfall ({shortfall.length} product{shortfall.length === 1 ? "" : "s"})
          </button>

          {posQ.isLoading && <div className="py-8 text-center text-sm text-ops-text-muted">Loading POs…</div>}
          {!posQ.isLoading && !pos.length && <div className="py-8 text-center text-sm text-ops-text-muted">No purchase orders yet.</div>}

          {pos.map((po) => {
            const units = po.items.reduce((a, i) => a + Number(i.qty), 0);
            return (
              <div key={po.id} className="rounded-xl border border-ops-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ops-border bg-ops-bg/40 px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-ops-text">PO #{po.id}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${CHIP[po.status]}`}>{po.status}</span>
                    <span className="text-xs text-ops-text-muted">{po.items.length} lines · {units} units · {new Date(po.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => downloadPoPdf(po)} title="Download PDF" className={`${ui.ghost} px-2 py-1.5 text-xs`}><FileDown size={13} /> PDF</button>
                    {po.status === "draft" && (
                      <>
                        <button type="button" disabled={busy !== null} onClick={() => setStatus(po, "ordered", `PO #${po.id} marked ordered — items now show as on-order.`)}
                          className={`${ui.primary} px-2.5 py-1.5 text-xs`}><Send size={13} /> Mark ordered</button>
                        <button type="button" disabled={busy !== null} onClick={() => removeDraft(po)} title="Delete draft"
                          className="p-1.5 text-ops-text-muted hover:text-red-400"><Trash2 size={14} /></button>
                      </>
                    )}
                    {po.status === "ordered" && (
                      <button type="button" disabled={busy !== null} onClick={() => setStatus(po, "received", `PO #${po.id} received — stock added for ${po.items.length} products.`)}
                        className={`${ui.primary} px-2.5 py-1.5 text-xs`}>
                        {busy === po.id ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />} Receive → stock in
                      </button>
                    )}
                  </div>
                </div>
                <ul className="max-h-44 divide-y divide-ops-border/50 overflow-y-auto px-4 py-1 text-xs">
                  {po.items.map((i) => (
                    <li key={i.id} className="flex items-center justify-between py-1.5">
                      <span className="text-ops-text">{i.product_name} <span className="text-ops-text-muted">({i.sku_code})</span></span>
                      <span className="font-semibold tabular-nums text-ops-text">{Number(i.qty)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
