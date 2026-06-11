import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

const j = (url: string) => fetch(url).then((r) => r.json());

/** Full-page lab PANEL editor (product catalog CMS). Route /labs/panel/:slug ("new" to create). */
export default function LabsPanelEdit({ slug }: { slug: string }) {
  const isNew = slug === "new";
  const existing = useQuery<{ panel: any }>({
    queryKey: ["labs-panel", slug], queryFn: () => j(`/api/ops/labs/panels/${slug}`), enabled: !isNew,
  });
  if (!isNew && existing.isLoading) return <div className="p-8 text-ops-text-muted">Loading…</div>;
  return <PanelForm isNew={isNew} p={existing.data?.panel || {}} />;
}

function PanelForm({ isNew, p }: { isNew: boolean; p: any }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    slug: p.slug || "",
    name: p.name || "",
    subtitle: p.subtitle || "",
    shortDescription: p.short_description || "",
    description: p.description || "",
    priceDollars: p.price_cents != null ? (p.price_cents / 100).toFixed(2) : "",
    markersCount: p.markers_count ?? "",
    turnaround: p.turnaround || "",
    tag: p.tag || "",
    panelType: p.panel_type || "specialty",
    category: p.category || "",
    fasting: p.fasting ?? false,
    popular: p.popular ?? false,
    isActive: p.is_active ?? true,
    imageUrl: p.image_url || "",
  });
  // Nested content edited as JSON (admin-grade). Pretty-printed for editing.
  const [json, setJson] = useState({
    benefits: JSON.stringify(p.benefits ?? [], null, 2),
    categories: JSON.stringify(p.categories ?? [], null, 2),
    bestFor: JSON.stringify(p.best_for ?? [], null, 2),
    faqs: JSON.stringify(p.faqs ?? [], null, 2),
  });
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));
  const setJ = (k: string, v: string) => setJson((s) => ({ ...s, [k]: v }));
  const [uploading, setUploading] = useState(false);
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch("/api/ops/labs/upload-image", { method: "POST", body: fd }).then((x) => x.json());
      if (r?.url) set("imageUrl", r.url); else alert(r?.error || "upload failed");
    } catch (e: any) { alert(e.message); } finally { setUploading(false); }
  };

  const save = useMutation({
    mutationFn: () => {
      let parsed: any = {};
      try {
        parsed = {
          benefits: JSON.parse(json.benefits || "[]"),
          categories: JSON.parse(json.categories || "[]"),
          bestFor: JSON.parse(json.bestFor || "[]"),
          faqs: JSON.parse(json.faqs || "[]"),
        };
        setJsonErr(null);
      } catch (e: any) { setJsonErr("Invalid JSON in content fields: " + e.message); throw e; }
      const body: any = {
        slug: f.slug, name: f.name, subtitle: f.subtitle, shortDescription: f.shortDescription,
        description: f.description, priceCents: f.priceDollars === "" ? null : Math.round(parseFloat(f.priceDollars) * 100),
        markersCount: f.markersCount === "" ? null : Number(f.markersCount), turnaround: f.turnaround,
        tag: f.tag, panelType: f.panelType, category: f.category, fasting: f.fasting, popular: f.popular,
        isActive: f.isActive, imageUrl: f.imageUrl, ...parsed,
      };
      const url = isNew ? "/api/ops/labs/panels" : `/api/ops/labs/panels/${p.slug}`;
      return fetch(url, { method: isNew ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    },
    onSuccess: (d) => { if (d?.error) alert(d.error); else { qc.invalidateQueries({ queryKey: ["labs-panels"] }); navigate("/labs"); } },
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/labs")} className="text-sm text-ops-text-muted hover:text-ops-text">← Back to Labs</button>
      <PageHero title={isNew ? "New Panel" : `Edit panel: ${f.name}`} subtitle="Product catalog content — shown on the public site. No patient data." />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Box title="Basics">
          <Row label="Slug"><input value={f.slug} onChange={(e) => set("slug", e.target.value)} disabled={!isNew} className="ops-input disabled:opacity-60" placeholder="fitscript-baseline" /></Row>
          <Row label="Name"><input value={f.name} onChange={(e) => set("name", e.target.value)} className="ops-input" /></Row>
          <Row label="Subtitle"><input value={f.subtitle} onChange={(e) => set("subtitle", e.target.value)} className="ops-input" /></Row>
          <Row label="Short description"><input value={f.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} className="ops-input" /></Row>
          <Row label="Description"><textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={4} className="ops-input resize-y" /></Row>
        </Box>
        <Box title="Pricing & meta">
          <Row label="Price USD"><input type="number" step="0.01" value={f.priceDollars} onChange={(e) => set("priceDollars", e.target.value)} className="ops-input" /></Row>
          <Row label="Markers count"><input type="number" value={f.markersCount} onChange={(e) => set("markersCount", e.target.value)} className="ops-input" /></Row>
          <Row label="Turnaround"><input value={f.turnaround} onChange={(e) => set("turnaround", e.target.value)} className="ops-input" placeholder="3-5 days" /></Row>
          <Row label="Tag"><input value={f.tag} onChange={(e) => set("tag", e.target.value)} className="ops-input" placeholder="Most popular" /></Row>
          <Row label="Type">
            <select value={f.panelType} onChange={(e) => set("panelType", e.target.value)} className="ops-input">
              <option value="core">core</option><option value="specialty">specialty</option>
            </select>
          </Row>
          <Row label="Category"><input value={f.category} onChange={(e) => set("category", e.target.value)} className="ops-input" /></Row>
          <div className="flex gap-6 pt-1">
            <Toggle label="Fasting" on={f.fasting} onClick={() => set("fasting", !f.fasting)} />
            <Toggle label="Popular" on={f.popular} onClick={() => set("popular", !f.popular)} />
            <Toggle label="Active" on={f.isActive} onClick={() => set("isActive", !f.isActive)} />
          </div>
        </Box>
      </div>

      <Box title="Image">
        <div className="flex items-center gap-4">
          {f.imageUrl ? <img src={f.imageUrl} alt="" className="w-20 h-20 rounded-lg object-cover border border-ops-border" />
            : <div className="w-20 h-20 rounded-lg border border-dashed border-ops-border flex items-center justify-center text-ops-text-muted text-xs">none</div>}
          <label className="px-4 py-2 rounded-lg text-sm bg-ops-bg border border-ops-border text-ops-text cursor-pointer hover:border-fitscript-green w-fit">
            {uploading ? "Uploading…" : f.imageUrl ? "Replace" : "Upload image"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0])} disabled={uploading} />
          </label>
          {f.imageUrl && <button onClick={() => set("imageUrl", "")} className="text-xs text-ops-text-muted hover:text-red-400">Remove</button>}
        </div>
      </Box>

      <Box title="Content (structured — JSON)">
        <p className="text-xs text-ops-text-muted -mt-2">Benefits, biomarker categories, "best for", and FAQs. Edit as JSON; saved to the live catalog.</p>
        {(["benefits", "categories", "bestFor", "faqs"] as const).map((k) => (
          <Row key={k} label={k}>
            <textarea value={(json as any)[k]} onChange={(e) => setJ(k, e.target.value)} rows={k === "categories" || k === "faqs" ? 8 : 4}
              className="ops-input resize-y font-mono text-xs leading-relaxed" spellCheck={false} />
          </Row>
        ))}
        {jsonErr && <div className="text-xs text-red-400">{jsonErr}</div>}
      </Box>

      <div className="flex justify-end gap-3 sticky bottom-0 bg-ops-bg/80 backdrop-blur py-4 border-t border-ops-border">
        <button onClick={() => navigate("/labs")} className="px-5 py-2 rounded-lg text-sm text-ops-text-muted hover:text-ops-text">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || uploading || !f.slug || !f.name}
          className="px-6 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold hover:opacity-90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save panel"}
        </button>
      </div>
    </div>
  );
}

function Box({ title, children }: { title: string; children: any }) {
  return <div className="bg-ops-card border border-ops-border rounded-xl p-5 space-y-4"><div className="text-xs uppercase tracking-wide text-ops-text-muted">{title}</div>{children}</div>;
}
function Row({ label, children }: { label: string; children: any }) {
  return <div><label className="text-xs uppercase text-ops-text-muted block mb-1">{label}</label>{children}</div>;
}
function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onClick} className={`relative w-10 h-5 rounded-full transition ${on ? "bg-fitscript-green" : "bg-ops-border"}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition ${on ? "translate-x-5" : ""}`} />
      </button>
      <span className="text-xs text-ops-text-muted">{label}</span>
    </div>
  );
}
