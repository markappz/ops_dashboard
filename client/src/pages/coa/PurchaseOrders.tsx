import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, FileDown, PackageCheck, Send, Trash2, ClipboardList, Loader2,
  Plus, Minus, ClipboardPaste, Search, ChevronDown, ChevronUp,
} from "lucide-react";
import { api, ui, thumbUrl, type Po, type PoItem, type ParsedCheckinLine, type Sku } from "./api";
import { downloadPoPdf, orderQty, isLow } from "./order-pdf";

/**
 * Purchase orders: what's been ordered from the manufacturer and when it
 * arrives. "Ordered" quantities show as on-order in the inventory table and
 * come off the reorder math. Check-ins are partial and per-line — each box
 * that lands stocks its contents in (audited) and the PO stays open with the
 * remainder until everything shows up or it's closed short. The paste box
 * turns the fulfilment team's "Product - qty" text into a check-in.
 */

const remainingOf = (i: PoItem) => Math.max(0, Number(i.qty) - Number(i.received_qty));
const poRemaining = (po: Po) => po.items.reduce((a, i) => a + remainingOf(i), 0);

export function PurchaseOrders({ skus, onClose, onSay }: { skus: Sku[]; onClose: () => void; onSay: (m: string) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | "new" | "paste" | null>(null);
  const [mode, setMode] = useState<"list" | "custom" | "paste">("list");
  const posQ = useQuery({ queryKey: ["coa-pos"], queryFn: () => api<{ pos: Po[] }>("/pos") });
  const pos = posQ.data?.pos ?? [];

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["coa-pos"] });
    qc.invalidateQueries({ queryKey: ["coa-skus"] });
  };
  async function run(key: number | "new" | "paste", fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try { await fn(); bump(); if (done) onSay(done); }
    catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(null); }
  }

  const shortfall = skus.filter((s) => isLow(s)).map((s) => ({ sku_id: s.id, qty: orderQty(s) ?? 0 })).filter((i) => i.qty > 0);
  const createFromShortfall = () =>
    run("new", () => api("/pos", { method: "POST", body: JSON.stringify({ supplier: "Manufacturer", items: shortfall }) }),
      `Draft PO created — ${shortfall.length} line${shortfall.length === 1 ? "" : "s"}. Mark it ordered when it's sent.`);

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-3xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Purchase orders</h2>
            <p className="text-xs text-ops-text-muted">Ordered quantities count as on-order; check-ins stock in what actually arrived, box by box.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-3 p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <button type="button" onClick={createFromShortfall} disabled={busy !== null || !shortfall.length} className={ui.primary}>
              {busy === "new" ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
              PO from shortfall ({shortfall.length})
            </button>
            <button type="button" onClick={() => setMode(mode === "custom" ? "list" : "custom")}
              className={mode === "custom" ? ui.primary : ui.ghost}><Plus size={15} /> Custom PO</button>
            <button type="button" onClick={() => setMode(mode === "paste" ? "list" : "paste")}
              className={mode === "paste" ? ui.primary : ui.ghost}><ClipboardPaste size={15} /> Paste check-in</button>
          </div>

          {mode === "custom" && (
            <CustomPoBuilder skus={skus} busy={busy !== null}
              onCreate={(items, supplier, note) =>
                run("new", () => api("/pos", { method: "POST", body: JSON.stringify({ supplier, note, items }) }),
                  `Draft PO created — ${items.length} line${items.length === 1 ? "" : "s"}. Mark it ordered when it's sent.`)
                  .then(() => setMode("list"))} />
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
          {!posQ.isLoading && !pos.length && <div className="py-8 text-center text-sm text-ops-text-muted">No purchase orders yet.</div>}

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

function CustomPoBuilder({ skus, busy, onCreate }: {
  skus: Sku[]; busy: boolean;
  onCreate: (items: { sku_id: number; qty: number }[], supplier: string, note: string) => void;
}) {
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("Manufacturer");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<{ sku: Sku; qty: string }[]>([]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const chosen = new Set(lines.map((l) => l.sku.id));
    return skus
      .filter((s) => !chosen.has(s.id) && (s.product_name.toLowerCase().includes(needle) || s.sku_code.toLowerCase().includes(needle)))
      .slice(0, 6);
  }, [q, skus, lines]);

  const items = lines.map((l) => ({ sku_id: l.sku.id, qty: Number(l.qty) })).filter((i) => i.qty > 0);
  const setQty = (id: number, qty: string) => setLines(lines.map((l) => (l.sku.id === id ? { ...l, qty } : l)));

  return (
    <div className="space-y-3 rounded-xl border border-ops-border p-4">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ops-text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a product — search name or SKU…" className={`${ui.input} pl-8`} autoFocus />
        {hits.length > 0 && (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-ops-border bg-ops-surface shadow-card">
            {hits.map((s) => {
              const img = thumbUrl(s);
              return (
                <button key={s.id} type="button" onClick={() => { setLines([...lines, { sku: s, qty: String(orderQty(s) || "") }]); setQ(""); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ops-bg">
                  <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md border border-ops-border bg-ops-bg">
                    {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ops-text">{s.product_name}</span>
                  <span className="shrink-0 text-[11px] text-ops-text-muted">
                    {s.sku_code}{s.do_not_replenish ? " · no-reorder" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {lines.length > 0 && (
        <ul className="divide-y divide-ops-border/50 rounded-xl border border-ops-border">
          {lines.map((l) => (
            <li key={l.sku.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ops-text">{l.sku.product_name} <span className="text-[11px] text-ops-text-muted">({l.sku.sku_code})</span></span>
              <input value={l.qty} inputMode="numeric" placeholder="qty" autoFocus={!l.qty}
                onChange={(e) => setQty(l.sku.id, e.target.value.replace(/[^\d]/g, ""))}
                className="h-8 w-20 rounded-md border border-ops-border bg-ops-bg text-center tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
              <button type="button" onClick={() => setLines(lines.filter((x) => x.sku.id !== l.sku.id))}
                className="p-1 text-ops-text-muted hover:text-red-400"><Minus size={14} /></button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier" className={ui.input} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={ui.input} />
      </div>
      <button type="button" disabled={busy || !items.length} onClick={() => { onCreate(items, supplier.trim(), note.trim()); setLines([]); }}
        className={`w-full ${ui.primary}`}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        Create draft PO ({items.length} line{items.length === 1 ? "" : "s"} · {items.reduce((a, i) => a + i.qty, 0)} units)
      </button>
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
