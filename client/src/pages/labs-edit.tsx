import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

const j = (url: string) => fetch(url).then((r) => r.json());
const METHODS = ["testkit", "at_home_phlebotomy", "walk_in_test", "on_site"];
const money = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

/**
 * Full-page lab mapping editor (replaces the old modal). Route: /labs/mapping/:id
 * where :id is a mapping id, or "new" (with ?env=sandbox|production).
 */
export default function LabsEdit({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const isNew = id === "new";
  const urlEnv = (new URLSearchParams(window.location.search).get("env") as "sandbox" | "production") || "sandbox";

  const existing = useQuery<{ mapping: any }>({
    queryKey: ["labs-mapping", id], queryFn: () => j(`/api/ops/labs/mappings/${id}`), enabled: !isNew,
  });
  const m = existing.data?.mapping;
  const env: "sandbox" | "production" = isNew ? urlEnv : (m?.env || urlEnv);
  const catalog = useQuery<{ tests: any[] }>({
    queryKey: ["labs-catalog", env], queryFn: () => j(`/api/ops/labs/catalog?env=${env}`),
  });
  const tests = catalog.data?.tests ?? [];

  if (!isNew && existing.isLoading) return <div className="p-8 text-ops-text-muted">Loading…</div>;
  return <EditForm key={m?.id || "new"} isNew={isNew} env={env} m={m || {}} tests={tests}
    onDone={() => { qc.invalidateQueries({ queryKey: ["labs-mappings", env] }); navigate("/labs"); }}
    onCancel={() => navigate("/labs")} />;
}

function EditForm({ isNew, env, m, tests, onDone, onCancel }: any) {
  const [f, setF] = useState({
    panelSlug: m.panel_slug || "",
    collectionMethod: m.collection_method || "testkit",
    junctionLabTestId: m.junction_lab_test_id || "",
    displayName: m.display_name || "",
    subtitle: m.subtitle || "",
    description: m.description || "",
    imageUrl: m.image_url || "",
    priceDollars: m.price_cents != null ? (m.price_cents / 100).toFixed(2) : "",
    enabled: m.enabled ?? false,
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const [uploading, setUploading] = useState(false);
  const selectedTest = tests.find((t: any) => t.junction_lab_test_id === f.junctionLabTestId);

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
      const body: any = {
        panelSlug: f.panelSlug, env, collectionMethod: f.collectionMethod, junctionLabTestId: f.junctionLabTestId,
        displayName: f.displayName, subtitle: f.subtitle, description: f.description, imageUrl: f.imageUrl,
        priceCents: f.priceDollars === "" ? null : Math.round(parseFloat(f.priceDollars) * 100),
        enabled: f.enabled,
      };
      const url = isNew ? "/api/ops/labs/mappings" : `/api/ops/labs/mappings/${m.id}`;
      return fetch(url, { method: isNew ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    },
    onSuccess: (d) => { if (d?.error) alert(d.error); else onDone(); },
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <button onClick={onCancel} className="text-sm text-ops-text-muted hover:text-ops-text">← Back to Labs</button>
      <PageHero title={isNew ? "New Lab Mapping" : `Edit: ${f.displayName || f.panelSlug}`} subtitle={`Environment: ${env}`} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Section title="Junction link">
          <Field label="Panel slug"><input value={f.panelSlug} onChange={(e) => set("panelSlug", e.target.value)} placeholder="e.g. fitscript-baseline" className="ops-input" /></Field>
          <Field label="Collection method">
            <select value={f.collectionMethod} onChange={(e) => set("collectionMethod", e.target.value)} className="ops-input">
              {METHODS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Junction test">
            <select value={f.junctionLabTestId} onChange={(e) => set("junctionLabTestId", e.target.value)} className="ops-input">
              <option value="">— select a test —</option>
              {tests.map((t: any) => <option key={t.junction_lab_test_id} value={t.junction_lab_test_id}>{t.name} ({t.method?.replace(/_/g, " ")}, {money(t.price_cents)})</option>)}
            </select>
            {!tests.length && <div className="text-xs text-yellow-400 mt-1">No catalog yet — sync it from the Catalog tab first.</div>}
          </Field>
          <Field label="Enabled">
            <button onClick={() => set("enabled", !f.enabled)} className={`relative w-11 h-6 rounded-full transition ${f.enabled ? "bg-fitscript-green" : "bg-ops-border"}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition ${f.enabled ? "translate-x-5" : ""}`} />
            </button>
          </Field>
        </Section>

        <Section title="Content & pricing (overrides)">
          <Field label="Display name"><input value={f.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder={selectedTest?.name || "defaults to panel name"} className="ops-input" /></Field>
          <Field label="Subtitle / tagline"><input value={f.subtitle} onChange={(e) => set("subtitle", e.target.value)} placeholder="short tagline" className="ops-input" /></Field>
          <Field label="Description"><textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={4} placeholder="Panel description shown to customers…" className="ops-input resize-y" /></Field>
          <Field label="Price USD">
            <input value={f.priceDollars} onChange={(e) => set("priceDollars", e.target.value)} placeholder={m.panel_price_cents != null ? (m.panel_price_cents / 100).toFixed(2) : "defaults to panel price"} className="ops-input" type="number" step="0.01" />
            <div className="mt-1 text-xs text-ops-text-muted">
              Junction cost: <span className="text-ops-text">{money(selectedTest?.price_cents ?? m.test_price_cents)}</span>
              {" · "}Our price: <span className="text-ops-text">{money(m.price_cents ?? m.panel_price_cents)}</span>
              {f.priceDollars === "" && m.panel_price_cents != null && " (panel default — leave blank to keep)"}
            </div>
          </Field>
        </Section>
      </div>

      <Section title="Panel image">
        <div className="flex items-center gap-4">
          {f.imageUrl
            ? <img src={f.imageUrl} alt="" className="w-20 h-20 rounded-lg object-cover border border-ops-border" />
            : <div className="w-20 h-20 rounded-lg border border-dashed border-ops-border flex items-center justify-center text-ops-text-muted text-xs">none</div>}
          <div className="flex flex-col gap-2">
            <label className="px-4 py-2 rounded-lg text-sm bg-ops-bg border border-ops-border text-ops-text cursor-pointer hover:border-fitscript-green inline-block w-fit">
              {uploading ? "Uploading…" : f.imageUrl ? "Replace image" : "Upload image"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0])} disabled={uploading} />
            </label>
            {f.imageUrl && <button onClick={() => set("imageUrl", "")} className="text-xs text-ops-text-muted hover:text-red-400 w-fit">Remove image</button>}
          </div>
        </div>
      </Section>

      <div className="flex justify-end gap-3 sticky bottom-0 bg-ops-bg/80 backdrop-blur py-4 border-t border-ops-border">
        <button onClick={onCancel} className="px-5 py-2 rounded-lg text-sm text-ops-text-muted hover:text-ops-text">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending || uploading || !f.panelSlug || !f.junctionLabTestId}
          className="px-6 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold hover:opacity-90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save mapping"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div className="bg-ops-card border border-ops-border rounded-xl p-5 space-y-4">
      <div className="text-xs uppercase tracking-wide text-ops-text-muted">{title}</div>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: any }) {
  return <div><label className="text-xs uppercase text-ops-text-muted block mb-1">{label}</label>{children}</div>;
}
