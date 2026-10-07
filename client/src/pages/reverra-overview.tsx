import { useQuery } from "@tanstack/react-query";
import {
  MINUTE, usd, num, get, rangeLabel,
  Delta, Card, Section, DailyBars, Breakdown, Panel, CommandHero,
} from "../components/command-center";
import { useDateRange, rangeQuery, rangeDays } from "../components/date-range-picker";

/**
 * Reverra Command Center (2026-10-07). D2C peptide oral-strip store, 49%
 * BRANDMAXXER. Sales come from the store's token-gated /api/ops-summary via
 * server/reverra-site.ts; traffic and search ride the shared GA4/GSC
 * connectors. Store not launched yet — every source renders its honest
 * connect state until the env vars and Google connection land.
 */

interface Win {
  revenue: number; grossSales: number; orders: number; aov: number;
  customers: number; itemsSold: number; refunds: number; coupons: number;
}
interface Summary {
  configured: boolean; hint?: string;
  current?: Win; previous?: Win;
  daily?: { date: string; revenue: number; orders: number }[];
  topProducts?: { name: string; units: number; revenue: number; orders: number }[];
  pending?: number;
}
interface Ga4 { connected?: boolean; totals?: { sessions?: number; users?: number; pageViews?: number } }
interface Gsc { connected?: boolean; totals?: { clicks?: number; impressions?: number; ctr?: number; position?: number } }

export default function ReverraOverview() {
  const [range, setRange] = useDateRange("reverra-overview");
  const days = rangeDays(range);
  const qs = rangeQuery(range);

  const sales = useQuery<Summary>({
    queryKey: ["rv-summary", qs],
    queryFn: () => get(`/api/ops/reverra/summary?${qs}`),
    refetchInterval: MINUTE,
  });
  const ga4 = useQuery<Ga4>({
    queryKey: ["rv-ga4", days],
    queryFn: () => get(`/api/ops/ga4/overview?company=reverra&range=${days}`),
    refetchInterval: 5 * MINUTE,
  });
  const gsc = useQuery<Gsc>({
    queryKey: ["rv-gsc", days],
    queryFn: () => get(`/api/ops/gsc/overview?company=reverra&range=${days}`),
    refetchInterval: 5 * MINUTE,
  });

  const cur = sales.data?.current;
  const prev = sales.data?.previous;
  const rl = rangeLabel(range);

  return (
    <div>
      <CommandHero
        eyebrow="Reverra"
        subtitle="Reverra at a glance — sales, backlog, traffic and search. Tiles read the same feeds as their tabs."
        range={range}
        setRange={setRange}
        keys={["rv-summary", "rv-ga4", "rv-gsc"]}
        refreshing={sales.isFetching}
      />

      {sales.data && !sales.data.configured && (
        <div className="mb-5 rounded-2xl border border-ops-border bg-ops-surface p-6 text-sm text-ops-text-muted shadow-card">
          {sales.data.hint || "Reverra store not connected yet."}
        </div>
      )}
      {sales.error && (
        <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {(sales.error as Error).message}
        </div>
      )}

      <Section title="Sales" hint={rl}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Card i={0} label={`Revenue · ${rl}`} accent value={usd(cur?.revenue)}
            sub={cur && prev ? <Delta cur={cur.revenue} prev={prev.revenue} /> : undefined} />
          <Card i={1} label={`Orders · ${rl}`} value={num(cur?.orders)}
            sub={cur && prev ? <Delta cur={cur.orders} prev={prev.orders} /> : undefined} />
          <Card i={2} label="Average order" value={usd(cur?.aov)} />
          <Card i={3} label={`Customers · ${rl}`} value={num(cur?.customers)} />
          <Card i={4} label="Backlog" value={num(sales.data?.pending)}
            sub="paid, awaiting fulfilment"
            tone={(sales.data?.pending ?? 0) > 0 ? "warn" : undefined} />
          <Card i={5} label={`Refunds · ${rl}`} value={usd(cur?.refunds)}
            tone={(cur?.refunds ?? 0) > 0 ? "bad" : undefined} />
        </div>
      </Section>

      <Section title="Traffic & search" hint={rl}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card i={0} label={`Sessions · ${rl}`}
            value={ga4.data?.connected === false ? "—" : num(ga4.data?.totals?.sessions)}
            sub={ga4.data?.connected === false ? "GA4 not connected" : ga4.data?.totals?.users != null ? `${num(ga4.data.totals.users)} users` : undefined}
            tone={ga4.data?.connected === false ? "warn" : undefined} to="/reverra/traffic" />
          <Card i={1} label={`Page views · ${rl}`}
            value={ga4.data?.connected === false ? "—" : num(ga4.data?.totals?.pageViews)} />
          <Card i={2} label={`Search clicks · ${rl}`}
            value={gsc.data?.connected === false ? "—" : num(gsc.data?.totals?.clicks)}
            sub={gsc.data?.connected === false ? "GSC not connected" : gsc.data?.totals?.impressions != null ? `${num(gsc.data.totals.impressions)} impressions` : undefined}
            tone={gsc.data?.connected === false ? "warn" : undefined} to="/reverra/seo" />
          <Card i={3} label="Avg position"
            value={gsc.data?.totals?.position != null ? gsc.data.totals.position.toFixed(1) : "—"} />
        </div>
      </Section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Panel title="Revenue by day" subtitle={rl}>
          <DailyBars
            rows={(sales.data?.daily ?? []).map((d) => ({ date: d.date, value: d.revenue }))}
            money
            label="revenue"
          />
        </Panel>
        <Panel title="Top products" subtitle={rl}>
          <Breakdown
            rows={(sales.data?.topProducts ?? []).map((p) => ({ key: p.name, count: p.units, value: p.revenue }))}
            money
            empty={sales.data?.configured ? "No sales in this window yet." : "Connect the store to see products."}
          />
        </Panel>
      </div>
    </div>
  );
}
