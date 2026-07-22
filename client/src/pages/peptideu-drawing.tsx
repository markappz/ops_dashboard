import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface LB { display_name: string; rank: string; entries: number; }
interface Win { id: string; display_name: string; email: string; prize: string; drawn_at: string; claimed_at: string | null; claim_email: string | null; claim_contact: string | null; }
interface Redemption { kind: string; created_at: string; expires_at: string | null; display_name: string; email: string; }
interface Draw { id: string; prize: string; num_winners: number; scheduled_at: string; seed_hash: string; status: string; drawn_at: string | null; }
interface Data { leaderboard: LB[]; winners: Win[]; totals: { players: number; entries: number; season: string }; drawings?: Draw[]; live?: boolean; claims?: Win[]; redemptions?: Redemption[]; error?: string; }

const PRIZES = ["Oura Ring", "WHOOP band", "Red-light therapy cap", "Peptide storage fridge", "FitScript voucher"];

export default function PeptideuDrawing() {
  const qc = useQueryClient();
  const [prize, setPrize] = useState(PRIZES[0]);
  const [schedPrize, setSchedPrize] = useState(PRIZES[0]);
  const [schedWinners, setSchedWinners] = useState(3);
  const [schedAt, setSchedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["/api/ops/peptideu/drawing"],
    queryFn: async () => (await fetch("/api/ops/peptideu/drawing")).json(),
  });

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 6000); };

  const run = async () => {
    if (!confirm(`Run the drawing now for "${prize}"? This picks 3 winners at random (weighted by entries) and records them. This can't be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/ops/peptideu/drawing/run", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prize, winners: 3 }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      if (!d.ok) throw new Error(d.reason === "no_entries" ? "No entries yet — nobody to draw." : (d.reason || "Draw failed"));
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/drawing"] });
      const names = Array.isArray(d.winners) ? d.winners.map((w: any) => w.winner).join(", ") : d.winner;
      flash(true, `🎉 Winners: ${names} — ${prize}`);
    } catch (e: any) { flash(false, e.message); } finally { setBusy(false); }
  };

  const post = async (url: string, body: any, ok: string | ((d: any) => string)) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
      if (d.ok === false) throw new Error(d.reason ?? "Failed");
      await qc.invalidateQueries({ queryKey: ["/api/ops/peptideu/drawing"] });
      flash(true, typeof ok === "function" ? (ok as any)(d) : ok);
    } catch (e: any) { flash(false, e.message); } finally { setBusy(false); }
  };
  const schedule = () => {
    if (!schedAt) return flash(false, "Pick a date/time first.");
    post("/api/ops/peptideu/drawings/schedule", { prize: schedPrize, winners: schedWinners, scheduled_at: new Date(schedAt).toISOString() }, "Drawing scheduled — seed committed.");
  };
  const execute = (id: string) => {
    if (!confirm("Execute this drawing now? Freezes entries, picks the winners from the committed seed, and reveals it. Can't be undone.")) return;
    post(`/api/ops/peptideu/drawings/${id}/execute`, {}, (d: any) => `🎉 Winners: ${(d.winners || []).map((w: any) => w.name).join(", ")}`);
  };
  const toggleLive = (enabled: boolean) => {
    if (enabled && !confirm("Enable LIVE drawings? Only do this after attorney sign-off + state registration. Real draws will award real prizes.")) return;
    post("/api/ops/peptideu/drawings/flag", { enabled }, enabled ? "Drawings are now LIVE." : "Drawings paused (not live).");
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

      {/* provably-fair scheduled drawings */}
      <div className="mt-4 bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-ops-text">Monthly drawing · provably fair</div>
          <label className="flex items-center gap-2 text-xs">
            <span className={data?.live ? "text-fitscript-green font-medium" : "text-ops-text-muted"}>{data?.live ? "LIVE" : "Paused"}</span>
            <button onClick={() => toggleLive(!data?.live)} disabled={busy}
              className={`relative w-10 h-5 rounded-full transition ${data?.live ? "bg-fitscript-green" : "bg-ops-border"}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${data?.live ? "left-5" : "left-0.5"}`} />
            </button>
          </label>
        </div>
        <p className="text-xs text-ops-text-muted mb-3">
          A seed hash is committed when you schedule; winners are computed from it and the seed revealed after — anyone can verify. <span className="text-red-400">Only enable LIVE after attorney sign-off + state registration.</span>
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <select value={schedPrize} onChange={(e) => setSchedPrize(e.target.value)} className="text-sm bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-ops-text">{PRIZES.map((p) => <option key={p}>{p}</option>)}</select>
          <input type="number" min={1} max={10} value={schedWinners} onChange={(e) => setSchedWinners(Number(e.target.value))} className="text-sm bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-ops-text w-16" />
          <input type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} className="text-sm bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-ops-text" />
          <button onClick={schedule} disabled={busy} className="text-sm font-medium px-4 py-2 rounded-lg border border-[#5C7FFF] text-[#5C7FFF] hover:bg-[#5C7FFF]/10 disabled:opacity-40">Schedule</button>
        </div>
        {(data?.drawings ?? []).length > 0 && (
          <div className="mt-4 border-t border-ops-border">
            {(data?.drawings ?? []).map((d) => {
              const due = new Date(d.scheduled_at).getTime() <= Date.now();
              return (
                <div key={d.id} className="flex flex-wrap items-center gap-3 py-3 border-b border-ops-border last:border-b-0">
                  <div className="flex-1 min-w-[180px]">
                    <div className="text-sm text-ops-text">{d.prize} · {d.num_winners} winners</div>
                    <div className="text-xs text-ops-text-muted">{new Date(d.scheduled_at).toLocaleString()} · seed {d.seed_hash.slice(0, 12)}…</div>
                  </div>
                  <span className={`text-xs font-mono uppercase ${d.status === "drawn" ? "text-fitscript-green" : d.status === "cancelled" ? "text-ops-text-muted" : "text-[#5C7FFF]"}`}>{d.status}</span>
                  {d.status === "scheduled" && (
                    <button onClick={() => execute(d.id)} disabled={busy || !due} title={due ? "" : "Not due yet"}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[#5C7FFF] text-white hover:opacity-90 disabled:opacity-40">Run now</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* run drawing (manual, legacy) */}
      <div className="mt-4 bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
        <div className="text-sm font-semibold text-ops-text mb-3">Run the drawing (manual)</div>
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

      {/* winners + prize fulfillment queue */}
      {winners.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Winners &amp; prize claims</h3>
          <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
            {winners.map((w, i) => (
              <div key={w.id || i} className={`flex flex-wrap items-center gap-3 p-3.5 ${i > 0 ? "border-t border-ops-border" : ""}`}>
                <div className="flex-1 min-w-[200px]">
                  <div className="text-sm text-ops-text">{w.display_name} <span className="text-fitscript-green">· {w.prize}</span></div>
                  <div className="text-xs text-ops-text-muted">
                    {w.claimed_at
                      ? <>Claimed → <span className="text-ops-text">{w.claim_email}</span>{w.claim_contact ? ` · ${w.claim_contact}` : ""}</>
                      : <>Unclaimed · account {w.email}</>}
                  </div>
                </div>
                <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded ${w.claimed_at ? "bg-fitscript-green/15 text-fitscript-green" : "bg-[#5C7FFF]/15 text-[#5C7FFF]"}`}>
                  {w.claimed_at ? "ready to ship" : "awaiting claim"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* scholarship redemptions (self-service; shown for audit) */}
      {(data?.redemptions ?? []).length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ops-text mt-6 mb-2">Scholarship redemptions</h3>
          <p className="text-xs text-ops-text-muted mb-2">Members who spent credits for free membership — automatic (no approval needed); listed for the record.</p>
          <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden shadow-card">
            {(data?.redemptions ?? []).map((r, i) => (
              <div key={i} className={`flex items-center gap-3 p-3.5 ${i > 0 ? "border-t border-ops-border" : ""}`}>
                <div className="flex-1"><span className="text-sm text-ops-text">{r.display_name}</span> <span className="text-xs text-ops-text-muted">· {r.email}</span></div>
                <span className="text-sm text-fitscript-green capitalize">{r.kind}{r.expires_at ? "" : " (lifetime)"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
