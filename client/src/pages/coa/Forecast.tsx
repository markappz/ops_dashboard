import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Loader2, TrendingUp, ClipboardList } from "lucide-react";
import { api, ui, type Sku } from "./api";
import { stockNum } from "./order-pdf";

/**
 * Demand forecast, the way Justin orders:
 * sales rate from the last 4 and 8 weeks (blended) → projected sales for the
 * next 4 and 8 weeks → stock wanted on hand = rate × (cover weeks + lead
 * time), where cover defaults to 6 weeks but any product can override it
 * (set in its manage sheet) and lead time is ~2 weeks → minus current stock
 * and what's already on open POs = what to order. One click → draft PO.
 */

const DEFAULT_COVER = 6;
const LEAD_CHOICES = [0, 1, 2, 3, 4];
const COVER_CHOICES = [2, 4, 6, 8, 12];

interface WindowStats { units: Record<number, number>; weekly: number }

export function Forecast({ skus, canEdit, onClose, onSay, onCreated }: {
  skus: Sku[]; canEdit: boolean; onClose: () => void; onSay: (m: string) => void; onCreated: () => void;
}) {
  const [cover, setCover] = useState(DEFAULT_COVER); // default weeks on hand (per-product override wins)
  const [lead, setLead] = useState(2);               // manufacturer lead time, weeks
  const [busy, setBusy] = useState(false);

  const statsQ = useQuery({
    queryKey: ["rp-inventory-stats", "28,56"],
    queryFn: async () =>
      (await fetch("/api/ops/realpeptides/inventory-stats?windows=28,56", { credentials: "include" })).json() as
        Promise<{ configured: boolean; bySku?: Record<string, WindowStats>; error?: string }>,
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const bySku = statsQ.data?.bySku ?? {};
    return skus
      .map((s) => {
        const sold4 = bySku[s.sku_code]?.units?.[28] ?? 0;
        const sold8 = bySku[s.sku_code]?.units?.[56] ?? 0;
        // Blend the two horizons: recent movement counts, one spike doesn't rule.
        const rate = (sold4 / 4 + sold8 / 8) / 2;
        const next4 = Math.ceil(rate * 4);
        const next8 = Math.ceil(rate * 8);
        const coverWeeks = s.cover_weeks != null ? Number(s.cover_weeks) : cover;
        const wanted = Math.ceil(rate * (coverWeeks + lead));
        const stock = stockNum(s.current_stock) ?? 0;
        const onOrder = stockNum(s.on_order) ?? 0;
        // Boxes come in tens — round the order up (28 → 30), never down.
        const gap = Math.ceil(Math.max(0, wanted - stock - onOrder) / 10) * 10;
        const runway = rate > 0 ? Math.round(((stock + onOrder) / rate) * 10) / 10 : null;
        return {
          s, sold4, sold8, rate: Math.round(rate * 10) / 10, next4, next8,
          coverWeeks, wanted, stock, onOrder, runway,
          order: s.do_not_replenish ? 0 : gap,
        };
      })
      .filter((r) => r.sold8 > 0 || r.order > 0 || r.s.do_not_replenish)
      .sort((a, b) => b.order - a.order || (a.runway ?? 999) - (b.runway ?? 999) || a.s.product_name.localeCompare(b.s.product_name));
  }, [skus, statsQ.data, cover, lead]);

  const toOrder = rows.filter((r) => r.order > 0);
  const totalUnits = toOrder.reduce((a, r) => a + r.order, 0);

  async function createPo() {
    setBusy(true);
    try {
      await api("/pos", {
        method: "POST",
        body: JSON.stringify({
          supplier: "Manufacturer",
          note: `Forecast: ${cover}w cover (per-product overrides apply) + ${lead}w lead, blended 4/8-week rate`,
          items: toOrder.map((r) => ({ sku_id: r.s.id, qty: r.order })),
        }),
      });
      onSay(`Draft PO created from the forecast — ${toOrder.length} lines, ${totalUnits} units.`);
      onCreated();
      onClose();
    } catch (e: any) { onSay(`Failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-5xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ops-text"><TrendingUp size={16} /> Demand forecast</h2>
            <p className="text-xs text-ops-text-muted">
              Blended 4/8-week sales rate → wanted on hand = rate × (cover + lead time) → minus stock and open POs.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-b border-ops-border px-5 py-3">
          <Picker label="Keep on hand" suffix="(products can override)" value={cover} onChange={setCover} choices={COVER_CHOICES} />
          <Picker label="Lead time" value={lead} onChange={setLead} choices={LEAD_CHOICES} />
        </div>

        <div className="max-h-[55vh] overflow-auto">
          {statsQ.isLoading ? (
            <div className="py-12 text-center text-sm text-ops-text-muted">Crunching order history…</div>
          ) : statsQ.data?.error ? (
            <div className="m-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{statsQ.data.error}</div>
          ) : (
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="sticky top-0 bg-ops-surface">
                <tr className="border-b border-ops-border text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-5 py-2.5 font-medium">Product</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sold 4w</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sold 8w</th>
                  <th className="px-3 py-2.5 text-right font-medium">Next 4w</th>
                  <th className="px-3 py-2.5 text-right font-medium">Next 8w</th>
                  <th className="px-3 py-2.5 text-right font-medium">Cover</th>
                  <th className="px-3 py-2.5 text-right font-medium">Wanted</th>
                  <th className="px-3 py-2.5 text-right font-medium">Stock</th>
                  <th className="px-3 py-2.5 text-right font-medium">On order</th>
                  <th className="px-5 py-2.5 text-right font-medium">Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {rows.map(({ s, sold4, sold8, next4, next8, coverWeeks, wanted, stock, onOrder, runway, order }) => (
                  <tr key={s.id} className={order > 0 ? "bg-yellow-500/[0.04]" : undefined}>
                    <td className="px-5 py-2">
                      <span className="text-ops-text">{s.product_name}</span>
                      <span className="ml-1.5 text-[10px] text-ops-text-muted">{s.sku_code}</span>
                      {s.do_not_replenish && <span className="ml-1.5 whitespace-nowrap rounded-full bg-ops-border px-1.5 py-0.5 text-[9px] font-bold uppercase text-ops-text-muted">no reorder</span>}
                      {runway !== null && runway < coverWeeks && !s.do_not_replenish && (
                        <span className="ml-1.5 text-[10px] font-semibold text-red-400">{runway}w runway</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text">{sold4}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{sold8}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text">{next4}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{next8}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">
                      {coverWeeks}w{s.cover_weeks != null && <span className="text-fitscript-green">*</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text">{wanted}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text">{stock}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-500">{onOrder || "—"}</td>
                    <td className="px-5 py-2 text-right">
                      {order > 0
                        ? <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-[11px] font-bold text-yellow-500">{order}</span>
                        : <span className="text-ops-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={10} className="px-5 py-10 text-center text-sm text-ops-text-muted">No sales in the last 8 weeks.</td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ops-border p-4">
          <span className="text-xs text-ops-text-muted">
            {toOrder.length
              ? `${toOrder.length} products short of ${cover}w cover + ${lead}w lead — ${totalUnits} units to order. * = per-product cover.`
              : `Stock + on-order covers ${cover} weeks + lead time everywhere.`}
          </span>
          {canEdit && (
            <button type="button" disabled={busy || !toOrder.length} onClick={createPo} className={ui.primary}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />} Create draft PO
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Picker({ label, suffix, value, onChange, choices }: {
  label: string; suffix?: string; value: number; onChange: (n: number) => void; choices: number[];
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-ops-text-muted">
      {label}
      <span className="inline-flex rounded-lg border border-ops-border bg-ops-bg p-0.5">
        {choices.map((w) => (
          <button key={w} type="button" onClick={() => onChange(w)}
            className={`rounded-md px-2 py-1 text-xs font-semibold tabular-nums transition ${w === value ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
            {w}w
          </button>
        ))}
      </span>
      {suffix && <span className="text-[10px]">{suffix}</span>}
    </label>
  );
}
