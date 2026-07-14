import { useQuery } from "@tanstack/react-query";
import { PuLoading } from "../components/peptideu/ui";

interface ModuleRow {
  title: string;
  orderIndex: number;
  lessons: number;
  lessonsCompleted: number;
  learners: number;
  quizAttempts: number;
  quizPasses: number;
  quizPassRate: number;
}

function pct(n: number) { return `${(n * 100).toFixed(0)}%`; }

function PassRateBar({ rate, attempts }: { rate: number; attempts: number }) {
  if (attempts === 0) return <span className="text-xs text-ops-text-muted">—</span>;
  const color = rate >= 0.8 ? "bg-fitscript-green" : rate >= 0.5 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 rounded-full bg-ops-bg overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${rate * 100}%` }} />
      </div>
      <span className="text-xs text-ops-text tabular-nums">{pct(rate)}</span>
    </div>
  );
}

export default function PeptideuCurriculum() {
  const { data, isLoading } = useQuery<ModuleRow[]>({
    queryKey: ["peptideu-curriculum"],
    queryFn: () => fetch("/api/ops/peptideu/curriculum").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <PuLoading />;
  const rows = Array.isArray(data) ? data : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Curriculum</h1>
        <p className="text-sm text-ops-text-muted mt-1">Module completion &amp; quiz pass rates across {rows.length} modules</p>
      </div>

      <div className="bg-ops-surface border border-ops-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ops-border text-xs uppercase tracking-wider text-ops-text-muted">
              <th className="text-left font-medium px-5 py-3 w-8">#</th>
              <th className="text-left font-medium px-5 py-3">Module</th>
              <th className="text-right font-medium px-5 py-3">Lessons</th>
              <th className="text-right font-medium px-5 py-3">Learners</th>
              <th className="text-right font-medium px-5 py-3">Completions</th>
              <th className="text-right font-medium px-5 py-3">Quiz attempts</th>
              <th className="text-left font-medium px-5 py-3">Pass rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ops-border">
            {rows.map((m, i) => (
              <tr key={i} className="hover:bg-ops-surface-hover transition-colors">
                <td className="px-5 py-3 text-ops-text-muted tabular-nums">{m.orderIndex + 1}</td>
                <td className="px-5 py-3 text-ops-text">{m.title}</td>
                <td className="px-5 py-3 text-right text-ops-text-muted tabular-nums">{m.lessons}</td>
                <td className="px-5 py-3 text-right text-ops-text tabular-nums">{m.learners}</td>
                <td className="px-5 py-3 text-right text-ops-text-muted tabular-nums">{m.lessonsCompleted}</td>
                <td className="px-5 py-3 text-right text-ops-text-muted tabular-nums">{m.quizAttempts}</td>
                <td className="px-5 py-3"><PassRateBar rate={m.quizPassRate} attempts={m.quizAttempts} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-ops-text-muted">No curriculum data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
