import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, UploadCloud, CheckCircle2, AlertCircle, Loader2, FileText, Trash2 } from "lucide-react";
import { api, ui, type Sku, type Lab } from "./api";

/**
 * Bulk COA uploader: drop a whole batch of certificates, the tracker matches
 * each filename to a product (and pulls the test date out of the name), you
 * fix anything it wasn't sure about, then everything files in one go through
 * the same upload endpoint the single-file form uses.
 */

interface MatchCandidate { id: number; sku_code: string; product_name: string }
interface FileMatch { file: string; test_date: string | null; sku: MatchCandidate | null; candidates: MatchCandidate[] }

interface Row {
  key: string;
  file: File;
  skuId: number | null;
  candidates: MatchCandidate[];
  autoMatched: boolean;
  testDate: string;
  purity: string;
  lot: string;
  state: "pending" | "uploading" | "done" | "error";
  error?: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const ACCEPT = /\.(pdf|png|jpe?g|webp)$/i;

export function BulkUpload({ skus, onClose, onDone }: { skus: Sku[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [lab, setLab] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  const labs = useQuery({ queryKey: ["coa-labs"], queryFn: () => api<{ labs: Lab[] }>("/labs") });
  const labName = lab || labs.data?.labs[0]?.name || "Kovera";
  const products = useMemo(
    () => skus.filter((s) => s.requires_coa).sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [skus],
  );
  const skuById = useMemo(() => new Map(products.map((s) => [s.id, s])), [products]);

  async function addFiles(list: FileList | File[]) {
    const files = [...list].filter((f) => ACCEPT.test(f.name));
    if (!files.length) return;
    setErr(null);
    try {
      const { matches } = await api<{ matches: FileMatch[] }>("/skus/match", {
        method: "POST",
        body: JSON.stringify({ files: files.map((f) => f.name) }),
      });
      const next = files.map((file, i): Row => {
        const m = matches[i];
        return {
          key: `${file.name}-${file.size}-${Date.now()}-${i}`,
          file,
          skuId: m.sku?.id ?? null,
          candidates: m.candidates,
          autoMatched: !!m.sku,
          testDate: m.test_date ?? today(),
          purity: "",
          lot: "",
          state: "pending",
        };
      });
      setRows((r) => [...r, ...next]);
    } catch (e: any) { setErr(`Matching failed: ${e.message}`); }
  }

  function patch(key: string, p: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  async function uploadOne(row: Row): Promise<Row> {
    const sku = row.skuId ? skuById.get(row.skuId) : null;
    if (!sku) return { ...row, state: "error", error: "Pick the product first." };
    const fd = new FormData();
    fd.append("file", row.file);
    fd.append("sku_code", sku.sku_code);
    fd.append("test_date", row.testDate);
    fd.append("lab_name", labName);
    if (row.purity.trim()) fd.append("purity", row.purity.trim());
    if (row.lot.trim()) fd.append("lot_number", row.lot.trim());
    const r = await fetch("/api/ops/realpeptides/coa/upload", { method: "POST", body: fd, credentials: "include" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ...row, state: "error", error: j.error || `HTTP ${r.status}` };
    return { ...row, state: "done", error: undefined };
  }

  async function uploadAll() {
    setBusy(true);
    let done = rows.filter((r) => r.state === "done").length;
    for (const row of rows) {
      if (row.state === "done") continue;
      patch(row.key, { state: "uploading", error: undefined });
      const result = await uploadOne(row);
      patch(row.key, result);
      if (result.state === "done") done++;
    }
    setBusy(false);
    const failed = rows.length - done;
    if (!failed) onDone(`Filed ${done} certificate${done === 1 ? "" : "s"} — statuses are updated.`);
  }

  const ready = rows.filter((r) => r.state !== "done" && r.skuId).length;
  const unassigned = rows.filter((r) => r.state !== "done" && !r.skuId).length;
  const doneCount = rows.filter((r) => r.state === "done").length;

  return (
    <div className={ui.modal} onClick={onClose}>
      <div className={`${ui.sheet} max-w-4xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Bulk COA upload</h2>
            <p className="text-xs text-ops-text-muted">Drop a whole batch — each file is matched to its product by name.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-ops-text-muted">Lab
              <select value={labName} onChange={(e) => setLab(e.target.value)} className={`${ui.input} w-auto py-1.5`}>
                {(labs.data?.labs ?? []).map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
              </select>
            </label>
            <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <input ref={pickRef} type="file" hidden multiple accept="application/pdf,.pdf,image/*" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <button
            type="button"
            onClick={() => pickRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            className={`flex w-full flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-sm transition ${dragOver ? "border-fitscript-green bg-fitscript-green/10 text-fitscript-green" : "border-ops-border text-ops-text-muted hover:border-fitscript-green/50"}`}
          >
            <UploadCloud size={22} />
            <span><span className="font-semibold text-ops-text">Drop COAs here</span> or click to choose — PDF or image, as many as you like</span>
          </button>

          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}

          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-ops-border">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Test date</th>
                    <th className="px-3 py-2 font-medium">Lot</th>
                    <th className="px-3 py-2 font-medium">Purity</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ops-border/50">
                  {rows.map((r) => (
                    <BulkRow key={r.key} row={r} products={products} disabled={busy || r.state === "done"}
                      onPatch={(p) => patch(r.key, p)} onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-ops-text-muted">
              {rows.length > 0 && <>
                {doneCount > 0 && <span className="text-fitscript-green">{doneCount} filed · </span>}
                {unassigned > 0 ? <span className="text-yellow-500">{unassigned} need{unassigned === 1 ? "s" : ""} a product picked · </span> : null}
                every file goes to <span className="text-ops-text">{labName}</span>'s column as tested that day
              </>}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={ui.ghost}>{doneCount ? "Close" : "Cancel"}</button>
              <button type="button" onClick={uploadAll} disabled={busy || !ready} className={ui.primary}>
                {busy ? <><Loader2 size={15} className="animate-spin" /> Uploading…</> : `Upload ${ready || ""} certificate${ready === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkRow({ row, products, disabled, onPatch, onRemove }: {
  row: Row; products: Sku[]; disabled: boolean; onPatch: (p: Partial<Row>) => void; onRemove: () => void;
}) {
  const candidateIds = new Set(row.candidates.map((c) => c.id));
  const rest = products.filter((p) => !candidateIds.has(p.id));
  return (
    <tr data-state={row.state} className={row.state === "done" ? "opacity-60" : undefined}>
      <td className="max-w-[180px] px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs text-ops-text"><FileText size={13} className="shrink-0 text-fitscript-green" /><span className="truncate" title={row.file.name}>{row.file.name}</span></span>
        {row.state === "error" && <span className="mt-0.5 block text-[11px] text-red-400">{row.error}</span>}
      </td>
      <td className="px-3 py-2">
        <select value={row.skuId ?? ""} disabled={disabled}
          onChange={(e) => onPatch({ skuId: e.target.value ? +e.target.value : null, autoMatched: false })}
          className={`${ui.input} py-1.5 ${!row.skuId ? "border-yellow-500/60" : ""}`}>
          <option value="">— pick product —</option>
          {row.candidates.length > 0 && (
            <optgroup label="Suggested">
              {row.candidates.map((c) => <option key={c.id} value={c.id}>{c.product_name} ({c.sku_code})</option>)}
            </optgroup>
          )}
          <optgroup label={row.candidates.length ? "All products" : "Products"}>
            {rest.map((p) => <option key={p.id} value={p.id}>{p.product_name} ({p.sku_code})</option>)}
          </optgroup>
        </select>
        {row.autoMatched && <span className="mt-0.5 block text-[10px] text-fitscript-green">auto-matched</span>}
      </td>
      <td className="px-3 py-2"><input type="date" value={row.testDate} max={today()} disabled={disabled} onChange={(e) => onPatch({ testDate: e.target.value })} className={`${ui.input} w-36 py-1.5`} /></td>
      <td className="px-3 py-2"><input value={row.lot} disabled={disabled} onChange={(e) => onPatch({ lot: e.target.value })} placeholder="Lot #" className={`${ui.input} w-24 py-1.5`} /></td>
      <td className="px-3 py-2"><input value={row.purity} disabled={disabled} onChange={(e) => onPatch({ purity: e.target.value })} placeholder="99.4%" className={`${ui.input} w-20 py-1.5`} /></td>
      <td className="px-3 py-2 text-right">
        {row.state === "uploading" ? <Loader2 size={15} className="inline animate-spin text-fitscript-green" />
          : row.state === "done" ? <CheckCircle2 size={15} className="inline text-fitscript-green" />
          : row.state === "error" ? <AlertCircle size={15} className="inline text-red-400" />
          : <button type="button" onClick={onRemove} className="p-1 text-ops-text-muted hover:text-red-400" title="Remove"><Trash2 size={14} /></button>}
      </td>
    </tr>
  );
}
