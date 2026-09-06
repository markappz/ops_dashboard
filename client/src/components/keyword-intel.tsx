import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Cluster = { id: string; pillar: string; intent: string; content_type: string; priority: number; rationale: string; keywords: string[]; coverage: { covered: number; total: number; pages: string[] }; score_breakdown: { impressions: number; breadth: number; gap: number; penalty: number } };
type Keyword = { keyword: string; cluster_id: string | null; sources: { seed?: boolean; gsc?: boolean; autocomplete?: string[] }; gsc: { impressions: number; clicks: number; position: number; page: string | null } | null; volume: number | null; covered_by: string | null };
type Push = { id: string; cluster_id: string; status: string; content_type: string; published_url: string | null; error: string | null; created_at: string; content_title: string | null; compliance_passed: boolean | null };
type Payload = { error?: string; run: { id: string; seeds: string[]; status: string; stats: { candidates: number; fromGsc: number; fromAutocomplete: number; clusters: number }; created_at: string } | null; clusters: Cluster[]; keywords: Keyword[] };

const num = (n?: number | null) => (n ?? 0).toLocaleString();
const ago = (iso: string) => { const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000); return d === 0 ? "today" : `${d}d ago`; };
const INTENT: Record<string, string> = { informational: "text-sky-400", commercial: "text-amber-400", transactional: "text-emerald-400", navigational: "text-ops-text-muted", mixed: "text-ops-text-muted" };

/** Keyword intelligence: Search Console + autocomplete demand, clustered by Opus. Replaces the SEMrush pipeline. */
export function KeywordIntel({ company }: { company: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Payload>({ queryKey: ["keyword-intel", company], queryFn: async () => (await fetch(`/api/ops/clomark/keyword-intel?company=${company}`, { credentials: "include" })).json() });
  const pushes = useQuery<{ pushes: Push[] }>({ queryKey: ["keyword-intel-pushes", company], queryFn: async () => (await fetch(`/api/ops/clomark/keyword-intel/pushes?company=${company}`, { credentials: "include" })).json(), refetchInterval: 30_000 });
  const push = useMutation({
    mutationFn: async (vars: { clusterId: string; contentType: "blog" | "seo_page" }) => {
      const r = await fetch(`/api/ops/clomark/keyword-intel/push?company=${company}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...vars, publish: true }) });
      if (!r.ok) throw new Error((await r.json()).error ?? "push failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keyword-intel-pushes", company] }),
  });
  const pushByCluster = new Map<string, Push>();
  for (const p of pushes.data?.pushes ?? []) if (!pushByCluster.has(p.cluster_id)) pushByCluster.set(p.cluster_id, p);
  const STATUS: Record<string, string> = { generating: "text-sky-400", queued: "text-sky-400", generated: "text-amber-400", gated: "text-amber-400", published: "text-emerald-400", failed: "text-red-400" };
  const kwByCluster = new Map<string, Keyword[]>();
  for (const k of data?.keywords ?? []) if (k.cluster_id) kwByCluster.set(k.cluster_id, [...(kwByCluster.get(k.cluster_id) ?? []), k]);
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-lg font-medium text-ops-text">Keyword intelligence</h2>
        <p className="text-xs text-ops-text-muted">
          Real demand, not estimates: Search Console queries the site already appears for plus live Google Autocomplete, clustered into page-sized pillars by Opus. Priority = impressions + autocomplete breadth + gap, minus what already ranks top 3.
          {data?.run && <> Last run {ago(data.run.created_at)} on seeds “{data.run.seeds.join("”, “")}” · {num(data.run.stats?.candidates)} queries ({num(data.run.stats?.fromGsc)} from Search Console).</>}
        </p>
      </div>
      {isLoading && <div className="text-sm text-ops-text-muted">Loading…</div>}
      {push.isError && <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">{(push.error as Error).message}</div>}
      {data?.error && <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">{data.error}</div>}
      {data && !data.error && !data.run && <div className="rounded-xl border border-ops-border bg-ops-surface p-4 text-sm text-ops-text-muted">No run yet for this brand. Runs start from Clomark (POST /api/keyword-intel/run) or the CLI.</div>}
      {data?.clusters?.length ? (
        <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">{["Priority", "Pillar", "Intent", "Page type", "Keywords", "Covered", "Impr 90d", "Production"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {data.clusters.map((c) => {
                const kws = kwByCluster.get(c.id) ?? [];
                const impr = kws.reduce((s, k) => s + (k.gsc?.impressions ?? 0), 0);
                const gap = c.coverage.total ? c.coverage.covered / c.coverage.total : 0;
                return (
                  <>
                    <tr key={c.id} onClick={() => setOpen(open === c.id ? null : c.id)} className="cursor-pointer border-b border-ops-border/50 last:border-0 hover:bg-ops-bg/40">
                      <td className="px-4 py-2.5 font-mono text-ops-text">{c.priority.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-ops-text">{c.pillar}</td>
                      <td className={`px-4 py-2.5 text-xs ${INTENT[c.intent] ?? ""}`}>{c.intent}</td>
                      <td className="px-4 py-2.5 text-xs text-ops-text-muted">{c.content_type.replace("_", " ")}</td>
                      <td className="px-4 py-2.5 text-ops-text-muted">{c.keywords.length}</td>
                      <td className="px-4 py-2.5"><span className={gap < 0.5 ? "text-emerald-400" : "text-ops-text-muted"}>{c.coverage.covered}/{c.coverage.total}</span>{gap < 0.5 && <span className="ml-1 text-[10px] text-emerald-400">gap</span>}</td>
                      <td className="px-4 py-2.5 text-ops-text-muted">{num(impr)}</td>
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        {(() => { const p = pushByCluster.get(c.id); if (p) return (
                          <span className={`text-xs ${STATUS[p.status] ?? "text-ops-text-muted"}`} title={p.error ?? p.content_title ?? ""}>
                            {p.status === "published" && p.published_url ? <a href={p.published_url} target="_blank" rel="noreferrer" className="underline">published ↗</a> : p.status === "gated" ? "held: compliance" : p.status}
                          </span>); return (
                          <button onClick={() => push.mutate({ clusterId: c.id, contentType: c.content_type === "hub" || c.content_type === "product_page" ? "seo_page" : "blog" })} disabled={push.isPending} className="rounded-md border border-ops-border bg-ops-surface px-2 py-1 text-xs text-ops-text hover:bg-ops-bg disabled:opacity-50">Push to production</button>); })()}
                      </td>
                    </tr>
                    {open === c.id && (
                      <tr key={`${c.id}-kw`}><td colSpan={8} className="bg-ops-bg/40 p-0">
                        <div className="px-4 py-3 text-xs text-ops-text-muted">{c.rationale}</div>
                        <div className="max-h-72 overflow-auto border-t border-ops-border/40">
                          <table className="w-full text-xs">
                            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ops-text-muted"><th className="px-4 py-2">Keyword</th><th className="px-2 py-2">Source</th><th className="px-2 py-2">Impr</th><th className="px-2 py-2">Pos</th><th className="px-2 py-2">Covered by</th></tr></thead>
                            <tbody>
                              {kws.sort((a, b) => (b.gsc?.impressions ?? 0) - (a.gsc?.impressions ?? 0)).map((k) => (
                                <tr key={k.keyword} className="border-t border-ops-border/30">
                                  <td className="px-4 py-1.5 text-ops-text">{k.keyword}</td>
                                  <td className="px-2 py-1.5 text-ops-text-muted">{[k.sources.gsc && "GSC", k.sources.autocomplete?.length && `AC×${k.sources.autocomplete.length}`].filter(Boolean).join(" · ") || "seed"}</td>
                                  <td className="px-2 py-1.5 text-ops-text-muted">{k.gsc ? num(k.gsc.impressions) : "—"}</td>
                                  <td className="px-2 py-1.5 text-ops-text-muted">{k.gsc?.position ? k.gsc.position.toFixed(1) : "—"}</td>
                                  <td className="px-2 py-1.5 text-ops-text-muted">{k.covered_by ? <a href={k.covered_by.startsWith("http") ? k.covered_by : `https://${company === "realpeptides" ? "www.realpeptides.co" : company + ".com"}${k.covered_by}`} target="_blank" rel="noreferrer" className="hover:underline">{k.covered_by.replace(/^https?:\/\/[^/]+/, "")}</a> : <span className="text-emerald-400">gap</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td></tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
