import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";
import { InlineError, hasApiError } from "../components/query-error";

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
  const { data: attrData, error: attrErr } = useQuery<{ channels: ChannelData[] }>({
    queryKey: ["ops-attribution"],
    queryFn: () => fetch("/api/ops/attribution").then((r) => r.json()),
  });

  const { data: funnelData, error: funnelErr } = useQuery<FunnelData>({
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

      {(hasApiError(attrData) || attrErr) && (
        <div className="mb-4">
          <InlineError context="Channel attribution" data={attrData} error={attrErr as Error | null} />
        </div>
      )}
      {(hasApiError(funnelData) || funnelErr) && (
        <div className="mb-4">
          <InlineError context="Funnel" data={funnelData} error={funnelErr as Error | null} />
        </div>
      )}

      {/* Top metrics */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Tracked Visitors" value={totalVisitors.toLocaleString()} accent />
        <StatCard label="Paying Customers" value={totalPaying} />
        <StatCard label="Total Revenue (Tracked)" value={`$${totalRevenue.toLocaleString()}`} />
        <StatCard label="Overall Conv Rate" value={totalVisitors > 0 ? `${((totalPaying / totalVisitors) * 100).toFixed(1)}%` : "---"} />
      </div>

      {/* Google Analytics 4 */}
      <GA4Section />

      {/* Meta Ads */}
      <MetaAdsSection />


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

interface MetaCampaign {
  campaignId: string;
  name: string;
  status: string | null;
  objective: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversions: number;
  conversionValue: number;
  reach: number;
  roas: number;
  cpa: number;
}

interface MetaCampaignsResp {
  timeframe: string;
  accountId: string;
  campaigns: MetaCampaign[];
  totals: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    conversionValue: number;
    ctr: number;
    cpc: number;
    cpa: number;
    roas: number;
  };
}

interface MetaStatus {
  configured: boolean;
  connected: boolean;
  accountId?: string;
  accountName?: string;
  currency?: string;
  error?: string;
  envHint?: string;
}

function fmtMoney(v: number, currency = "USD"): string {
  if (!v) return `${currency === "USD" ? "$" : ""}0`;
  const symbol = currency === "USD" ? "$" : "";
  if (v < 1) return `${symbol}${v.toFixed(2)}`;
  return `${symbol}${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function MetaStatusBadge({ s }: { s: MetaStatus }) {
  if (!s.configured) {
    return <span className="text-xs text-ops-text-muted">Not configured</span>;
  }
  if (s.connected) {
    return (
      <span className="flex items-center gap-2 text-xs">
        <span className="w-2 h-2 rounded-full bg-fitscript-green" />
        <span className="text-ops-text-muted">
          {s.accountName} · {s.currency}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="w-2 h-2 rounded-full bg-red-400" />
      <span className="text-red-400">{s.error || "Connection error"}</span>
    </span>
  );
}

function MetaAdsSection() {
  const { data: status } = useQuery<MetaStatus>({
    queryKey: ["meta-status"],
    queryFn: () => fetch("/api/ops/meta/status").then((r) => r.json()),
  });
  const enabled = !!status?.connected;
  const { data, isLoading, error: metaErr } = useQuery<MetaCampaignsResp>({
    queryKey: ["meta-campaigns"],
    queryFn: () =>
      fetch("/api/ops/meta/campaigns?days=30").then((r) => r.json()),
    enabled,
    staleTime: 60_000 * 5,
  });

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold text-ops-text">Meta Ads (last 30d)</h3>
        {status && <MetaStatusBadge s={status} />}
      </div>

      {status && !status.configured && (
        <div className="bg-ops-bg border border-ops-border rounded-lg p-4 text-xs text-ops-text-muted">
          <div className="font-medium text-ops-text mb-2">Connect Meta Ads</div>
          <div className="space-y-2">
            <p>{status.envHint}</p>
            <ol className="list-decimal list-inside space-y-1 text-ops-text-muted/80">
              <li>business.facebook.com → Settings → System Users → Create</li>
              <li>Assign the System User to your ad account with <code className="bg-ops-bg px-1 rounded">Advertise</code> permission</li>
              <li>Generate a long-lived token with the <code className="bg-ops-bg px-1 rounded">ads_read</code> scope</li>
              <li>
                Add to <code className="bg-ops-bg px-1 rounded">ops-dashboard/.env</code>:
                <pre className="bg-ops-bg p-2 mt-1 rounded text-[10px] overflow-x-auto">
                  META_SYSTEM_USER_TOKEN=EAA...{"\n"}META_AD_ACCOUNT_ID=1234567890
                </pre>
              </li>
              <li>Restart the dashboard.</li>
            </ol>
          </div>
        </div>
      )}

      {status?.configured && !status.connected && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-xs text-red-300">
          {status.error || "Connection error"}
        </div>
      )}

      {enabled && (
        <>
          {/* Totals */}
          {data?.totals && (
            <div className="grid grid-cols-6 gap-4 mb-5">
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">Spend</div>
                <div className="text-lg font-bold text-amber-300">
                  {fmtMoney(data.totals.spend, status.currency)}
                </div>
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">Impressions</div>
                <div className="text-lg font-bold text-ops-text">
                  {data.totals.impressions.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">Clicks</div>
                <div className="text-lg font-bold text-ops-text">
                  {data.totals.clicks.toLocaleString()}
                </div>
                <div className="text-[10px] text-ops-text-muted mt-1">{data.totals.ctr.toFixed(2)}% CTR</div>
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">CPC</div>
                <div className="text-lg font-bold text-ops-text">
                  {fmtMoney(data.totals.cpc, status.currency)}
                </div>
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">Conversions</div>
                <div className="text-lg font-bold text-fitscript-green">
                  {data.totals.conversions.toLocaleString()}
                </div>
                <div className="text-[10px] text-ops-text-muted mt-1">
                  {data.totals.cpa > 0 ? `${fmtMoney(data.totals.cpa, status.currency)} CPA` : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider">ROAS</div>
                <div
                  className={`text-lg font-bold ${
                    data.totals.roas >= 3
                      ? "text-fitscript-green"
                      : data.totals.roas >= 1
                        ? "text-amber-400"
                        : "text-red-400"
                  }`}
                >
                  {data.totals.roas > 0 ? `${data.totals.roas.toFixed(2)}x` : "—"}
                </div>
                <div className="text-[10px] text-ops-text-muted mt-1">
                  {fmtMoney(data.totals.conversionValue, status.currency)} revenue
                </div>
              </div>
            </div>
          )}

          {/* Campaigns table */}
          {(hasApiError(data) || metaErr) && (
            <div className="mb-3">
              <InlineError context="Meta Ads campaigns" data={data} error={metaErr as Error | null} />
            </div>
          )}
          {isLoading ? (
            <div className="text-sm text-ops-text-muted">Loading campaigns…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-ops-text-muted">
                  <tr className="border-b border-ops-border">
                    <th className="text-left px-3 py-2 font-medium">Campaign</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Spend</th>
                    <th className="text-right px-3 py-2 font-medium">Impr.</th>
                    <th className="text-right px-3 py-2 font-medium">CTR</th>
                    <th className="text-right px-3 py-2 font-medium">CPC</th>
                    <th className="text-right px-3 py-2 font-medium">Conv.</th>
                    <th className="text-right px-3 py-2 font-medium">CPA</th>
                    <th className="text-right px-3 py-2 font-medium">ROAS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ops-border">
                  {(data?.campaigns ?? []).map((c) => (
                    <tr key={c.campaignId}>
                      <td className="px-3 py-2 text-ops-text max-w-[260px] truncate" title={c.name}>
                        {c.name}
                        {c.objective && (
                          <div className="text-[10px] text-ops-text-muted">{c.objective}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${
                            c.status === "ACTIVE"
                              ? "bg-fitscript-green/10 text-fitscript-green"
                              : c.status === "PAUSED"
                                ? "bg-amber-500/10 text-amber-300"
                                : "bg-ops-bg text-ops-text-muted"
                          }`}
                        >
                          {c.status || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-amber-300 font-medium">
                        {fmtMoney(c.spend, status.currency)}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text-muted">
                        {c.impressions.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text">
                        {c.ctr > 0 ? `${c.ctr.toFixed(2)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text">
                        {c.cpc > 0 ? fmtMoney(c.cpc, status.currency) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-fitscript-green">
                        {c.conversions > 0 ? c.conversions.toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-ops-text">
                        {c.cpa > 0 ? fmtMoney(c.cpa, status.currency) : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${
                          c.roas >= 3
                            ? "text-fitscript-green"
                            : c.roas >= 1
                              ? "text-amber-400"
                              : c.roas > 0
                                ? "text-red-400"
                                : "text-ops-text-muted"
                        }`}
                      >
                        {c.roas > 0 ? `${c.roas.toFixed(2)}x` : "—"}
                      </td>
                    </tr>
                  ))}
                  {(data?.campaigns ?? []).length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-sm text-ops-text-muted">
                        No campaigns in the last 30 days.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── GA4 Section ────────────────────────────────────────────────────

interface GA4Daily {
  date: string;
  sessions: number;
  users: number;
  newUsers: number;
  pageViews: number;
  bounceRate: number;
  avgDuration: number;
}

interface GA4Overview {
  connected: boolean;
  daily?: GA4Daily[];
  totals?: { sessions: number; users: number; newUsers: number; pageViews: number };
  sources?: { channel: string; sessions: number; users: number; pageViews: number }[];
  topPages?: { page: string; views: number; avgDuration: number }[];
  error?: string;
}

interface ConnectionsResp {
  google?: { connected: boolean; ga4PropertyId?: string };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function GA4Section() {
  const { data: connections } = useQuery<ConnectionsResp>({
    queryKey: ["ops-connections"],
    queryFn: () => fetch("/api/ops/connections").then((r) => r.json()),
  });
  const ready =
    !!connections?.google?.connected && !!connections.google.ga4PropertyId;

  const { data, isLoading, error } = useQuery<GA4Overview>({
    queryKey: ["ops-ga4-overview", 30],
    queryFn: () => fetch("/api/ops/ga4/overview?range=30").then((r) => r.json()),
    enabled: ready,
    staleTime: 60_000 * 5,
  });

  return (
    <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ops-text">Google Analytics 4 (last 30d)</h3>
          {ready && (
            <p className="text-xs text-ops-text-muted mt-0.5">
              Property {connections!.google!.ga4PropertyId} · cross-validates with first-party attribution above
            </p>
          )}
        </div>
        {!ready && (
          <span className="text-xs text-ops-text-muted">Not configured</span>
        )}
      </div>

      {!ready ? (
        <div className="bg-ops-bg border border-ops-border rounded-lg p-4 text-xs text-ops-text-muted">
          {connections?.google?.connected
            ? "GA4 connected but no property selected."
            : "Google account not connected."}{" "}
          <a href="/integrations" className="text-fitscript-green hover:underline">
            Configure →
          </a>
        </div>
      ) : error ? (
        <InlineError context="GA4" error={error as Error | null} />
      ) : hasApiError(data) ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-xs text-red-300">
          {(data as { error: string }).error}
        </div>
      ) : (() => {
        const d = data as GA4Overview | undefined;
        if (d?.error) {
          return (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-xs text-red-300">
              {d.error}
            </div>
          );
        }
        if (isLoading || !d?.totals) {
          return <div className="text-sm text-ops-text-muted">Loading GA4 data…</div>;
        }
        return <GA4Body data={d} />;
      })()}
    </div>
  );
}

function GA4Body({ data }: { data: GA4Overview }) {
  const totals = data.totals!;
  const sources = data.sources ?? [];
  const topPages = data.topPages ?? [];
  const daily = data.daily ?? [];
  return (
    <>
      <div className="grid grid-cols-4 gap-4 mb-5">
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider">Sessions</div>
          <div className="text-2xl font-bold text-ops-text">
            {totals.sessions.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider">Users</div>
          <div className="text-2xl font-bold text-fitscript-green">
            {totals.users.toLocaleString()}
          </div>
          <div className="text-[10px] text-ops-text-muted mt-1">
            {totals.newUsers.toLocaleString()} new
          </div>
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider">Page Views</div>
          <div className="text-2xl font-bold text-ops-text">
            {totals.pageViews.toLocaleString()}
          </div>
          <div className="text-[10px] text-ops-text-muted mt-1">
            {totals.sessions > 0
              ? `${(totals.pageViews / totals.sessions).toFixed(1)} per session`
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider">Avg Bounce</div>
          <div className="text-2xl font-bold text-ops-text">
            {daily.length > 0
              ? `${((daily.reduce((s: number, d: GA4Daily) => s + d.bounceRate, 0) / daily.length) * 100).toFixed(1)}%`
              : "—"}
          </div>
        </div>
      </div>

      {/* Daily traffic chart */}
      {daily.length > 0 && (
        <div className="mb-5">
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-2">
            Daily Traffic
          </div>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={daily.map((d) => ({
                  ...d,
                  label: `${d.date.slice(4, 6)}/${d.date.slice(6, 8)}`,
                }))}
              >
                <defs>
                  <linearGradient id="ga4Sessions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4285F4" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#4285F4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="label"
                  stroke="rgba(255,255,255,0.4)"
                  tick={{ fontSize: 10 }}
                  interval={Math.max(0, Math.floor(daily.length / 12))}
                />
                <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#0f1115",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Area type="monotone" dataKey="sessions" name="Sessions" stroke="#4285F4" fill="url(#ga4Sessions)" strokeWidth={2} />
                <Area type="monotone" dataKey="users" name="Users" stroke="#0EA57A" fill="#0EA57A" fillOpacity={0.1} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Sources + top pages side-by-side */}
      <div className="grid grid-cols-2 gap-6 pt-4 border-t border-ops-border">
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
            Traffic by Channel (GA4)
          </div>
          {sources.length > 0 ? (
            <div className="space-y-1.5">
              {sources.slice(0, 8).map((s) => (
                <div key={s.channel} className="flex items-center justify-between text-sm">
                  <span className="text-ops-text">{s.channel}</span>
                  <div className="flex gap-3">
                    <span className="text-ops-text-muted text-xs">
                      {s.users.toLocaleString()} users
                    </span>
                    <span className="text-ops-text font-medium w-20 text-right">
                      {s.sessions.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ops-text-muted">No channel data.</div>
          )}
        </div>
        <div>
          <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
            Top Pages
          </div>
          {topPages.length > 0 ? (
            <div className="space-y-1.5">
              {topPages.slice(0, 8).map((p) => (
                <div key={p.page} className="flex items-center justify-between text-sm">
                  <span className="text-ops-text-muted truncate max-w-[70%]" title={p.page}>
                    {p.page}
                  </span>
                  <div className="flex gap-3">
                    <span className="text-ops-text-muted text-xs">
                      {formatDuration(p.avgDuration)}
                    </span>
                    <span className="text-ops-text font-medium w-16 text-right">
                      {p.views.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ops-text-muted">No pages data.</div>
          )}
        </div>
      </div>
    </>
  );
}
