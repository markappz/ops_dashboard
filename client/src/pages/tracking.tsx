import { useQuery } from "@tanstack/react-query";

interface ChannelData {
  channel: string;
  users: string;
  paying: string;
  total_revenue: string;
  avg_ltv: string;
  avg_days_to_convert: string;
  avg_sessions: string;
}

interface FunnelData {
  visitors: string;
  quiz_started: string;
  signups: string;
  paid: string;
  labs_uploaded: string;
  revenue_users: string;
}

interface Campaign {
  id: string;
  name: string;
  slug: string;
  channel: string;
  medium: string;
  status: string;
  spend: string;
  visitors: string;
  signups: string;
  paid_conversions: string;
  revenue: string;
  roas: string;
  cpa: string;
  created_at: string;
}

function FunnelBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const convRate = total > 0 ? ((value / total) * 100).toFixed(1) : "0";
  return (
    <div className="mb-4">
      <div className="flex justify-between text-sm mb-1">
        <span className="text-ops-text font-medium">{label}</span>
        <span className="text-ops-text-muted">{value.toLocaleString()} ({convRate}%)</span>
      </div>
      <div className="h-8 bg-ops-bg rounded-lg overflow-hidden">
        <div className={`h-full rounded-lg ${color} transition-all duration-500`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
    </div>
  );
}

export default function Tracking() {
  const { data: attrData } = useQuery<{ channels: ChannelData[] }>({
    queryKey: ["ops-attribution"],
    queryFn: () => fetch("/api/ops/attribution").then((r) => r.json()),
  });

  const { data: funnelData } = useQuery<FunnelData>({
    queryKey: ["ops-funnel"],
    queryFn: () => fetch("/api/ops/funnel").then((r) => r.json()),
  });

  const { data: campaignData } = useQuery<{ campaigns: Campaign[] }>({
    queryKey: ["ops-campaigns"],
    queryFn: () => fetch("/api/ops/campaigns").then((r) => r.json()),
  });

  const funnel = funnelData ? {
    visitors: parseInt(funnelData.visitors),
    quizStarted: parseInt(funnelData.quiz_started),
    signups: parseInt(funnelData.signups),
    paid: parseInt(funnelData.paid),
    labsUploaded: parseInt(funnelData.labs_uploaded),
    revenueUsers: parseInt(funnelData.revenue_users),
  } : null;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ops-text">Tracking & Attribution</h1>
        <p className="text-sm text-ops-text-muted mt-1">Full funnel from first visit to lifetime value</p>
      </div>

      {/* Funnel */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-6 shadow-card mb-6">
        <h3 className="text-sm font-semibold text-ops-text mb-5">Conversion Funnel</h3>
        {funnel ? (
          <>
            <FunnelBar label="Visitors" value={funnel.visitors} total={funnel.visitors} color="bg-ops-text-muted/30" />
            <FunnelBar label="Quiz Started" value={funnel.quizStarted} total={funnel.visitors} color="bg-blue-500/50" />
            <FunnelBar label="Signups" value={funnel.signups} total={funnel.visitors} color="bg-purple-500/50" />
            <FunnelBar label="Paid Subscribers" value={funnel.paid} total={funnel.visitors} color="bg-fitscript-green/50" />
            <FunnelBar label="Labs Uploaded" value={funnel.labsUploaded} total={funnel.visitors} color="bg-amber-500/50" />
          </>
        ) : (
          <div className="text-sm text-ops-text-muted py-8 text-center">
            No funnel data yet. Install the tracking pixel on fitscript.me to start capturing visitor data.
          </div>
        )}
      </div>

      {/* Attribution by Channel */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card mb-6 overflow-hidden">
        <div className="px-5 py-4 border-b border-ops-border">
          <h3 className="text-sm font-semibold text-ops-text">Attribution by Channel (First Touch)</h3>
        </div>
        {attrData?.channels && attrData.channels.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-ops-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Channel</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Users</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Paying</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Revenue</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Avg LTV</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Avg Days to Convert</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Avg Sessions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border">
              {attrData.channels.map((ch) => (
                <tr key={ch.channel} className="hover:bg-ops-surface-hover">
                  <td className="px-5 py-3 text-sm font-medium text-ops-text">{ch.channel}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{ch.users}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{ch.paying}</td>
                  <td className="px-5 py-3 text-sm text-fitscript-green text-right font-medium">${parseFloat(ch.total_revenue).toLocaleString()}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">${parseFloat(ch.avg_ltv).toFixed(0)}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{parseFloat(ch.avg_days_to_convert).toFixed(0)}d</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{parseFloat(ch.avg_sessions).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-ops-text-muted">
            No attribution data yet. Data populates as tracked visitors sign up.
          </div>
        )}
      </div>

      {/* Campaign Performance */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card overflow-hidden">
        <div className="px-5 py-4 border-b border-ops-border">
          <h3 className="text-sm font-semibold text-ops-text">Campaign Performance</h3>
        </div>
        {campaignData?.campaigns && campaignData.campaigns.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-ops-border">
                <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Campaign</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Channel</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Visitors</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Signups</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Paid</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Revenue</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">Spend</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">ROAS</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-ops-text-muted uppercase tracking-wider">CPA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ops-border">
              {campaignData.campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-ops-surface-hover">
                  <td className="px-5 py-3 text-sm font-medium text-ops-text">{c.name}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted">{c.channel}/{c.medium}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{c.visitors}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{c.signups}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{c.paid_conversions}</td>
                  <td className="px-5 py-3 text-sm text-fitscript-green text-right font-medium">${parseFloat(c.revenue).toLocaleString()}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">${parseFloat(c.spend).toLocaleString()}</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">{c.roas}x</td>
                  <td className="px-5 py-3 text-sm text-ops-text-muted text-right">${c.cpa}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-ops-text-muted">
            No campaigns tracked yet. Campaigns auto-create when visitors arrive with utm_campaign parameters.
          </div>
        )}
      </div>

      {/* Setup Instructions */}
      <div className="mt-6 bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ops-text mb-3">Setup</h3>
        <div className="text-sm text-ops-text-muted space-y-2">
          <p>1. Copy <code className="bg-ops-bg px-1.5 py-0.5 rounded text-xs">tracking.ts</code> into the main FitScript app at <code className="bg-ops-bg px-1.5 py-0.5 rounded text-xs">client/src/lib/tracking.ts</code></p>
          <p>2. In App.tsx or main.tsx: <code className="bg-ops-bg px-1.5 py-0.5 rounded text-xs">import {"{ initTracking }"} from "./lib/tracking"; initTracking();</code></p>
          <p>3. On login/signup: <code className="bg-ops-bg px-1.5 py-0.5 rounded text-xs">identifyUser(userId);</code></p>
          <p>4. On payment: <code className="bg-ops-bg px-1.5 py-0.5 rounded text-xs">trackRevenue(userId, amount);</code></p>
          <p>5. Add tracking API routes to the main FitScript server (or proxy to ops server)</p>
        </div>
      </div>
    </div>
  );
}
