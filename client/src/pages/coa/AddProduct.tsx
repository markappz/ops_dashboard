import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, ui, type Sku } from "./api";
import { groupFamilies } from "./families";

/**
 * Add a product or a new variant (dose / form) of an existing one. Used from
 * the COA tab and the Inventory tab. Picking "variant of" pre-fills the name
 * prefix, SKU prefix, supplier, cover weeks and COA requirement from the
 * family so a new dose takes ten seconds and lands under the same card.
 */
const SUPPLIER_FALLBACK = ["Mike", "Caleb", "Ming", "Max", "Brent and Alan"];

export function AddProduct({ skus, onClose, onDone }: { skus: Sku[]; onClose: () => void; onDone: (msg: string) => void }) {
  const families = useMemo(() => groupFamilies(skus), [skus]);
  const supQ = useQuery({ queryKey: ["coa-suppliers"], queryFn: () => api<{ suppliers: string[] }>("/suppliers"), staleTime: 60_000 });
  const suppliers = supQ.data?.suppliers ?? SUPPLIER_FALLBACK;

  const [variantOf, setVariantOf] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [supplier, setSupplier] = useState("");
  const [target, setTarget] = useState("");
  const [cover, setCover] = useState("");
  const [stock, setStock] = useState("");
  const [alias, setAlias] = useState("");
  const [url, setUrl] = useState("");
  const [requiresCoa, setRequiresCoa] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickFamily = (key: string) => {
    setVariantOf(key);
    const f = families.find((x) => x.key === key);
    if (!f) return;
    const base = f.variants[0];
    setName(`${f.label} - `);
    setCode(base.sku_code.replace(/\d+[A-Z]*$/, ""));
    setSupplier(base.supplier ?? "");
    setCover(base.cover_weeks != null ? String(Number(base.cover_weeks)) : "");
    setRequiresCoa(base.requires_coa !== false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/skus", { method: "POST", body: JSON.stringify({
        product_name: name.trim(), sku_code: code.trim(), product_url: url.trim() || null, requires_coa: requiresCoa,
        supplier: supplier || null, ideal_stock: target === "" ? null : Number(target), cover_weeks: cover === "" ? null : Number(cover),
        coa_name: alias.trim() || null, initial_stock: stock === "" ? null : Number(stock),
      }) });
      onDone(`Added ${name.trim()} (${code.trim()})${stock ? ` with ${stock} in stock` : ""}${supplier ? ` · supplier ${supplier}` : ""}.${requiresCoa ? ' It shows as "Needs COA" until a certificate is filed.' : ""}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const numInput = (v: string, set: (s: string) => void, placeholder: string) => (
    <input value={v} inputMode="numeric" onChange={(e) => set(e.target.value.replace(/[^\d.]/g, ""))} className={ui.input} placeholder={placeholder} />
  );

  return (
    <div className={ui.modal} onClick={onClose}>
      <form onSubmit={submit} className={`${ui.sheet} max-w-xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Add a product</h2>
            <p className="text-xs text-ops-text-muted">New product, or a new variant of one already tracked.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <label className={ui.label}>Variant of (optional)</label>
            <select value={variantOf} onChange={(e) => pickFamily(e.target.value)} className={ui.input}>
              <option value="">— brand-new product —</option>
              {families.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.variants.length} variant{f.variants.length === 1 ? "" : "s"})</option>)}
            </select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className={ui.label}>Product name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={ui.input} placeholder="BPC-157 - 10mg (Injectable)" required /></div>
            <div><label className={ui.label}>SKU code</label><input value={code} onChange={(e) => setCode(e.target.value)} className={ui.input} placeholder="RP-BPC10V" required /></div>
            <div>
              <label className={ui.label}>Supplier</label>
              <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className={ui.input}>
                <option value="">— not set —</option>
                {suppliers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
              </select>
            </div>
            <div><label className={ui.label}>Starting stock (units on hand)</label>{numInput(stock, setStock, "0")}</div>
            <div><label className={ui.label}>Target on hand</label>{numInput(target, setTarget, "auto-set from sales every 4 weeks")}</div>
            <div><label className={ui.label}>Cover weeks</label>{numInput(cover, setCover, "6")}</div>
            <div><label className={ui.label}>Site name (if the store calls it something else)</label><input value={alias} onChange={(e) => setAlias(e.target.value)} className={ui.input} placeholder="matches website order lines" /></div>
            <div className="sm:col-span-2"><label className={ui.label}>Product page URL (optional)</label><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={ui.input} placeholder="https://www.realpeptides.co/products/bpc-157/" /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ops-text">
            <input type="checkbox" checked={requiresCoa} onChange={(e) => setRequiresCoa(e.target.checked)} className="h-4 w-4 rounded border-ops-border" />
            Needs a COA (untick for accessories like BAC water or supplies)
          </label>
          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={ui.ghost}>Cancel</button>
            <button type="submit" disabled={busy || !name.trim() || !code.trim()} className={ui.primary}>{busy ? "Adding…" : "Add product"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
