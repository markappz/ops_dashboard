import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { PageHero } from "../components/page-hero";
import { api as coaApi, type Sku } from "./coa/api";
import { groupFamilies, familyCounts } from "./coa/families";

/**
 * Real Peptides command center. Every tile reads the same source its tab does:
 * sales + contacts from realpeptides.co's ops endpoints (the CRM that mirrors
 * to Resend), certificates from the COA tracker's /skus grouped exactly like
 * the COA tab, pages from the sitemap crawl + Search Console. Tiles poll every
 * minute and the Refresh button forces everything, sitemap crawl included.
 */

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();
const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return null;
  const d = prev ? ((cur - prev) / prev) * 100 : 100;
  const good = invert ? d < 0 : d > 0;
  const cls = Math.abs(d) < 1 ? "text-ops-text-muted" : good ? "text-fitscript-green" : "text-red-400";
  return <span className={`ml-1.5 text-xs font-medium ${cls}`}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</span>;
}

type Tone = "warn" | "bad" | "good" | "info";
function Card({ label, value, sub, accent, tone, to }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: boolean; tone?: Tone; to?: string }) {
  const color = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : tone === "info" ? "text-violet-400" : accent ? "text-brand-blue-500" : "text-ops-text";
  const body = (
    <div className="h-full rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card transition hover:border-ops-text-muted/40">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link href={to} className="block">{body}</Link> : body;
}

function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ops-text">{title}</h2>
        {hint && <span className="text-right text-xs text-ops-text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());
const MINUTE = 60_000;

function useOverviewData(range: number, forceRef: React.MutableRefObject<boolean>) {
  const pageDays = Math.min(90, Math.max(7, range));
  const ov = useQuery({ queryKey: ["rp-overview", range], queryFn: () => get(`/api/ops/realpeptides/overview?range=${range}`), refetchInterval: MINUTE });
  const contacts = useQuery({ queryKey: ["rp-contacts", range], queryFn: () => get(`/api/ops/realpeptides/contacts?range=${range}`), refetchInterval: MINUTE });
  const skus = useQuery({ queryKey: ["coa-skus"], queryFn: () => coaApi<{ skus: Sku[] }>("/skus"), retry: false, refetchInterval: MINUTE });
  const pages = useQuery({
    queryKey: ["rp-pages-summary", pageDays],
    queryFn: () => {
      const force = forceRef.current ? "&refresh=1" : "";
      forceRef.current = false;
      return get(`/api/ops/pages?company=realpeptides&days=${pageDays}&summary=1${force}`);
    },
    staleTime: 5 * MINUTE,
    refetchInterval: 5 * MINUTE,
  });
  const clomark = useQuery({ queryKey: ["ops-clomark-overview", "realpeptides"], queryFn: () => get("/api/ops/clomark/overview?company=realpeptides"), staleTime: 5 * MINUTE, refetchInterval: 5 * MINUTE });
  return { ov, contacts, skus, pages, clomark };
}

function SalesCards({ ov, rlabel }: { ov: ReturnType<typeof useOverviewData>["ov"]; rlabel: string }) {
  const sales = ov.data?.sales;
  if (sales?.configured) {
    return (
      <>
        <Card label={`Revenue · ${rlabel}`} accent value={<>{usd(sales.current.revenue)}<Delta cur={sales.current.revenue} prev={sales.previous.revenue} /></>} sub={`${num(sales.current.orders)} orders · net of coupons & refunds · gross ${usd(sales.current.grossSales)}`} />
        <Card label="Average order" value={<>{usd(sales.current.aov)}<Delta cur={sales.current.aov} prev={sales.previous.aov} /></>} sub={`${num(sales.current.customers)} customers · ${num(sales.current.itemsSold)} items${sales.pending ? ` · ${sales.pending} pending` : ""}`} />
      </>
    );
  }
  return (
    <div className="col-span-2 rounded-xl border border-dashed border-ops-border bg-ops-surface p-5">
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Sales</div>
      <div className="text-sm font-semibold text-ops-text">{ov.isLoading ? "Loading realpeptides.co sales…" : ov.isError ? "Sales feed failed" : "Not connected yet"}</div>
      {!ov.isLoading && (
        <p className="mt-1 text-xs text-ops-text-muted">
          {sales?.error ? `realpeptides.co error: ${sales.error}` : sales?.hint ?? "Connect the site's /api/ops-summary (RP_SITE_API_URL + RP_SITE_OPS_TOKEN on ops)."}
        </p>
      )}
    </div>
  );
}

function LeadCards({ contacts }: { contacts: ReturnType<typeof useOverviewData>["contacts"] }) {
  const c = contacts.data;
  const off = c?.configured === false;
  const v = (n?: number) => (off ? "—" : contacts.isError ? "!" : contacts.isLoading ? "…" : num(n));
  const topSource = c?.bySource?.[0];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card label="Contacts" to="/realpeptides/leads" value={v(c?.totals?.total)} sub={off ? c?.hint : c ? `${num(c.totals.marketable)} mailable · ${num(c.totals.buyers)} buyers` : "Resend list"} />
      <Card label="New leads · today" to="/realpeptides/leads" value={v(c?.new?.today)} tone={c?.new?.today ? "good" : undefined} sub="last 24 hours" />
      <Card label="New leads · 7 days" to="/realpeptides/leads" value={v(c?.new?.week)} sub={c?.new?.week ? `${Math.round(c.new.week / 7)}/day` : "last 7 days"} />
      <Card label="New leads · 30 days" to="/realpeptides/leads" value={v(c?.new?.month)} sub={topSource ? `top source · ${topSource.source}` : "last 30 days"} />
    </div>
  );
}

function CoaCards({ skus }: { skus: ReturnType<typeof useOverviewData>["skus"] }) {
  const families = useMemo(() => groupFamilies(skus.data?.skus ?? []), [skus.data]);
  const c = useMemo(() => familyCounts(families), [families]);
  const ready = !!skus.data;
  const v = (k: string) => (ready ? num(c[k] ?? 0) : skus.isError ? "!" : "…");
  const tone = (k: string, t: Tone): Tone | undefined => (ready && c[k] ? t : undefined);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
      <Card label="Products" to="/realpeptides/coa" value={ready ? num(families.length) : skus.isError ? "!" : "…"} sub={ready ? `${num(skus.data?.skus?.length)} SKUs` : skus.isError ? "tracker unreachable" : "loading"} />
      <Card label="Expired" to="/realpeptides/coa" value={v("expired")} tone={tone("expired", "bad")} sub="retest needed" />
      <Card label="No COA" to="/realpeptides/coa" value={v("untested")} tone={tone("untested", "warn")} sub="never tested" />
      <Card label="Expiring soon" to="/realpeptides/coa" value={v("expiring")} tone={tone("expiring", "warn")} />
      <Card label="Fresh" to="/realpeptides/coa" value={v("fresh")} tone="good" sub="90-day validity" />
      <Card label="Send to lab" to="/realpeptides/coa" value={v("tosend")} tone={tone("tosend", "warn")} sub="not yet shipped" />
      <Card label="At the lab" to="/realpeptides/coa" value={v("atlab")} tone={tone("atlab", "info")} sub="awaiting results" />
    </div>
  );
}

function ContentCards({ pages, clomark }: { pages: ReturnType<typeof useOverviewData>["pages"]; clomark: ReturnType<typeof useOverviewData>["clomark"] }) {
  const pg = pages.data?.totals;
  const cl = clomark.data;
  const gsc = pages.data?.gsc?.connected;
  const kinds = Object.entries(pg?.byKind ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${num(v as number)} ${k}`).join(", ");
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Card label="Live URLs" to="/realpeptides/pages" value={pg ? num(pg.live) : pages.isLoading ? "…" : "—"} sub={pages.data?.sitemap ? `crawled ${clock(pages.data.sitemap.fetchedAt)} · ${kinds}` : undefined} />
      <Card label="Getting impressions" to="/realpeptides/pages" value={gsc && pg ? num(pg.indexedProxy) : "—"} sub={gsc && pg ? `${pg.live ? Math.round((pg.indexedProxy / pg.live) * 100) : 0}% of live URLs` : "needs Search Console"} tone={gsc && pg && pg.live && pg.indexedProxy / pg.live < 0.5 ? "warn" : undefined} />
      <Card label="Clomark suggestions" to="/realpeptides/content" value={cl?.content ? num(cl.content.suggestions.all) : clomark.isLoading ? "…" : "—"} sub={cl?.content ? `${num(cl.content.suggestions.byStatus?.pending ?? 0)} pending` : clomark.data?.error ?? undefined} />
      <Card label="Generated content" to="/realpeptides/content" value={cl?.content ? num(cl.content.generated.all) : "—"} sub={cl?.content ? `${num(cl.content.generated.byStatus?.published ?? 0)} published in Clomark` : undefined} />
      <Card label="SEO score" to="/realpeptides/content" value={cl?.seoScore?.score ?? cl?.seoScore?.overall_score ?? "—"} sub={cl?.seoScore?.created_at ? `as of ${new Date(cl.seoScore.created_at).toLocaleDateString()}` : "Clomark"} />
    </div>
  );
}

function TopProducts({ sales, range }: { sales: any; range: number }) {
  if (!sales?.configured) return null;
  return (
    <Section title="Top products" hint={`${range === 1 ? "last 24 hours" : `${range} days`} · by revenue`}>
      <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted"><th className="px-4 py-3 font-medium">Product</th><th className="px-4 py-3 text-right font-medium">Units</th><th className="px-4 py-3 text-right font-medium">Orders</th><th className="px-4 py-3 text-right font-medium">Net revenue</th></tr></thead>
          <tbody>
            {sales.topProducts.map((p: any) => (
              <tr key={p.name} className="border-b border-ops-border/50 last:border-0"><td className="px-4 py-2 text-ops-text">{p.name}</td><td className="px-4 py-2 text-right tabular-nums text-ops-text-muted">{num(p.units)}</td><td className="px-4 py-2 text-right tabular-nums text-ops-text-muted">{num(p.orders)}</td><td className="px-4 py-2 text-right tabular-nums text-ops-text">{usd(p.revenue)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Health({ d }: { d: ReturnType<typeof useOverviewData> }) {
  const sales = d.ov.data?.sales;
  const traffic = d.ov.data?.traffic;
  const pg = d.pages.data;
  const c = d.contacts.data;
  const rows: [string, string, string][] = [
    ["Sales (realpeptides.co)", sales?.configured ? "ok" : d.ov.isLoading ? "…" : "off", sales?.configured ? `as of ${clock(sales.fetchedAt)}` : sales?.error ?? "not connected"],
    ["Contacts (Resend list)", c?.configured ? "ok" : d.contacts.isError ? "bad" : c ? "off" : "…", c?.configured ? `as of ${clock(c.generatedAt)}` : c?.hint ?? ""],
    ["COA tracker", d.skus.data ? "ok" : d.skus.isError ? "bad" : "…", d.skus.data ? `${num(d.skus.data.skus.length)} SKUs · live` : d.skus.error?.message ?? ""],
    ["Sitemap", pg?.sitemap && !pg.sitemap.error ? "ok" : pg?.sitemap?.error ? "bad" : "…", pg?.sitemap ? pg.sitemap.error ?? `crawled ${clock(pg.sitemap.fetchedAt)}` : ""],
    ["Search Console", pg?.gsc?.connected ? "ok" : d.pages.isLoading ? "…" : "off", pg?.gsc?.connected ? `${num(pg.gsc.pages)} pages` : pg?.gsc?.error ?? ""],
    ["Pixel", traffic?.pixelInstalled ? "ok" : "off", traffic?.pixelInstalled ? "reporting" : "no events yet"],
    ["Clomark", d.clomark.data?.content ? "ok" : d.clomark.data?.error ? "bad" : "…", d.clomark.data?.content ? "connected" : d.clomark.data?.error ?? ""],
  ];
  return (
    <Section title="Integration health">
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        {rows.map(([name, state, note]) => (
          <div key={name} className="flex items-center justify-between gap-3 rounded-lg border border-ops-border bg-ops-surface px-3 py-2">
            <span className="shrink-0 text-ops-text">{name}</span>
            <span className="flex min-w-0 items-center gap-2 text-xs text-ops-text-muted"><span className="truncate" title={note}>{note}</span><span className={`h-2 w-2 shrink-0 rounded-full ${state === "ok" ? "bg-fitscript-green" : state === "bad" ? "bg-red-400" : state === "off" ? "bg-ops-border" : "bg-yellow-500"}`} /></span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function RealPeptidesOverview() {
  const qc = useQueryClient();
  const [range, setRange] = useState(30);
  const forceRef = useRef(false);
  const rlabel = range === 1 ? "24h" : `${range}d`;
  const d = useOverviewData(range, forceRef);
  const traffic = d.ov.data?.traffic;
  const pg = d.pages.data?.totals;
  const refreshing = [d.ov, d.contacts, d.skus, d.pages, d.clomark].some((q) => q.isFetching);

  const refreshAll = () => {
    forceRef.current = true;
    for (const key of ["rp-overview", "rp-contacts", "coa-skus", "rp-pages-summary", "ops-clomark-overview"]) qc.invalidateQueries({ queryKey: [key] });
  };

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Command Center"
        subtitle="Real Peptides at a glance — sales, traffic, search, leads, certificates, and the content machine. Live: tiles refresh every minute."
        actions={
          <>
            <button type="button" onClick={refreshAll} disabled={refreshing} title="Re-pull everything, including a fresh sitemap crawl" className="inline-flex items-center gap-1.5 rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text hover:border-ops-text-muted disabled:opacity-60">
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh
            </button>
            <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-fitscript-green focus:outline-none">
              {[1, 7, 30, 90].map((n) => <option key={n} value={n}>{n === 1 ? "Last 24 hours" : `Last ${n} days`}</option>)}
            </select>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SalesCards ov={d.ov} rlabel={rlabel} />
        <Card label={`Sessions · ${rlabel}`} to="/realpeptides/traffic"
          value={traffic?.pixelInstalled ? <>{num(traffic.current.sessions)}<Delta cur={traffic.current.sessions} prev={traffic.previous.sessions} /></> : "—"}
          sub={traffic?.pixelInstalled ? `${num(traffic.current.visitors)} visitors · pixel` : "pixel not reporting yet"} />
        <Card label={`Search clicks · ${rlabel}`} to="/realpeptides/pages"
          value={d.pages.data?.gsc?.connected ? <>{num(pg?.clicks)}<Delta cur={pg?.clicks ?? 0} prev={pg?.prevClicks ?? 0} /></> : d.pages.isLoading ? "…" : "—"}
          sub={d.pages.data?.gsc?.connected ? `${num(pg?.impressions)} impressions · Search Console` : d.pages.data?.gsc?.error ?? "Search Console"} />
      </div>

      <Section title="Leads" hint={<>realpeptides.co CRM → Resend{d.contacts.data?.generatedAt ? ` · as of ${clock(d.contacts.data.generatedAt)}` : ""}</>}>
        <LeadCards contacts={d.contacts} />
      </Section>

      <Section title="Certificates" hint="COA tracker · same counts as the COA tab">
        <CoaCards skus={d.skus} />
      </Section>

      <Section title="Content & search footprint" hint="Clomark · sitemap · Search Console">
        <ContentCards pages={d.pages} clomark={d.clomark} />
      </Section>

      <TopProducts sales={d.ov.data?.sales} range={range} />
      <Health d={d} />
    </div>
  );
}
