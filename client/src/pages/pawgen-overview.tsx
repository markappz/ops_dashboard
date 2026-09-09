import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { rangeQuery, rangeDays, useDateRange, type DateRange } from "../components/date-range-picker";
import { Card, CommandHero, DailyBars, Delta, Health, Panel, Section, Breakdown, MINUTE, clock, get, num, usd, rangeLabel, rangeShort, type HealthRow } from "../components/command-center";

/**
 * pawgen Command Center — K9-REPAIR sales, fulfilment, leads, traffic and the
 * content machine, on the same kit as Real Peptides: every tile reads the feed
 * its tab reads, polls every minute, and compares to the previous window.
 */

function useData(range: DateRange, forceRef: React.MutableRefObject<boolean>) {
  const rq = rangeQuery(range);
  const pageDays = Math.min(90, Math.max(7, rangeDays(range)));
  const cmd = useQuery({ queryKey: ["pawgen-command", rq], queryFn: () => get(`/api/ops/pawgen/command?${rq}`), refetchInterval: MINUTE });
  const pages = useQuery({
    queryKey: ["pawgen-pages-summary", pageDays],
    queryFn: () => { const force = forceRef.current ? "&refresh=1" : ""; forceRef.current = false; return get(`/api/ops/pages?company=pawgen&days=${pageDays}&summary=1${force}`); },
    staleTime: 5 * MINUTE, refetchInterval: 5 * MINUTE,
  });
  const clomark = useQuery({ queryKey: ["ops-clomark-overview", "pawgen"], queryFn: () => get("/api/ops/clomark/overview?company=pawgen"), staleTime: 5 * MINUTE, refetchInterval: 5 * MINUTE });
  return { cmd, pages, clomark };
}

function SalesRow({ d, range }: { d: any; range: DateRange }) {
  const s = d?.sales; const t = d?.traffic; const rl = rangeShort(range);
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label={`Revenue · ${rl}`} accent to="/pawgen/orders" value={s ? <>{usd(s.current.revenue)}<Delta cur={s.current.revenue} prev={s.previous.revenue} /></> : "…"} sub={s ? `${num(s.current.orders)} paid orders · all time ${usd(s.allTime.revenue)}` : undefined} />
      <Card label="Average order" to="/pawgen/orders" value={s ? <>{usd(s.current.aov)}<Delta cur={s.current.aov} prev={s.previous.aov} /></> : "…"} sub={s ? `${num(s.current.customers)} customers · ${num(s.allTime.repeatCustomers)} repeat buyers all time` : undefined} />
      <Card label={`Sessions · ${rl}`} to="/pawgen/marketing" value={t?.pixelInstalled ? <>{num(t.current.sessions)}<Delta cur={t.current.sessions} prev={t.previous.sessions} /></> : "—"} sub={t?.pixelInstalled ? `${num(t.current.visitors)} visitors · pixel` : "pixel not reporting yet"} />
      <Card label="New customers" to="/pawgen/orders" value={d?.newCustomers ? <>{num(d.newCustomers.window)}<Delta cur={d.newCustomers.window} prev={d.newCustomers.previous} /></> : "…"} sub={d?.newCustomers ? `${num(d.newCustomers.today)} today · ${num(d.newCustomers.week)} 7d · ${num(d.newCustomers.month)} 30d` : "first paid order"} />
    </div>
  );
}

function LeadsRow({ d }: { d: any }) {
  const l = d?.leads;
  const conv = l && l.total ? Math.round((l.converted / l.total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Guide leads" to="/pawgen/marketing" value={l ? num(l.total) : "…"} sub={l ? `${num(l.guideSent)} guides sent` : undefined} />
      <Card label="New leads · today" value={l ? num(l.today) : "…"} tone={l?.today ? "good" : undefined} sub="last 24 hours" />
      <Card label="New leads · 7 days" value={l ? num(l.week) : "…"} sub={l?.week ? `${Math.round(l.week / 7)}/day` : "last 7 days"} />
      <Card label="New leads · 30 days" value={l ? num(l.month) : "…"} sub={l?.bySource?.[0] ? `top source · ${l.bySource[0].source}` : "last 30 days"} />
      <Card label="Lead → buyer" value={l ? `${conv}%` : "…"} tone={conv >= 5 ? "good" : undefined} sub={l ? `${num(l.converted)} leads bought` : undefined} />
    </div>
  );
}

function FulfilmentRow({ d }: { d: any }) {
  const b = d?.backlog; const s = d?.sales;
  const age = b?.oldestAt ? Math.floor((Date.now() - new Date(b.oldestAt).getTime()) / 86_400_000) : null;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label="To ship" to="/pawgen/orders" value={b ? num(b.count) : "…"} tone={b?.count ? "warn" : "good"} sub={b ? `${usd(b.value)} paid, not yet shipped` : undefined} />
      <Card label="Oldest unshipped" to="/pawgen/orders" value={age === null ? "—" : `${age}d`} tone={age !== null && age >= 3 ? "bad" : undefined} sub={b?.oldestAt ? new Date(b.oldestAt).toLocaleDateString() : "nothing waiting"} />
      <Card label="Pending payments" to="/pawgen/orders" value={s ? num(s.pendingPayments) : "…"} tone={s?.pendingPayments ? "warn" : undefined} sub="checkout started, not paid" />
      <Card label="Refunded" to="/pawgen/orders" value={s ? num(s.refunded) : "…"} sub="all time" />
    </div>
  );
}

function ContentRow({ pages, clomark }: { pages: any; clomark: any }) {
  const pg = pages.data?.totals; const cl = clomark.data; const gsc = pages.data?.gsc?.connected;
  const kinds = Object.entries(pg?.byKind ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${num(v as number)} ${k}`).join(", ");
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Live URLs" to="/pawgen/pages" value={pg ? num(pg.live) : pages.isLoading ? "…" : "—"} sub={pages.data?.sitemap ? `crawled ${clock(pages.data.sitemap.fetchedAt)} · ${kinds}` : undefined} />
      <Card label="Getting impressions" to="/pawgen/pages" value={gsc && pg ? num(pg.indexedProxy) : "—"} sub={gsc && pg ? `${pg.live ? Math.round((pg.indexedProxy / pg.live) * 100) : 0}% of live URLs` : "needs Search Console"} tone={gsc && pg && pg.live && pg.indexedProxy / pg.live < 0.5 ? "warn" : undefined} />
      <Card label="Search clicks" to="/pawgen/pages" value={gsc ? <>{num(pg?.clicks)}<Delta cur={pg?.clicks ?? 0} prev={pg?.prevClicks ?? 0} /></> : pages.isLoading ? "…" : "—"} sub={gsc ? `${num(pg?.impressions)} impressions · Google through ${pages.data?.window?.end}` : pages.data?.gsc?.error ?? "Search Console"} />
      <Card label="Clomark suggestions" to="/pawgen/content" value={cl?.content ? num(cl.content.suggestions.all) : clomark.isLoading ? "…" : "—"} sub={cl?.content ? `${num(cl.content.suggestions.byStatus?.pending ?? 0)} pending` : clomark.data?.error ?? undefined} />
      <Card label="Generated content" to="/pawgen/content" value={cl?.content ? num(cl.content.generated.all) : "—"} sub={cl?.content ? `${num(cl.content.generated.byStatus?.published ?? 0)} published in Clomark` : undefined} />
    </div>
  );
}

export default function PawgenOverview() {
  const [range, setRange] = useDateRange("pawgen-overview");
  const forceRef = useRef(false);
  const q = useData(range, forceRef);
  const d = q.cmd.data?.configured === false ? { ...q.cmd.data, sales: null, leads: null, backlog: null, newCustomers: null, traffic: null } : q.cmd.data;
  const refreshing = [q.cmd, q.pages, q.clomark].some((x) => x.isFetching);
  const series = useMemo(() => (d?.sales?.series ?? []).map((r: any) => ({ date: r.date, value: r.revenue })), [d]);
  const leadSeries = useMemo(() => (d?.leads?.daily ?? []).map((r: any) => ({ date: r.date, value: r.count })), [d]);

  const health: HealthRow[] = [
    ["Orders (Supabase)", d?.configured ? "ok" : q.cmd.isError ? "bad" : d ? "off" : "…", d?.configured ? `as of ${clock(d.generatedAt)}` : d?.hint ?? (q.cmd.error as Error)?.message ?? ""],
    ["Pixel", d?.traffic?.pixelInstalled ? "ok" : "off", d?.traffic?.pixelInstalled ? "reporting" : "no events yet"],
    ["Sitemap", q.pages.data?.sitemap && !q.pages.data.sitemap.error ? "ok" : q.pages.data?.sitemap?.error ? "bad" : "…", q.pages.data?.sitemap ? q.pages.data.sitemap.error ?? `crawled ${clock(q.pages.data.sitemap.fetchedAt)}` : ""],
    ["Search Console", q.pages.data?.gsc?.connected ? "ok" : q.pages.isLoading ? "…" : "off", q.pages.data?.gsc?.connected ? `${num(q.pages.data.gsc.pages)} pages` : q.pages.data?.gsc?.error ?? ""],
    ["Clomark", q.clomark.data?.content ? "ok" : q.clomark.data?.error ? "bad" : "…", q.clomark.data?.content ? "connected" : q.clomark.data?.error ?? ""],
  ];

  return (
    <div>
      <CommandHero eyebrow="pawgen" subtitle="K9-REPAIR at a glance — sales, fulfilment, leads, traffic, search and the content machine." range={range} setRange={setRange} keys={["pawgen-command", "pawgen-pages-summary", "ops-clomark-overview"]} refreshing={refreshing} onRefresh={() => { forceRef.current = true; }} />

      {d && !d.configured && <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-500">{d.hint}</div>}
      {q.cmd.isError && <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{(q.cmd.error as Error).message}</div>}

      <SalesRow d={d} range={range} />

      <Section title="Leads" hint="guide magnet · pawgen.com">
        <LeadsRow d={d} />
      </Section>

      <Section title="Fulfilment" hint={d?.backlog ? `as of ${clock(d.generatedAt)}` : undefined}>
        <FulfilmentRow d={d} />
      </Section>

      <Section title="Content & search footprint" hint="Clomark · sitemap · Search Console">
        <ContentRow pages={q.pages} clomark={q.clomark} />
      </Section>

      <Section title={`Sales · ${rangeLabel(range)}`}>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2"><Panel title="Revenue by day" subtitle={`${usd(d?.sales?.current.revenue)} · ${num(d?.sales?.current.orders)} paid orders`}><DailyBars rows={series} money label="revenue" /></Panel></div>
          <Panel title="By pack" subtitle="revenue share"><Breakdown rows={d?.sales?.byPack ?? []} money empty="No paid orders in this window." /></Panel>
          <Panel title="By payment method" subtitle="revenue share"><Breakdown rows={d?.sales?.byMethod ?? []} money empty="No paid orders in this window." /></Panel>
          <Panel title="By source" subtitle="first-touch ref_source at checkout"><Breakdown rows={d?.sales?.bySource ?? []} money empty="No attributed orders in this window." /></Panel>
          <Panel title="Leads by day" subtitle={`${num(d?.leads?.window)} guide signups in the window`}><DailyBars rows={leadSeries} label="leads" /></Panel>
        </div>
      </Section>

      <Health rows={health} />
    </div>
  );
}
