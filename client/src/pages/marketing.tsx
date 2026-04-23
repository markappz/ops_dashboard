import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";

interface ChannelData {
  channel: string;
  users: string;
  paying: string;
  total_revenue: string;
  avg_ltv: string;
  avg_days_to_convert: string;
}

interface FunnelData {
  visitors: string;
  quiz_started: string;
  signups: string;
  paid: string;
  labs_uploaded: string;
  revenue_users: string;
}

interface DailyTraffic {
  date: string;
  visitors: number;
  signups: number;
  paid: number;
}

const CHANNEL_COLORS: Record<string, string> = {
  google: "#4285F4",
  facebook: "#1877F2",
  instagram: "#E4405F",
  tiktok: "#000000",
  youtube: "#FF0000",
  twitter: "#1DA1F2",
  linkedin: "#0A66C2",
  email: "#0EA57A",
  direct: "#6B7280",
  organic: "#10B981",
  chatgpt: "#74AA9C",
  perplexity: "#20808D",
  claude: "#D97706",
  referral: "#8B5CF6",
};

const PIE_COLORS = ["#0EA57A", "#4285F4", "#E4405F", "#FF0000", "#1877F2", "#8B5CF6", "#D97706", "#6B7280", "#1DA1F2", "#0A66C2"];

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
      <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-2xl font-bold ${accent ? "text-fitscript-green" : "text-ops-text"}`}>{value}</div>
      {sub && <div className="text-xs text-ops-text-muted mt-1">{sub}</div>}
    </div>
  );
}

export default function Marketing() {
  const { data: attrData } = useQuery<{ channels: ChannelData[] }>({
    queryKey: ["ops-attribution"],
    queryFn: () => fetch("/api/ops/attribution").then((r) => r.json()),
  });

  const { data: funnelData } = useQuery<FunnelData>({
    queryKey: ["ops-funnel"],
    queryFn: () => fetch("/api/ops/funnel").then((r) => r.json()),
  });

  const channels = attrData?.channels || [];
  const hasData = channels.length > 0;

  // Prepare chart data
  const channelBarData = channels.map((ch) => ({
    name: ch.channel,
    users: parseInt(ch.users),
    paying: parseInt(ch.paying),
    revenue: parseFloat(ch.total_revenue),
  }));

  const channelPieData = channels.map((ch) => ({
    name: ch.channel,
    value: parseInt(ch.users),
  }));

  const revenuePieData = channels.filter((ch) => parseFloat(ch.total_revenue) > 0).map((ch) => ({
    name: ch.channel,
    value: parseFloat(ch.total_revenue),
  }));

  // Group channels by type
  const organic = channels.filter((ch) => ["google", "bing", "yahoo", "duckduckgo"].includes(ch.channel));
  const social = channels.filter((ch) => ["facebook", "instagram", "tiktok", "youtube", "twitter", "linkedin"].includes(ch.channel));
  const ai = channels.filter((ch) => ["chatgpt", "perplexity", "claude", "gemini", "copilot"].includes(ch.channel));
  const paid = channels.filter((ch) => ch.channel.includes("cpc") || ch.channel.includes("paid"));

  const totalVisitors = channels.reduce((s, c) => s + parseInt(c.users), 0);
  const totalRevenue = channels.reduce((s, c) => s + parseFloat(c.total_revenue), 0);
  const totalPaying = channels.reduce((s, c) => s + parseInt(c.paying), 0);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Marketing</h1>
        <p className="text-sm text-ops-text-muted mt-1">Traffic, channels, conversions, and attribution</p>
      </div>

      {/* Top metrics */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Tracked Visitors" value={totalVisitors.toLocaleString()} accent />
        <StatCard label="Paying Customers" value={totalPaying} />
        <StatCard label="Total Revenue (Tracked)" value={`$${totalRevenue.toLocaleString()}`} />
        <StatCard label="Overall Conv Rate" value={totalVisitors > 0 ? `${((totalPaying / totalVisitors) * 100).toFixed(1)}%` : "---"} />
      </div>

      {!hasData && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-8 text-center mb-6 shadow-card">
          <h3 className="text-lg font-semibold text-ops-text mb-2">No tracking data yet</h3>
          <p className="text-sm text-ops-text-muted max-w-lg mx-auto">
            Install the tracking pixel on fitscript.me and data will flow here automatically.
            Visitors are grouped by source — Google, Meta, TikTok, organic, AI engines, etc.
          </p>
        </div>
      )}

      {hasData && (
        <>
          {/* Channel breakdown charts */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            {/* Traffic by channel bar chart */}
            <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
              <h3 className="text-sm font-semibold text-ops-text mb-4">Traffic by Channel</h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={channelBarData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--ops-border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} />
                  <YAxis tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} />
                  <Tooltip contentStyle={{ backgroundColor: "rgb(var(--ops-surface))", border: "1px solid rgb(var(--ops-border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="users" fill="#0EA57A" name="Visitors" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="paying" fill="#4285F4" name="Paying" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Traffic source pie */}
            <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
              <h3 className="text-sm font-semibold text-ops-text mb-4">Traffic Distribution</h3>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={channelPieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {channelPieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => [value, "Visitors"]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Revenue by channel */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
              <h3 className="text-sm font-semibold text-ops-text mb-4">Revenue by Channel</h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={channelBarData.filter((d) => d.revenue > 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--ops-border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} />
                  <YAxis tick={{ fontSize: 11, fill: "rgb(var(--ops-text-muted))" }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip contentStyle={{ backgroundColor: "rgb(var(--ops-surface))", border: "1px solid rgb(var(--ops-border))", borderRadius: 8, fontSize: 12 }} formatter={(value: number) => [`$${value}`, "Revenue"]} />
                  <Bar dataKey="revenue" fill="#0EA57A" name="Revenue" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Revenue distribution pie */}
            {revenuePieData.length > 0 && (
              <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
                <h3 className="text-sm font-semibold text-ops-text mb-4">Revenue Distribution</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={revenuePieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {revenuePieData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`$${value.toLocaleString()}`, "Revenue"]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}

      {/* Channel breakdown table */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* Organic / Search */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Search & Organic</h3>
            <p className="text-xs text-ops-text-muted mt-0.5">Google, Bing, DuckDuckGo + organic referrals</p>
          </div>
          <ChannelTable channels={organic} />
        </div>

        {/* Social */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Social Media</h3>
            <p className="text-xs text-ops-text-muted mt-0.5">Instagram, TikTok, YouTube, Facebook, Twitter, LinkedIn</p>
          </div>
          <ChannelTable channels={social} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* AI Engines */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">AI Engines</h3>
            <p className="text-xs text-ops-text-muted mt-0.5">ChatGPT, Perplexity, Claude, Gemini, Copilot</p>
          </div>
          <ChannelTable channels={ai} />
        </div>

        {/* Paid */}
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Paid Advertising</h3>
            <p className="text-xs text-ops-text-muted mt-0.5">Google Ads, Meta Ads, TikTok Ads</p>
          </div>
          <ChannelTable channels={paid} />
        </div>
      </div>

      {/* GA4 + GSC Integration Status */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ops-text">Google Analytics 4</h3>
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/15 text-yellow-400">Not Connected</span>
          </div>
          <p className="text-sm text-ops-text-muted mb-3">Connect GA4 to see real-time traffic, sessions, pageviews, bounce rate, and user behavior data.</p>
          <div className="text-xs text-ops-text-muted space-y-1">
            <p>1. Create a Google Cloud project</p>
            <p>2. Enable Analytics Data API</p>
            <p>3. Create OAuth 2.0 credentials</p>
            <p>4. Add credentials in Settings</p>
          </div>
        </div>

        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ops-text">Google Search Console</h3>
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/15 text-yellow-400">Not Connected</span>
          </div>
          <p className="text-sm text-ops-text-muted mb-3">Connect GSC to see search queries, impressions, clicks, average position, and keyword rankings.</p>
          <div className="text-xs text-ops-text-muted space-y-1">
            <p>1. Verify site ownership in GSC</p>
            <p>2. Use same Google Cloud project</p>
            <p>3. Enable Search Console API</p>
            <p>4. Add credentials in Settings</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelTable({ channels }: { channels: ChannelData[] }) {
  if (channels.length === 0) {
    return <div className="px-5 py-6 text-center text-sm text-ops-text-muted">No data for this channel group yet</div>;
  }
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-ops-border">
          <th className="text-left px-4 py-2 text-xs font-medium text-ops-text-muted">Channel</th>
          <th className="text-right px-4 py-2 text-xs font-medium text-ops-text-muted">Users</th>
          <th className="text-right px-4 py-2 text-xs font-medium text-ops-text-muted">Paying</th>
          <th className="text-right px-4 py-2 text-xs font-medium text-ops-text-muted">Revenue</th>
          <th className="text-right px-4 py-2 text-xs font-medium text-ops-text-muted">Avg LTV</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ops-border">
        {channels.map((ch) => (
          <tr key={ch.channel} className="hover:bg-ops-surface-hover">
            <td className="px-4 py-2 text-sm text-ops-text font-medium">{ch.channel}</td>
            <td className="px-4 py-2 text-sm text-ops-text-muted text-right">{ch.users}</td>
            <td className="px-4 py-2 text-sm text-ops-text-muted text-right">{ch.paying}</td>
            <td className="px-4 py-2 text-sm text-fitscript-green text-right font-medium">${parseFloat(ch.total_revenue).toLocaleString()}</td>
            <td className="px-4 py-2 text-sm text-ops-text-muted text-right">${parseFloat(ch.avg_ltv).toFixed(0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
