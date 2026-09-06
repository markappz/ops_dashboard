import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LineChart, Line, ResponsiveContainer } from "recharts";

type Snap = { taken_on: string; clicks: number; impressions: number; position: number; urls_seen: number; urls_total: number } | null;
type Cohort = { cohort: string; urls: number; latest: Snap; previous: Snap; month: Snap; series: { date: string; clicks: number; impressions: number; position: number }[] };
type Payload = { configured: boolean; cohorts: Cohort[]; runs: Record<string, { last_run: string; note: string }>; nextWeeklyAt: string; error?: string };
type UrlRow = { url: string; clicks: number; impressions: number; position: number };

const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");

/** Week-over-week chip: green up, red past a 25% drop, muted otherwise. Position is inverted (lower is better). */
function Delta({ now, before, invert = false, pct = true }: { now?: number | null; before?: number | null; invert?: boolean; pct?: boolean }) {
  if (now == null) return <span className="text-ops-text-muted">—</span>;
  if (before == null) return <span className="ml-1 text-[11px] text-emerald-400">new</span>;
  const diff = now - before;
  if (diff === 0) return <span className="ml-1 text-[11px] text-ops-text-muted">=</span>;
  const good = invert ? diff < 0 : diff > 0;
  const bad = invert ? diff > 0.5 : before > 0 && diff / before < -0.25;
  const cls = bad ? "text-red-400" : good ? "text-emerald-400" : "text-ops-text-muted";
  const label = pct && before > 0 ? `${Math.abs(Math.round((diff / before) * 100))}%` : Math.abs(diff).toFixed(invert ? 1 : 0);
  return <span className={`ml-1 text-[11px] ${cls}`}>{good ? "▲" : "▼"} {label}</span>;
}

function Spark({ series }: { series: Cohort["series"] }) {
  if (series.length < 2) return <span className="text-[11px] text-ops-text-muted">{series.length === 1 ? "1 snapshot" : "no data"}</span>;
  return (
    <div className="h-8 w-28">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series}><Line type="monotone" dataKey="clicks" stroke="#34d399" strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CohortUrls({ name }: { name: string }) {
  const { data, isLoading } = useQuery<{ rows: UrlRow[] }>({
    queryKey: ["rp-ranking-cohort", name],
    queryFn: async () => (await fetch(`/api/ops/rp/ranking/cohort?name=${encodeURIComponent(name)}`, { credentials: "include" })).json(),
  });
  if (isLoading) return <div className="px-4 py-3 text-xs text-ops-text-muted">Loading URLs…</div>;
  return (
    <div className="max-h-80 overflow-auto border-t border-ops-border/50 bg-ops-bg/40">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ops-text-muted"><th className="px-4 py-2">URL (28d)</th><th className="px-2 py-2">Clicks</th><th className="px-2 py-2">Impr</th><th className="px-2 py-2">Pos</th></tr></thead>
        <tbody>
          {(data?.rows ?? []).map((r) => (
            <tr key={r.url} className="border-t border-ops-border/30">
              <td className="px-4 py-1.5 text-ops-text"><a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.url.replace("https://www.realpeptides.co", "")}</a></td>
              <td className="px-2 py-1.5 text-ops-text-muted">{num(r.clicks)}</td>
              <td className="px-2 py-1.5 text-ops-text-muted">{num(r.impressions)}</td>
              <td className="px-2 py-1.5 text-ops-text-muted">{r.position ? r.position.toFixed(1) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Ranking Machine panel inside Real Peptides → SEO. */
export function RpRankingMachine() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["rp-ranking"],
    queryFn: async () => (await fetch("/api/ops/rp/ranking", { credentials: "include" })).json(),
  });
  const run = useMutation({
    mutationFn: async () => { const r = await fetch("/api/ops/rp/ranking/run", { method: "POST", credentials: "include" }); if (!r.ok) throw new Error((await r.json()).error ?? "run failed"); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rp-ranking"] }),
  });
  const stamp = useMutation({
    mutationFn: async () => { await fetch("/api/ops/rp/ranking/freshness", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "marked from ops" }) }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rp-ranking"] }),
  });

  const sb = data?.runs?.scoreboard, fr = data?.runs?.freshness;
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ops-text">Ranking Machine</h2>
          <p className="text-xs text-ops-text-muted">
            Search Console by program cohort · 7 days vs the 7 before (ending 3 days ago, GSC lag) · snapshot every Monday.
            {" "}Last snapshot {when(sb?.last_run)} · next {when(data?.nextWeeklyAt)} · last freshness cycle {fr?.last_run ? when(fr.last_run) : "not yet run"}.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate()} disabled={run.isPending} className="rounded-lg border border-ops-border bg-ops-surface px-3 py-1.5 text-xs text-ops-text hover:bg-ops-bg disabled:opacity-50">
            {run.isPending ? "Pulling Search Console…" : "Snapshot now"}
          </button>
          <button onClick={() => stamp.mutate()} disabled={stamp.isPending} className="rounded-lg border border-ops-border bg-ops-surface px-3 py-1.5 text-xs text-ops-text-muted hover:bg-ops-bg disabled:opacity-50">
            Mark freshness run
          </button>
        </div>
      </div>
      {run.isError && <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">{(run.error as Error).message}</div>}
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {data?.error && <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{data.error}</div>}
      {data?.cohorts && (
        <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                {["Cohort", "URLs", "Clicks 7d", "Impressions 7d", "Avg position", "28d clicks", "Trend"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((c) => (
                <>
                  <tr key={c.cohort} onClick={() => setOpen(open === c.cohort ? null : c.cohort)} className="cursor-pointer border-b border-ops-border/50 last:border-0 hover:bg-ops-bg/40">
                    <td className="px-4 py-2.5 text-ops-text">{c.cohort}<span className="ml-2 text-[11px] text-ops-text-muted">{open === c.cohort ? "▾" : "▸"}</span></td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{c.latest ? `${num(c.latest.urls_seen)} / ${num(c.urls)}` : num(c.urls)}</td>
                    <td className="px-4 py-2.5 text-ops-text">{num(c.latest?.clicks)}<Delta now={c.latest?.clicks} before={c.previous?.clicks} /></td>
                    <td className="px-4 py-2.5 text-ops-text">{num(c.latest?.impressions)}<Delta now={c.latest?.impressions} before={c.previous?.impressions} /></td>
                    <td className="px-4 py-2.5 text-ops-text">{c.latest?.position ? c.latest.position.toFixed(1) : "—"}<Delta now={c.latest?.position} before={c.previous?.position} invert pct={false} /></td>
                    <td className="px-4 py-2.5 text-ops-text-muted">{num(c.month?.clicks)}</td>
                    <td className="px-4 py-2.5"><Spark series={c.series} /></td>
                  </tr>
                  {open === c.cohort && <tr key={`${c.cohort}-urls`}><td colSpan={7} className="p-0"><CohortUrls name={c.cohort} /></td></tr>}
                </>
              ))}
              {data.cohorts.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-ops-text-muted">No cohorts seeded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
