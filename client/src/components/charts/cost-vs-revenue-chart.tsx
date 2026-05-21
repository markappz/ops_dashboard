import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

interface PlatformEconomics {
  coverage: string;
  cost_mtd: number;
  cost_ltd: number;
  revenue_mtd: number;
  gross_margin_pct: number | null;
  series: { date: string; cost_usd: number; revenue_usd: number }[];
}

export function CostVsRevenueChart() {
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const { data, isLoading } = useQuery<PlatformEconomics>({
    queryKey: ["ops-economics-chart", days],
    queryFn: () => fetch(`/api/ops/economics/platform?days=${days}`).then((r) => r.json()),
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 h-80 flex items-center justify-center shadow-card">
        <div className="w-6 h-6 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const formatted = data.series.map((d) => ({
    ...d,
    label: new Date(d.date + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  }));

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ops-text">AI Cost vs Revenue</h3>
          <p className="text-xs text-ops-text-muted mt-1">
            {data.coverage === "atlas_only"
              ? "Atlas chat only · other AI surfaces pending instrumentation"
              : "All AI surfaces"}
          </p>
        </div>
        <div className="flex gap-1 bg-ops-bg rounded-lg p-1">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d as 30 | 60 | 90)}
              className={`px-3 py-1 text-xs rounded ${
                days === d
                  ? "bg-ops-surface text-ops-text"
                  : "text-ops-text-muted hover:text-ops-text"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={formatted}>
            <defs>
              <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#fbbf24" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="label"
              stroke="rgba(255,255,255,0.4)"
              tick={{ fontSize: 11 }}
              interval={Math.max(0, Math.floor(formatted.length / 12))}
            />
            <YAxis
              yAxisId="left"
              stroke="#2E5BFF"
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `$${v}`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#fbbf24"
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => (v < 1 ? `$${v.toFixed(2)}` : `$${v}`)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0f1115",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              labelStyle={{ color: "#fff" }}
              formatter={(value: number, name: string) => {
                if (name === "Revenue") return [`$${value.toFixed(2)}`, name];
                return [`$${value.toFixed(4)}`, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="revenue_usd"
              name="Revenue"
              stroke="#2E5BFF"
              fill="#2E5BFF"
              fillOpacity={0.15}
              strokeWidth={2}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="cost_usd"
              name="AI Cost"
              stroke="#fbbf24"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-ops-border">
        <div>
          <div className="text-xs text-ops-text-muted">Revenue MTD</div>
          <div className="text-base font-bold text-fitscript-green">
            ${data.revenue_mtd.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs text-ops-text-muted">AI Cost MTD</div>
          <div className="text-base font-bold text-amber-300">
            {data.cost_mtd < 1 ? `$${data.cost_mtd.toFixed(4)}` : `$${data.cost_mtd.toFixed(2)}`}
          </div>
        </div>
        <div>
          <div className="text-xs text-ops-text-muted">Gross Margin</div>
          <div
            className={`text-base font-bold ${
              data.gross_margin_pct === null
                ? "text-ops-text-muted"
                : data.gross_margin_pct >= 70
                ? "text-fitscript-green"
                : data.gross_margin_pct >= 40
                ? "text-amber-400"
                : "text-red-400"
            }`}
          >
            {data.gross_margin_pct === null ? "—" : `${data.gross_margin_pct.toFixed(1)}%`}
          </div>
        </div>
      </div>
    </div>
  );
}
