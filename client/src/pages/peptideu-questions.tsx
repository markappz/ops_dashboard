import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PuLoading, PuUnavailable } from "../components/peptideu/ui";

interface Question { question: string; asks: number; users: number; lastAt: string; answer: string | null; }
interface Theme { topic: string; demand: "high" | "medium" | "low"; covered: boolean; coveredBy: string | null; example: string; }
interface Suggestion { title?: string; topic?: string; rationale: string; }
interface Insights { themes: Theme[]; moduleSuggestions: Suggestion[]; officeHoursSuggestions: Suggestion[]; sampleSize: number; }

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const DEMAND: Record<string, string> = {
  high: "bg-fitscript-green/15 text-fitscript-green",
  medium: "bg-[#5C7FFF]/15 text-[#5C7FFF]",
  low: "bg-ops-border/40 text-ops-text-muted",
};

function QueueRow({ q, rank }: { q: Question; rank: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-ops-border first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-start gap-3 p-4 text-left hover:bg-ops-bg">
        <span className="text-xs font-mono text-ops-text-muted mt-0.5 w-5 shrink-0">{String(rank).padStart(2, "0")}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ops-text">{q.question}</div>
          <div className="text-xs text-ops-text-muted mt-1">
            {q.asks > 1 ? <span className="text-[#5C7FFF] font-medium">asked {q.asks}× · {q.users} {q.users === 1 ? "member" : "members"} · </span> : null}
            {ago(q.lastAt)}{q.answer ? " · tap to see the Professor's answer" : ""}
          </div>
          {open && q.answer ? (
            <div className="text-xs text-ops-text-muted mt-2 p-3 rounded-lg bg-ops-bg border border-ops-border whitespace-pre-wrap">{q.answer}</div>
          ) : null}
        </div>
        {q.asks > 1 ? <span className="text-xs font-bold text-ops-text tabular-nums shrink-0">{q.asks}×</span> : null}
      </button>
    </div>
  );
}

function SuggestionCard({ head, sub, items, empty }: { head: string; sub: string; items: Suggestion[]; empty: string }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
      <div className="text-sm font-semibold text-ops-text">{head}</div>
      <div className="text-xs text-ops-text-muted mb-3">{sub}</div>
      {items.length === 0 ? <div className="text-xs text-ops-text-muted">{empty}</div> : (
        <div className="space-y-3">
          {items.map((s, i) => (
            <div key={i} className="border-l-2 border-fitscript-green/50 pl-3">
              <div className="text-sm font-medium text-ops-text">{s.title || s.topic}</div>
              <div className="text-xs text-ops-text-muted mt-0.5">{s.rationale}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PeptideuQuestions() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Question[] | { error: string }>({
    queryKey: ["peptideu-questions"],
    queryFn: () => fetch("/api/ops/peptideu/questions").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const analyze = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ops/peptideu/question-insights", { method: "POST", headers: { "Content-Type": "application/json" } });
      const d = await r.json();
      if (d.error) throw new Error(d.error === "read_only" ? "Read-only account — an admin can run the analysis" : d.error);
      setInsights(d);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (isLoading) return <PuLoading />;
  if ((data as any)?.error) return <PuUnavailable message={(data as any).error} />;
  const queue = Array.isArray(data) ? data : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Questions</h1>
        <p className="text-sm text-ops-text-muted mt-1">What members ask the Professor & the Commons — a coach queue, plus AI curriculum-gap analysis.</p>
      </div>

      {/* Coach queue */}
      <div className="bg-ops-surface border border-ops-border rounded-xl mb-8">
        <div className="flex items-center justify-between p-4 border-b border-ops-border">
          <div>
            <div className="text-sm font-semibold text-ops-text">Most-asked questions</div>
            <div className="text-xs text-ops-text-muted">Live — repeats bubble up. Tap a row for the answer given.</div>
          </div>
          <span className="text-xs text-ops-text-muted">{queue.length} shown</span>
        </div>
        {queue.length === 0 ? (
          <div className="p-8 text-center text-sm text-ops-text-muted">No questions logged yet.</div>
        ) : queue.map((q, i) => <QueueRow key={i} q={q} rank={i + 1} />)}
      </div>

      {/* AI gap analysis */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-ops-text">Coverage gaps</h2>
          <p className="text-sm text-ops-text-muted">Cluster real questions and find what the 12 modules don't teach yet.</p>
        </div>
        <button onClick={analyze} disabled={busy}
          className="text-sm font-medium px-4 py-2 rounded-lg border border-fitscript-green/40 text-fitscript-green hover:bg-fitscript-green/10 disabled:opacity-50">
          {busy ? "Analyzing…" : insights ? "Re-analyze" : "Analyze questions"}
        </button>
      </div>
      {err ? <div className="text-sm text-red-400 mb-4">{err}</div> : null}

      {!insights ? (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center text-sm text-ops-text-muted">
          Run the analysis to cluster recent questions into themes and get module & office-hours suggestions.
          <div className="text-xs mt-2">Uses one AI call over the latest ~450 questions.</div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="text-xs text-ops-text-muted">Analysed {insights.sampleSize} recent questions.</div>
          <div className="grid grid-cols-2 gap-4">
            <SuggestionCard head="Suggested new modules" sub="Gaps with real demand" items={insights.moduleSuggestions} empty="No clear module gaps." />
            <SuggestionCard head="Suggested office hours" sub="Live-session topics" items={insights.officeHoursSuggestions} empty="No office-hours suggestions." />
          </div>
          <div className="bg-ops-surface border border-ops-border rounded-xl">
            <div className="p-4 border-b border-ops-border text-sm font-semibold text-ops-text">Themes ({insights.themes.length})</div>
            {insights.themes.map((t, i) => (
              <div key={i} className="flex items-start gap-3 p-4 border-t border-ops-border first:border-t-0">
                <span className={`text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded shrink-0 ${DEMAND[t.demand] || DEMAND.low}`}>{t.demand}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ops-text">{t.topic}</div>
                  <div className="text-xs text-ops-text-muted mt-0.5 italic">e.g. "{t.example}"</div>
                </div>
                <span className={`text-xs font-medium shrink-0 ${t.covered ? "text-ops-text-muted" : "text-fitscript-green"}`}>
                  {t.covered ? `✓ ${t.coveredBy || "covered"}` : "gap"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
