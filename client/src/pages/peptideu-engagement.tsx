import { useQuery } from "@tanstack/react-query";
import { PuLoading } from "../components/peptideu/ui";

interface Metric { events: number; users: number; }
interface Engagement {
  ask: Metric;
  coa: Metric;
  commons: Metric & { posts: number; comments: number };
  officeHours: Metric;
  researchLog: Metric;
}

const FEATURES: { key: keyof Engagement; label: string; unit: string; blurb: string }[] = [
  { key: "ask", label: "Ask the Professor", unit: "questions", blurb: "AI education Q&A" },
  { key: "coa", label: "COA Scanner", unit: "scans", blurb: "Document analysis" },
  { key: "commons", label: "The Commons", unit: "posts + comments", blurb: "Community feed" },
  { key: "officeHours", label: "Office Hours", unit: "RSVPs", blurb: "Live sessions" },
  { key: "researchLog", label: "Research Log", unit: "entries", blurb: "Private tracking" },
];

function Card({ label, blurb, events, users, unit }: { label: string; blurb: string; events: number; users: number; unit: string }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
      <div className="text-sm font-semibold text-ops-text">{label}</div>
      <div className="text-xs text-ops-text-muted mb-4">{blurb}</div>
      <div className="flex items-end gap-6">
        <div>
          <div className="text-2xl font-bold text-ops-text tabular-nums">{events.toLocaleString()}</div>
          <div className="text-xs text-ops-text-muted">{unit}</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-fitscript-green tabular-nums">{users.toLocaleString()}</div>
          <div className="text-xs text-ops-text-muted">unique users</div>
        </div>
      </div>
    </div>
  );
}

export default function PeptideuEngagement() {
  const { data, isLoading } = useQuery<Engagement>({
    queryKey: ["peptideu-engagement"],
    queryFn: () => fetch("/api/ops/peptideu/engagement").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return <PuLoading />;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Feature Engagement</h1>
        <p className="text-sm text-ops-text-muted mt-1">Usage across PeptideU's core tools</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {FEATURES.map((f) => {
          const m = data[f.key];
          return <Card key={f.key} label={f.label} blurb={f.blurb} events={m.events} users={m.users} unit={f.unit} />;
        })}
      </div>
    </div>
  );
}
