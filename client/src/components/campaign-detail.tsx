import { X, Mail, MousePointerClick, DollarSign, Send as SendIcon, AlertTriangle } from "lucide-react";
import { StatCard } from "./stat";

/**
 * Campaign performance drawer (Paul, 10-02: "click directly on them, see how they performed,
 * a nice graphic that's easy to understand — open rate, click rate, sales"). One shared panel,
 * opened from the Email tab's campaign rows and the Broadcasts page's sent list. All figures
 * come from our own ledger (EmailEvent by tag) — the same numbers everywhere.
 */

export interface CampaignLike {
  broadcastId: string;
  name: string;
  prettyName?: string;
  sentAt?: string | null;
  lastSeen?: string | null;
  sends: number;
  trackedSends?: number;
  uniqueOpens: number;
  uniqueClicks: number;
  openRate: number | null;
  clickRate: number | null;
  bounces: number;
  complaints: number;
  attributedOrders: number;
  attributedRevenueCents: number;
  receivedOrders?: number;
  receivedRevenueCents?: number;
}

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function FunnelBar({ label, value, of, color, hint }: { label: string; value: number; of: number; color: string; hint?: string }) {
  const w = of > 0 ? Math.max(1.5, (value / of) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 shrink-0 text-right text-[11px] font-semibold uppercase tracking-wide text-ops-text-muted">{label}</div>
      <div className="h-7 min-w-0 flex-1 rounded-lg bg-ops-bg/60">
        <div className={`flex h-full items-center rounded-lg px-2 ${color}`} style={{ width: `${w}%`, minWidth: value > 0 ? "2.4rem" : 0, transition: "width .6s cubic-bezier(.2,.8,.2,1)" }}>
          {value > 0 && <span className="whitespace-nowrap text-[11px] font-bold text-white drop-shadow">{value.toLocaleString()}</span>}
        </div>
      </div>
      <div className="w-16 shrink-0 text-left text-[11px] tabular-nums text-ops-text-muted">{hint ?? (of > 0 ? `${((value / of) * 100).toFixed(1)}%` : "—")}</div>
    </div>
  );
}

export function CampaignDetail({ c, onClose }: { c: CampaignLike; onClose: () => void }) {
  const delivered = Math.max(0, c.sends - c.bounces);
  const purchased = c.attributedOrders + (c.receivedOrders ?? 0);
  const revenue = c.attributedRevenueCents + (c.receivedRevenueCents ?? 0);
  const when = c.sentAt ?? c.lastSeen;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-2 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div className="my-4 w-full max-w-3xl rounded-2xl border border-ops-border bg-ops-surface shadow-card-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-ops-border p-5">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ops-text-muted">Campaign</div>
            <h2 className="truncate text-lg font-bold text-ops-text">{c.prettyName ?? c.name}</h2>
            <div className="mt-0.5 text-xs text-ops-text-muted">
              {when ? `sent ${new Date(when).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
              {" · "}tag <code className="rounded bg-ops-bg px-1 py-0.5 text-[10px]">{c.broadcastId.slice(0, 34)}</code>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-2 text-ops-text-muted hover:text-ops-text" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="space-y-6 p-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard i={0} icon={<SendIcon />} label="Delivered" number={delivered} sub={`${c.sends.toLocaleString()} sent · ${c.bounces} bounced`} />
            <StatCard i={1} icon={<Mail />} label="Open rate" value={pct(c.openRate)} tone={c.openRate != null && c.openRate >= 0.2 ? "good" : c.openRate != null && c.openRate < 0.1 ? "warn" : undefined} sub={`${c.uniqueOpens.toLocaleString()} unique opens`} />
            <StatCard i={2} icon={<MousePointerClick />} label="Click rate" value={pct(c.clickRate)} sub={`${c.uniqueClicks.toLocaleString()} unique clicks`} />
            <StatCard i={3} icon={<DollarSign />} label="Sales" value={revenue > 0 ? money(revenue) : "—"} accent={revenue > 0} sub={purchased ? `${purchased} order${purchased === 1 ? "" : "s"} attributed` : "coupon or click-within-7d"} />
          </div>

          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ops-text-muted">The funnel</div>
            <div className="space-y-2 rounded-xl border border-ops-border bg-ops-bg/30 p-4">
              <FunnelBar label="Sent" value={c.sends} of={c.sends} color="bg-gradient-to-r from-brand-blue-600 to-brand-blue-500" hint="100%" />
              <FunnelBar label="Delivered" value={delivered} of={c.sends} color="bg-gradient-to-r from-brand-blue-500 to-brand-blue-400" />
              <FunnelBar label="Opened" value={c.uniqueOpens} of={c.sends} color="bg-gradient-to-r from-violet-600 to-violet-500" />
              <FunnelBar label="Clicked" value={c.uniqueClicks} of={c.sends} color="bg-gradient-to-r from-emerald-600 to-emerald-500" />
              <FunnelBar label="Purchased" value={purchased} of={c.sends} color="bg-gradient-to-r from-amber-600 to-amber-500" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-ops-text-muted">
            <span className={`inline-flex items-center gap-1.5 ${c.complaints > 0 ? "font-semibold text-red-400" : ""}`}>
              <AlertTriangle size={13} className={c.complaints > 0 ? "text-red-400" : "text-ops-text-subtle"} />
              {c.complaints} complaint{c.complaints === 1 ? "" : "s"} {c.sends > 0 && c.complaints > 0 ? `(${((c.complaints / c.sends) * 100).toFixed(3)}%)` : ""}
            </span>
            <span>{c.bounces} bounce{c.bounces === 1 ? "" : "s"}{c.sends > 0 ? ` (${((c.bounces / c.sends) * 100).toFixed(2)}%)` : ""}</span>
            {c.attributedOrders > 0 && <span>{money(c.attributedRevenueCents)} click/coupon-attributed ({c.attributedOrders})</span>}
            {(c.receivedOrders ?? 0) > 0 && <span>+{money(c.receivedRevenueCents ?? 0)} received &lt;48h ({c.receivedOrders})</span>}
            {c.lastSeen && <span className="ml-auto">last activity {new Date(c.lastSeen).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
