import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface Proposal { id: string; field: string; current_value: string; proposed_value: string; summary: string | null; sources: { title: string; url: string }[]; confidence: string | null; created_at: string; name: string; slug: string; }
interface NewsItem { name: string; slug: string; latest_update: string; latest_update_at: string; }
interface Data { pending: Proposal[]; recentNews: NewsItem[]; error?: string; }

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const CONF: Record<string, string> = { high: "bg-fitscript-green/15 text-fitscript-green", medium: "bg-[#5C7FFF]/15 text-[#5C7FFF]", low: "bg-ops-border/40 text-ops-text-muted" };

export default function PeptideuLibrary() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Data>({
    queryKey: ["peptideu-library-updates"],
    queryFn: () => fetch("/api/ops/peptideu/library-updates").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const act = async (id: string, action: "approve" | "dismiss") => {
    const r = await fetch(`/api/ops/peptideu/library-updates/${id}/${action}`, { method: "POST" });
    const d = await r.json();
    if (d.error) return alert(d.error === "read_only" ? "Read-only account — ask an admin" : d.error);
    qc.invalidateQueries({ queryKey: ["peptideu-library-updates"] });
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  const pending = data?.pending ?? [];
  const news = data?.recentNews ?? [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Library Updates</h1>
        <p className="text-sm text-ops-text-muted mt-1">A daily web-search job keeps the Library current. News auto-applies; regulatory/FDA changes wait here for your approval.</p>
      </div>

      {/* regulatory review queue */}
      <h2 className="text-sm font-semibold text-ops-text mb-3">Regulatory changes to review ({pending.length})</h2>
      {pending.length === 0 ? (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center text-sm text-ops-text-muted mb-8">Nothing to review. Regulatory changes the daily job finds will appear here.</div>
      ) : (
        <div className="space-y-3 mb-8">
          {pending.map((p) => (
            <div key={p.id} className="bg-ops-surface border border-ops-border rounded-xl p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-ops-text">{p.name}</span>
                {p.confidence ? <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${CONF[p.confidence] || CONF.low}`}>{p.confidence}</span> : null}
                <span className="text-xs text-ops-text-muted ml-auto">{ago(p.created_at)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm mb-2">
                <span className="font-mono text-xs px-2 py-1 rounded bg-ops-bg text-ops-text-muted">{p.current_value}</span>
                <span className="text-ops-text-muted">→</span>
                <span className="font-mono text-xs px-2 py-1 rounded bg-fitscript-green/15 text-fitscript-green">{p.proposed_value}</span>
              </div>
              {p.summary ? <p className="text-sm text-ops-text-muted mb-2">{p.summary}</p> : null}
              {p.sources?.length ? (
                <div className="text-xs mb-3 space-y-0.5">
                  {p.sources.map((s, i) => <div key={i}><a href={s.url} target="_blank" rel="noreferrer" className="text-[#5C7FFF] hover:underline">{s.title || s.url}</a></div>)}
                </div>
              ) : null}
              <div className="flex gap-2">
                <button onClick={() => act(p.id, "approve")} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-fitscript-green text-black hover:opacity-90">Approve &amp; apply</button>
                <button onClick={() => act(p.id, "dismiss")} className="text-sm px-4 py-1.5 rounded-lg border border-ops-border text-ops-text-muted hover:text-ops-text">Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* auto-applied news log */}
      <h2 className="text-sm font-semibold text-ops-text mb-3">Recently auto-updated ({news.length})</h2>
      <div className="bg-ops-surface border border-ops-border rounded-xl">
        {news.length === 0 ? (
          <div className="p-8 text-center text-sm text-ops-text-muted">No auto-applied news yet.</div>
        ) : news.map((n) => (
          <div key={n.slug} className="p-4 border-t border-ops-border first:border-t-0">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-ops-text">{n.name}</span>
              <span className="text-xs text-ops-text-muted">{ago(n.latest_update_at)}</span>
            </div>
            <p className="text-sm text-ops-text-muted mt-1">{n.latest_update}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
