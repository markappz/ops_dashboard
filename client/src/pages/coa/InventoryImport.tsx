import { useMemo, useRef, useState } from "react";
import { X, UploadCloud, CheckCircle2, AlertCircle, Loader2, FileDown } from "lucide-react";
import { api, ui, type Sku } from "./api";
import { stockNum } from "./order-pdf";

/**
 * Spreadsheet import/export for inventory.
 *
 * Import: drop a CSV or XLSX (Shelf Planner exports, Justin's master sheet,
 * anything with a SKU column), preview every change as old → new, then apply —
 * counts go through the audited stock route (note carries the filename), and
 * targets through the same PATCH the UI uses. Rows we can't match are listed,
 * never guessed. Export: the current inventory as a CSV that round-trips
 * straight back into this importer.
 */

interface Row {
  sku_code: string;
  skuId: number | null;
  name: string;
  stock: number | null;        // parsed new count (null = column absent/blank)
  target: number | null;
  labelStock: number | null;
  labelTarget: number | null;
  oldStock: number | null;
  oldTarget: number | null;
  changed: boolean;
  state: "pending" | "applying" | "done" | "error";
  error?: string;
}

const HEADER_MAP: [RegExp, keyof Pick<Row, "stock" | "target" | "labelStock" | "labelTarget"> | "sku"][] = [
  [/^(sku|sku[ _-]?code)$/i, "sku"],
  [/^(current[ _-]?stock|stock|in[ _-]?stock|on[ _-]?hand|qty|quantity|count|units)$/i, "stock"],
  [/^(ideal[ _-]?stock|target|restock[ _-]?target|ideal)$/i, "target"],
  [/^(label[ _-]?stock|labels[ _-]?on[ _-]?hand|labels)$/i, "labelStock"],
  [/^(label[ _-]?ideal|label[ _-]?target)$/i, "labelTarget"],
];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

export function exportInventoryCsv(skus: Sku[]): void {
  const head = ["SKU", "Product", "Form", "Current Stock", "Ideal Stock", "On Order", "Label Stock", "Label Ideal"];
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head, ...skus.map((s) => [
    s.sku_code, s.product_name, s.form ?? "", stockNum(s.current_stock) ?? "", stockNum(s.ideal_stock) ?? "",
    stockNum(s.on_order) ?? "", stockNum(s.label_stock) ?? "", stockNum(s.label_ideal) ?? "",
  ])].map((r) => r.map(esc).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `real-peptides-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function InventoryImport({ skus, onClose, onDone }: { skus: Sku[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);

  const byCode = useMemo(() => new Map(skus.map((s) => [s.sku_code.toUpperCase(), s])), [skus]);

  async function parseFile(f: File) {
    setErr(null); setFileName(f.name);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (!grid.length) throw new Error("The file is empty.");

      const header = grid[0].map((h) => String(h).trim());
      const cols: Partial<Record<"sku" | "stock" | "target" | "labelStock" | "labelTarget", number>> = {};
      header.forEach((h, idx) => {
        for (const [re, key] of HEADER_MAP) if (re.test(h) && cols[key] === undefined) cols[key] = idx;
      });
      if (cols.sku === undefined) throw new Error(`No SKU column found. Headers seen: ${header.filter(Boolean).join(", ")}`);
      if (cols.stock === undefined && cols.target === undefined && cols.labelStock === undefined && cols.labelTarget === undefined) {
        throw new Error("No stock/target columns found — nothing to import.");
      }

      const parsed: Row[] = [];
      const missing: string[] = [];
      for (const raw of grid.slice(1)) {
        const code = String(raw[cols.sku!] ?? "").trim();
        if (!code) continue;
        const sku = byCode.get(code.toUpperCase());
        const stock = cols.stock !== undefined ? num(raw[cols.stock]) : null;
        const target = cols.target !== undefined ? num(raw[cols.target]) : null;
        const labelStock = cols.labelStock !== undefined ? num(raw[cols.labelStock]) : null;
        const labelTarget = cols.labelTarget !== undefined ? num(raw[cols.labelTarget]) : null;
        if (!sku) { missing.push(code); continue; }
        const oldStock = stockNum(sku.current_stock);
        const oldTarget = stockNum(sku.ideal_stock);
        const changed =
          (stock !== null && stock !== (oldStock ?? -1)) ||
          (target !== null && target !== (oldTarget ?? -1)) ||
          (labelStock !== null && labelStock !== (stockNum(sku.label_stock) ?? -1)) ||
          (labelTarget !== null && labelTarget !== (stockNum(sku.label_ideal) ?? -1));
        parsed.push({
          sku_code: sku.sku_code, skuId: sku.id, name: sku.product_name,
          stock, target, labelStock, labelTarget, oldStock, oldTarget,
          changed, state: "pending",
        });
      }
      parsed.sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name));
      setRows(parsed);
      setUnknown(missing);
      if (!parsed.length) setErr("No rows matched the catalog.");
    } catch (e: any) { setErr(e.message); setRows([]); setUnknown([]); }
  }

  async function apply() {
    setBusy(true);
    let applied = 0;
    for (const row of rows) {
      if (!row.changed || row.state === "done") continue;
      setRows((rs) => rs.map((r) => (r === row ? { ...r, state: "applying" } : r)));
      try {
        if (row.stock !== null) {
          await api(`/skus/${row.skuId}/stock`, { method: "POST", body: JSON.stringify({ set: row.stock, item: "product", note: `spreadsheet import: ${fileName}` }) });
        }
        if (row.labelStock !== null) {
          await api(`/skus/${row.skuId}/stock`, { method: "POST", body: JSON.stringify({ set: row.labelStock, item: "label", note: `spreadsheet import: ${fileName}` }) });
        }
        if (row.target !== null || row.labelTarget !== null) {
          const body: Record<string, number> = {};
          if (row.target !== null) body.ideal_stock = row.target;
          if (row.labelTarget !== null) body.label_ideal = row.labelTarget;
          await api(`/skus/${row.skuId}`, { method: "PATCH", body: JSON.stringify(body) });
        }
        applied++;
        setRows((rs) => rs.map((r) => (r.sku_code === row.sku_code ? { ...r, state: "done" } : r)));
      } catch (e: any) {
        setRows((rs) => rs.map((r) => (r.sku_code === row.sku_code ? { ...r, state: "error", error: e.message } : r)));
      }
    }
    setBusy(false);
    const failed = rows.filter((r) => r.state === "error").length;
    if (!failed) onDone(`Imported ${applied} product${applied === 1 ? "" : "s"} from ${fileName} — every change is in the audit log.`);
  }

  const toApply = rows.filter((r) => r.changed && r.state !== "done").length;
  const unchanged = rows.filter((r) => !r.changed).length;

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-3xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Import inventory from a spreadsheet</h2>
            <p className="text-xs text-ops-text-muted">CSV or Excel with a SKU column — counts and targets update in one pass, all audited.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>

        <div className="space-y-4 p-5">
          <input ref={pickRef} type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = ""; }} />
          {!rows.length && (
            <button type="button" onClick={() => pickRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) parseFile(f); }}
              className={`flex w-full flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-8 text-sm transition ${dragOver ? "border-fitscript-green bg-fitscript-green/10 text-fitscript-green" : "border-ops-border text-ops-text-muted hover:border-fitscript-green/50"}`}>
              <UploadCloud size={22} />
              <span><span className="font-semibold text-ops-text">Drop a spreadsheet here</span> or click to choose (.xlsx or .csv)</span>
              <span className="text-[11px]">Recognized columns: SKU · Current Stock · Ideal Stock · Label Stock · Label Ideal — extra columns are ignored.</span>
            </button>
          )}

          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
          {unknown.length > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
              {unknown.length} SKU{unknown.length === 1 ? "" : "s"} not in the catalog (skipped): {unknown.slice(0, 8).join(", ")}{unknown.length > 8 ? "…" : ""}
            </div>
          )}

          {rows.length > 0 && (
            <>
              <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-ops-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ops-surface">
                    <tr className="border-b border-ops-border text-[10px] uppercase tracking-wider text-ops-text-muted">
                      <th className="px-3 py-2 text-left font-medium">Product</th>
                      <th className="px-3 py-2 text-right font-medium">Stock</th>
                      <th className="px-3 py-2 text-right font-medium">Target</th>
                      <th className="px-3 py-2 text-right font-medium">Labels</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ops-border/50">
                    {rows.map((r) => (
                      <tr key={r.sku_code} className={r.changed ? undefined : "opacity-45"}>
                        <td className="px-3 py-2">
                          <span className="text-ops-text">{r.name}</span>
                          <span className="ml-1.5 text-[10px] text-ops-text-muted">{r.sku_code}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.stock === null ? <span className="text-ops-text-muted">—</span>
                            : r.stock === r.oldStock ? <span className="text-ops-text-muted">{r.stock}</span>
                            : <span><span className="text-ops-text-muted line-through">{r.oldStock ?? "—"}</span> <span className="font-semibold text-fitscript-green">{r.stock}</span></span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.target === null ? <span className="text-ops-text-muted">—</span>
                            : r.target === r.oldTarget ? <span className="text-ops-text-muted">{r.target}</span>
                            : <span><span className="text-ops-text-muted line-through">{r.oldTarget ?? "—"}</span> <span className="font-semibold text-fitscript-green">{r.target}</span></span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">
                          {r.labelStock ?? "—"}{r.labelTarget !== null ? ` / ${r.labelTarget}` : ""}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {r.state === "applying" ? <Loader2 size={13} className="inline animate-spin text-fitscript-green" />
                            : r.state === "done" ? <CheckCircle2 size={13} className="inline text-fitscript-green" />
                            : r.state === "error" ? <span title={r.error}><AlertCircle size={13} className="inline text-red-400" /></span>
                            : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-ops-text-muted">{toApply} to update · {unchanged} unchanged · from <span className="text-ops-text">{fileName}</span></span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setRows([]); setUnknown([]); }} className={ui.ghost} disabled={busy}>Choose another file</button>
                  <button type="button" onClick={apply} disabled={busy || !toApply} className={ui.primary}>
                    {busy ? <><Loader2 size={15} className="animate-spin" /> Applying…</> : `Apply ${toApply} change${toApply === 1 ? "" : "s"}`}
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="border-t border-ops-border pt-3 text-[11px] text-ops-text-muted">
            <FileDown size={11} className="mr-1 inline" /> Need a starting point? The Export button on the Inventory tab produces a CSV that round-trips straight back into this importer.
          </div>
        </div>
      </div>
    </div>
  );
}
