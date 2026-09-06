/**
 * Real Peptides Ranking Machine scoreboard.
 *
 * Search Console sliced by the cohorts the SEO program changed (compound hubs,
 * twin-merge winners, query-mined pages, calculator posts, flagship calculator).
 * Cohort membership is seeded from server/data/rp-seo-cohorts.json on boot
 * (append URLs there). A weekly job takes a snapshot so trend lines accumulate.
 * The freshness-cycle stamp is set by hand after the quarterly run.
 */
import type { Express } from "express";
import { google } from "googleapis";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { pool } from "./db";
import { getAuthenticatedClient, getConnection } from "./google-auth";

const COMPANY = "realpeptides";
const WINDOW_DAYS = 7;
const WEEK_MS = 7 * 86_400_000;

type GscRow = { clicks: number; impressions: number; position: number };
type Agg = { clicks: number; impressions: number; position: number; urlsSeen: number };

export async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_rp_seo_cohorts (
      cohort TEXT NOT NULL, url TEXT NOT NULL, added_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (cohort, url)
    );
    CREATE TABLE IF NOT EXISTS ops_rp_seo_snapshots (
      id SERIAL PRIMARY KEY, taken_on DATE NOT NULL, days INT NOT NULL, cohort TEXT NOT NULL,
      clicks INT NOT NULL, impressions INT NOT NULL, position REAL NOT NULL,
      urls_seen INT NOT NULL, urls_total INT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (taken_on, days, cohort)
    );
    CREATE TABLE IF NOT EXISTS ops_rp_seo_runs (
      kind TEXT PRIMARY KEY, last_run TIMESTAMPTZ, note TEXT
    );
  `);
}

export async function seedCohorts() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "data/rp-seo-cohorts.json"), path.join(process.cwd(), "server/data/rp-seo-cohorts.json")];
  const file = candidates.find((f) => { try { readFileSync(f); return true; } catch { return false; } });
  if (!file) { console.warn("[RP ranking] cohort seed file missing"); return; }
  const seed = JSON.parse(readFileSync(file, "utf8")) as { cohorts: Record<string, string[]> };
  let added = 0;
  for (const [cohort, urls] of Object.entries(seed.cohorts)) {
    for (const url of urls) {
      const r = await pool.query(`INSERT INTO ops_rp_seo_cohorts (cohort, url) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cohort, url]);
      added += r.rowCount ?? 0;
    }
  }
  if (added) console.log(`[RP ranking] seeded ${added} cohort urls`);
}

async function gscByPage(start: Date, end: Date): Promise<Map<string, GscRow>> {
  const auth = await getAuthenticatedClient(COMPANY);
  if (!auth) throw new Error("Search Console not connected for Real Peptides");
  const conn = await getConnection(COMPANY);
  if (!conn?.gsc_site_url) throw new Error("No Search Console site selected for Real Peptides");
  const webmasters = google.webmasters({ version: "v3", auth });
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const out = new Map<string, GscRow>();
  for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
    const resp = await webmasters.searchanalytics.query({
      siteUrl: conn.gsc_site_url,
      requestBody: { startDate: fmt(start), endDate: fmt(end), dimensions: ["page"], rowLimit: 25_000, startRow },
    });
    const rows = resp.data.rows || [];
    for (const r of rows) {
      // GSC reports #fragment variants as separate pages; fold them into the canonical URL.
      const key = String(r.keys?.[0]).split("#")[0];
      const prev = out.get(key);
      if (!prev) out.set(key, { clicks: r.clicks || 0, impressions: r.impressions || 0, position: r.position || 0 });
      else { prev.clicks += r.clicks || 0; prev.impressions += r.impressions || 0; }
    }
    if (rows.length < 25_000) break;
  }
  return out;
}

function aggregate(urls: string[], rows: Map<string, GscRow>): Agg {
  let clicks = 0, impressions = 0, weighted = 0, urlsSeen = 0;
  for (const u of urls) {
    const r = rows.get(u);
    if (!r) continue;
    clicks += r.clicks; impressions += r.impressions; weighted += r.position * r.impressions; urlsSeen++;
  }
  return { clicks, impressions, position: impressions ? +(weighted / impressions).toFixed(2) : 0, urlsSeen };
}

async function cohortMap(): Promise<Map<string, string[]>> {
  const r = await pool.query(`SELECT cohort, url FROM ops_rp_seo_cohorts ORDER BY cohort`);
  const m = new Map<string, string[]>();
  for (const row of r.rows) m.set(row.cohort, [...(m.get(row.cohort) ?? []), row.url]);
  return m;
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Takes the weekly snapshot: latest 7 days (ending 3 days ago, GSC lag) + a 28-day roll-up. */
export async function runScoreboard(trigger: string): Promise<{ cohorts: number }> {
  const cohorts = await cohortMap();
  const [week, month] = await Promise.all([gscByPage(day(2 + WINDOW_DAYS), day(3)), gscByPage(day(31), day(3))]);
  const takenOn = day(0).toISOString().slice(0, 10);
  for (const [name, urls] of cohorts) {
    for (const [days, rows] of [[WINDOW_DAYS, week], [28, month]] as const) {
      const a = aggregate(urls, rows);
      await pool.query(
        `INSERT INTO ops_rp_seo_snapshots (taken_on, days, cohort, clicks, impressions, position, urls_seen, urls_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (taken_on, days, cohort) DO UPDATE SET clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions,
           position=EXCLUDED.position, urls_seen=EXCLUDED.urls_seen, urls_total=EXCLUDED.urls_total`,
        [takenOn, days, name, a.clicks, a.impressions, a.position, a.urlsSeen, urls.length],
      );
    }
  }
  await pool.query(`INSERT INTO ops_rp_seo_runs (kind, last_run, note) VALUES ('scoreboard', NOW(), $1)
    ON CONFLICT (kind) DO UPDATE SET last_run = NOW(), note = EXCLUDED.note`, [trigger]);
  console.log(`[RP ranking] scoreboard snapshot (${trigger}) for ${cohorts.size} cohorts`);
  return { cohorts: cohorts.size };
}

/** Next Monday 11:00 UTC (06:00 New York in summer, 07:00 in winter). */
function msUntilNextMonday(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0));
  const daysAhead = (8 - next.getUTCDay()) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + (next <= now ? daysAhead : daysAhead === 7 ? 0 : daysAhead));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next.getTime() - now.getTime();
}

export function startRpRankingLoop() {
  if (process.env.NODE_ENV !== "production" && process.env.OPS_ENABLE_SCAN !== "1") {
    console.log("[RP ranking] weekly loop disabled in dev (OPS_ENABLE_SCAN=1 to test)");
    return;
  }
  const tick = () => runScoreboard("weekly").catch((e) => console.warn("[RP ranking] weekly failed:", e.message));
  // Catch up on boot if the last snapshot is stale (a deploy that skipped a Monday).
  setTimeout(async () => {
    const r = await pool.query(`SELECT last_run FROM ops_rp_seo_runs WHERE kind = 'scoreboard'`);
    const last = r.rows[0]?.last_run ? new Date(r.rows[0].last_run).getTime() : 0;
    if (Date.now() - last > 6 * 86_400_000) tick();
  }, 90_000);
  setTimeout(() => { tick(); setInterval(tick, WEEK_MS); }, msUntilNextMonday());
  console.log(`[RP ranking] weekly scoreboard armed (next in ${Math.round(msUntilNextMonday() / 3_600_000)}h)`);
}

// In-memory cache for the per-URL drill-down (one GSC pull per hour at most).
let urlCache: { at: number; rows: Map<string, GscRow> } | null = null;
async function monthRows(): Promise<Map<string, GscRow>> {
  if (urlCache && Date.now() - urlCache.at < 3_600_000) return urlCache.rows;
  const rows = await gscByPage(day(31), day(3));
  urlCache = { at: Date.now(), rows };
  return rows;
}

export function registerRpRankingRoutes(app: Express) {
  ensureTables().then(seedCohorts).catch((e) => console.error("[RP ranking] init failed", e.message));

  app.get("/api/ops/rp/ranking", async (_req, res) => {
    try {
      const connected = Boolean(await getAuthenticatedClient(COMPANY).catch(() => null));
      const [snaps, runs, counts] = await Promise.all([
        pool.query(`SELECT taken_on, days, cohort, clicks, impressions, position, urls_seen, urls_total
                    FROM ops_rp_seo_snapshots WHERE taken_on > NOW() - INTERVAL '120 days' ORDER BY taken_on ASC`),
        pool.query(`SELECT kind, last_run, note FROM ops_rp_seo_runs`),
        pool.query(`SELECT cohort, COUNT(*)::int AS n FROM ops_rp_seo_cohorts GROUP BY cohort ORDER BY cohort`),
      ]);
      const byCohort: Record<string, { week: typeof snaps.rows; month: typeof snaps.rows }> = {};
      for (const s of snaps.rows) {
        const c = (byCohort[s.cohort] ??= { week: [], month: [] });
        (s.days === WINDOW_DAYS ? c.week : c.month).push(s);
      }
      const cohorts = counts.rows.map((c) => {
        const w = byCohort[c.cohort]?.week ?? [], m = byCohort[c.cohort]?.month ?? [];
        return { cohort: c.cohort, urls: c.n, latest: w.at(-1) ?? null, previous: w.at(-2) ?? null, month: m.at(-1) ?? null,
          series: w.map((s) => ({ date: s.taken_on, clicks: s.clicks, impressions: s.impressions, position: s.position })) };
      });
      const runMap = Object.fromEntries(runs.rows.map((r) => [r.kind, r]));
      res.json({ configured: true, connected, cohorts, runs: runMap, nextWeeklyAt: new Date(Date.now() + msUntilNextMonday()).toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/rp/ranking/cohort", async (req, res) => {
    try {
      const name = String(req.query.name || "");
      const urls = (await cohortMap()).get(name) ?? [];
      const rows = await monthRows();
      const list = urls.map((u) => ({ url: u, ...(rows.get(u) ?? { clicks: 0, impressions: 0, position: 0 }) }))
        .sort((a, b) => b.impressions - a.impressions).slice(0, 200);
      res.json({ cohort: name, days: 28, rows: list });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/rp/ranking/run", async (_req, res) => {
    try { res.json(await runScoreboard("manual")); } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ops/rp/ranking/freshness", async (req, res) => {
    const note = String(req.body?.note || "").slice(0, 200);
    await pool.query(`INSERT INTO ops_rp_seo_runs (kind, last_run, note) VALUES ('freshness', NOW(), $1)
      ON CONFLICT (kind) DO UPDATE SET last_run = NOW(), note = EXCLUDED.note`, [note]);
    res.json({ ok: true });
  });
}
