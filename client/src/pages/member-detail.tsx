import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";

interface MemberDetailData {
  member: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    subscriptionTier: string | null;
    subscriptionStatus: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    createdAt: string | null;
    lastActiveDate: string | null;
    sex: string | null;
    dateOfBirth: string | null;
  };
  subscription: {
    tier: string;
    status: string;
    period: string;
    startDate: string | null;
    renewalDate: string | null;
  } | null;
  labCount: number;
  chatCount: number;
  stripe: {
    totalPaid: number;
    chargeCount: number;
    lastCharge: string | null;
  } | null;
}

interface Payment {
  id: string;
  amount: number;
  status: string;
  paid: boolean;
  refunded: boolean;
  amountRefunded: number;
  description: string | null;
  created: string;
  receiptUrl: string | null;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex justify-between py-2 border-b border-ops-border last:border-0">
      <span className="text-sm text-ops-text-muted">{label}</span>
      <span className="text-sm text-ops-text font-medium">{value ?? "---"}</span>
    </div>
  );
}

function ConfirmDialog({ title, message, onConfirm, onCancel }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-ops-surface border border-ops-border rounded-xl p-6 max-w-md w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-ops-text mb-2">{title}</h3>
        <p className="text-sm text-ops-text-muted mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-ops-text-muted hover:text-ops-text">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600">Confirm</button>
        </div>
      </div>
    </div>
  );
}

export default function MemberDetail({ id }: { id: string }) {
  const memberId = id;
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<{ title: string; message: string; action: () => void } | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [compMonths, setCompMonths] = useState("1");
  const [changeTier, setChangeTier] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const { data, isLoading } = useQuery<MemberDetailData>({
    queryKey: ["ops-member", memberId],
    queryFn: () => fetch(`/api/ops/members/${memberId}`).then((r) => r.json()),
    enabled: !!memberId,
  });

  const { data: paymentsData } = useQuery<{ payments: Payment[] }>({
    queryKey: ["ops-member-payments", memberId],
    queryFn: () => fetch(`/api/ops/members/${memberId}/payments`).then((r) => r.json()),
    enabled: !!memberId,
  });

  const { data: journeyData } = useQuery<{
    attribution: any;
    touchpoints: any[];
    sessions: any[];
  }>({
    queryKey: ["ops-member-journey", memberId],
    queryFn: () => fetch(`/api/ops/members/${memberId}/journey`).then((r) => r.json()),
    enabled: !!memberId,
  });

  const { data: economics } = useQuery<{
    coverage: string;
    cost_mtd: number;
    cost_ltd: number;
    turns_mtd: number;
    turns_ltd: number;
    avg_cost_per_turn: number;
    avg_latency_ms: number | null;
    revenue_total: number;
    ltv: number;
    cost_to_revenue_pct: number | null;
    surfaces: { surface: string; cost_usd: number; calls: number }[];
    model_mix: { model: string; turns: number; cost_usd: number }[];
    daily_last_30d: { date: string; cost_usd: number }[];
  }>({
    queryKey: ["ops-member-economics", memberId],
    queryFn: () => fetch(`/api/ops/economics/members/${memberId}`).then((r) => r.json()),
    enabled: !!memberId,
  });

  const { data: engagement } = useQuery<{
    email: string;
    profile_id: string | null;
    klaviyo_url: string | null;
    summary: {
      received: number;
      opened: number;
      clicked: number;
      unsubscribed: boolean;
      last_engaged_at: string | null;
    };
    campaigns: Array<{
      name: string;
      type: "campaign" | "flow";
      received: number;
      opened: number;
      clicked: number;
      revenue: number;
      lastAt: string;
    }>;
    events: Array<{
      datetime: string;
      metric: string;
      campaign_name: string | null;
      flow_id: string | null;
      value: number;
    }>;
    note?: string;
    error?: string;
  }>({
    queryKey: ["ops-member-email-engagement", memberId],
    queryFn: () =>
      fetch(`/api/ops/klaviyo/member/${memberId}/email-engagement`).then((r) =>
        r.json(),
      ),
    enabled: !!memberId,
    staleTime: 60_000 * 5,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["ops-member", memberId] });
    queryClient.invalidateQueries({ queryKey: ["ops-member-payments", memberId] });
    queryClient.invalidateQueries({ queryKey: ["ops-snapshot"] });
  };

  const showFeedback = (type: "success" | "error", msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 4000);
  };

  const doAction = async (url: string, body?: object) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      invalidate();
      showFeedback("success", "Done");
      return data;
    } catch (e: any) {
      showFeedback("error", e.message);
    }
  };

  const doPatch = async (url: string, body: object) => {
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      invalidate();
      showFeedback("success", "Done");
    } catch (e: any) {
      showFeedback("error", e.message);
    }
  };

  if (!memberId) return <div className="p-8 text-ops-text-muted">No member selected</div>;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="w-8 h-8 border-2 border-fitscript-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data?.member) {
    return (
      <div className="p-8">
        <Link href="/members" className="text-sm text-ops-text-muted hover:text-ops-text mb-4 inline-block">Back to Members</Link>
        <div className="text-ops-text-muted mt-4">Member not found (ID: {memberId})</div>
      </div>
    );
  }

  const { member, subscription, labCount, chatCount, stripe } = data;
  const isActive = member.subscriptionStatus === "active" && member.subscriptionTier !== "free";
  const isPaused = member.subscriptionStatus === "paused";
  const hasSub = !!member.stripeSubscriptionId;

  return (
    <div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title} message={confirm.message}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <Link href="/members" className="text-sm text-ops-text-muted hover:text-ops-text mb-4 inline-block">
        Back to Members
      </Link>

      {/* Feedback toast */}
      {feedback && (
        <div className={`fixed top-20 right-8 px-4 py-3 rounded-lg text-sm font-medium z-50 shadow-lg ${
          feedback.type === "success" ? "bg-fitscript-green text-white" : "bg-red-500 text-white"
        }`}>
          {feedback.msg}
        </div>
      )}

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-ops-text">
            {member.firstName || ""} {member.lastName || ""}
            {!member.firstName && !member.lastName && <span className="text-ops-text-muted italic">No name</span>}
          </h1>
          <p className="text-sm text-ops-text-muted mt-1">{member.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
            member.subscriptionTier === "free" ? "bg-zinc-600/30 text-zinc-400" :
            member.subscriptionTier === "complete" || member.subscriptionTier === "elite" ? "bg-amber-500/20 text-amber-400" :
            "bg-fitscript-green/20 text-fitscript-green"
          }`}>
            {member.subscriptionTier || "free"}
          </span>
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
            member.subscriptionStatus === "active" ? "bg-green-500/15 text-green-400" :
            member.subscriptionStatus === "paused" ? "bg-yellow-500/15 text-yellow-400" :
            "bg-red-500/15 text-red-400"
          }`}>
            {member.subscriptionStatus || "active"}
          </span>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-4">Profile</h3>
          <InfoRow label="Email" value={member.email} />
          <InfoRow label="Sex" value={member.sex} />
          <InfoRow label="DOB" value={member.dateOfBirth ? new Date(member.dateOfBirth).toLocaleDateString() : null} />
          <InfoRow label="Signed Up" value={member.createdAt ? new Date(member.createdAt).toLocaleDateString() : null} />
          <InfoRow label="Last Active" value={member.lastActiveDate ? new Date(member.lastActiveDate).toLocaleDateString() : null} />
        </div>

        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-4">Subscription</h3>
          <InfoRow label="Tier" value={member.subscriptionTier || "free"} />
          <InfoRow label="Status" value={member.subscriptionStatus || "active"} />
          <InfoRow label="Period" value={subscription?.period} />
          <InfoRow label="Start" value={subscription?.startDate ? new Date(subscription.startDate).toLocaleDateString() : null} />
          <InfoRow label="Renewal" value={subscription?.renewalDate ? new Date(subscription.renewalDate).toLocaleDateString() : null} />
        </div>

        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ops-text mb-4">Revenue</h3>
          <InfoRow label="Total Paid" value={stripe ? `$${stripe.totalPaid.toFixed(2)}` : "---"} />
          <InfoRow label="Payments" value={stripe?.chargeCount} />
          <InfoRow label="Last Payment" value={stripe?.lastCharge ? new Date(stripe.lastCharge).toLocaleDateString() : null} />
          <InfoRow label="Lab Uploads" value={labCount} />
          <InfoRow label="Atlas Chats" value={chatCount} />
        </div>
      </div>

      {/* AI Economics */}
      {economics && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-sm font-semibold text-ops-text">AI Economics</h3>
            <div className="text-xs text-ops-text-muted">
              {economics.coverage === "atlas_only"
                ? "Atlas chat only · other AI surfaces pending instrumentation"
                : "All AI surfaces"}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Cost MTD</div>
              <div className="text-lg font-bold text-amber-300">
                {economics.cost_mtd < 0.01 ? `$${economics.cost_mtd.toFixed(4)}` : `$${economics.cost_mtd.toFixed(2)}`}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">{economics.turns_mtd} turns</div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Cost LTD</div>
              <div className="text-lg font-bold text-amber-300">
                {economics.cost_ltd < 0.01 ? `$${economics.cost_ltd.toFixed(4)}` : `$${economics.cost_ltd.toFixed(2)}`}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">{economics.turns_ltd} turns</div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Avg / Turn</div>
              <div className="text-lg font-bold text-ops-text">
                ${economics.avg_cost_per_turn.toFixed(4)}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">
                {economics.avg_latency_ms ? `${economics.avg_latency_ms}ms avg` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Revenue</div>
              <div className="text-lg font-bold text-fitscript-green">
                ${economics.revenue_total.toFixed(2)}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">LTV ${economics.ltv.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-ops-text-muted uppercase tracking-wider">Cost / Revenue</div>
              <div
                className={`text-lg font-bold ${
                  economics.cost_to_revenue_pct === null
                    ? "text-ops-text-muted"
                    : economics.cost_to_revenue_pct < 20
                    ? "text-fitscript-green"
                    : economics.cost_to_revenue_pct < 50
                    ? "text-amber-400"
                    : "text-red-400"
                }`}
              >
                {economics.cost_to_revenue_pct === null
                  ? "—"
                  : `${economics.cost_to_revenue_pct.toFixed(1)}%`}
              </div>
              <div className="text-xs text-ops-text-muted mt-1">
                {economics.cost_to_revenue_pct === null
                  ? "no revenue yet"
                  : economics.cost_to_revenue_pct < 20
                  ? "healthy"
                  : economics.cost_to_revenue_pct < 50
                  ? "watch"
                  : "review"}
              </div>
            </div>
          </div>

          {/* Model mix + 30d sparkline */}
          {(economics.model_mix.length > 0 || economics.daily_last_30d.length > 0) && (
            <div className="grid grid-cols-2 gap-6 mt-6 pt-5 border-t border-ops-border">
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">Model Mix</div>
                {economics.model_mix.length === 0 ? (
                  <div className="text-sm text-ops-text-muted">No Atlas activity yet.</div>
                ) : (
                  <div className="space-y-2">
                    {economics.model_mix.map((m, i) => {
                      const modelLabel = (m.model ?? "unknown")
                        .replace("us.anthropic.", "")
                        .replace(/-v\d+:\d+$/, "");
                      return (
                      <div key={m.model ?? `unknown-${i}`} className="flex items-center justify-between text-sm">
                        <span className="text-ops-text-muted font-mono text-xs truncate max-w-[60%]" title={m.model ?? "unknown"}>
                          {modelLabel}
                        </span>
                        <div className="flex gap-3">
                          <span className="text-ops-text-muted">{m.turns} turns</span>
                          <span className="text-amber-300 font-medium w-16 text-right">
                            ${m.cost_usd.toFixed(4)}
                          </span>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">Last 30 Days</div>
                {economics.daily_last_30d.length === 0 ? (
                  <div className="text-sm text-ops-text-muted">No activity in last 30 days.</div>
                ) : (
                  <div className="flex items-end gap-1 h-16">
                    {(() => {
                      const max = Math.max(...economics.daily_last_30d.map((d) => d.cost_usd), 0.0001);
                      return economics.daily_last_30d.map((d) => (
                        <div
                          key={d.date}
                          className="flex-1 bg-amber-400/60 rounded-t-sm hover:bg-amber-400 transition-colors"
                          style={{ height: `${(d.cost_usd / max) * 100}%`, minHeight: d.cost_usd > 0 ? "2px" : "0" }}
                          title={`${d.date}: $${d.cost_usd.toFixed(4)}`}
                        />
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Email Engagement */}
      {engagement && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
          <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-sm font-semibold text-ops-text">Email Engagement</h3>
            <div className="flex items-center gap-3 text-xs">
              {engagement.summary.unsubscribed && (
                <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-400 font-medium">
                  Unsubscribed
                </span>
              )}
              {engagement.klaviyo_url ? (
                <a
                  href={engagement.klaviyo_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ops-text-muted hover:text-fitscript-green"
                >
                  Open in Klaviyo ↗
                </a>
              ) : (
                <span className="text-ops-text-muted">{engagement.note || "no profile"}</span>
              )}
            </div>
          </div>

          {engagement.profile_id ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-5">
                <div>
                  <div className="text-xs text-ops-text-muted uppercase tracking-wider">Received</div>
                  <div className="text-lg font-bold text-ops-text">{engagement.summary.received}</div>
                </div>
                <div>
                  <div className="text-xs text-ops-text-muted uppercase tracking-wider">Opened</div>
                  <div className="text-lg font-bold text-fitscript-green">
                    {engagement.summary.opened}
                  </div>
                  <div className="text-[10px] text-ops-text-muted mt-1">
                    {engagement.summary.received > 0
                      ? `${((engagement.summary.opened / engagement.summary.received) * 100).toFixed(0)}% open rate`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ops-text-muted uppercase tracking-wider">Clicked</div>
                  <div className="text-lg font-bold text-fitscript-green">
                    {engagement.summary.clicked}
                  </div>
                  <div className="text-[10px] text-ops-text-muted mt-1">
                    {engagement.summary.opened > 0
                      ? `${((engagement.summary.clicked / engagement.summary.opened) * 100).toFixed(0)}% CTOR`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ops-text-muted uppercase tracking-wider">Last Engaged</div>
                  <div className="text-base font-medium text-ops-text">
                    {engagement.summary.last_engaged_at
                      ? new Date(engagement.summary.last_engaged_at).toLocaleDateString()
                      : "Never"}
                  </div>
                  {engagement.summary.last_engaged_at && (
                    <div className="text-[10px] text-ops-text-muted mt-1">
                      {Math.floor(
                        (Date.now() - new Date(engagement.summary.last_engaged_at).getTime()) /
                          (1000 * 60 * 60 * 24),
                      )}d ago
                    </div>
                  )}
                </div>
              </div>

              {engagement.campaigns.length > 0 && (
                <div className="pt-4 border-t border-ops-border">
                  <div className="text-xs text-ops-text-muted uppercase tracking-wider mb-3">
                    Campaigns &amp; Flows
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-ops-text-muted">
                        <th className="text-left pb-2 font-medium">Name</th>
                        <th className="text-right pb-2 font-medium">Rec.</th>
                        <th className="text-right pb-2 font-medium">Open</th>
                        <th className="text-right pb-2 font-medium">Click</th>
                        <th className="text-right pb-2 font-medium">Revenue</th>
                        <th className="text-right pb-2 font-medium">Last</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ops-border/40">
                      {engagement.campaigns.map((c, i) => (
                        <tr key={i}>
                          <td className="py-2 pr-3 max-w-[300px] truncate" title={c.name}>
                            <span
                              className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${
                                c.type === "flow" ? "bg-blue-400" : "bg-amber-400"
                              }`}
                            />
                            <span className="text-ops-text">{c.name}</span>
                          </td>
                          <td className="py-2 text-right text-ops-text-muted">{c.received}</td>
                          <td className="py-2 text-right text-fitscript-green">{c.opened}</td>
                          <td className="py-2 text-right text-fitscript-green">{c.clicked}</td>
                          <td className="py-2 text-right text-fitscript-green font-medium">
                            {c.revenue > 0 ? `$${c.revenue.toFixed(2)}` : "—"}
                          </td>
                          <td className="py-2 text-right text-ops-text-muted text-xs">
                            {new Date(c.lastAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}

              {engagement.events.length > 0 && (
                <details className="pt-4 border-t border-ops-border mt-4">
                  <summary className="text-xs text-ops-text-muted uppercase tracking-wider cursor-pointer hover:text-ops-text">
                    Recent event timeline ({engagement.events.length})
                  </summary>
                  <div className="mt-3 space-y-1 max-h-80 overflow-y-auto">
                    {engagement.events.map((e, i) => (
                      <div key={i} className="flex items-center justify-between text-xs py-1.5 px-2 hover:bg-ops-surface-hover rounded">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span className="text-ops-text-muted w-32 shrink-0">
                            {new Date(e.datetime).toLocaleString()}
                          </span>
                          <span
                            className={
                              e.metric === "Opened Email"
                                ? "text-fitscript-green font-medium"
                                : e.metric === "Clicked Email"
                                  ? "text-fitscript-green font-medium"
                                  : e.metric === "Bounced Email"
                                    ? "text-red-400"
                                    : "text-ops-text"
                            }
                          >
                            {e.metric}
                          </span>
                          {e.campaign_name && (
                            <span className="text-ops-text-muted truncate">
                              · {e.campaign_name}
                            </span>
                          )}
                          {!e.campaign_name && e.flow_id && (
                            <span className="text-ops-text-muted font-mono text-[10px]">
                              · flow {e.flow_id}
                            </span>
                          )}
                        </div>
                        {e.value > 0 && (
                          <span className="text-fitscript-green font-medium">${e.value.toFixed(2)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          ) : (
            <div className="text-sm text-ops-text-muted py-3">
              No Klaviyo profile found for {engagement.email}. This user may not be in any Klaviyo list yet.
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mb-6">
        <h3 className="text-sm font-semibold text-ops-text mb-4">Actions</h3>
        <div className="flex flex-wrap gap-3">

          {/* Subscription controls */}
          {isActive && hasSub && (
            <>
              <button onClick={() => setConfirm({
                title: "Cancel at Period End",
                message: `Cancel ${member.email}'s subscription at end of billing period?`,
                action: () => doAction(`/api/ops/members/${memberId}/cancel`, { immediate: false }),
              })} className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
                Cancel at Period End
              </button>
              <button onClick={() => setConfirm({
                title: "Cancel Immediately",
                message: `Cancel NOW? ${member.email} loses access immediately.`,
                action: () => doAction(`/api/ops/members/${memberId}/cancel`, { immediate: true }),
              })} className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
                Cancel Now
              </button>
              <button onClick={() => doAction(`/api/ops/members/${memberId}/pause`)}
                className="px-3 py-2 text-sm rounded-lg bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20">
                Pause
              </button>
            </>
          )}

          {isPaused && hasSub && (
            <button onClick={() => doAction(`/api/ops/members/${memberId}/resume`)}
              className="px-3 py-2 text-sm rounded-lg bg-fitscript-green/10 text-fitscript-green hover:bg-fitscript-green/20">
              Resume
            </button>
          )}

          {/* Tier change */}
          <div className="flex items-center gap-2">
            <select value={changeTier} onChange={(e) => setChangeTier(e.target.value)}
              className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text">
              <option value="">Change tier...</option>
              <option value="free">Free</option>
              <option value="essentials">Essentials</option>
              <option value="optimized">Optimized</option>
              <option value="complete">Complete</option>
              <option value="elite">Elite</option>
            </select>
            {changeTier && (
              <button onClick={() => setConfirm({
                title: "Change Tier",
                message: `Change ${member.email} to "${changeTier}"?`,
                action: () => { doAction(`/api/ops/members/${memberId}/change-tier`, { tier: changeTier }); setChangeTier(""); },
              })} className="px-3 py-2 text-sm rounded-lg bg-fitscript-green/10 text-fitscript-green hover:bg-fitscript-green/20">
                Apply
              </button>
            )}
          </div>

          {/* Comp months */}
          {isActive && hasSub && (
            <div className="flex items-center gap-2">
              <input type="number" min="1" max="12" value={compMonths} onChange={(e) => setCompMonths(e.target.value)}
                className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-16" />
              <button onClick={() => doAction(`/api/ops/members/${memberId}/comp`, { months: parseInt(compMonths) })}
                className="px-3 py-2 text-sm rounded-lg bg-fitscript-green/10 text-fitscript-green hover:bg-fitscript-green/20">
                Comp {compMonths}mo
              </button>
            </div>
          )}

          <div className="w-px h-8 bg-ops-border self-center" />

          {/* Refund */}
          <button onClick={() => setConfirm({
            title: "Refund Last Payment",
            message: `Full refund on ${member.email}'s most recent charge?`,
            action: () => doAction(`/api/ops/members/${memberId}/refund`, { reason: "requested_by_customer" }),
          })} className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
            Refund Last Payment
          </button>

          <div className="flex items-center gap-2">
            <input type="number" placeholder="$ amount" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)}
              className="bg-ops-bg border border-ops-border rounded-lg px-3 py-2 text-sm text-ops-text w-28" />
            {refundAmount && (
              <button onClick={() => setConfirm({
                title: "Partial Refund",
                message: `Refund $${refundAmount} to ${member.email}?`,
                action: () => { doAction(`/api/ops/members/${memberId}/refund`, { amount: parseFloat(refundAmount), reason: "requested_by_customer" }); setRefundAmount(""); },
              })} className="px-3 py-2 text-sm rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20">
                Refund ${refundAmount}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Payment History */}
      <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card">
        <div className="px-5 py-4 border-b border-ops-border">
          <h3 className="text-sm font-semibold text-ops-text">Payment History</h3>
        </div>
        <div className="divide-y divide-ops-border">
          {(!paymentsData?.payments || paymentsData.payments.length === 0) && (
            <div className="px-5 py-8 text-center text-sm text-ops-text-muted">No payments found</div>
          )}
          {paymentsData?.payments.map((p) => (
            <div key={p.id} className="px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${p.refunded ? "bg-red-400" : p.paid ? "bg-green-400" : "bg-yellow-400"}`} />
                <div>
                  <div className="text-sm text-ops-text">
                    ${p.amount.toFixed(2)}
                    {p.refunded && <span className="text-red-400 ml-2">(refunded ${p.amountRefunded.toFixed(2)})</span>}
                  </div>
                  <div className="text-xs text-ops-text-muted">{p.description || p.id}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-ops-text-muted">{new Date(p.created).toLocaleDateString()}</span>
                {p.receiptUrl && (
                  <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-fitscript-green hover:underline">Receipt</a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Attribution & Source */}
      {journeyData?.attribution && (
        <div className="bg-ops-surface border border-ops-border rounded-xl p-5 shadow-card mt-6">
          <h3 className="text-sm font-semibold text-ops-text mb-4">Acquisition & Attribution</h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">First Touch</div>
              <InfoRow label="Source" value={journeyData.attribution.first_touch_source || "direct"} />
              <InfoRow label="Medium" value={journeyData.attribution.first_touch_medium} />
              <InfoRow label="Campaign" value={journeyData.attribution.first_touch_campaign} />
              <InfoRow label="Landing Page" value={journeyData.attribution.first_touch_landing} />
              <InfoRow label="Date" value={journeyData.attribution.first_touch_at ? new Date(journeyData.attribution.first_touch_at).toLocaleDateString() : null} />
            </div>
            <div>
              <div className="text-xs text-ops-text-muted font-medium uppercase tracking-wider mb-2">Conversion</div>
              <InfoRow label="Sessions Before Signup" value={journeyData.attribution.total_sessions} />
              <InfoRow label="Days to Convert" value={journeyData.attribution.days_to_convert} />
              <InfoRow label="Total Touchpoints" value={journeyData.attribution.total_touchpoints} />
              <InfoRow label="LTV (Lifetime)" value={`$${parseFloat(journeyData.attribution.ltv_lifetime || 0).toFixed(2)}`} />
              <InfoRow label="Total Revenue" value={`$${parseFloat(journeyData.attribution.total_revenue || 0).toFixed(2)}`} />
            </div>
          </div>
        </div>
      )}

      {/* Customer Journey Timeline */}
      {journeyData?.touchpoints && journeyData.touchpoints.length > 0 && (
        <div className="bg-ops-surface border border-ops-border rounded-xl shadow-card mt-6">
          <div className="px-5 py-4 border-b border-ops-border">
            <h3 className="text-sm font-semibold text-ops-text">Customer Journey ({journeyData.touchpoints.length} events)</h3>
          </div>
          <div className="divide-y divide-ops-border max-h-96 overflow-y-auto">
            {journeyData.touchpoints.map((tp: any, i: number) => (
              <div key={tp.id || i} className="px-5 py-3 flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  tp.event_type === "signup" ? "bg-purple-400" :
                  tp.event_type === "subscription_started" ? "bg-fitscript-green" :
                  tp.event_type === "payment" ? "bg-amber-400" :
                  tp.event_type === "lab_uploaded" ? "bg-blue-400" :
                  "bg-ops-text-muted/50"
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ops-text">
                    <span className="font-medium">{tp.event_type.replace(/_/g, " ")}</span>
                    {tp.page_url && <span className="text-ops-text-muted ml-2">{tp.page_url}</span>}
                  </div>
                  {tp.utm_source && (
                    <div className="text-xs text-ops-text-muted">
                      via {tp.utm_source}{tp.utm_campaign ? ` / ${tp.utm_campaign}` : ""}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  {parseFloat(tp.revenue) > 0 && (
                    <div className="text-sm text-fitscript-green font-medium">${parseFloat(tp.revenue).toFixed(2)}</div>
                  )}
                  <div className="text-xs text-ops-text-muted">
                    {new Date(tp.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
