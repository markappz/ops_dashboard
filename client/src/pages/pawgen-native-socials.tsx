import { useQuery } from "@tanstack/react-query";
import { MousePointerClick, ShoppingBag, DollarSign, HandCoins } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { StatCard } from "../components/stat";

/**
 * Native-social program: pawgen's own X / Instagram / Facebook / TikTok,
 * managed for 5% of attributed sales. Orders qualify by first-touch attribution
 * (utm_medium=organic-social via the /go/{x,ig,fb,tt} short links or long UTM
 * links; legacy utm_campaign=jess counts too). Commission pays on PAID revenue
 * only — refunds excluded.
 */

type Row = { source: string; paidOrders: number; revenue: number; lastOrderAt: string | null; clicks: number };
type Data = {
  sources: Row[];
  totals: { clicks: number; paidOrders: number; revenue: number; commissionRate: number; commission: number };
  error?: string;
};

const LINKS: Record<string, string> = {
  x: "pawgen.com/go/x",
  instagram: "pawgen.com/go/ig",
  facebook: "pawgen.com/go/fb",
  tiktok: "pawgen.com/go/tt",
};

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PawgenNativeSocials() {
  const q = useQuery<Data>({
    queryKey: ["pawgen-native-socials"],
    queryFn: async () => {
      const r = await fetch("/api/ops/pawgen/native-socials", { credentials: "include" });
      try { return await r.json(); } catch { return { sources: [], totals: { clicks: 0, paidOrders: 0, revenue: 0, commissionRate: 0.05, commission: 0 }, error: `Request failed (HTTP ${r.status})` }; }
    },
  });

  const t = q.data?.totals;

  return (
    <div>
      <PageHero
        eyebrow="pawgen · Marketing"
        title="Native Socials"
        subtitle="The company's own X, Instagram, Facebook, and TikTok. Sales attribute first-touch through the /go short links; the manager earns 5% of paid revenue, refunds excluded."
      />

      {q.data?.error && <p className="mb-4 text-sm text-red-500">{q.data.error}</p>}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard i={0} label="Clicks" icon={<MousePointerClick size={16} />} number={t?.clicks ?? 0} sub="all four platforms" />
        <StatCard i={1} label="Paid orders" icon={<ShoppingBag size={16} />} number={t?.paidOrders ?? 0} sub="first-touch attributed" />
        <StatCard i={2} label="Attributed revenue" icon={<DollarSign size={16} />} number={t?.revenue ?? 0} format={usd} sub="paid only, refunds excluded" />
        <StatCard i={3} label="Commission owed" icon={<HandCoins size={16} />} number={t?.commission ?? 0} format={usd} sub="5% of attributed revenue" accent />
      </div>

      <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ops-border text-left text-xs uppercase tracking-wide text-ops-text-muted">
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3">Link</th>
              <th className="px-4 py-3 text-right">Clicks</th>
              <th className="px-4 py-3 text-right">Paid orders</th>
              <th className="px-4 py-3 text-right">Revenue</th>
              <th className="px-4 py-3 text-right">Commission</th>
              <th className="px-4 py-3">Last order</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.sources ?? []).map((r) => (
              <tr key={r.source} className="border-b border-ops-border/60 last:border-0">
                <td className="px-4 py-3 font-medium capitalize">{r.source}</td>
                <td className="px-4 py-3 text-ops-text-muted">{LINKS[r.source] ?? "—"}</td>
                <td className="px-4 py-3 text-right">{r.clicks.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">{r.paidOrders.toLocaleString()}</td>
                <td className="px-4 py-3 text-right">{usd(r.revenue)}</td>
                <td className="px-4 py-3 text-right">{usd(Math.round(r.revenue * 5) / 100)}</td>
                <td className="px-4 py-3 text-ops-text-muted">{r.lastOrderAt ? new Date(r.lastOrderAt).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {!q.isLoading && (q.data?.sources ?? []).length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-ops-text-muted">No attributed traffic yet. Clicks and sales appear here as soon as the /go links get used.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-ops-text-muted">
        Attribution is first-touch: whoever clicks a native-social link keeps that credit even if they buy
        later without it. Qualifying orders have utm_medium=organic-social or the legacy jess campaign tag.
      </p>
    </div>
  );
}
