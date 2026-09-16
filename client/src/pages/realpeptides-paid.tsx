import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";
import { DateRangePicker, rangeQuery, useDateRange } from "../components/date-range-picker";

/**
 * Paid Ads (Meta) for Real Peptides.
 *
 * The number that matters is the segment block: subscribers per guide joined to
 * real orders by email on the site (order AFTER opt-in) — first-party truth,
 * independent of Meta's attribution. The traffic block is our own pixel: which
 * campaign/adset/ad is actually landing sessions on the funnels and the store.
 * Pixel purchase counts are a same-domain floor (funnel and store are different
 * origins), never the conversion truth — the segment join is.
 */

interface SegmentRow {
  key: string;
  offer: string;
  subscribers: { window: number; total: number };
  purchasers: { window: number; total: number };
  orders: number;
  revenueCents: number;
  paid: null | { subscribers: number; purchasers: number; revenueCents: number };
}
interface CampaignConv {
  campaign: string;
  adset: string;
  ad: string;
  offer: string;
  subscribers: number;
  purchasers: number;
  revenueCents: number;
}
interface Paid {
  window?: { from: string; to: string; days: number };
  traffic?: {
    error?: string;
    summary?: { sessions: number; visitors: number; purchases: number; revenue: number };
    campaigns?: { campaign: string; adset: string; ad: string; offer: string; sessions: number; visitors: number; purchases: number; revenue: number }[];
    offers?: { offer: string; sessions: number; visitors: number }[];
  };
  segments?: {
    configured?: boolean;
    pending?: boolean;
    hint?: string;
    error?: string;
    segments?: SegmentRow[];
    byCampaign?: CampaignConv[];
  };
  error?: string;
}

const OFFER_LABEL: Record<string, string> = {
  hair: "Hair Growth",
  fatloss: "Fat Loss Bible",
  peptide101: "Peptides 101",
  sexualhealth: "Sexual Health",
  none: "No offer tag",
};
const SEGMENT_LABEL: Record<string, string> = {
  "guide-hair-growth": "Hair Growth",
  "guide-fat-loss": "Fat Loss Bible",
  "guide-peptide-101": "Peptides 101",
  "guide-sexual-health": "Sexual Health",
};
const UTM_TEMPLATES = [
  { offer: "hair", label: "Hair Growth Protocol" },
  { offer: "fatloss", label: "Fat Loss Bible" },
  { offer: "peptide101", label: "Peptides 101" },
  { offer: "sexualhealth", label: "Sexual Health Guide" },
].map((t) => ({
  ...t,
  value: `utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&offer=${t.offer}`,
}));

const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
const usd = (n: number | undefined | null) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = (c: number | undefined | null) => usd((c ?? 0) / 100);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());
const MINUTE = 60_000;

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "good" | "muted" }) {
  const color = tone === "good" ? "text-fitscript-green" : tone === "muted" ? "text-ops-text-muted" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface px-4 py-3 text-sm text-ops-text-muted">
      {children}
    </div>
  );
}

function SegmentCard({ s }: { s: SegmentRow }) {
  const label = SEGMENT_LABEL[s.key] ?? s.key;
  const nonBuyers = s.subscribers.window - s.purchasers.window;
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card">
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-sm font-semibold text-ops-text">{label}</div>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-ops-text-muted">offer={s.offer}</span>
      </div>
      <div className="mb-3 text-3xl font-bold tabular-nums text-fitscript-green">
        {pct(s.purchasers.window, s.subscribers.window)}
        <span className="ml-2 text-xs font-medium text-ops-text-muted">subscriber → buyer</span>
      </div>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-ops-text-muted">Subscribers (range)</dt><dd className="tabular-nums font-medium">{num(s.subscribers.window)}</dd></div>
        <div className="flex justify-between"><dt className="text-ops-text-muted">Purchased</dt><dd className="tabular-nums font-medium">{num(s.purchasers.window)}</dd></div>
        <div className="flex justify-between"><dt className="text-ops-text-muted">Not yet purchased</dt><dd className="tabular-nums font-medium">{num(Math.max(0, nonBuyers))}</dd></div>
        <div className="flex justify-between"><dt className="text-ops-text-muted">Orders / revenue</dt><dd className="tabular-nums font-medium">{num(s.orders)} · {cents(s.revenueCents)}</dd></div>
        <div className="flex justify-between border-t border-ops-border pt-1.5"><dt className="text-ops-text-muted">All-time</dt><dd className="tabular-nums text-ops-text-muted">{num(s.purchasers.total)} of {num(s.subscribers.total)} ({pct(s.purchasers.total, s.subscribers.total)})</dd></div>
      </dl>
      <div className="mt-3 text-xs">
        {s.paid && s.paid.subscribers > 0 ? (
          <span>
            Paid-tagged: <b className="tabular-nums">{num(s.paid.purchasers)}</b> of <b className="tabular-nums">{num(s.paid.subscribers)}</b> bought · {cents(s.paid.revenueCents)}
          </span>
        ) : (
          <span className="text-ops-text-muted">
            No paid-tagged subscribers yet — UTM capture starts when the funnel embed snippets are re-pasted.
          </span>
        )}
      </div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ops-border bg-ops-bg px-3 py-2">
      <div className="w-40 shrink-0 text-xs font-medium text-ops-text">{label}</div>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ops-text-muted">{value}</code>
      <button
        className="shrink-0 rounded-md border border-ops-border px-2.5 py-1 text-xs font-medium hover:bg-ops-surface"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type Level = "campaign" | "adset" | "ad";
const LEVELS: { key: Level; label: string }[] = [
  { key: "campaign", label: "Campaigns" },
  { key: "adset", label: "Ad sets" },
  { key: "ad", label: "Ads" },
];

export default function RealPeptidesPaid() {
  const [range, setRange] = useDateRange("realpeptides");
  const [level, setLevel] = useState<Level>("campaign");

  const q = useQuery<Paid>({
    queryKey: ["rp-paid", rangeQuery(range)],
    queryFn: () => get(`/api/ops/rp/paid?${rangeQuery(range)}`),
    refetchInterval: 5 * MINUTE,
    staleTime: MINUTE,
  });
  const d = q.data;
  const traffic = d?.traffic;
  const seg = d?.segments;

  const grouped = useMemo(() => {
    const rows = traffic?.campaigns ?? [];
    if (level === "ad") return rows;
    const key = (r: (typeof rows)[number]) => (level === "campaign" ? r.campaign : `${r.campaign} ${r.adset}`);
    const out = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = key(r);
      const cur = out.get(k);
      if (!cur) {
        out.set(k, { ...r, adset: level === "campaign" ? "" : r.adset, ad: "" });
      } else {
        cur.sessions += r.sessions;
        cur.visitors += r.visitors;
        cur.purchases += r.purchases;
        cur.revenue += r.revenue;
        if (cur.offer !== r.offer) cur.offer = "mixed";
      }
    }
    return [...out.values()].sort((a, b) => b.sessions - a.sessions);
  }, [traffic?.campaigns, level]);

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Paid Ads"
        subtitle="Meta campaigns measured first-party: our pixel for traffic, the subscriber → order join for conversions."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />

      {q.isLoading && <Banner>Loading…</Banner>}
      {d?.error && <Banner>Error: {d.error}</Banner>}

      {/* ── Subscriber → sale conversion (source of truth) ─────────────── */}
      <h2 className="mb-3 mt-2 text-sm font-semibold uppercase tracking-[0.08em] text-ops-text-muted">Guide subscribers → sales</h2>
      {seg && !seg.configured && <Banner>{seg.hint ?? "Site connection not configured."}</Banner>}
      {seg?.configured && seg.pending && <Banner>{seg.hint}</Banner>}
      {seg?.configured && seg.error && <Banner>Site endpoint error: {seg.error}</Banner>}
      {seg?.segments && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {seg.segments.map((s) => <SegmentCard key={s.key} s={s} />)}
        </div>
      )}

      {/* Conversions attributed to the ad that captured the subscriber (email join, not Meta) */}
      {!!seg?.byCampaign?.length && (
        <div className="mt-4 rounded-xl border border-ops-border bg-ops-surface shadow-card">
          <div className="border-b border-ops-border px-4 py-3">
            <div className="text-sm font-semibold">Conversions by ad</div>
            <div className="text-xs text-ops-text-muted">Subscribers captured by each ad in the range, and which of them bought — email join on the site, independent of Meta's pixel.</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.08em] text-ops-text-muted">
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 font-medium">Ad set</th>
                  <th className="px-4 py-2 font-medium">Ad</th>
                  <th className="px-4 py-2 font-medium">Offer</th>
                  <th className="px-4 py-2 text-right font-medium">Subscribers</th>
                  <th className="px-4 py-2 text-right font-medium">Bought</th>
                  <th className="px-4 py-2 text-right font-medium">Conv.</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {seg.byCampaign.slice(0, 50).map((r, i) => (
                  <tr key={i} className="border-t border-ops-border/60">
                    <td className="max-w-[240px] truncate px-4 py-2" title={r.campaign}>{r.campaign}</td>
                    <td className="max-w-[200px] truncate px-4 py-2" title={r.adset}>{r.adset}</td>
                    <td className="max-w-[200px] truncate px-4 py-2" title={r.ad}>{r.ad}</td>
                    <td className="px-4 py-2 text-xs text-ops-text-muted">{OFFER_LABEL[r.offer] ?? r.offer}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(r.subscribers)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(r.purchasers)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pct(r.purchasers, r.subscribers)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">{cents(r.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Paid traffic from the pixel ────────────────────────────────── */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-[0.08em] text-ops-text-muted">Meta traffic (our pixel)</h2>
      {traffic?.error && <Banner>Pixel query error: {traffic.error}</Banner>}
      {traffic?.summary && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Paid sessions" value={num(traffic.summary.sessions)} />
          <Stat label="Paid visitors" value={num(traffic.summary.visitors)} />
          <Stat label="Store purchases (same-domain)" value={num(traffic.summary.purchases)} sub="Pixel floor — funnel→store buyers appear above, not here" />
          <Stat label="Pixel revenue" value={usd(traffic.summary.revenue)} tone="good" />
        </div>
      )}
      {!!traffic?.offers?.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {traffic.offers.map((o) => (
            <span key={o.offer} className="rounded-full border border-ops-border bg-ops-surface px-3 py-1 text-xs">
              {OFFER_LABEL[o.offer] ?? o.offer}: <b className="tabular-nums">{num(o.sessions)}</b> sessions · {num(o.visitors)} visitors
            </span>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-ops-border bg-ops-surface shadow-card">
        <div className="flex items-center justify-between border-b border-ops-border px-4 py-3">
          <div className="text-sm font-semibold">By {LEVELS.find((l) => l.key === level)?.label.toLowerCase()}</div>
          <div className="flex gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => setLevel(l.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${level === l.key ? "bg-ops-bg text-ops-text border border-ops-border" : "text-ops-text-muted hover:text-ops-text"}`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-[0.08em] text-ops-text-muted">
                <th className="px-4 py-2 font-medium">Campaign</th>
                {level !== "campaign" && <th className="px-4 py-2 font-medium">Ad set</th>}
                {level === "ad" && <th className="px-4 py-2 font-medium">Ad</th>}
                <th className="px-4 py-2 font-medium">Offer</th>
                <th className="px-4 py-2 text-right font-medium">Sessions</th>
                <th className="px-4 py-2 text-right font-medium">Visitors</th>
                <th className="px-4 py-2 text-right font-medium">Purchases</th>
                <th className="px-4 py-2 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((r, i) => (
                <tr key={i} className="border-t border-ops-border/60">
                  <td className="max-w-[260px] truncate px-4 py-2" title={r.campaign}>{r.campaign}</td>
                  {level !== "campaign" && <td className="max-w-[220px] truncate px-4 py-2" title={r.adset}>{r.adset}</td>}
                  {level === "ad" && <td className="max-w-[220px] truncate px-4 py-2" title={r.ad}>{r.ad}</td>}
                  <td className="px-4 py-2 text-xs text-ops-text-muted">{OFFER_LABEL[r.offer] ?? r.offer}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(r.sessions)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(r.visitors)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(r.purchases)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd(r.revenue)}</td>
                </tr>
              ))}
              {!grouped.length && !q.isLoading && (
                <tr><td colSpan={level === "ad" ? 8 : level === "adset" ? 7 : 6} className="px-4 py-8 text-center text-ops-text-muted">
                  No Meta-tagged sessions in this range. Check the ads carry the UTM templates below.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── UTM templates ──────────────────────────────────────────────── */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-[0.08em] text-ops-text-muted">UTM templates (Meta URL parameters)</h2>
      <div className="space-y-2">
        {UTM_TEMPLATES.map((t) => <CopyRow key={t.offer} label={t.label} value={t.value} />)}
      </div>
      <p className="mt-3 text-xs text-ops-text-muted">
        Paste into the ad's “URL parameters” field — Meta fills the {"{{…}}"} placeholders per campaign/ad set/ad.
        Keep <code className="font-mono">offer=</code> matching the guide the ad sells; it's how sessions and subscribers land in the right segment here.
      </p>
    </div>
  );
}
