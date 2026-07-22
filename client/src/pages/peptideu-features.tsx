import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface Feature {
  id: string; title: string; body: string | null; status: string; created_at: string;
  votes: number; display_name: string | null; email: string | null;
}

const STATUS = ["open", "planned", "in_progress", "shipped", "declined"];
const STATUS_TONE: Record<string, string> = {
  open: "text-ops-text-muted", planned: "text-[#5C7FFF]", in_progress: "text-[#5C7FFF]",
  shipped: "text-fitscript-green", declined: "text-red-400",
};

export default function PeptideuFeatures() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isLoading } = useQuery<Feature[] | { error: string }>({
    queryKey: ["peptideu-features"],
    queryFn: () => fetch("/api/ops/peptideu/features").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 3500); };
  const post = async (url: string, body: any, ok: string) => {
    setBusy(url);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      await qc.invalidateQueries({ queryKey: ["peptideu-features"] });
      flash(true, ok);
    } catch (e: any) { flash(false, e.message); } finally { setBusy(null); }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  const features = Array.isArray(data) ? data : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Feature Requests</h1>
        <p className="text-sm text-ops-text-muted mt-1">What members are asking for, ranked by votes. Set a status or remove spam. Statuses show back in the app.</p>
      </div>
      {toast && <div className={`mb-4 text-sm rounded-lg px-4 py-3 ${toast.ok ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"}`}>{toast.msg}</div>}

      {features.length === 0 ? (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center text-sm text-ops-text-muted">No feature requests yet.</div>
      ) : (
        <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
          {features.map((f, i) => (
            <div key={f.id} className={`flex flex-wrap items-start gap-3 p-4 ${i > 0 ? "border-t border-ops-border" : ""}`}>
              <div className="flex flex-col items-center justify-center w-12 shrink-0 bg-ops-bg border border-ops-border rounded-lg py-1.5">
                <span className="text-xs text-ops-text-muted">▲</span>
                <span className="text-base font-bold text-ops-text tabular-nums">{f.votes}</span>
              </div>
              <div className="flex-1 min-w-[200px]">
                <div className="text-sm font-medium text-ops-text">{f.title}</div>
                {f.body ? <div className="text-xs text-ops-text-muted mt-0.5">{f.body}</div> : null}
                <div className="text-[11px] text-ops-text-muted mt-1">by {f.display_name || f.email || "a member"}</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={f.status} disabled={!!busy}
                  onChange={(e) => post(`/api/ops/peptideu/features/${f.id}/status`, { status: e.target.value }, "Status updated")}
                  className={`text-xs bg-ops-bg border border-ops-border rounded-lg px-2 py-1.5 focus:outline-none focus:border-[#5C7FFF] ${STATUS_TONE[f.status] ?? "text-ops-text"}`}>
                  {STATUS.map((s) => <option key={s} value={s} className="text-ops-text">{s.replace("_", " ")}</option>)}
                </select>
                <button
                  disabled={!!busy}
                  onClick={() => { if (confirm(`Delete "${f.title}"?`)) post(`/api/ops/peptideu/features/${f.id}/delete`, {}, "Deleted"); }}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-ops-border text-ops-text-muted hover:bg-ops-bg disabled:opacity-50">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
