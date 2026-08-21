/**
 * Page performance — every URL that is actually live on a brand's site, joined
 * with what Search Console and the first-party pixel say about it.
 *
 * Truth order: the sitemap decides what exists (Clomark's "published" flag
 * doesn't — Real Peptides shows 0 published in Clomark while its WordPress
 * sitemap lists thousands of posts). Search Console says whether Google shows
 * it and how it ranks. The pixel says whether humans arrive and buy.
 *
 *   GET /api/ops/pages?company=&days=28[&refresh=1]
 *
 * Sitemaps are crawled from robots.txt (index → children) and cached in
 * ops_site_pages for 6h; `refresh=1` forces a re-crawl. GSC is queried by
 * `page` for the current and previous window so every row carries a delta.
 */
import type { Express } from "express";
import { google } from "googleapis";
import { pool } from "./db";
import { getAuthenticatedClient, getConnection, normalizeCompany } from "./google-auth";

const SITE_ROOTS: Record<string, string | null> = {
  fitscript: "https://www.fitscript.me",
  pawgen: "https://pawgen.com",
  realpeptides: "https://www.realpeptides.co",
  peptideu: null, // no public marketing site yet
};

const CACHE_HOURS = 6;
const MAX_SITEMAPS = 80;
const MAX_URLS = 60_000;
const UA = "Mozilla/5.0 (compatible; FitScriptOps/1.0; +https://ops.fitscript.me)";

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_site_pages (
      site        TEXT NOT NULL,
      url         TEXT NOT NULL,
      path        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      source      TEXT,
      lastmod     TIMESTAMPTZ,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (site, url)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_sitemap_runs (
      site        TEXT PRIMARY KEY,
      fetched_at  TIMESTAMPTZ NOT NULL,
      url_count   INTEGER NOT NULL DEFAULT 0,
      sources     JSONB NOT NULL DEFAULT '[]',
      error       TEXT
    )`);
}

// ─── Sitemap crawl ──────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function discoverSitemaps(root: string): Promise<string[]> {
  const found: string[] = [];
  try {
    const robots = await fetchText(`${root}/robots.txt`);
    for (const line of robots.split("\n")) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) found.push(m[1]);
    }
  } catch { /* fall through to defaults */ }
  if (!found.length) found.push(`${root}/sitemap.xml`, `${root}/sitemap_index.xml`);
  return [...new Set(found)];
}

const tag = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "g"))].map((m) => m[1]);

/** Classify a URL by the sitemap it came from first (WordPress names them), then by path. */
function kindOf(path: string, source: string | null): string {
  const s = (source || "").toLowerCase();
  if (/product/.test(s)) return "product";
  if (/post|blog/.test(s)) return "blog";
  if (/page-sitemap/.test(s)) return "page";
  if (/category|tag|author|taxonom/.test(s)) return "taxonomy";
  if (/location/.test(s)) return "location";
  if (path === "/" || path === "") return "home";
  if (/^\/(product|products|shop)\//.test(path)) return "product";
  if (/^\/(blog|post|posts|articles?|news)\//.test(path)) return "blog";
  if (/^\/locations?\//.test(path)) return "location";
  if (/^\/(conditions|breeds|peptides|guides?|learn)\//.test(path)) return "topical";
  if (/^\/(category|tag|author)\//.test(path)) return "taxonomy";
  if (/^\/(product-category|collections?)\//.test(path)) return "taxonomy";
  return "page";
}

function pathOf(url: string): string {
  try { const u = new URL(url); return (u.pathname.replace(/\/+$/, "") || "/") + (u.search || ""); }
  catch { return url; }
}

export async function refreshSitemap(site: string): Promise<{ count: number; sources: string[] }> {
  const root = SITE_ROOTS[site];
  if (!root) throw new Error(`No public site configured for ${site}`);
  const runStart = new Date();
  const queue = await discoverSitemaps(root);
  const seen = new Set<string>();
  const sources: string[] = [];
  const rows: { url: string; lastmod: string | null; source: string }[] = [];

  while (queue.length && seen.size < MAX_SITEMAPS && rows.length < MAX_URLS) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml: string;
    try { xml = await fetchText(sm); } catch (e: any) { console.warn(`[PAGES] ${site} sitemap skipped: ${e.message}`); continue; }
    sources.push(sm);
    if (/<sitemapindex/i.test(xml)) {
      for (const child of tag(xml, "loc")) queue.push(child.trim());
      continue;
    }
    const name = sm.split("/").pop() || sm;
    for (const block of xml.split(/<url>/i).slice(1)) {
      const loc = tag(block, "loc")[0];
      if (!loc) continue;
      rows.push({ url: loc.trim(), lastmod: tag(block, "lastmod")[0] ?? null, source: name });
    }
  }

  // Upsert in batches; anything not seen this run fell out of the sitemap.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values: any[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 6;
      values.push(site, r.url, pathOf(r.url), kindOf(pathOf(r.url), r.source), r.source, r.lastmod ? new Date(r.lastmod) : null);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},NOW(),NOW())`;
    });
    await pool.query(
      `INSERT INTO ops_site_pages (site, url, path, kind, source, lastmod, first_seen, last_seen) VALUES ${tuples.join(",")}
       ON CONFLICT (site, url) DO UPDATE SET path = EXCLUDED.path, kind = EXCLUDED.kind, source = EXCLUDED.source,
         lastmod = EXCLUDED.lastmod, last_seen = NOW()`, values);
  }
  await pool.query(`DELETE FROM ops_site_pages WHERE site = $1 AND last_seen < $2`, [site, runStart]);
  await pool.query(
    `INSERT INTO ops_sitemap_runs (site, fetched_at, url_count, sources, error) VALUES ($1, NOW(), $2, $3, NULL)
     ON CONFLICT (site) DO UPDATE SET fetched_at = NOW(), url_count = EXCLUDED.url_count, sources = EXCLUDED.sources, error = NULL`,
    [site, rows.length, JSON.stringify(sources)]);
  console.log(`[PAGES] ${site}: ${rows.length} URLs from ${sources.length} sitemap(s)`);
  return { count: rows.length, sources };
}

async function ensureFresh(site: string, force: boolean) {
  const { rows } = await pool.query(`SELECT fetched_at FROM ops_sitemap_runs WHERE site = $1`, [site]);
  const age = rows[0] ? (Date.now() - new Date(rows[0].fetched_at).getTime()) / 36e5 : Infinity;
  if (force || age > CACHE_HOURS) {
    try { await refreshSitemap(site); }
    catch (e: any) {
      await pool.query(
        `INSERT INTO ops_sitemap_runs (site, fetched_at, error) VALUES ($1, COALESCE((SELECT fetched_at FROM ops_sitemap_runs WHERE site = $1), NOW()), $2)
         ON CONFLICT (site) DO UPDATE SET error = EXCLUDED.error`, [site, e.message]);
    }
  }
}

// ─── Search Console by page ─────────────────────────────────────────

interface GscRow { clicks: number; impressions: number; ctr: number; position: number }

async function gscByPage(company: string, start: Date, end: Date): Promise<{ rows: Map<string, GscRow>; error?: string }> {
  try {
    return await gscByPageInner(company, start, end);
  } catch (e: any) {
    // A Search Console failure must not take the sitemap view down with it.
    console.warn(`[PAGES] GSC ${company}: ${e.message}`);
    return { rows: new Map(), error: e.message === "deleted_client" ? "Google OAuth client is invalid — reconnect Google in Integrations" : e.message };
  }
}

async function gscByPageInner(company: string, start: Date, end: Date): Promise<{ rows: Map<string, GscRow>; error?: string }> {
  const auth = await getAuthenticatedClient(company);
  if (!auth) return { rows: new Map(), error: "Search Console not connected" };
  const conn = await getConnection(company);
  if (!conn?.gsc_site_url) return { rows: new Map(), error: "No Search Console site selected" };
  const webmasters = google.webmasters({ version: "v3", auth });
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const out = new Map<string, GscRow>();
  for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
    const resp = await webmasters.searchanalytics.query({
      siteUrl: conn.gsc_site_url,
      requestBody: { startDate: fmt(start), endDate: fmt(end), dimensions: ["page"], rowLimit: 25_000, startRow },
    });
    const rows = resp.data.rows || [];
    for (const r of rows) out.set(String(r.keys?.[0]), { clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0 });
    if (rows.length < 25_000) break;
  }
  return { rows: out };
}

// ─── Pixel by page ──────────────────────────────────────────────────

async function pixelByPath(site: string, days: number) {
  const [views, landings, revenue] = await Promise.all([
    pool.query(
      `SELECT page_url AS path, COUNT(*)::int AS views, COUNT(DISTINCT visitor_id)::int AS visitors
       FROM touchpoints WHERE site = $1 AND event_type = 'page_view' AND page_url IS NOT NULL
         AND created_at > NOW() - ($2 || ' days')::interval GROUP BY 1`, [site, String(days)]),
    pool.query(
      `SELECT landing_page AS path, COUNT(*)::int AS sessions
       FROM visitor_sessions WHERE site = $1 AND landing_page IS NOT NULL
         AND created_at > NOW() - ($2 || ' days')::interval GROUP BY 1`, [site, String(days)]),
    pool.query(
      `SELECT s.landing_page AS path, COUNT(DISTINCT t.id)::int AS purchases, COALESCE(SUM(t.revenue), 0)::float AS revenue
       FROM touchpoints t JOIN visitor_sessions s ON s.session_id = t.session_id AND s.site = t.site
       WHERE t.site = $1 AND t.revenue > 0 AND s.landing_page IS NOT NULL
         AND t.created_at > NOW() - ($2 || ' days')::interval GROUP BY 1`, [site, String(days)]),
  ]);
  const norm = (p: string) => (p || "/").replace(/\/+$/, "") || "/";
  const map = new Map<string, { views: number; visitors: number; sessions: number; purchases: number; revenue: number }>();
  const get = (p: string) => { const k = norm(p); if (!map.has(k)) map.set(k, { views: 0, visitors: 0, sessions: 0, purchases: 0, revenue: 0 }); return map.get(k)!; };
  for (const r of views.rows) { const m = get(r.path); m.views += r.views; m.visitors += r.visitors; }
  for (const r of landings.rows) get(r.path).sessions += r.sessions;
  for (const r of revenue.rows) { const m = get(r.path); m.purchases += r.purchases; m.revenue += r.revenue; }
  return map;
}

// ─── Route ──────────────────────────────────────────────────────────

export function registerPagesRoutes(app: Express) {
  ensureTables().catch((e) => console.error("[PAGES] table init failed", e.message));

  app.get("/api/ops/pages", async (req, res) => {
    const company = normalizeCompany(req.query.company);
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days || "28"), 10) || 28));
    if (!SITE_ROOTS[company]) return res.json({ configured: false, hint: `${company} has no public site configured for page tracking yet.` });
    try {
      await ensureFresh(company, req.query.refresh === "1");
      const end = new Date(Date.now() - 2 * 86400000); // GSC lags ~2 days
      const start = new Date(end.getTime() - days * 86400000);
      const prevEnd = new Date(start.getTime() - 86400000);
      const prevStart = new Date(prevEnd.getTime() - days * 86400000);

      const [pages, run, cur, prev, pixel] = await Promise.all([
        pool.query(`SELECT url, path, kind, source, lastmod FROM ops_site_pages WHERE site = $1`, [company]),
        pool.query(`SELECT fetched_at, url_count, sources, error FROM ops_sitemap_runs WHERE site = $1`, [company]),
        gscByPage(company, start, end),
        gscByPage(company, prevStart, prevEnd),
        pixelByPath(company, days),
      ]);

      const normUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();
      const byUrl = new Map<string, any>();
      for (const p of pages.rows) {
        byUrl.set(normUrl(p.url), { url: p.url, path: p.path, kind: p.kind, lastmod: p.lastmod, inSitemap: true });
      }
      // GSC pages missing from the sitemap still matter: orphans, old URLs, 404s Google keeps showing.
      for (const [u] of cur.rows) {
        const k = normUrl(u);
        if (!byUrl.has(k)) byUrl.set(k, { url: u, path: pathOf(u), kind: kindOf(pathOf(u), null), lastmod: null, inSitemap: false });
      }

      const rows = [...byUrl.values()].map((p) => {
        const g = cur.rows.get(p.url) ?? cur.rows.get(p.url + "/") ?? cur.rows.get(p.url.replace(/\/$/, ""));
        const gp = prev.rows.get(p.url) ?? prev.rows.get(p.url + "/") ?? prev.rows.get(p.url.replace(/\/$/, ""));
        const px = pixel.get((p.path.split("?")[0] || "/").replace(/\/+$/, "") || "/");
        return {
          url: p.url, path: p.path, kind: p.kind, lastmod: p.lastmod, inSitemap: p.inSitemap, inGsc: !!g,
          clicks: g?.clicks ?? 0, impressions: g?.impressions ?? 0,
          ctr: g ? +(g.ctr * 100).toFixed(2) : null, position: g ? +g.position.toFixed(1) : null,
          prevClicks: gp?.clicks ?? 0, prevImpressions: gp?.impressions ?? 0, prevPosition: gp ? +gp.position.toFixed(1) : null,
          views: px?.views ?? 0, visitors: px?.visitors ?? 0, sessions: px?.sessions ?? 0, purchases: px?.purchases ?? 0, revenue: px?.revenue ?? 0,
        };
      });
      rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.path.localeCompare(b.path));

      const inSitemap = rows.filter((r) => r.inSitemap);
      const totals = {
        live: inSitemap.length,
        indexedProxy: inSitemap.filter((r) => r.impressions > 0).length,
        noImpressions: inSitemap.filter((r) => r.impressions === 0).length,
        orphans: rows.length - inSitemap.length,
        clicks: rows.reduce((a, r) => a + r.clicks, 0),
        prevClicks: rows.reduce((a, r) => a + r.prevClicks, 0),
        impressions: rows.reduce((a, r) => a + r.impressions, 0),
        prevImpressions: rows.reduce((a, r) => a + r.prevImpressions, 0),
        revenue: rows.reduce((a, r) => a + r.revenue, 0),
        byKind: inSitemap.reduce<Record<string, number>>((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {}),
      };

      res.json({
        configured: true, company, days,
        window: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
        sitemap: run.rows[0] ? { fetchedAt: run.rows[0].fetched_at, urlCount: run.rows[0].url_count, sources: run.rows[0].sources, error: run.rows[0].error } : null,
        gsc: { connected: !cur.error, error: cur.error ?? null, pages: cur.rows.size },
        totals,
        // Overview cards only need the totals; 23k rows is a lot to ship for five tiles.
        rows: req.query.summary === "1" ? [] : rows,
      });
    } catch (e: any) {
      console.error("[PAGES]", e.message);
      res.status(500).json({ error: `Page performance failed: ${e.message}` });
    }
  });
}
