import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface PeptideReq { id: string; name: string; category: string | null; why: string | null; created_at: string; }
interface BrandReq { id: string; name: string; note: string | null; created_at: string; }
interface Data { peptides: PeptideReq[]; brands: BrandReq[]; error?: string; }

export default function PeptideuRequests() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["/api/ops/peptideu/requests"],
    queryFn: async () => (await fetch("/api/ops/peptideu/requests")).json(),
  });

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 4000); };

  const call = async (url: string, label: string) => {
    setBusy(url);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/requests"] });
      flash(true, label);
    } catch (e: any) { flash(false, e.message); } finally { setBusy(null); }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  if (error) return <PuUnavailable message="Failed to load requests" />;

  const pep = data?.peptides ?? [];
  const brands = data?.brands ?? [];
  const gen = busy?.endsWith("/generate");

  const Card = ({ id, kind, name, meta, onApprove, approveLabel }: {
    id: string; kind: string; name: string; meta: string;
    onApprove: () => void; approveLabel: string;
  }) => (
    <div className="flex flex-wrap items-center gap-3 p-4 border-t border-ops-border first:border-t-0">
      <div className="flex-1 min-w-[200px]">
        <div className="text-[10px] font-mono uppercase tracking-wide text-[#5C7FFF]">{kind}</div>
        <div className="text-sm font-medium text-ops-text mt-0.5">{name}</div>
        {meta ? <div className="text-xs text-ops-text-muted mt-1">{meta}</div> : null}
      </div>
      <button
        disabled={!!busy}
        onClick={() => call(`/api/ops/peptideu/requests/${kind}/${id}/denied`, "Denied")}
        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-ops-border text-ops-text-muted hover:bg-ops-bg disabled:opacity-50"
      >
        Deny
      </button>
      <button
        disabled={!!busy}
        onClick={onApprove}
        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-fitscript-green/40 text-fitscript-green hover:bg-fitscript-green/10 disabled:opacity-50"
      >
        {approveLabel}
      </button>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-1 text-xs font-mono uppercase tracking-widest text-[#5C7FFF]">PeptideU · Requests</div>
      <h1 className="text-2xl font-semibold text-ops-text">Member requests</h1>
      <p className="text-sm text-ops-text-muted mt-1">
        Approve a peptide and AI drafts the Library entry (unpublished — you publish it after review). Brands are marked manual.
      </p>
      {toast && (
        <div className={`mt-3 text-sm rounded-lg px-4 py-2 ${toast.ok ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"}`}>{toast.msg}</div>
      )}

      <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Peptides <span className="text-ops-text-muted font-normal">· {pep.length}</span></h3>
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
        {pep.length === 0 ? <div className="p-6 text-center text-ops-text-muted text-sm">No pending peptide requests.</div>
          : pep.map((r) => (
            <Card key={r.id} id={r.id} kind="peptide" name={r.name}
              meta={[r.category, r.why].filter(Boolean).join(" · ")}
              approveLabel={gen && busy?.includes(r.id) ? "Drafting…" : "Approve → draft"}
              onApprove={() => call(`/api/ops/peptideu/requests/peptide/${r.id}/generate`, "Draft created — review in the Library")}
            />
          ))}
      </div>

      <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Brands <span className="text-ops-text-muted font-normal">· {brands.length}</span></h3>
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
        {brands.length === 0 ? <div className="p-6 text-center text-ops-text-muted text-sm">No pending brand requests.</div>
          : brands.map((r) => (
            <Card key={r.id} id={r.id} kind="brand" name={r.name} meta={r.note ?? ""}
              approveLabel="Approve"
              onApprove={() => call(`/api/ops/peptideu/requests/brand/${r.id}/approved`, "Approved")}
            />
          ))}
      </div>
    </div>
  );
}
