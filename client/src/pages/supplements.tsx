/**
 * Supplements — ops surface for the FitScript supplement catalog. Reads/edits
 * supplement_catalog on the shared RDS; Sync (Fullscript import) + image
 * hosting/normalize proxy to FitScript's internal endpoints (sharp + the
 * Fullscript API live there).
 */
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { PageHero } from "../components/page-hero";

const j = (url: string) => fetch(url).then((r) => r.json());
const money = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

interface Item {
  id: string;
  fulfillment_sku: string | null;
  display_name: string;
  brand: string | null;
  image_url: string | null;
  msrp_cents: number | null;
  availability: string | null;
  active: boolean;
  atlas_selected: boolean;
  evidence_tier: number | null;
  sort_order: number | null;
}
interface ListResp { items: Item[]; total: number; hosted: number; }

export default function Supplements() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [rehostRunning, setRehostRunning] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const uploadTarget = useRef<Item | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { const t = setTimeout(() => setDq(q), 300); return () => clearTimeout(t); }, [q]);

  const list = useQuery<ListResp>({ queryKey: ["supp", dq], queryFn: () => j(`/api/ops/supplements?q=${encodeURIComponent(dq)}`) });

  const sync = useMutation({
    mutationFn: () => fetch("/api/ops/supplements/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
    onSuccess: ({ ok, body }) => {
      if (!ok) { setNote(`Sync failed: ${body?.error || "error"}`); return; }
      setNote(`Sync: ${body.inserted} new · ${body.updated} updated · ${body.merged} merged${body.hostingNewImages ? ` · hosting ${body.hostingNewImages} new images…` : ""}`);
      if (body.hostingNewImages) setRehostRunning(true);
      qc.invalidateQueries({ queryKey: ["supp"] });
    },
  });

  const rehostStatus = useQuery<{ running: boolean; summary: any }>({
    queryKey: ["supp-rehost-status"], queryFn: () => j("/api/ops/supplements/rehost-status"),
    enabled: rehostRunning, refetchInterval: rehostRunning ? 2500 : false,
  });
  useEffect(() => {
    if (rehostRunning && rehostStatus.data && !rehostStatus.data.running) {
      setRehostRunning(false);
      const s = rehostStatus.data.summary;
      setNote(s?.error ? `Re-host error: ${s.error}` : `Re-host done: ${s?.migrated ?? 0} hosted · ${s?.skipped ?? 0} skipped · ${s?.failed ?? 0} failed · ${s?.outliers?.length ?? 0} outliers`);
      qc.invalidateQueries({ queryKey: ["supp"] });
    }
  }, [rehostRunning, rehostStatus.data]);
  const startRehost = async (force: boolean) => {
    const r = await fetch(`/api/ops/supplements/rehost-images${force ? "?force=true" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.ok) { setRehostRunning(true); setNote(force ? "Re-hosting ALL images…" : "Hosting new images…"); }
    else { const b = await r.json().catch(() => ({})); setNote(`Couldn't start: ${b.error || r.status}`); }
  };

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => fetch(`/api/ops/supplements/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["supp"] }),
  });

  const pickImage = (it: Item) => { uploadTarget.current = it; fileRef.current?.click(); };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; const it = uploadTarget.current; e.target.value = "";
    if (!file || !it) return;
    setUploadingId(it.id);
    try {
      const fd = new FormData(); fd.append("image", file);
      const r = await fetch(`/api/ops/supplements/${it.id}/image`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setNote(`Image replaced: ${it.display_name}`);
      qc.invalidateQueries({ queryKey: ["supp"] });
    } catch (err: any) { setNote(`Upload failed: ${err.message}`); }
    finally { setUploadingId(null); uploadTarget.current = null; }
  };

  const d = list.data;
  const btn = "px-3 py-1.5 rounded-md text-sm font-medium transition disabled:opacity-50";

  return (
    <div className="space-y-6">
      <PageHero title="Supplements" subtitle="Manage the Fullscript supplement catalog — sync new products, pricing, and hosted product images." />
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-ops-text-muted">
          {d ? <>{d.total} products · <span className="text-ops-text">{d.hosted}</span> images hosted on our S3</> : "Loading…"}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => sync.mutate()} disabled={sync.isPending} className={`${btn} bg-ops-card border border-ops-border text-ops-text hover:bg-ops-bg`}>
            {sync.isPending ? "Syncing…" : "Sync from Fullscript"}
          </button>
          <button onClick={() => startRehost(false)} disabled={rehostRunning} className={`${btn} bg-fitscript-green text-black`}>
            {rehostRunning ? "Hosting…" : "Host new images"}
          </button>
          <button onClick={() => startRehost(true)} disabled={rehostRunning} title="Re-download + re-normalize (rows still on a Fullscript URL)" className={`${btn} bg-ops-card border border-ops-border text-ops-text-muted hover:text-ops-text`}>
            Re-host all
          </button>
        </div>
      </div>

      {note && <div className="text-sm bg-ops-card border border-ops-border rounded-lg px-4 py-2 text-ops-text">{note}</div>}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, brand, or SKU…"
        className="w-full max-w-md bg-ops-card border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:outline-none focus:border-fitscript-green" />

      <div className="bg-ops-card border border-ops-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ops-bg text-ops-text-muted text-xs uppercase">
            <tr>
              <th className="text-left p-3">Image</th>
              <th className="text-left p-3">Product</th>
              <th className="text-left p-3">Price</th>
              <th className="text-left p-3">Availability</th>
              <th className="text-left p-3">Active</th>
              <th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && <tr><td colSpan={6} className="p-8 text-center text-ops-text-muted">Loading…</td></tr>}
            {d?.items.map((it) => (
              <tr key={it.id} onClick={() => navigate(`/supplements/${it.id}`)} className="border-t border-ops-border cursor-pointer hover:bg-ops-bg/40">
                <td className="p-3">
                  <div className="w-12 h-12 bg-ops-bg rounded flex items-center justify-center overflow-hidden">
                    {it.image_url ? <img src={it.image_url} alt="" className="max-w-full max-h-full object-contain" /> : <span className="text-ops-text-muted text-xs">—</span>}
                  </div>
                </td>
                <td className="p-3">
                  <div className="text-ops-text font-medium">{it.display_name}</div>
                  <div className="text-xs text-ops-text-muted">{it.brand || "—"} · {it.fulfillment_sku || "no SKU"}</div>
                </td>
                <td className="p-3 text-ops-text whitespace-nowrap">{money(it.msrp_cents)}</td>
                <td className="p-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${it.availability === "In Stock" ? "bg-fitscript-green/15 text-fitscript-green" : "bg-amber-500/15 text-amber-400"}`}>
                    {it.availability || "—"}
                  </span>
                </td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={it.active} onChange={(e) => patch.mutate({ id: it.id, body: { active: e.target.checked } })} />
                </td>
                <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => pickImage(it)} disabled={uploadingId === it.id} className="text-xs text-fitscript-green hover:underline disabled:opacity-50">
                    {uploadingId === it.id ? "Uploading…" : "Replace image"}
                  </button>
                </td>
              </tr>
            ))}
            {d && !d.items.length && <tr><td colSpan={6} className="p-8 text-center text-ops-text-muted">No products match “{dq}”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
