import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

// Secondary series color for the ops dashboard's brand-blue system (rank bars).
export const PU_GOLD = "#5C7FFF"; // brand-blue-400

export function PuKpi({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5">
      <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-2xl font-bold ${accent ? "text-fitscript-green" : "text-ops-text"}`}>{value}</div>
      {sub && <div className="text-xs text-ops-text-muted mt-1">{sub}</div>}
    </div>
  );
}

export function PuLoading() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="w-8 h-8 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function PuUnavailable({ message }: { message?: string }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center">
      <div className="text-sm text-ops-text-muted">
        {message || "PeptideU database is not connected. Set PEPTIDEU_DATABASE_URL."}
      </div>
    </div>
  );
}

export function SignupsChart() {
  const { data, isLoading } = useQuery<{ date: string; count: number }[]>({
    queryKey: ["peptideu-signups"],
    queryFn: () => fetch("/api/ops/peptideu/signups").then((r) => r.json()),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 h-80 flex items-center justify-center shadow-card">
        <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const rows = Array.isArray(data) ? data : [];
  const formatted = rows.map((d) => ({
    ...d,
    label: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-ops-text">New signups (30 days)</h3>
        <span className="text-xs text-ops-text-muted">{rows.reduce((s, d) => s + d.count, 0)} total</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="puSignupsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0EA57A" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#0EA57A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--ops-border))" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} tickLine={false} axisLine={false} interval={4} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ backgroundColor: "rgb(var(--ops-surface))", border: "1px solid rgb(var(--ops-border))", borderRadius: 8, fontSize: 12 }}
            formatter={(value: number) => [value, "Signups"]}
            labelStyle={{ color: "rgb(var(--ops-text-muted))" }}
          />
          <Area type="monotone" dataKey="count" stroke="#0EA57A" strokeWidth={2} fill="url(#puSignupsGrad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
