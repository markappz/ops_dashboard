import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

const j = (url: string) => fetch(url).then((r) => r.json());
const METHODS = ["testkit", "at_home_phlebotomy", "walk_in_test", "on_site_collection"];

type Marker = { id: number; name: string; slug: string; providerId?: string; labId?: number; type?: string };

/**
 * Lab Test Builder — assemble a custom Junction lab test from catalog markers,
 * then submit for Junction approval. Route: /labs/builder
 * Markers are picked by hand (clinical accuracy) and keyed by providerId when
 * available (shared across envs), else markerId.
 */
export default function LabsBuilder() {
  const [, navigate] = useLocation();
  const labs = useQuery<{ labs: any[] }>({ queryKey: ["junction-labs"], queryFn: () => j("/api/ops/labs/junction-labs") });

  const [labId, setLabId] = useState<number | "">("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("at_home_phlebotomy");
  const [fasting, setFasting] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Marker[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Marker[]>([]);
  const [created, setCreated] = useState<any>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const qs = new URLSearchParams({ name: query.trim(), size: "40" });
      if (labId) qs.set("labId", String(labId));
      const r = await j(`/api/ops/labs/markers?${qs.toString()}`);
      setResults(r.markers ?? []);
    } catch { setResults([]); } finally { setSearching(false); }
  };

  const add = (m: Marker) => { if (!selected.some((s) => s.id === m.id)) setSelected([...selected, m]); };
  const remove = (id: number) => setSelected(selected.filter((s) => s.id !== id));

  const create = useMutation({
    mutationFn: () => {
      const providerIds = selected.filter((s) => s.providerId).map((s) => s.providerId!);
      const markerIds = selected.filter((s) => !s.providerId).map((s) => s.id);
      return fetch("/api/ops/labs/lab-tests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: description || name, method, fasting, providerIds, markerIds }),
      }).then((r) => r.json());
    },
    onSuccess: (d) => { if (d?.error) alert(d.error); else setCreated(d.labTest || d); },
  });

  if (created) {
    return (
      <div className="space-y-6 max-w-2xl">
        <PageHero title="Lab test submitted" subtitle="Pending Junction approval" />
        <div className="bg-ops-card border border-ops-border rounded-xl p-6 space-y-3">
          <div className="text-fitscript-green font-semibold">✓ "{created.name || name}" created</div>
          <p className="text-sm text-ops-text-muted">
            Junction must validate and approve it before it's orderable (it's <code>is_active: false</code> for now).
            Check the Catalog tab — its status will flip to active once approved. Then create a mapping for it.
          </p>
          <div className="flex gap-3 pt-2">
            <button onClick={() => { setCreated(null); setSelected([]); setName(""); setDescription(""); }}
              className="px-5 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold">Build another</button>
            <button onClick={() => navigate("/labs")} className="px-5 py-2 rounded-lg text-sm text-ops-text-muted hover:text-ops-text">Back to Labs</button>
          </div>
        </div>
      </div>
    );
  }

  const labList = labs.data?.labs ?? [];
  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/labs")} className="text-sm text-ops-text-muted hover:text-ops-text">← Back to Labs</button>
      <PageHero title="Build a Lab Test" subtitle="Assemble a custom Junction lab test from catalog markers, then submit for Junction approval." />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Section title="Test details">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="FitScript Essential" className="ops-input" /></Field>
          <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="defaults to name" className="ops-input" /></Field>
          <Field label="Lab">
            <select value={labId} onChange={(e) => setLabId(e.target.value ? Number(e.target.value) : "")} className="ops-input">
              <option value="">— any lab —</option>
              {labList.map((l: any) => <option key={l.id} value={l.id}>{l.name} ({(l.collectionMethods || []).join(", ")})</option>)}
            </select>
          </Field>
          <Field label="Collection method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="ops-input">
              {METHODS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-ops-text-muted">
            <input type="checkbox" checked={fasting} onChange={(e) => setFasting(e.target.checked)} /> Fasting required
          </label>
        </Section>

        <Section title={`Selected markers (${selected.length})`}>
          {selected.length === 0 && <p className="text-xs text-ops-text-muted">Search and add markers from the catalog →</p>}
          <div className="space-y-1.5 max-h-72 overflow-auto">
            {selected.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm bg-ops-bg rounded-lg px-3 py-2">
                <div><span className="text-ops-text">{m.name}</span> <span className="text-xs text-ops-text-muted">{m.providerId ? `#${m.providerId}` : `id ${m.id}`}</span></div>
                <button onClick={() => remove(m.id)} className="text-xs text-red-400 hover:underline">remove</button>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Catalog marker search">
        <div className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search marker name (e.g. Lipid Panel, Hemoglobin A1c, Testosterone)" className="ops-input flex-1" />
          <button onClick={search} disabled={searching} className="px-5 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold disabled:opacity-50">
            {searching ? "…" : "Search"}
          </button>
        </div>
        <div className="space-y-1 max-h-80 overflow-auto">
          {results.map((m) => {
            const isSel = selected.some((s) => s.id === m.id);
            return (
              <div key={m.id} className="flex items-center justify-between text-sm border-b border-ops-border py-2">
                <div>
                  <span className="text-ops-text">{m.name}</span>
                  <span className="ml-2 text-xs text-ops-text-muted">{m.type === "panel" ? "panel · " : ""}{m.providerId ? `#${m.providerId}` : `id ${m.id}`} · lab {m.labId}</span>
                </div>
                <button onClick={() => add(m)} disabled={isSel} className={`text-xs px-3 py-1 rounded ${isSel ? "text-ops-text-muted" : "text-fitscript-green hover:bg-fitscript-green/10"}`}>{isSel ? "added" : "+ add"}</button>
              </div>
            );
          })}
          {!results.length && !searching && <p className="text-xs text-ops-text-muted py-3">No results yet — search above.</p>}
        </div>
      </Section>

      <div className="flex justify-end gap-3 sticky bottom-0 bg-ops-bg/80 backdrop-blur py-4 border-t border-ops-border">
        <button onClick={() => navigate("/labs")} className="px-5 py-2 rounded-lg text-sm text-ops-text-muted hover:text-ops-text">Cancel</button>
        <button onClick={() => create.mutate()} disabled={create.isPending || !name || !selected.length}
          className="px-6 py-2 rounded-lg text-sm bg-fitscript-green text-black font-semibold hover:opacity-90 disabled:opacity-50">
          {create.isPending ? "Submitting…" : `Create lab test (${selected.length} markers)`}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return <div className="bg-ops-card border border-ops-border rounded-xl p-5 space-y-4"><div className="text-xs uppercase tracking-wide text-ops-text-muted">{title}</div>{children}</div>;
}
function Field({ label, children }: { label: string; children: any }) {
  return <div><label className="text-xs uppercase text-ops-text-muted block mb-1">{label}</label>{children}</div>;
}
