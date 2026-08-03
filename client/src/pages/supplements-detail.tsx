import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

const j = (url: string) => fetch(url).then((r) => r.json());
const money = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const stripHtml = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Full-page supplement detail — Fullscript-synced info/pricing (read-only) +
 *  editable curation + image replace. Route /supplements/:id. */
export default function SupplementsDetail({ id }: { id: string }) {
  const q = useQuery<{ item: any }>({ queryKey: ["supp-item", id], queryFn: () => j(`/api/ops/supplements/${id}`) });
  if (q.isLoading) return <div className="p-8 text-ops-text-muted">Loading…</div>;
  if (!q.data?.item) return <div className="p-8 text-ops-text-muted">Not found.</div>;
  return <Detail item={q.data.item} />;
}

function Detail({ item }: { item: any }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    why_this_one: item.why_this_one || "",
    primary_benefit: item.primary_benefit || "",
    typical_dose: item.typical_dose || "",
    evidence_tier: item.evidence_tier ?? "",
    sort_order: item.sort_order ?? "",
    biomarker_targets: (item.biomarker_targets || []).join(", "),
    certifications: (item.certifications || []).join(", "),
    active: item.active ?? true,
    atlas_selected: item.atlas_selected ?? false,
  });
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));
  const [img, setImg] = useState(item.image_url || "");
  const [uploading, setUploading] = useState(false);
  useEffect(() => { setImg(item.image_url || ""); }, [item.image_url]);

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("image", file);
      const r = await fetch(`/api/ops/supplements/${item.id}/image`, { method: "POST", body: fd }).then((x) => x.json());
      if (r?.imageUrl) { setImg(r.imageUrl); qc.invalidateQueries({ queryKey: ["supp"] }); }
      else alert(r?.error || "upload failed");
    } catch (e: any) { alert(e.message); } finally { setUploading(false); }
  };

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        why_this_one: f.why_this_one, primary_benefit: f.primary_benefit, typical_dose: f.typical_dose,
        evidence_tier: f.evidence_tier === "" ? null : Number(f.evidence_tier),
        sort_order: f.sort_order === "" ? 0 : Number(f.sort_order),
        biomarker_targets: f.biomarker_targets.split(",").map((s) => s.trim()).filter(Boolean),
        certifications: f.certifications.split(",").map((s) => s.trim()).filter(Boolean),
        active: f.active, atlas_selected: f.atlas_selected,
      };
      return fetch(`/api/ops/supplements/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    },
    onSuccess: (d) => { if (d?.error) alert(d.error); else { qc.invalidateQueries({ queryKey: ["supp"] }); qc.invalidateQueries({ queryKey: ["supp-item", item.id] }); } },
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/supplements")} className="text-sm text-ops-text-muted hover:text-ops-text">← Back to Supplements</button>
      <PageHero title={item.display_name} subtitle={`${item.brand || "—"} · ${item.fulfillment_sku || "no SKU"}`} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Image */}
        <Box title="Image">
          <div className="flex items-center gap-4">
            <div className="w-24 h-24 rounded-lg border border-ops-border bg-white flex items-center justify-center overflow-hidden">
              {img ? <img src={img} alt="" className="max-w-full max-h-full object-contain" /> : <span className="text-ops-text-muted text-xs">none</span>}
            </div>
            <label className="px-4 py-2 rounded-lg text-sm bg-ops-bg border border-ops-border text-ops-text cursor-pointer hover:border-fitscript-green w-fit">
              {uploading ? "Uploading…" : img ? "Replace image" : "Upload image"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0])} disabled={uploading} />
            </label>
          </div>
          <p className="text-xs text-ops-text-muted">Uploads are trimmed + normalized to a uniform 1000px canvas and hosted on our S3.</p>
        </Box>

        {/* Pricing & availability — Fullscript-synced, read-only */}
        <Box title="Pricing & availability (Fullscript — synced)">
          <KV k="MSRP" v={money(item.msrp_cents)} />
          <KV k="Availability" v={item.availability || "—"} />
          <KV k="Units" v={item.units_label || "—"} />
          <KV k="Prop 65" v={item.prop65_restriction || "none"} />
        </Box>
      </div>

      {/* Curation — editable */}
      <Box title="Curation (editable)">
        <Row label="Primary benefit"><input value={f.primary_benefit} onChange={(e) => set("primary_benefit", e.target.value)} className="ops-input" /></Row>
        <Row label="Why this one"><textarea value={f.why_this_one} onChange={(e) => set("why_this_one", e.target.value)} rows={3} className="ops-input resize-y" /></Row>
        <Row label="Typical dose"><input value={f.typical_dose} onChange={(e) => set("typical_dose", e.target.value)} className="ops-input" /></Row>
        <div className="grid grid-cols-2 gap-4">
          <Row label="Evidence tier (1–3)"><input type="number" min={1} max={3} value={f.evidence_tier} onChange={(e) => set("evidence_tier", e.target.value)} className="ops-input" /></Row>
          <Row label="Sort order"><input type="number" value={f.sort_order} onChange={(e) => set("sort_order", e.target.value)} className="ops-input" /></Row>
        </div>
        <Row label="Biomarker targets (comma-separated registry ids)"><input value={f.biomarker_targets} onChange={(e) => set("biomarker_targets", e.target.value)} className="ops-input" placeholder="apob, ldl-cholesterol" /></Row>
        <Row label="Certifications (comma-separated)"><input value={f.certifications} onChange={(e) => set("certifications", e.target.value)} className="ops-input" placeholder="NSF, USP" /></Row>
        <div className="flex gap-6 pt-1">
          <Toggle label="Active (sellable)" on={f.active} onClick={() => set("active", !f.active)} />
          <Toggle label="Atlas-Selected" on={f.atlas_selected} onClick={() => set("atlas_selected", !f.atlas_selected)} />
        </div>
      </Box>

      {/* Description — Fullscript, read-only */}
      {item.description_html && (
        <Box title="Description (Fullscript — read-only)">
          <p className="text-sm text-ops-text-muted leading-relaxed whitespace-pre-wrap">{stripHtml(item.description_html)}</p>
        </Box>
      )}

      {/* Refs — read-only */}
      <Box title="Fullscript references">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <KV k="Catalog id" v={item.id} />
          <KV k="Fulfillment SKU" v={item.fulfillment_sku || "—"} />
          <KV k="Product id" v={item.fullscript_product_id || "—"} />
          <KV k="Variant id" v={item.fullscript_variant_id || "—"} />
          <KV k="UPC" v={item.upc || "—"} />
          <KV k="Categories" v={(item.category_ids || []).join(", ") || "—"} />
        </div>
      </Box>

      <div className="flex justify-end gap-3 sticky bottom-0 bg-ops-bg/80 backdrop-blur py-4 border-t border-ops-border">
        <button onClick={() => navigate("/supplements")} className="px-5 py-2 rounded-lg text-sm text-ops-text-muted hover:text-ops-text">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || uploading}
          className="px-6 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold hover:opacity-90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save curation"}
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
function KV({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4 py-1 text-sm border-b border-ops-border/40 last:border-0"><span className="text-ops-text-muted">{k}</span><span className="text-ops-text text-right break-all">{v}</span></div>;
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
