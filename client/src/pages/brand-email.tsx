import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Mail, Users, UserMinus, ShieldAlert, MousePointerClick, Info } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { EmailCalendar } from "./email-calendar";

/**
 * Generic brand email analytics page — identical layout to the Real Peptides
 * Email tab so every brand tracks the same way in one dashboard. Fed by
 * /api/ops/<slug>/email, which proxies the brand's own token-gated summary
 * endpoint. Revenue attribution columns render when the brand's endpoint
 * supplies them (RP does; PeptideU/pawgen show — until wired).
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
}
interface Payload {
  configured: boolean; hint?: string; days: number; trackingSince?: string;
  totals: {
    marketableContacts: number; unsubscribed: number; suppressedBounced: number; suppressedComplained: number;
    sends: number; openRate: number | null; clickRate: number | null;
    lifetime: { sends: number; opens: number; clicks: number };
  };
  flows: Flow[]; campaigns: Campaign[];
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

export function BrandEmail({ slug, brand, subtitle, flowLabels = {} }: {
  slug: string; brand: string; subtitle: string; flowLabels?: Record<string, string>;
}) {
  const [range, setRange] = useState(30);
  const q = useQuery({
    queryKey: [`${slug}-email`, range],
    queryFn: async () => {
      const r = await fetch(`/api/ops/${slug}/email?range=${range}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json() as Promise<Payload>;
    },
  });
  const d = q.data;
  const t = d?.totals;

  return (
    <div>
      <PageHero
        eyebrow={brand}
        title="Email"
        subtitle={subtitle}
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

      <EmailCalendar company={slug} />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading email analytics…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}
      {d && !d.configured && (
        <div className="rounded-2xl border border-ops-border bg-ops-surface p-8 text-center shadow-card">
          <div className="mx-auto max-w-md text-sm text-ops-text-muted">{d.hint}</div>
        </div>
      )}

      {d?.configured && t && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Stat icon={<Users size={16} />} label="Marketable contacts" value={t.marketableContacts.toLocaleString()} />
            <Stat icon={<UserMinus size={16} />} label="Unsubscribed" value={t.unsubscribed.toLocaleString()} />
            <Stat icon={<ShieldAlert size={16} />} label="Suppressed" value={`${t.suppressedBounced + t.suppressedComplained}`}
              sub={`${t.suppressedBounced} bounced · ${t.suppressedComplained} spam`} tone={t.suppressedComplained ? "warn" : undefined} />
            <Stat icon={<Mail size={16} />} label={`Open rate (${range}d)`} value={pct(t.openRate)} sub={`${t.sends.toLocaleString()} tracked sends`} />
            <Stat icon={<MousePointerClick size={16} />} label={`Click rate (${range}d)`} value={pct(t.clickRate)} />
          </div>

          <div className="mb-6 flex flex-wrap items-start gap-2 rounded-xl border border-ops-border bg-ops-bg/40 px-4 py-3 text-[12px] text-ops-text-muted">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Open and click rates count only sends made after Resend tracking was switched on ({d.trackingSince ? new Date(d.trackingSince).toLocaleString() : "pending"}).
              Lifetime: {t.lifetime.sends.toLocaleString()} sends · {t.lifetime.opens.toLocaleString()} opens · {t.lifetime.clicks.toLocaleString()} clicks. Timestamps are UTC.
            </span>
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">Flows</h2>
          <div className="mb-8 overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Flow</th>
                  <th className="px-4 py-3 text-right font-medium">Sends</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Unsubs</th>
                  <th className="px-4 py-3 text-right font-medium">Bounce/Spam</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.flows.map((f) => <FlowRow key={f.flowKey} f={f} labels={flowLabels} />)}
                {!d.flows.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ops-text-muted">No flow sends in this window yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">Campaigns (Resend broadcasts)</h2>
          <div className="overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Campaign</th>
                  <th className="px-4 py-3 text-right font-medium">Sends</th>
                  <th className="px-4 py-3 text-right font-medium">Opens</th>
                  <th className="px-4 py-3 text-right font-medium">Clicks</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Bounce/Spam</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.campaigns.map((c) => (
                  <tr key={c.broadcastId}>
                    <td className="max-w-[280px] px-4 py-3">
                      <div className="truncate font-medium text-ops-text" title={c.broadcastId}>{c.name}</div>
                      <div className="text-[11px] text-ops-text-muted">{new Date(c.lastSeen).toLocaleDateString()}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{c.sends.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{c.uniqueOpens.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{c.uniqueClicks.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(c.openRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(c.clickRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums"><BadCounts bounces={c.bounces} complaints={c.complaints} /></td>
                  </tr>
                ))}
                {!d.campaigns.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-ops-text-muted">No campaign sends in this window yet.</td></tr>}
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

function FlowRow({ f, labels }: { f: Flow; labels: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer hover:bg-ops-bg/30" onClick={() => setOpen(!open)}>
        <td className="px-4 py-3">
          <span className="flex items-center gap-1.5 font-medium text-ops-text">
            {open ? <ChevronDown size={14} className="text-ops-text-muted" /> : <ChevronRight size={14} className="text-ops-text-muted" />}
            {labels[f.flowKey] ?? f.flowKey}
          </span>
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{f.sends.toLocaleString()}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(f.openRate)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(f.clickRate)}</td>
        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{f.unsubscribes || "—"}</td>
        <td className="px-4 py-3 text-right"><BadCounts bounces={f.bounces} complaints={f.complaints} /></td>
      </tr>
      {open && (
        <tr className="bg-ops-bg/30">
          <td colSpan={6} className="px-4 py-3">
            {!f.steps.length ? <span className="text-xs text-ops-text-muted">No per-step data in this window.</span> : null}
          </td>
        </tr>
      )}
    </>
  );
}

export function PeptideuEmail() {
  return (
    <BrandEmail
      slug="peptideu"
      brand="PeptideU"
      subtitle="Campaign blasts and guide funnels from the app's own send log — open rates, clicks, bounces, one tracking system across every brand."
      flowLabels={{ hair: "Hair guide funnel", metabolic: "Metabolic guide funnel", "peptide-101": "Peptide 101 funnel" }}
    />
  );
}

export function PawgenEmail() {
  return (
    <BrandEmail
      slug="pawgen"
      brand="pawgen"
      subtitle="Lifecycle and campaign email from the pawgen site's send instrumentation — same tracking as every other brand."
      flowLabels={{ welcome: "Welcome flow" }}
    />
  );
}
