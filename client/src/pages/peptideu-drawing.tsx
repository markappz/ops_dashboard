import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface LB { display_name: string; rank: string; entries: number; }
interface Win { display_name: string; prize: string; season: string; drawn_at: string; }
interface Data { leaderboard: LB[]; winners: Win[]; totals: { players: number; entries: number; season: string }; error?: string; }

const PRIZES = ["Oura Ring", "WHOOP band", "Red-light therapy cap", "Peptide storage fridge", "FitScript voucher"];

export default function PeptideuDrawing() {
  const qc = useQueryClient();
  const [prize, setPrize] = useState(PRIZES[0]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["/api/ops/peptideu/drawing"],
    queryFn: async () => (await fetch("/api/ops/peptideu/drawing")).json(),
  });

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 6000); };

  const run = async () => {
    if (!confirm(`Run the drawing now for "${prize}"? This picks a winner at random (weighted by entries) and records it. This can't be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/ops/peptideu/drawing/run", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prize }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      if (!d.ok) throw new Error(d.reason === "no_entries" ? "No entries yet — nobody to draw." : (d.reason || "Draw failed"));
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/drawing"] });
      flash(true, `🎉 Winner: ${d.winner} — ${prize}`);
    } catch (e: any) { flash(false, e.message); } finally { setBusy(false); }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  if (error) return <PuUnavailable message="Failed to load drawing" />;

  const lb = data?.leaderboard ?? [];
  const winners = data?.winners ?? [];
  const totals = data?.totals;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-1 text-xs font-mono uppercase tracking-widest text-[#5C7FFF]">PeptideU · Grant Drawing</div>
      <h1 className="text-2xl font-semibold text-ops-text">Drawing</h1>
      <p className="text-sm text-ops-text-muted mt-1">
        Free-entry sweepstakes. Winners are drawn at random, weighted by entries. Period: {totals?.season}.
      </p>

      {toast && (
        <div className={`mt-3 text-sm rounded-lg px-4 py-3 ${toast.ok ? "bg-fitscript-green/15 text-fitscript-green" : "bg-red-500/15 text-red-400"}`}>{toast.msg}</div>
      )}

      {/* totals */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-xs font-mono uppercase tracking-wide text-ops-text-muted">Total entries</div>
          <div className="text-3xl font-semibold text-ops-text mt-1 tabular-nums">{(totals?.entries ?? 0).toLocaleString()}</div>
        </div>
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="text-xs font-mono uppercase tracking-wide text-ops-text-muted">Players</div>
          <div className="text-3xl font-semibold text-ops-text mt-1 tabular-nums">{(totals?.players ?? 0).toLocaleString()}</div>
        </div>
      </div>

      {/* run drawing */}
      <div className="mt-4 bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
        <div className="text-sm font-semibold text-ops-text mb-3">Run the drawing</div>
        <div className="flex flex-wrap items-center gap-3">
          <select value={prize} onChange={(e) => setPrize(e.target.value)}
            className="text-sm bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-ops-text focus:outline-none focus:border-[#5C7FFF]">
            {PRIZES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button disabled={busy || (totals?.entries ?? 0) === 0} onClick={run}
            className="text-sm font-medium px-5 py-2 rounded-lg bg-[#5C7FFF] text-white hover:opacity-90 disabled:opacity-40">
            {busy ? "Drawing…" : "Run drawing"}
          </button>
        </div>
        <p className="text-xs text-ops-text-muted mt-3">Weighted-random pick from all entries this period. Records the winner. Make sure the entry period has ended and the official rules are finalized before drawing.</p>
      </div>

      {/* leaderboard */}
      <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Entry leaderboard</h3>
      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
        {lb.length === 0 ? <div className="p-6 text-center text-ops-text-muted text-sm">No entries yet.</div>
          : lb.map((r, i) => (
            <div key={`${r.display_name}-${i}`} className={`flex items-center gap-3 p-3.5 ${i > 0 ? "border-t border-ops-border" : ""}`}>
              <span className={`w-6 text-center font-semibold ${i === 0 ? "text-[#5C7FFF]" : "text-ops-text-muted"}`}>{i + 1}</span>
              <div className="flex-1"><span className="text-sm text-ops-text">{r.display_name}</span> <span className="text-xs text-ops-text-muted">· {r.rank}</span></div>
              <span className="text-sm font-medium text-ops-text tabular-nums">{r.entries} {r.entries === 1 ? "entry" : "entries"}</span>
            </div>
          ))}
      </div>

      {/* winners */}
      {winners.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Past winners</h3>
          <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
            {winners.map((w, i) => (
              <div key={i} className={`flex items-center gap-3 p-3.5 ${i > 0 ? "border-t border-ops-border" : ""}`}>
                <div className="flex-1"><span className="text-sm text-ops-text">{w.display_name}</span> <span className="text-xs text-ops-text-muted">· {w.season}</span></div>
                <span className="text-sm text-fitscript-green">{w.prize}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
