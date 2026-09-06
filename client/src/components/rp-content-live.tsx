import { useQuery } from "@tanstack/react-query";

type Live = {
  configured: boolean; error?: string; hint?: string; generatedAt?: string;
  totals?: { published: number; hubs: number; calculators: number; withReferences: number; publishedLast7: number; publishedLast30: number; updatedLast7: number; updatedLast30: number };
  recent?: { slug: string; title: string; publishedAt: string | null; updatedAt: string; campaign: string | null; change: "new" | "updated" }[];
};
type Gsc = { connected?: boolean; totals?: { clicks: number; impressions: number; position: number }; topPages?: unknown[] };

const num = (n?: number) => (n ?? 0).toLocaleString();
const ago = (iso: string) => { const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-2 text-xs uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className="text-2xl font-bold text-ops-text">{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

/** What is actually live on realpeptides.co, plus 30-day Search Console totals. */
export function RpContentLive() {
  const live = useQuery<Live>({ queryKey: ["rp-content-live"], queryFn: async () => (await fetch("/api/ops/rp/content-live", { credentials: "include" })).json() });
  const gsc = useQuery<Gsc>({ queryKey: ["realpeptides-gsc"], queryFn: async () => (await fetch("/api/ops/gsc/overview?company=realpeptides&range=30", { credentials: "include" })).json() });
  const t = live.data?.totals;
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-lg font-medium text-ops-text">Live on realpeptides.co</h2>
        <p className="text-xs text-ops-text-muted">Read from the site itself{live.data?.generatedAt ? ` · ${ago(live.data.generatedAt)}` : ""}. The Clomark block below is the generation queue; publishing happens on the site.</p>
      </div>
      {live.data?.error && <div className="mb-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">{live.data.error}</div>}
      {live.data?.configured === false && <div className="mb-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-500">{live.data.hint}</div>}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Tile label="Published posts" value={t ? num(t.published) : "—"} sub={t ? `${num(t.publishedLast30)} new in 30d` : undefined} />
        <Tile label="Updated in 7d" value={t ? num(t.updatedLast7) : "—"} sub={t ? `${num(t.updatedLast30)} in 30d` : undefined} />
        <Tile label="Compound hubs" value={t ? num(t.hubs) : "—"} sub="pillar pages" />
        <Tile label="With References" value={t ? num(t.withReferences) : "—"} sub="PubMed-cited posts" />
        <Tile label="Calculator posts" value={t ? num(t.calculators) : "—"} sub="embedded tool" />
        <Tile label="Search, 30d" value={gsc.data?.totals ? num(gsc.data.totals.clicks) : "—"} sub={gsc.data?.totals ? `${num(gsc.data.totals.impressions)} impressions · pos ${Number(gsc.data.totals.position).toFixed(1)}` : gsc.data?.connected === false ? "Search Console not connected" : undefined} />
      </div>
      {(live.data?.recent ?? []).length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted"><th className="px-4 py-3 font-medium">Recently changed on the site</th><th className="px-4 py-3 font-medium">Change</th><th className="px-4 py-3 font-medium">When</th></tr></thead>
            <tbody>
              {live.data!.recent!.slice(0, 12).map((p) => (
                <tr key={p.slug} className="border-b border-ops-border/50 last:border-0">
                  <td className="px-4 py-2 text-ops-text"><a href={`https://www.realpeptides.co/${p.slug}/`} target="_blank" rel="noreferrer" className="hover:underline">{p.title}</a>{p.campaign === "hub" && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">hub</span>}</td>
                  <td className="px-4 py-2 text-ops-text-muted">{p.change}</td>
                  <td className="px-4 py-2 text-ops-text-muted">{ago(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
