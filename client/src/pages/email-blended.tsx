import { useState } from "react";
import { StatCard } from "../components/stat";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Mail, Users, UserMinus, ShieldAlert, MousePointerClick, DollarSign } from "lucide-react";
import { PageHero } from "../components/page-hero";

/**
 * Blended email view — every brand's list health and performance in one tab,
 * fed by /api/ops/email/blended (which fans out to each brand's own summary
 * endpoint). One place for the growth seat: combined totals up top, then the
 * per-brand rows, then the latest campaigns across all brands.
 */

interface BrandRow {
  slug: string; label: string; configured: boolean; error?: string;
  totals?: {
    marketableContacts: number; unsubscribed: number; suppressedBounced: number; suppressedComplained: number;
    sends: number; trackedSends?: number; openRate: number | null; clickRate: number | null;
    attributedOrders: number; attributedRevenueCents: number;
  };
}
interface Payload {
  days: number;
  brands: BrandRow[];
  combined: {
    marketableContacts: number; unsubscribed: number; suppressed: number; sends: number;
    openRate: number | null; clickRate: number | null; attributedOrders: number; attributedRevenueCents: number;
  };
  campaigns: Array<{
    brand: string; brandLabel: string; broadcastId: string; name: string; sentAt?: string; lastSeen?: string;
    sends: number; openRate: number | null; clickRate: number | null; attributedOrders: number; attributedRevenueCents: number;
  }>;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (cents: number) => "$" + (cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
const BRAND_TONE: Record<string, string> = {
  realpeptides: "bg-blue-500/15 text-blue-400",
  peptideu: "bg-amber-500/15 text-amber-400",
  pawgen: "bg-orange-500/15 text-orange-400",
};

export default function EmailBlended() {
  const [range, setRange] = useState(30);
  const q = useQuery({
    queryKey: ["email-blended", range],
    queryFn: async () => {
      const r = await fetch(`/api/ops/email/blended?range=${range}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json() as Promise<Payload>;
    },
  });
  const d = q.data;
  const c = d?.combined;

  return (
    <div>
      <PageHero
        eyebrow="All brands"
        title="Email"
        subtitle="Every company's list health and email performance in one view — combined totals, brand by brand, and the latest campaigns across the portfolio. New brands appear here automatically once their email endpoint is wired."
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-ops-border bg-ops-surface p-1">
            {[7, 30, 90].map((n) => (
              <button key={n} onClick={() => setRange(n)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${range === n ? "bg-ops-bg text-ops-text" : "text-ops-text-muted hover:text-ops-text"}`}>
                {n}d
              </button>
            ))}
          </div>
        }
      />

      {q.isLoading && <div className="py-16 text-center text-sm text-ops-text-muted">Loading blended email analytics…</div>}
      {q.error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.error as Error).message}</div>}

      {d && c && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat icon={<Users size={16} />} label="Marketable contacts" value={c.marketableContacts.toLocaleString()} />
            <Stat icon={<UserMinus size={16} />} label="Unsubscribed" value={c.unsubscribed.toLocaleString()} />
            <Stat icon={<ShieldAlert size={16} />} label="Suppressed" value={c.suppressed.toLocaleString()} tone={c.suppressed ? "warn" : undefined} />
            <Stat icon={<Mail size={16} />} label={`Sends · ${d.days}d`} value={c.sends.toLocaleString()} />
            <Stat icon={<MousePointerClick size={16} />} label="Open · click rate" value={<>{pct(c.openRate)} <span className="text-base font-semibold text-ops-text-muted">· {pct(c.clickRate)}</span></>} sub="tracked-send weighted" />
            <Stat icon={<DollarSign size={16} />} label="Email-attributed revenue" value={money(c.attributedRevenueCents)} sub={`${c.attributedOrders} orders`} tone="good" />
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">By brand</h2>
          <div className="mb-8 overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Brand</th>
                  <th className="px-4 py-3 text-right font-medium">Contacts</th>
                  <th className="px-4 py-3 text-right font-medium">Unsubs</th>
                  <th className="px-4 py-3 text-right font-medium">Sends · {d.days}d</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Attributed sales</th>
                  <th className="px-4 py-3 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.brands.map((b) => (
                  <tr key={b.slug}>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${BRAND_TONE[b.slug] ?? "bg-ops-bg text-ops-text"}`}>{b.label}</span>
                      {!b.configured && <span className="ml-2 text-[11px] text-yellow-500">{b.error ? "endpoint error" : "not wired"}</span>}
                    </td>
                    {b.configured && b.totals ? (
                      <>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{b.totals.marketableContacts.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text-muted">{b.totals.unsubscribed.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{b.totals.sends.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(b.totals.openRate)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(b.totals.clickRate)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {b.totals.attributedOrders
                            ? <span className="font-semibold text-fitscript-green">{money(b.totals.attributedRevenueCents)} <span className="text-[11px] font-normal text-ops-text-muted">({b.totals.attributedOrders})</span></span>
                            : <span className="text-ops-text-muted">—</span>}
                        </td>
                      </>
                    ) : (
                      <td colSpan={6} className="px-4 py-3 text-right text-[12px] text-ops-text-muted">{b.error ?? "Set this brand's EMAIL_API_URL + TOKEN on ops to light it up."}</td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <Link href={`/${b.slug}/email`} className="text-xs font-medium text-ops-text-muted hover:text-ops-text">Open →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-ops-text-muted">Latest campaigns · all brands</h2>
          <div className="overflow-x-auto rounded-2xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-ops-border bg-ops-bg/40 text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Campaign</th>
                  <th className="px-4 py-3 font-medium">Brand</th>
                  <th className="px-4 py-3 text-right font-medium">Sends</th>
                  <th className="px-4 py-3 text-right font-medium">Open rate</th>
                  <th className="px-4 py-3 text-right font-medium">CTR</th>
                  <th className="px-4 py-3 text-right font-medium">Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ops-border/50">
                {d.campaigns.map((cp) => (
                  <tr key={`${cp.brand}-${cp.broadcastId}`}>
                    <td className="max-w-[320px] px-4 py-3">
                      <div className="truncate font-medium text-ops-text" title={cp.name}>{cp.name}</div>
                      <div className="text-[11px] text-ops-text-muted">{new Date(cp.sentAt ?? cp.lastSeen ?? 0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                    </td>
                    <td className="px-4 py-3"><span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${BRAND_TONE[cp.brand] ?? "bg-ops-bg text-ops-text"}`}>{cp.brandLabel}</span></td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{cp.sends.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(cp.openRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ops-text">{pct(cp.clickRate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {cp.attributedOrders
                        ? <span className="font-semibold text-fitscript-green">{money(cp.attributedRevenueCents)}</span>
                        : <span className="text-ops-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {!d.campaigns.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-ops-text-muted">No campaigns recorded in this window.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: "good" | "warn" }) {
  return <StatCard icon={icon} label={label} value={value} sub={sub} tone={tone} />;
}
