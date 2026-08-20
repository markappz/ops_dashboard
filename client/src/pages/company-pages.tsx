import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHero } from "../components/page-hero";

/**
 * Page performance: what's live (sitemap) × how Google treats it (Search
 * Console) × what humans do there (pixel). One row per URL.
 */

interface Row {
  url: string; path: string; kind: string; lastmod: string | null; inSitemap: boolean; inGsc: boolean;
  clicks: number; impressions: number; ctr: number | null; position: number | null;
  prevClicks: number; prevImpressions: number; prevPosition: number | null;
  views: number; visitors: number; sessions: number; purchases: number; revenue: number;
}
interface Resp {
  configured: boolean; hint?: string; error?: string; company: string; days: number;
  window: { start: string; end: string };
  sitemap: { fetchedAt: string; urlCount: number; sources: string[]; error: string | null } | null;
  gsc: { connected: boolean; error: string | null; pages: number };
  totals: { live: number; indexedProxy: number; noImpressions: number; orphans: number; clicks: number; prevClicks: number; impressions: number; prevImpressions: number; revenue: number; byKind: Record<string, number> };
  rows: Row[];
}

type SortKey = "clicks" | "impressions" | "position" | "ctr" | "views" | "revenue" | "lastmod" | "delta";
type View = "sitemap" | "all" | "orphans" | "zero";

const num = (n: number) => n.toLocaleString();
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const input = "rounded-lg border border-ops-border bg-ops-bg px-3 py-2 text-sm text-ops-text placeholder:text-ops-text-muted focus:border-fitscript-green focus:outline-none";
const ghost = "rounded-lg border border-ops-border bg-ops-surface px-3 py-2 text-sm text-ops-text-muted hover:text-ops-text disabled:opacity-40";

function Delta({ cur, prev, invert }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return <span className="text-ops-text-muted">—</span>;
  const d = prev ? ((cur - prev) / prev) * 100 : 100;
  const good = invert ? d < 0 : d > 0;
  const cls = Math.abs(d) < 1 ? "text-ops-text-muted" : good ? "text-fitscript-green" : "text-red-400";
  return <span className={`text-[11px] ${cls}`}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</span>;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "good" | "warn" | "bad" }) {
  const c = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-yellow-500" : tone === "good" ? "text-fitscript-green" : "text-ops-text";
  return (
    <div className="rounded-xl border border-ops-border bg-ops-surface p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-ops-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${c}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ops-text-muted">{sub}</div>}
    </div>
  );
}

export default function CompanyPages({ company, label, hasPixel = true }: { company: string; label: string; hasPixel?: boolean }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(28);
  const [view, setView] = useState<View>("sitemap");
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("clicks");
  const [limit, setLimit] = useState(200);
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, isFetching } = useQuery<Resp>({
    queryKey: ["ops-pages", company, days],
    queryFn: async () => {
      const r = await fetch(`/api/ops/pages?company=${company}&days=${days}`, { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    staleTime: 10 * 60_000,
  });

  async function recrawl() {
    setRefreshing(true);
    try {
      await fetch(`/api/ops/pages?company=${company}&days=${days}&refresh=1`, { credentials: "include" });
      qc.invalidateQueries({ queryKey: ["ops-pages", company] });
    } finally { setRefreshing(false); }
  }

  const rows = useMemo(() => {
    let list = data?.rows ?? [];
    if (view === "sitemap") list = list.filter((r) => r.inSitemap);
    else if (view === "orphans") list = list.filter((r) => !r.inSitemap);
    else if (view === "zero") list = list.filter((r) => r.inSitemap && r.impressions === 0);
    if (kind !== "all") list = list.filter((r) => r.kind === kind);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((r) => r.path.toLowerCase().includes(needle));
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      clicks: (a, b) => b.clicks - a.clicks,
      impressions: (a, b) => b.impressions - a.impressions,
      position: (a, b) => (a.position ?? 999) - (b.position ?? 999),
      ctr: (a, b) => (b.ctr ?? -1) - (a.ctr ?? -1),
      views: (a, b) => b.views - a.views,
      revenue: (a, b) => b.revenue - a.revenue,
      lastmod: (a, b) => (b.lastmod ? Date.parse(b.lastmod) : 0) - (a.lastmod ? Date.parse(a.lastmod) : 0),
      delta: (a, b) => (b.clicks - b.prevClicks) - (a.clicks - a.prevClicks),
    };
    return [...list].sort(cmp[sort]);
  }, [data, view, kind, q, sort]);

  const t = data?.totals;
  const gscOn = !!data?.gsc.connected;
  const kinds = Object.entries(t?.byKind ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <PageHero
        eyebrow={label}
        title="Pages"
        subtitle="Every URL live on the site, with how Google ranks it and what visitors do there. Sitemap is the source of truth; Search Console is the scoreboard."
        actions={
          <div className="flex items-center gap-2">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={input}>
              {[7, 28, 56, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
            <button type="button" onClick={recrawl} disabled={refreshing || isFetching} className={ghost}>{refreshing ? "Re-crawling…" : "Re-crawl sitemap"}</button>
          </div>
        }
      />

      {isLoading && <div className="text-sm text-ops-text-muted">Crawling the sitemap and pulling Search Console — first load can take a minute.</div>}
      {data?.configured === false && <div className="rounded-xl border border-ops-border bg-ops-surface p-6 text-sm text-ops-text-muted">{data.hint}</div>}
      {data?.error && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>}

      {t && (
        <>
          {(data?.gsc.error || data?.sitemap?.error) && (
            <div className="mb-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-500">
              {data.gsc.error ? `Search Console: ${data.gsc.error}. ` : ""}{data.sitemap?.error ? `Sitemap: ${data.sitemap.error} (showing the last good crawl).` : ""}
            </div>
          )}

          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Live URLs" value={num(t.live)} sub={data?.sitemap ? `sitemap crawled ${new Date(data.sitemap.fetchedAt).toLocaleString()}` : undefined} />
            <Stat label="Getting impressions" value={gscOn ? num(t.indexedProxy) : "—"} sub={gscOn ? `${t.live ? Math.round((t.indexedProxy / t.live) * 100) : 0}% of live URLs — closest proxy for indexed` : "connect Search Console"} tone={gscOn && t.live && t.indexedProxy / t.live < 0.5 ? "warn" : gscOn ? "good" : undefined} />
            <Stat label="Zero impressions" value={gscOn ? num(t.noImpressions) : "—"} sub={gscOn ? "live but invisible in search" : "connect Search Console"} tone={gscOn && t.noImpressions > 0 ? "warn" : undefined} />
            <Stat label={`Clicks · ${days}d`} value={gscOn ? num(t.clicks) : "—"} sub={gscOn ? <><Delta cur={t.clicks} prev={t.prevClicks} /> vs prior {days}d · {num(t.impressions)} impressions <Delta cur={t.impressions} prev={t.prevImpressions} /></> : "connect Search Console"} />
            {hasPixel
              ? <Stat label="Landing-page revenue" value={money(t.revenue)} sub="orders from sessions that landed on these pages" tone={t.revenue > 0 ? "good" : undefined} />
              : <Stat label="Google sees but not in sitemap" value={num(t.orphans)} sub="old or orphaned URLs" tone={t.orphans > 0 ? "warn" : undefined} />}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ops-border bg-ops-surface p-0.5 text-xs">
              {([["sitemap", `In sitemap (${num(t.live)})`], ["zero", `Zero impressions (${num(t.noImpressions)})`], ["orphans", `Not in sitemap (${num(t.orphans)})`], ["all", "Everything"]] as [View, string][]).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`rounded-md px-2.5 py-1.5 ${view === v ? "bg-fitscript-green/15 text-fitscript-green" : "text-ops-text-muted hover:text-ops-text"}`}>{l}</button>
              ))}
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
              <option value="all">All types</option>
              {kinds.map(([k, n]) => <option key={k} value={k}>{k} ({num(n)})</option>)}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={input}>
              <option value="clicks">Most clicks</option>
              <option value="delta">Biggest click change</option>
              <option value="impressions">Most impressions</option>
              <option value="position">Best position</option>
              <option value="ctr">Highest CTR</option>
              {hasPixel && <option value="views">Most pixel views</option>}
              {hasPixel && <option value="revenue">Most revenue</option>}
              <option value="lastmod">Recently modified</option>
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path…" className={`${input} min-w-[220px]`} />
            <span className="ml-auto text-xs text-ops-text-muted">{num(rows.length)} URLs · window {data?.window.start} → {data?.window.end}</span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-ops-border bg-ops-surface shadow-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ops-border text-left text-[11px] uppercase tracking-wider text-ops-text-muted">
                  <th className="px-4 py-3 font-medium">Page</th>
                  <th className="px-3 py-3 font-medium">Type</th>
                  <th className="px-3 py-3 text-right font-medium">Clicks</th>
                  <th className="px-3 py-3 text-right font-medium">Impr.</th>
                  <th className="px-3 py-3 text-right font-medium">CTR</th>
                  <th className="px-3 py-3 text-right font-medium">Pos.</th>
                  {hasPixel && <th className="px-3 py-3 text-right font-medium">Views</th>}
                  {hasPixel && <th className="px-3 py-3 text-right font-medium">Revenue</th>}
                  <th className="px-3 py-3 font-medium">Modified</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-ops-text-muted">Nothing matches.</td></tr>}
                {rows.slice(0, limit).map((r) => (
                  <tr key={r.url} className="border-b border-ops-border/50 last:border-0">
                    <td className="max-w-[420px] px-4 py-2">
                      <a href={r.url} target="_blank" rel="noreferrer" className="block truncate text-ops-text hover:text-fitscript-green" title={r.url}>{r.path}</a>
                      {!r.inSitemap && <span className="text-[10px] text-yellow-500">not in sitemap</span>}
                      {gscOn && r.inSitemap && r.impressions === 0 && <span className="text-[10px] text-ops-text-muted">no impressions yet</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-ops-text-muted">{r.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text">{num(r.clicks)} <Delta cur={r.clicks} prev={r.prevClicks} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{num(r.impressions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{r.ctr === null ? "—" : `${r.ctr.toFixed(1)}%`}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">
                      {r.position === null ? "—" : r.position.toFixed(1)}
                      {r.position !== null && r.prevPosition !== null && <> <Delta cur={r.position} prev={r.prevPosition} invert /></>}
                    </td>
                    {hasPixel && <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{r.views ? num(r.views) : "—"}</td>}
                    {hasPixel && <td className="px-3 py-2 text-right tabular-nums text-ops-text-muted">{r.revenue ? money(r.revenue) : "—"}</td>}
                    <td className="px-3 py-2 text-xs text-ops-text-muted">{r.lastmod ? new Date(r.lastmod).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > limit && (
              <div className="border-t border-ops-border p-3 text-center">
                <button type="button" onClick={() => setLimit((l) => l + 500)} className={ghost}>Show {num(Math.min(500, rows.length - limit))} more of {num(rows.length - limit)}</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
