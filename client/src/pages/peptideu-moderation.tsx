import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface Row { id: string; body?: string; note?: string; rating?: number; created_at: string; display_name: string | null; channel?: string; subject?: string; }
interface Data { posts: Row[]; peptideReviews: Row[]; brandReviews: Row[]; error?: string; }

function when(iso: string) { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

export default function PeptideuModeration() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["/api/ops/peptideu/moderation"],
    queryFn: async () => (await fetch("/api/ops/peptideu/moderation")).json(),
  });

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 3500); };

  const remove = async (type: string, id: string, label: string) => {
    if (!confirm(`Remove this ${label}? This hides it from members.`)) return;
    setBusy(id);
    try {
      const r = await fetch("/api/ops/peptideu/moderation/remove", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, id }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/moderation"] });
      flash(true, "Removed");
    } catch (e: any) { flash(false, e.message); } finally { setBusy(null); }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  if (error) return <PuUnavailable message="Failed to load moderation queue" />;

  const Section = ({ title, rows, type, label }: { title: string; rows: Row[]; type: string; label: string }) => (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-ops-text mb-2">{title} <span className="text-ops-text-muted font-normal">· {rows.length}</span></h3>
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-ops-text-muted text-sm">Nothing here.</div>
        ) : rows.map((r, i) => (
          <div key={r.id} className={`flex items-start gap-3 p-4 ${i > 0 ? "border-t border-ops-border" : ""}`}>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-ops-text">{r.body || r.note}</div>
              <div className="text-xs text-ops-text-muted mt-1 font-mono">
                {r.display_name || "member"}
                {r.subject ? ` · ${r.subject}` : ""}{r.channel ? ` · #${r.channel}` : ""}
                {r.rating ? ` · ${r.rating}★` : ""} · {when(r.created_at)}
              </div>
            </div>
            <button
              disabled={busy === r.id}
              onClick={() => remove(type, r.id, label)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 shrink-0"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-1 text-xs font-mono uppercase tracking-widest text-[#5C7FFF]">PeptideU · Moderation</div>
      <h1 className="text-2xl font-semibold text-ops-text">Moderation queue</h1>
      <p className="text-sm text-ops-text-muted mt-1">
        Everything here is already live and passed the AI check. Pull anything that slipped through.
      </p>
      {toast && (
        <div className={`mt-3 text-sm rounded-lg px-4 py-2 ${toast.ok ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"}`}>{toast.msg}</div>
      )}
      <Section title="Commons posts" rows={data?.posts ?? []} type="post" label="post" />
      <Section title="Peptide reviews" rows={data?.peptideReviews ?? []} type="peptide_review" label="review" />
      <Section title="Brand reviews" rows={data?.brandReviews ?? []} type="brand_review" label="review" />
    </div>
  );
}
