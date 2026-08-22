import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageHero } from "../components/page-hero";

/**
 * Real Peptides command center. Every number here is real or the card says
 * what's missing — RP has never had a sales feed in ops, so the revenue card
 * is a connect state until the WooCommerce key (or the new site's Supabase)
 * is wired. No invented zeros.
 */

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num = (n: number | undefined | null) => (n ?? 0).toLocaleString();

function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return null;
  const d = prev ? ((cur - prev) / prev) * 100 : 100;
  const good = invert ? d < 0 : d > 0;
  const cls = Math.abs(d) < 1 ? "text-ops-text-muted" : good ? "text-fitscript-green" : "text-red-400";
  return <span className={`ml-1.5 text-xs font-medium ${cls}`}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</span>;
}

function Card({ label, value, sub, accent, tone, to }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: boolean; tone?: "warn" | "bad" | "good"; to?: string }) {
  const color = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : accent ? "text-brand-blue-500" : "text-ops-text";
  const body = (
    <div className="h-full rounded-xl border border-ops-border bg-ops-surface p-5 shadow-card transition hover:border-ops-text-muted/40">
      <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">{label}</div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link href={to} className="block">{body}</Link> : body;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ops-text">{title}</h2>
        {hint && <span className="text-xs text-ops-text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const get = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export default function RealPeptidesOverview() {
  const [range, setRange] = useState(30);
  const ov = useQuery({ queryKey: ["rp-overview", range], queryFn: () => get(`/api/ops/realpeptides/overview?range=${range}`) });
  const leads = useQuery({ queryKey: ["rp-leads", range], queryFn: () => get(`/api/ops/realpeptides/leads?range=${range}`) });
  const coa = useQuery({ queryKey: ["realpeptides-coa"], queryFn: () => get("/api/ops/realpeptides/coa") });
  const pages = useQuery({ queryKey: ["rp-pages-summary", range], queryFn: () => get(`/api/ops/pages?company=realpeptides&days=${Math.min(90, Math.max(7, range))}&summary=1`), staleTime: 10 * 60_000 });
  const clomark = useQuery({ queryKey: ["ops-clomark-overview", "realpeptides"], queryFn: () => get("/api/ops/clomark/overview?company=realpeptides"), staleTime: 5 * 60_000 });

  const sales = ov.data?.sales;
  const traffic = ov.data?.traffic;
  const t = coa.data?.totals;
  const pg = pages.data?.totals;
  const cl = clomark.data;
  const moosend = leads.data?.moosend;
  const cr = leads.data?.campaignRefinery;

  return (
    <div>
      <PageHero
        eyebrow="Real Peptides"
        title="Command Center"
        subtitle="Real Peptides at a glance — sales, traffic, search, leads, certificates, and the content machine."
        actions={
          <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text focus:border-fitscript-green focus:outline-none">
            {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        }
      />

      {/* ── Money + traffic ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {sales?.configured ? (
          <>
            <Card label={`Revenue · ${range}d`} accent value={<>{usd(sales.current.revenue)}<Delta cur={sales.current.revenue} prev={sales.previous.revenue} /></>} sub={`${num(sales.current.orders)} orders · net of coupons & refunds · gross ${usd(sales.current.grossSales)}`} />
            <Card label="Average order" value={<>{usd(sales.current.aov)}<Delta cur={sales.current.aov} prev={sales.previous.aov} /></>} sub={`${num(sales.current.customers)} customers · ${num(sales.current.itemsSold)} items${sales.pending ? ` · ${sales.pending} pending` : ""}`} />
          </>
        ) : (
          <div className="col-span-2 rounded-xl border border-dashed border-ops-border bg-ops-surface p-5">
            <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-ops-text-muted">Sales</div>
            <div className="text-sm font-semibold text-ops-text">Not connected yet</div>
            <p className="mt-1 text-xs text-ops-text-muted">
              {sales?.error ? `WooCommerce error: ${sales.error}` : sales?.hint ?? "Real Peptides has no order feed in ops. Add a read-only WooCommerce API key (WP admin → WooCommerce → Settings → Advanced → REST API) as RP_WOO_CONSUMER_KEY / RP_WOO_CONSUMER_SECRET and revenue, orders, AOV and top products appear here. After the Vercel launch, point RP_DATABASE_URL at the new site's Supabase."}
            </p>
          </div>
        )}
        <Card label={`Sessions · ${range}d`} to="/realpeptides/traffic"
          value={traffic?.pixelInstalled ? <>{num(traffic.current.sessions)}<Delta cur={traffic.current.sessions} prev={traffic.previous.sessions} /></> : "—"}
          sub={traffic?.pixelInstalled ? `${num(traffic.current.visitors)} visitors · pixel` : "pixel not reporting yet"} />
        <Card label={`Search clicks · ${range}d`} to="/realpeptides/pages"
          value={pages.data?.gsc?.connected ? <>{num(pg?.clicks)}<Delta cur={pg?.clicks ?? 0} prev={pg?.prevClicks ?? 0} /></> : pages.isLoading ? "…" : "—"}
          sub={pages.data?.gsc?.connected ? `${num(pg?.impressions)} impressions · Search Console` : pages.data?.gsc?.error ?? "Search Console"} />
      </div>

      {/* ── Leads + certificates ── */}
      <Section title="Leads & certificates" hint="Campaign Refinery · COA tracker">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          <Card label="Contacts (all time)" to="/realpeptides/leads" value={cr?.configured === false ? "—" : cr?.error ? "!" : num(cr?.total)} sub={cr?.configured === false ? "key not set" : cr?.error ?? "Campaign Refinery · list of record"} />
          <Card label={`Campaign Refinery · ${range}d`} to="/realpeptides/leads" value={cr?.configured === false ? "—" : cr?.error ? "!" : `${num(cr?.recentCount)}${cr?.capped ? "+" : ""}`} sub={cr?.configured === false ? "key not set" : cr?.error ?? `new contacts · ${num(cr?.total)} total`} />
          <Card label="Tracked SKUs" to="/realpeptides/coa" value={t ? num(t.tracked) : "—"} />
          <Card label="Expired COAs" to="/realpeptides/coa" value={t ? num(t.expired) : "—"} tone={t?.expired ? "bad" : undefined} sub="retest needed" />
          <Card label="Never tested" to="/realpeptides/coa" value={t ? num(t.untested) : "—"} tone={t?.untested ? "warn" : undefined} />
          <Card label="Fresh" to="/realpeptides/coa" value={t ? num(t.fresh) : "—"} tone="good" sub={coa.data?.validityDays ? `${coa.data.validityDays}-day validity` : undefined} />
        </div>
      </Section>

      {/* ── Content machine ── */}
      <Section title="Content & search footprint" hint="Clomark · sitemap · Search Console">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Card label="Live URLs" to="/realpeptides/pages" value={pg ? num(pg.live) : pages.isLoading ? "…" : "—"} sub={pages.data?.sitemap ? `sitemap · ${Object.entries(pg?.byKind ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${num(v as number)} ${k}`).join(", ")}` : undefined} />
          <Card label="Getting impressions" to="/realpeptides/pages" value={pages.data?.gsc?.connected && pg ? num(pg.indexedProxy) : "—"} sub={pages.data?.gsc?.connected && pg ? `${pg.live ? Math.round((pg.indexedProxy / pg.live) * 100) : 0}% of live URLs` : "needs Search Console"} tone={pages.data?.gsc?.connected && pg && pg.live && pg.indexedProxy / pg.live < 0.5 ? "warn" : undefined} />
          <Card label="Clomark suggestions" to="/realpeptides/content" value={cl?.content ? num(cl.content.suggestions.all) : clomark.isLoading ? "…" : "—"} sub={cl?.content ? `${num(cl.content.suggestions.byStatus?.pending ?? 0)} pending` : clomark.data?.error ?? undefined} />
          <Card label="Generated content" to="/realpeptides/content" value={cl?.content ? num(cl.content.generated.all) : "—"} sub={cl?.content ? `${num(cl.content.generated.byStatus?.published ?? 0)} published in Clomark` : undefined} />
          <Card label="SEO score" to="/realpeptides/content" value={cl?.seoScore?.score ?? cl?.seoScore?.overall_score ?? "—"} sub={cl?.seoScore?.created_at ? `as of ${new Date(cl.seoScore.created_at).toLocaleDateString()}` : "Clomark"} />
        </div>
      </Section>

      {/* ── Sales detail when connected ── */}
      {sales?.configured && (
        <Section title="Top products" hint={`${range} days · by revenue`}>
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
      )}

      {/* ── Health ── */}
      <Section title="Integration health">
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          {[
            ["Sales (WooCommerce)", sales?.configured ? "ok" : "off", sales?.configured ? "connected" : "no API key"],
            ["Pixel", traffic?.pixelInstalled ? "ok" : "off", traffic?.pixelInstalled ? "reporting" : "no events yet"],
            ["Search Console", pages.data?.gsc?.connected ? "ok" : pages.isLoading ? "…" : "off", pages.data?.gsc?.connected ? `${num(pages.data.gsc.pages)} pages` : pages.data?.gsc?.error ?? ""],
            ["Moosend (optional)", moosend?.configured === false ? "off" : moosend?.error ? "bad" : "ok", moosend?.configured === false ? "funnels sync to CR" : moosend?.error ?? "connected"],
            ["Campaign Refinery", cr?.configured === false ? "off" : cr?.error ? "bad" : "ok", cr?.configured === false ? "key not set" : cr?.error ?? "connected"],
            ["COA tracker", coa.data?.configured === false ? "off" : coa.data?.error ? "bad" : t ? "ok" : "…", coa.data?.generatedAt ? `as of ${new Date(coa.data.generatedAt).toLocaleTimeString()}` : coa.data?.error ?? ""],
            ["Clomark", cl?.content ? "ok" : clomark.data?.error ? "bad" : "…", cl?.content ? "connected" : clomark.data?.error ?? ""],
          ].map(([name, state, note]) => (
            <div key={name as string} className="flex items-center justify-between gap-3 rounded-lg border border-ops-border bg-ops-surface px-3 py-2">
              <span className="shrink-0 text-ops-text">{name}</span>
              <span className="flex min-w-0 items-center gap-2 text-xs text-ops-text-muted"><span className="truncate" title={note as string}>{note}</span><span className={`h-2 w-2 rounded-full shrink-0 ${state === "ok" ? "bg-fitscript-green" : state === "bad" ? "bg-red-400" : state === "off" ? "bg-ops-border" : "bg-yellow-500"}`} /></span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
