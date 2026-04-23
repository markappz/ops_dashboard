import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

interface RevenueData {
  chartData: { date: string; revenue: number }[];
  totalRefunds: number;
  activeSubscriptions: number;
  canceledRecent: number;
}

export function RevenueChart() {
  const { data, isLoading } = useQuery<RevenueData>({
    queryKey: ["ops-revenue"],
    queryFn: () => fetch("/api/ops/revenue").then((r) => r.json()),
    staleTime: 60_000,
  });

  if (isLoading || !data?.chartData) {
    return (
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 h-80 flex items-center justify-center shadow-card">
        <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (data.chartData.length === 0) {
    return (
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 h-80 flex items-center justify-center shadow-card">
        <span className="text-sm text-ops-text-muted">No revenue data yet</span>
      </div>
    );
  }

  // Format dates for display
  const formatted = data.chartData.map((d) => ({
    ...d,
    label: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-ops-text">Revenue (90 days)</h3>
        <div className="flex gap-4 text-xs text-ops-text-muted">
          <span>Refunds: ${data.totalRefunds}</span>
          <span>Active subs: {data.activeSubscriptions}</span>
          <span>Canceled (30d): {data.canceledRecent}</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0EA57A" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#0EA57A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--ops-border))" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            contentStyle={{
              backgroundColor: "rgb(var(--ops-surface))",
              border: "1px solid rgb(var(--ops-border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value: number) => [`$${value}`, "Revenue"]}
            labelStyle={{ color: "rgb(var(--ops-text-muted))" }}
          />
          <Area type="monotone" dataKey="revenue" stroke="#0EA57A" strokeWidth={2} fill="url(#revenueGrad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
