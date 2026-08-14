/**
 * Real Peptides connector.
 *
 * RP is the one brand with no readable order database: realpeptides.co is
 * WordPress + WooCommerce and no API credentials exist for it. So this module
 * deliberately does NOT pretend to know revenue. It reports the two things that
 * are genuinely observable today:
 *
 *   1. Traffic + attribution, from the first-party pixel already running on
 *      ops.fitscript.me (`site = 'realpeptides'`, set from the browser Origin).
 *      Covers realpeptides.co and the three lead-magnet funnels.
 *   2. Leads, from Real Peptides' own Klaviyo account (RP_KLAVIYO_API_KEY).
 *
 * Every surface degrades to an explicit "not configured / not installed" state
 * rather than a zero, because a zero here reads as "no traffic" when the truth
 * is "nothing is reporting yet".
 */
import type { Express, Response } from "express";
import { pool } from "./db";
import { KLAVIYO_BASE, KLAVIYO_REVISION } from "./klaviyo";

const SITE = "realpeptides";

function days(v: unknown): number {
  const n = parseInt(String(v ?? "30"), 10);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
}

function fail(res: Response, where: string, e: any) {
  console.error(`[OPS][RP] ${where}:`, e?.message ?? e);
  res.status(500).json({ error: `${where} failed: ${e?.message ?? "unknown error"}` });
}

// ─── Traffic / attribution (first-party pixel) ─────────────────────

/** Groups sessions by one column, newest-heavy first. NULL is kept, never dropped. */
async function groupSessions(column: string, since: number, limit = 12) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(${column}, ''), '(none)') AS key,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY sessions DESC LIMIT $3`,
    [SITE, String(since), limit]
  );
  return rows;
}

async function trafficTotals(since: number) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors,
            COALESCE(SUM(page_count), 0)::int AS page_views
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
    [SITE, String(since)]
  );
  return rows[0];
}

async function trafficDaily(since: number) {
  const { rows } = await pool.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [SITE, String(since)]
  );
  return rows;
}

/**
 * Which RP property the session landed on. The funnels and the store all write
 * site='realpeptides', so the host is the only thing separating them.
 */
async function trafficByProperty(since: number) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(substring(landing_page from '^https?://([^/]+)'), ''), '(unknown)') AS key,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY sessions DESC LIMIT 20`,
    [SITE, String(since)]
  );
  return rows;
}

// ─── Klaviyo (Real Peptides' own account) ──────────────────────────

function rpKlaviyoKey(): string | null {
  const k = process.env.RP_KLAVIYO_API_KEY;
  return k && k.startsWith("pk_") ? k : null;
}

async function rpKlaviyo<T = any>(path: string): Promise<T> {
  const key = rpKlaviyoKey();
  if (!key) throw Object.assign(new Error("RP_KLAVIYO_API_KEY not configured"), { status: 503 });

  const res = await fetch(path.startsWith("http") ? path : `${KLAVIYO_BASE}${path}`, {
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      Accept: "application/vnd.api+json",
      revision: KLAVIYO_REVISION,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Klaviyo ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface KProfile {
  id: string;
  attributes?: { email?: string; created?: string; properties?: Record<string, unknown> };
}

/**
 * Profiles created in the window. Klaviyo pages at 100; we follow up to `maxPages`
 * so the count stays honest for normal volume and the cap is reported, never hidden.
 */
async function recentProfiles(since: number, maxPages = 10) {
  const from = new Date(Date.now() - since * 86400_000).toISOString();
  let url: string | null =
    `/profiles/?filter=greater-than(created,${from})&sort=-created&page[size]=100`;
  const out: KProfile[] = [];
  let pages = 0;

  while (url && pages < maxPages) {
    const body: { data?: KProfile[]; links?: { next?: string | null } } = await rpKlaviyo(url);
    out.push(...(body.data ?? []));
    url = body.links?.next ?? null;
    pages++;
  }
  return { profiles: out, truncated: Boolean(url) };
}

/** Lists with their sizes — one list per lead magnet is how RP's funnels segment. */
async function klaviyoLists() {
  const body = await rpKlaviyo<{ data?: { id: string; attributes?: { name?: string; profile_count?: number } }[] }>(
    "/lists/?additional-fields[list]=profile_count"
  );
  return (body.data ?? [])
    .map((l) => ({ id: l.id, name: l.attributes?.name ?? l.id, profiles: l.attributes?.profile_count ?? 0 }))
    .sort((a, b) => b.profiles - a.profiles);
}

/** Best-effort signup source off whatever the funnel wrote onto the profile. */
function profileSource(p: KProfile): string {
  const props = p.attributes?.properties ?? {};
  for (const k of ["source", "Source", "utm_source", "lead_source", "signup_source", "Sign Up Source"]) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "(not tagged)";
}

function dailySeries(profiles: KProfile[], since: number) {
  const buckets = new Map<string, number>();
  for (let i = since - 1; i >= 0; i--) {
    buckets.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), 0);
  }
  for (const p of profiles) {
    const day = (p.attributes?.created ?? "").slice(0, 10);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return [...buckets].map(([date, leads]) => ({ date, leads }));
}

// ─── COA tracker (coa.realpeptides.co) ─────────────────────────────

/**
 * The COA tracker is a separate app in a separate AWS account with a private
 * RDS, so ops can't read its database. It exposes a read-only, token-gated
 * summary instead — the same "keys stay in one system" pattern as pawgen's
 * ShippingEasy endpoint.
 */
async function coaSummary() {
  const base = process.env.COA_API_URL || "https://coa.realpeptides.co";
  const token = process.env.COA_OPS_TOKEN;
  if (!token) {
    return {
      configured: false as const,
      hint: "Set COA_OPS_TOKEN here and on the COA tracker (same value) to read coa.realpeptides.co.",
    };
  }

  const r = await fetch(`${base}/api/ops-summary`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`COA tracker ${r.status}: ${text.slice(0, 200)}`);
  return { configured: true as const, ...JSON.parse(text) };
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerRealPeptidesRoutes(app: Express) {
  /**
   * Pixel-derived marketing. `pixelInstalled` is false until the first event
   * ever arrives from an RP origin — the UI shows install instructions instead
   * of an all-zero dashboard.
   */
  app.get("/api/ops/realpeptides/marketing", async (req, res) => {
    try {
      const since = days(req.query.range);
      const [ever, totals, daily, bySource, byMedium, byCampaign, byLanding, byReferrer, byProperty] =
        await Promise.all([
          pool.query(`SELECT EXISTS(SELECT 1 FROM visitor_sessions WHERE site = $1) AS ok`, [SITE]),
          trafficTotals(since),
          trafficDaily(since),
          groupSessions("utm_source", since),
          groupSessions("utm_medium", since),
          groupSessions("utm_campaign", since),
          groupSessions("landing_page", since),
          groupSessions("referrer", since),
          trafficByProperty(since),
        ]);

      res.json({
        pixelInstalled: ever.rows[0]?.ok === true,
        range: since,
        totals,
        daily,
        bySource,
        byMedium,
        byCampaign,
        byLanding,
        byReferrer,
        byProperty,
      });
    } catch (e) {
      fail(res, "Real Peptides marketing", e);
    }
  });

  /**
   * Leads from RP's Klaviyo. No revenue or conversion figures: WooCommerce isn't
   * readable, so "became a customer" is genuinely unknown and is not guessed at.
   */
  app.get("/api/ops/realpeptides/leads", async (req, res) => {
    if (!rpKlaviyoKey()) {
      return res.json({
        configured: false,
        hint: "Set RP_KLAVIYO_API_KEY (a pk_* private key from Real Peptides' own Klaviyo account) in the ECS task definition.",
      });
    }
    try {
      const since = days(req.query.range);
      const [{ profiles, truncated }, lists] = await Promise.all([recentProfiles(since), klaviyoLists()]);

      const bySource = new Map<string, number>();
      for (const p of profiles) {
        const s = profileSource(p);
        bySource.set(s, (bySource.get(s) ?? 0) + 1);
      }

      res.json({
        configured: true,
        range: since,
        truncated,
        totals: { leads: profiles.length, lists: lists.length },
        lists,
        series: dailySeries(profiles, since),
        bySource: [...bySource].map(([key, leads]) => ({ key, leads })).sort((a, b) => b.leads - a.leads),
        recent: profiles.slice(0, 100).map((p) => ({
          email: p.attributes?.email ?? "(no email)",
          source: profileSource(p),
          created_at: p.attributes?.created ?? null,
        })),
      });
    } catch (e) {
      fail(res, "Real Peptides leads", e);
    }
  });

  /** COA freshness, proxied from the COA tracker's own read-only endpoint. */
  app.get("/api/ops/realpeptides/coa", async (_req, res) => {
    try {
      res.json(await coaSummary());
    } catch (e) {
      fail(res, "COA summary", e);
    }
  });
}
