import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Mail, Users, UserMinus, ShieldAlert, MousePointerClick, DollarSign, Info } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { EmailCalendar } from "./email-calendar";
import { ui } from "./coa/api";

/**
 * Real Peptides Email — flows and campaigns from the site's own instrumentation.
 * Per-send stats exist only from the instrumentation deploy forward; lifetime
 * per-contact counters cover history and are shown separately, never blended.
 */

interface Step { stepIndex: number; subject: string; sends: number; openRate: number | null; clickRate: number | null; bounces: number; complaints: number }
interface Flow {
  flowKey: string; sends: number; instrumented: number; openRate: number | null; clickRate: number | null;
  bounces: number; complaints: number; unsubscribes: number;
  attributedOrders: number; attributedRevenueCents: number; steps: Step[];
}
interface Campaign {
  broadcastId: string; name: string; sends: number; trackedSends?: number; uniqueOpens: number; uniqueClicks: number;
  openRate: number | null; clickRate: number | null; bounces: number; complaints: number; lastSeen: string;
  attributedOrders: number; attributedRevenueCents: number;
  receivedOrders?: number; receivedRevenueCents?: number;
}
interface Payload {
  configured: boolean; hint?: string; days: number; perSendStatsSince: string | null; trackingSince?: string;
  totals: {
    marketableContacts: number; unsubscribed: number; suppressedBounced: number; suppressedComplained: number;
    sends: number; openRate: number | null; clickRate: number | null;
    attributedOrders: number; attributedRevenueCents: number;
    receivedOrders?: number; receivedRevenueCents?: number;
    lifetime: { sends: number; opens: number; clicks: number };
  };
  flows: Flow[]; campaigns: Campaign[];
}

const FLOW_LABEL: Record<string, string> = {
  welcome: "Welcome",
  "abandoned-checkout": "Abandoned checkout",
  "post-purchase": "Post-purchase",
  "browse-abandonment": "Browse abandonment",
  "fat-loss-bible": "Fat Loss Bible",
  "hair-loss-guide": "Hair Loss Guide",
};

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (cents: number) => "$" + (cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function RealPeptidesEmail() {
  const [range, setRange] = useState(30);
  const q = useQuery({
    queryKey: ["rp-email", range],
    queryFn: async () => {
      const r = await fetch(`/api/ops/realpeptides/email?range=${range}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json() as Promise<Payload>;
    },
  });
  const d = q.data;
  const t = d?.totals;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Email"
        subtitle="Flows and campaigns from the site's own send instrumentation — open rates, clicks, unsubscribes, and the sales each flow and broadcast produced (coupon first, else the last email clicked within 7 days)."
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[7, 30, 90].map((n) => (
              <button key={n} type="button" onClick={() => setRange(n)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${range === n ? "bg-fitscript-green text-white" : "text-ops-text-muted hover:text-ops-text"}`}>
                {n}d
              </button>
            ))}
          </div>
        }
      />

      <EmailCalendar company="realpeptides" />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading email analytics…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {d && !d.configured && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-8 text-center shadow-card">
          <div className="mx-auto max-w-md text-sm text-ops-text-muted">{d.hint}</div>
        </div>
      )}

      {d?.configured && t && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat icon={<Users size={16} />} label="Marketable contacts" value={t.marketableContacts.toLocaleString()} />
            <Stat icon={<UserMinus size={16} />} label="Unsubscribed" value={t.unsubscribed.toLocaleString()} />
            <Stat icon={<ShieldAlert size={16} />} label="Suppressed" value={`${t.suppressedBounced + t.suppressedComplained}`}
              sub={`${t.suppressedBounced} bounced · ${t.suppressedComplained} spam`} tone={t.suppressedComplained ? "warn" : undefined} />
            <Stat icon={<Mail size={16} />} label={`Open rate (${range}d)`} value={pct(t.openRate)} sub={`${t.sends.toLocaleString()} tracked sends`} />
            <Stat icon={<MousePointerClick size={16} />} label={`Click rate (${range}d)`} value={pct(t.clickRate)} />
            <Stat icon={<DollarSign size={16} />} label="Email-attributed revenue" value={money(t.attributedRevenueCents)} sub={`${t.attributedOrders} orders by coupon/click${t.receivedOrders ? ` · +${money(t.receivedRevenueCents ?? 0)} (${t.receivedOrders}) received a broadcast <48h` : ""}`} tone="good" />
          </div>

          <div className="mb-6 flex flex-wrap items-start gap-2 rounded-xl border border-ops-border bg-ops-bg/40 px-4 py-3 text-[12px] text-ops-text-muted">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Open and click rates count only sends made after Resend tracking was switched on ({d.trackingSince ? new Date(d.trackingSince).toLocaleString() : "pending"}) — a send before that carries no pixel and no tracked links, so it can never register an open. Earlier sends are shown in the totals but excluded from every rate.
              Lifetime totals across all history: {t.lifetime.sends.toLocaleString()} sends · {t.lifetime.opens.toLocaleString()} opens · {t.lifetime.clicks.toLocaleString()} clicks (per-contact counters, kept separate on purpose).
              Timestamps are UTC.
            </span>
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">Flows</h2>
          <div className="mb-8 overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Flow</th>
                  <th className="px-4 py-3 text-right font-medium">Sends</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Unsubs</th>
                  <th className="px-4 py-3 text-right font-medium">Bounce/Spam</th>
                  <th className="px-4 py-3 text-right font-medium">Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.flows.map((f) => <FlowRow key={f.flowKey} f={f} />)}
                {!d.flows.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-ops-text-muted">No flow sends in this window yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">Campaigns (Resend broadcasts)</h2>
          <div className="overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Campaign</th>
                  <th className="px-4 py-3 text-right font-medium">Sends</th>
                  <th className="px-4 py-3 text-right font-medium">Opens</th>
                  <th className="px-4 py-3 text-right font-medium">Clicks</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Bounce/Spam</th>
                  <th className="px-4 py-3 text-right font-medium">Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.campaigns.map((c) => (
                  <tr key={c.broadcastId}>
                    <td className="max-w-[280px] px-4 py-3">
                      <div className="truncate font-medium text-ops-text" title={c.broadcastId}>{c.name}</div>
                      <div className="text-[11px] text-ops-text-muted">{new Date(c.lastSeen).toLocaleDateString()}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">
                      {c.sends.toLocaleString()}
                      {typeof c.trackedSends === "number" && c.trackedSends < c.sends && <span className="block text-[10px] text-ops-text-muted">{c.trackedSends.toLocaleString()} tracked</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{c.uniqueOpens.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{c.uniqueClicks.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(c.openRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(c.clickRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <BadCounts bounces={c.bounces} complaints={c.complaints} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.attributedOrders
                        ? <span className="font-semibold text-fitscript-green">{money(c.attributedRevenueCents)} <span className="text-[11px] font-normal text-ops-text-muted">({c.attributedOrders} clicked)</span></span>
                        : <span className="text-ops-text-muted">—</span>}
                      {c.receivedOrders
                        ? <span className="block text-[11px] text-ops-text-muted">+{money(c.receivedRevenueCents ?? 0)} ({c.receivedOrders}) received &lt;48h</span>
                        : null}
                    </td>
                  </tr>
                ))}
                {!d.campaigns.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-ops-text-muted">No broadcast events yet — the ledger starts collecting at the instrumentation deploy.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  const color = tone === "good" ? "text-fitscript-green" : tone === "warn" ? "text-yellow-500" : "text-ops-text";
  return (
    <div className="rounded-2xl border border-ops-border bg-ops-surface p-3.5 shadow-card">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-ops-text-muted">{icon} {label}</div>
      <div className={`mt-1.5 text-lg font-bold leading-none tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ops-text-muted">{sub}</div>}
    </div>
  );
}

function BadCounts({ bounces, complaints }: { bounces: number; complaints: number }) {
  if (!bounces && !complaints) return <span className="text-ops-text-muted">—</span>;
  return (
    <span className="text-[12px]">
      {bounces > 0 && <span className="text-yellow-500">{bounces}b</span>}
      {bounces > 0 && complaints > 0 && <span className="text-ops-text-muted"> / </span>}
      {complaints > 0 && <span className="text-red-400">{complaints} spam</span>}
    </span>
  );
}

function FlowRow({ f }: { f: Flow }) {
  const [open, setOpen] = useState(false);
  const partial = f.instrumented < f.sends;
  return (
    <>
      <tr className="cursor-pointer hover:bg-ops-bg/30" onClick={() => setOpen(!open)}>
        <td className="px-4 py-3">
          <span className="flex items-center gap-1.5 font-medium text-ops-text">
            {open ? <ChevronDown size={14} className="text-ops-text-muted" /> : <ChevronRight size={14} className="text-ops-text-muted" />}
            {FLOW_LABEL[f.flowKey] ?? f.flowKey}
          </span>
          {partial && <span className="ml-5 block text-[10px] text-ops-text-muted">{f.instrumented}/{f.sends} sends tracked (rest sent before tracking was on)</span>}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{f.sends.toLocaleString()}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(f.openRate)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(f.clickRate)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{f.unsubscribes || "—"}</td>
        <td className="px-4 py-3 text-right"><BadCounts bounces={f.bounces} complaints={f.complaints} /></td>
        <td className="px-4 py-3 text-right">
          {f.attributedOrders
            ? <span className="font-semibold tabular-nums text-fitscript-green">{money(f.attributedRevenueCents)} <span className="text-[11px] font-normal text-ops-text-muted">({f.attributedOrders})</span></span>
            : <span className="text-ops-text-muted">—</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-ops-bg/30">
          <td colSpan={7} className="px-4 py-3">
            {!f.steps.length ? <span className="text-xs text-ops-text-muted">No steps recorded in this window.</span> : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-ops-text-muted">
                    <th className="py-1 pr-3 text-left font-medium">Step</th>
                    <th className="py-1 pr-3 text-left font-medium">Subject</th>
                    <th className="py-1 pr-3 text-right font-medium">Sends</th>
                    <th className="py-1 pr-3 text-right font-medium">Open</th>
                    <th className="py-1 pr-3 text-right font-medium">CTR</th>
                    <th className="py-1 text-right font-medium">Bounce/Spam</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ops-border/40">
                  {f.steps.map((s) => (
                    <tr key={`${s.stepIndex}-${s.subject}`}>
                      <td className="py-1.5 pr-3 tabular-nums text-ops-text-muted">#{s.stepIndex + 1}</td>
                      <td className="max-w-[380px] truncate py-1.5 pr-3 text-ops-text" title={s.subject}>{s.subject}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-ops-text">{s.sends}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-ops-text">{pct(s.openRate)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-ops-text">{pct(s.clickRate)}</td>
                      <td className="py-1.5 text-right"><BadCounts bounces={s.bounces} complaints={s.complaints} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
