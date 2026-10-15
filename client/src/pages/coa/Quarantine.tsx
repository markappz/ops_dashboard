import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, PackageCheck } from "lucide-react";
import { ui, fetchQuarantine, releaseQuarantine, type Quarantine } from "./api";

/**
 * Quarantined receipts awaiting their COA. Units are received against a PO but
 * held out of live stock; releasing a lot (COA received/approved) returns the
 * units to sellable inventory and stamps the result. Hidden when nothing is held.
 */
export function QuarantinePanel({ canEdit, onSay }: { canEdit: boolean; onSay: (m: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["coa-quarantine"], queryFn: fetchQuarantine });
  const active = (q.data ?? []).filter((r) => r.status === "sent_to_lab" && r.qty - r.released_qty > 0);
  if (!active.length) return null;
  const done = (m: string) => {
    qc.invalidateQueries({ queryKey: ["coa-quarantine"] });
    qc.invalidateQueries({ queryKey: ["coa-skus"] });
    onSay(m);
  };
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-600">
        <FlaskConical size={16} /> Quarantine — sent to lab ({active.length})
      </div>
      <div className="space-y-2">
        {active.map((r) => <Row key={r.id} row={r} canEdit={canEdit} onDone={done} />)}
      </div>
    </div>
  );
}

function Row({ row, canEdit, onDone }: { row: Quarantine; canEdit: boolean; onDone: (m: string) => void }) {
  const open = row.qty - row.released_qty;
  const [qty, setQty] = useState(String(open));
  const [result, setResult] = useState<"approved" | "received">("approved");
  const [busy, setBusy] = useState(false);
  async function release() {
    const n = Math.min(Number(qty) || 0, open);
    if (n <= 0) return;
    setBusy(true);
    try { await releaseQuarantine(row.id, n, result); onDone(`Released ${n} ${row.product_name ?? "units"} to live — COA ${result}.`); }
    catch (e: any) { onDone(`Failed: ${e.message}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ops-border bg-ops-surface px-3 py-2 text-xs">
      <div className="min-w-0">
        <span className="block truncate font-medium text-ops-text">{row.product_name} <span className="text-ops-text-muted">({row.sku_code})</span></span>
        <span className="text-[11px] text-amber-600">Sent to lab {row.sent_date}{row.lab_name ? ` · ${row.lab_name}` : ""}{row.lot ? ` · lot ${row.lot}` : ""}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap font-semibold tabular-nums text-ops-text">{open} held</span>
        {canEdit && (
          <>
            <input value={qty} inputMode="numeric" onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
              className="h-7 w-16 rounded-md border border-ops-border bg-ops-bg px-1 text-center tabular-nums text-ops-text focus:border-fitscript-green focus:outline-none" />
            <select value={result} onChange={(e) => setResult(e.target.value as "approved" | "received")}
              className="h-7 rounded-md border border-ops-border bg-ops-bg px-1 text-xs text-ops-text focus:border-fitscript-green focus:outline-none">
              <option value="approved">Approved</option>
              <option value="received">Received</option>
            </select>
            <button type="button" disabled={busy} onClick={release} className={`${ui.primary} px-2.5 py-1.5 text-xs`}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />} Release
            </button>
          </>
        )}
      </div>
    </div>
  );
}
