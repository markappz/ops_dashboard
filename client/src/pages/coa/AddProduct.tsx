import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImagePlus, X } from "lucide-react";
import { api, ui, type Sku } from "./api";
import { groupFamilies } from "./families";

/**
 * Add SKU — writes the storefront AND inventory in one go. Pick the parent
 * product from the site's own list (a new dose lands under that card on both
 * sides), or name a brand-new product (created as a site DRAFT so the copy
 * gets finished in the site admin before it goes live). The photo becomes the
 * variant image, or the product image for a new product. Used from the COA
 * tab and the Inventory tab.
 */
const SUPPLIER_FALLBACK = ["Mike", "Caleb", "Ming", "Max", "Brent and Alan"];
const CATALOG = "/api/ops/realpeptides/catalog";

interface SiteProduct { id: string; name: string; slug: string; status: string; image: string | null; variantCount: number }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function postSku(form: FormData) {
  const res = await fetch(`${CATALOG}/sku`, { method: "POST", body: form, credentials: "include" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json as { site: { created: "variant" | "product"; product: { name: string; slug: string; status: string; url: string } } };
}

/** Ops family whose name matches the site product — prefills SKU prefix, supplier, cover weeks, COA rule. */
function matchFamily(product: SiteProduct | undefined, families: ReturnType<typeof groupFamilies>) {
  if (!product) return undefined;
  const target = norm(product.name);
  return families.find((f) => norm(f.label) === target) ?? families.find((f) => target.startsWith(norm(f.label)) || norm(f.label).startsWith(target));
}

export function AddProduct({ skus, onClose, onDone }: { skus: Sku[]; onClose: () => void; onDone: (msg: string) => void }) {
  const families = useMemo(() => groupFamilies(skus), [skus]);
  const supQ = useQuery({ queryKey: ["coa-suppliers"], queryFn: () => api<{ suppliers: string[] }>("/suppliers"), staleTime: 60_000 });
  const prodQ = useQuery({ queryKey: ["rp-site-products"], queryFn: async () => (await (await fetch(`${CATALOG}/products`, { credentials: "include" })).json()) as { products?: SiteProduct[]; error?: string }, staleTime: 60_000 });
  const suppliers = supQ.data?.suppliers ?? SUPPLIER_FALLBACK;
  const products = prodQ.data?.products ?? [];

  const [mode, setMode] = useState<"variant" | "new">("variant");
  const [parentId, setParentId] = useState("");
  const [newName, setNewName] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [weight, setWeight] = useState("");
  const [packEligible, setPackEligible] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [supplier, setSupplier] = useState("");
  const [target, setTarget] = useState("");
  const [cover, setCover] = useState("");
  const [stock, setStock] = useState("");
  const [alias, setAlias] = useState("");
  const [requiresCoa, setRequiresCoa] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parent = products.find((p) => p.id === parentId);
  const family = useMemo(() => matchFamily(parent, families), [parent, families]);
  const baseName = mode === "variant" ? parent?.name ?? "" : newName.trim();
  const productName = baseName && label.trim() ? `${baseName} - ${label.trim()}` : "";

  useEffect(() => {
    if (!family) return;
    const base = family.variants[0];
    setCode((c) => c || base.sku_code.replace(/\d+[A-Z]*$/, ""));
    setSupplier((s) => s || base.supplier || "");
    setCover((c) => c || (base.cover_weeks != null ? String(Number(base.cover_weeks)) : ""));
    setRequiresCoa(base.requires_coa !== false);
  }, [family]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const form = new FormData();
    const fields: Record<string, string> = {
      sku_code: code.trim(), variant_label: label.trim(), price, compare_at: compareAt, weight_grams: weight, pack_eligible: String(packEligible),
      site_product_id: mode === "variant" ? parentId : "", new_product_name: mode === "new" ? newName.trim() : "", product_name: productName,
      supplier, ideal_stock: target, cover_weeks: cover, coa_name: alias.trim(), initial_stock: stock, requires_coa: String(requiresCoa),
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (image) form.append("image", image);
    try {
      const { site } = await postSku(form);
      onDone(doneMessage(site, productName, code.trim(), stock));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const canSubmit = !busy && !!label.trim() && !!code.trim() && price !== "" && (mode === "variant" ? !!parentId : !!newName.trim());

  return (
    <div className={ui.modal} onClick={onClose}>
      <form onSubmit={submit} className={`${ui.sheet} max-w-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-ops-border p-5">
          <div>
            <h2 className="text-base font-semibold text-ops-text">Add SKU</h2>
            <p className="text-xs text-ops-text-muted">Goes on the website and into inventory together. A new dose of a product you already sell, or a brand-new product.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-ops-text-muted hover:text-ops-text"><X size={20} /></button>
        </div>
        <div className="space-y-5 p-5">
          <ParentPicker mode={mode} setMode={setMode} parentId={parentId} setParentId={setParentId} newName={newName} setNewName={setNewName} products={products} loadError={prodQ.data?.error ?? (prodQ.isError ? "Couldn't load the site's product list." : null)} loading={prodQ.isLoading} />

          <Section title="Variant details" hint={productName ? `Will be listed as “${productName}”` : "The dose or form this SKU is, and what it sells for."}>
            <div><label className={ui.label}>Dose / form label</label><input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className={ui.input} placeholder="20mg" required /></div>
            <div><label className={ui.label}>SKU code</label><input value={code} onChange={(e) => setCode(e.target.value)} className={ui.input} placeholder="RP-PIN20V" required /></div>
            <div><label className={ui.label}>Price (USD)</label><NumInput v={price} set={setPrice} placeholder="89.00" /></div>
            <div><label className={ui.label}>Compare-at price (optional)</label><NumInput v={compareAt} set={setCompareAt} placeholder="shows as struck-through" /></div>
            <div><label className={ui.label}>Shipping weight, grams (optional)</label><NumInput v={weight} set={setWeight} placeholder="" /></div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-ops-text">
              <input type="checkbox" checked={packEligible} onChange={(e) => setPackEligible(e.target.checked)} className="h-4 w-4 rounded border-ops-border" />
              Counts toward Build-a-Pack discounts
            </label>
          </Section>

          <PhotoPicker image={image} setImage={setImage} mode={mode} parent={parent} />

          <Section title="Inventory" hint="What the tracker needs. Stock is set here and syncs to the site within 15 minutes.">
            <div><label className={ui.label}>Starting stock (units on hand)</label><NumInput v={stock} set={setStock} placeholder="0" /></div>
            <div>
              <label className={ui.label}>Supplier</label>
              <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className={ui.input}>
                <option value="">— not set —</option>
                {suppliers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
              </select>
            </div>
            <div><label className={ui.label}>Target on hand</label><NumInput v={target} set={setTarget} placeholder="auto-set from sales every 4 weeks" /></div>
            <div><label className={ui.label}>Cover weeks</label><NumInput v={cover} set={setCover} placeholder="6" /></div>
            <div className="sm:col-span-2"><label className={ui.label}>Site name alias (only if order lines call it something else)</label><input value={alias} onChange={(e) => setAlias(e.target.value)} className={ui.input} placeholder="matches website order lines" /></div>
            <label className="flex items-center gap-2 text-sm text-ops-text sm:col-span-2">
              <input type="checkbox" checked={requiresCoa} onChange={(e) => setRequiresCoa(e.target.checked)} className="h-4 w-4 rounded border-ops-border" />
              Needs a COA (untick for accessories like BAC water or supplies)
            </label>
          </Section>

          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-ops-text-muted">{mode === "new" ? "New products go on the site as a draft — finish the description in the site admin, then publish." : parent?.status === "DRAFT" ? "This product is still a draft on the site; the dose shows once it's published." : "The dose goes live on the product page right away."}</p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={ui.ghost}>Cancel</button>
              <button type="submit" disabled={!canSubmit} className={ui.primary}>{busy ? "Adding…" : "Add SKU"}</button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function doneMessage(site: { created: "variant" | "product"; product: { name: string; url: string } }, productName: string, code: string, stock: string) {
  const where = site.created === "product" ? `created ${site.product.name} as a draft on the site` : `added to ${site.product.name} on the site (${site.product.url})`;
  return `Added ${productName} (${code}) — ${where}${stock ? `, ${stock} in stock` : ""}. Inventory row created.`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-ops-border p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ops-text-muted">{title}</legend>
      {hint && <p className="mb-3 text-xs text-ops-text-muted">{hint}</p>}
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function NumInput({ v, set, placeholder }: { v: string; set: (s: string) => void; placeholder: string }) {
  return <input value={v} inputMode="decimal" onChange={(e) => set(e.target.value.replace(/[^\d.]/g, ""))} className={ui.input} placeholder={placeholder} />;
}

function ParentPicker(p: { mode: "variant" | "new"; setMode: (m: "variant" | "new") => void; parentId: string; setParentId: (s: string) => void; newName: string; setNewName: (s: string) => void; products: SiteProduct[]; loadError: string | null; loading: boolean }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = norm(q);
    return t ? p.products.filter((x) => norm(x.name).includes(t)) : p.products;
  }, [q, p.products]);
  const tab = (m: "variant" | "new", text: string) => (
    <button type="button" onClick={() => p.setMode(m)} className={`rounded-lg px-3 py-1.5 text-sm ${p.mode === m ? "bg-fitscript-green text-white" : "border border-ops-border text-ops-text-muted hover:text-ops-text"}`}>{text}</button>
  );
  return (
    <fieldset className="rounded-xl border border-ops-border p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ops-text-muted">Where it goes on the site</legend>
      <div className="mb-3 flex gap-2">{tab("variant", "New dose of an existing product")}{tab("new", "Brand-new product")}</div>
      {p.mode === "variant" ? (
        <div className="space-y-2">
          {p.loadError && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">{p.loadError}</div>}
          <input value={q} onChange={(e) => setQ(e.target.value)} className={ui.input} placeholder={p.loading ? "Loading the site's products…" : "Search products on the site…"} />
          <select value={p.parentId} onChange={(e) => p.setParentId(e.target.value)} className={ui.input} size={Math.min(8, Math.max(3, shown.length))} required>
            {shown.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.variantCount} variant{x.variantCount === 1 ? "" : "s"}{x.status !== "ACTIVE" ? ` · ${x.status.toLowerCase()}` : ""}</option>)}
          </select>
        </div>
      ) : (
        <div><label className={ui.label}>Product name</label><input value={p.newName} onChange={(e) => p.setNewName(e.target.value)} className={ui.input} placeholder="Pinealon" required /></div>
      )}
    </fieldset>
  );
}

function PhotoPicker({ image, setImage, mode, parent }: { image: File | null; setImage: (f: File | null) => void; mode: "variant" | "new"; parent?: SiteProduct }) {
  const ref = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setPreview(null); return; }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const fallback = mode === "variant" ? parent?.image ?? null : null;
  const hint = mode === "variant" ? "Optional — without one the dose uses the product's photo." : "Becomes the product photo on the site.";
  return (
    <fieldset className="rounded-xl border border-ops-border p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ops-text-muted">Photo</legend>
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-ops-border bg-ops-bg">
          {preview || fallback ? <img src={preview ?? fallback ?? ""} alt="" className="h-full w-full object-cover" /> : <ImagePlus size={22} className="text-ops-text-muted" />}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-ops-text-muted">{hint} JPG, PNG or WebP up to 8MB.</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => ref.current?.click()} className={ui.ghost}>{image ? "Change photo" : "Choose photo"}</button>
            {image && <button type="button" onClick={() => { setImage(null); if (ref.current) ref.current.value = ""; }} className={ui.ghost}>Remove</button>}
          </div>
          {image && <p className="text-[11px] text-ops-text-muted">{image.name} · {(image.size / 1024).toFixed(0)} KB</p>}
        </div>
      </div>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
    </fieldset>
  );
}
