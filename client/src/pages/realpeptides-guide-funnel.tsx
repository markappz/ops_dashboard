import { useQuery } from "@tanstack/react-query";
import { BookOpen, Loader2 } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { StatCard } from "../components/stat";
import { DateRangePicker, useDateRange, rangeKey, rangeDays } from "../components/date-range-picker";

/**
 * tryrealpep.co guide-funnel report. Everything is computed by the engine's
 * /api/ops-guide-funnel; this page renders it with the attribution model
 * and window ALWAYS visible (launch spec: labels must expose both).
 */
interface Bucket { orders: number; netRevenueCents: number }
interface GuideRow {
  guideId: string; landingViews: number; thankYouViews: number; pdfDownloads: number;
  optins: number; eligibleEnrollments: number; activeEnrollments: number;
  guideDelivery: { accepted: number; delivered: number };
  marketing: { sent: number; delivered: number; uniqueClicks: number; held: number; byStep: { step: number; sent: number; delivered: number }[] };
  orders: { handle: Bucket; coupon: Bucket };
}
interface Report {
  configured: boolean; hint?: string; error?: string;
  window?: { days: number; since: string };
  contentRevision?: string; flowsEnabled?: boolean; offersEnabled?: boolean;
  attribution?: { models: string[]; handleWindowDays: number; note: string };
  guides?: GuideRow[];
  legacyCampaigns?: { campaign: string; orders: number; netRevenueCents: number }[];
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const GUIDE_LABEL: Record<string, string> = {
  nootropics: "Nootropics", sleep: "Sleep", recovery: "Recovery", "delivery-methods": "Delivery Methods",
  skin: "Skin", "mens-performance": "Men's Performance", "womens-health": "Women's Health", storage: "Storage", travel: "Travel",
};

export default function RealPeptidesGuideFunnel() {
  const [range, setRange] = useDateRange("rp-guide-funnel");
  const days = rangeDays(range);
  const { data: d, isLoading } = useQuery<Report>({
    queryKey: ["rp-guide-funnel", rangeKey(range)],
    queryFn: async () => {
      const r = await fetch(`/api/ops/realpeptides/guide-funnel?days=${days}`, { credentials: "include" });
      return r.json();
    },
    refetchInterval: 5 * 60_000,
  });

  const guides = d?.guides ?? [];
  const totals = guides.reduce(
    (a, g) => ({
      optins: a.optins + g.optins,
      sent: a.sent + g.marketing.sent,
      clicks: a.clicks + g.marketing.uniqueClicks,
      orders: a.orders + g.orders.handle.orders + g.orders.coupon.orders,
      revenue: a.revenue + g.orders.handle.netRevenueCents + g.orders.coupon.netRevenueCents,
    }),
    { optins: 0, sent: 0, clicks: 0, orders: 0, revenue: 0 },
  );

  return (
    <div className="space-y-4">
      <PageHero
        eyebrow="Real Peptides"
        title="Guide Funnel"
        subtitle="The nine tryrealpep.co guides: opt-ins, delivery, the four-email arcs, and verified orders. Attribution models are labeled on every figure — a tagged click is never counted as a sale."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-ops-border bg-ops-surface p-6 text-sm text-ops-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : !d?.configured ? (
        <div className="rounded-xl border border-amber-500/40 bg-ops-surface p-5 text-sm text-amber-400">{d?.hint ?? "Not connected."}</div>
      ) : d.error ? (
        <div className="rounded-xl border border-red-500/40 bg-ops-surface p-5 text-sm text-red-400">Site feed error: {d.error}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full border px-2.5 py-1 ${d.flowsEnabled ? "border-emerald-400/40 text-emerald-400" : "border-amber-400/40 text-amber-400"}`}>
              Flows {d.flowsEnabled ? "LIVE" : "dark (pre-launch)"}
            </span>
            <span className={`rounded-full border px-2.5 py-1 ${d.offersEnabled ? "border-emerald-400/40 text-emerald-400" : "border-amber-400/40 text-amber-400"}`}>
              50% offers {d.offersEnabled ? "redeemable" : "inactive"}
            </span>
            <span className="rounded-full border border-ops-border px-2.5 py-1 text-ops-text-muted">copy rev {d.contentRevision}</span>
            <span className="rounded-full border border-ops-border px-2.5 py-1 text-ops-text-muted">attribution: handle ({d.attribution?.handleWindowDays}d) + coupon · {d.window?.days}d window</span>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard i={0} label="Opt-ins" icon={<BookOpen />} value={totals.optins.toLocaleString()} />
            <StatCard i={1} label="Marketing sent" value={totals.sent.toLocaleString()} />
            <StatCard i={2} label="Unique clicks" value={totals.clicks.toLocaleString()} />
            <StatCard i={3} label="Verified orders" value={totals.orders.toLocaleString()} />
            <StatCard i={4} label="Net revenue" value={usd(totals.revenue)} accent />
          </div>

          <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.1em] text-ops-text-muted">
                  <th className="px-4 py-2.5 font-medium">Guide</th>
                  <th className="px-3 py-2.5 text-right font-medium">Landing</th>
                  <th className="px-3 py-2.5 text-right font-medium">PDF</th>
                  <th className="px-3 py-2.5 text-right font-medium">Opt-ins</th>
                  <th className="px-3 py-2.5 text-right font-medium">Eligible</th>
                  <th className="px-3 py-2.5 text-right font-medium">Guide deliv.</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sent</th>
                  <th className="px-3 py-2.5 text-right font-medium">Deliv.</th>
                  <th className="px-3 py-2.5 text-right font-medium">Clicks</th>
                  <th className="px-3 py-2.5 text-right font-medium">Orders (handle)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Orders (coupon)</th>
                  <th className="px-3 py-2.5 text-right font-medium">Net revenue</th>
                </tr>
              </thead>
              <tbody>
                {guides.map((g) => (
                  <tr key={g.guideId} className="border-t border-ops-border/40">
                    <td className="px-4 py-2.5 font-medium text-ops-text">{GUIDE_LABEL[g.guideId] ?? g.guideId}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.landingViews.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.pdfDownloads.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text">{g.optins.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.eligibleEnrollments.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.guideDelivery.accepted}/{g.guideDelivery.delivered}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text">{g.marketing.sent.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.marketing.delivered.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text">{g.marketing.uniqueClicks.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text">{g.orders.handle.orders}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ops-text-muted">{g.orders.coupon.orders}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">{usd(g.orders.handle.netRevenueCents + g.orders.coupon.netRevenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(d.legacyCampaigns ?? []).some((l) => l.orders > 0) && (
            <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
              <div className="mb-2.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Legacy guide campaigns · coupon redemptions mapped to campaign records (repair of 09-17 gap)</div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ops-text">
                {(d.legacyCampaigns ?? []).map((l) => (
                  <span key={l.campaign}>{l.campaign}: {l.orders} orders · {usd(l.netRevenueCents)}</span>
                ))}
              </div>
              <p className="mt-2 text-xs text-ops-text-muted">A redemption proves the offer reached the buyer — never that they clicked a specific email. Coupon attribution ranks below handle attribution; an order carrying both counts once, under handle.</p>
            </div>
          )}

          <p className="text-xs text-ops-text-muted">{d.attribution?.note}</p>
        </>
      )}
    </div>
  );
}
