/**
 * Global Command Center (2026-10-10, Paul): every brand's vitals on one page —
 * revenue, growth, traffic, leads, tracked expenses → net — plus computed
 * rankings and opportunity callouts.
 *
 * Aggregation rules:
 *  - Each brand block reuses the SAME source its own tabs read (the 09-04
 *    decision), through exported builders or the same upstream feeds. No new
 *    math definitions.
 *  - Per-brand fault isolation: one dead feed returns {configured:false,
 *    error} for that brand and never blanks the page.
 *  - Numbers that are estimates or partial are labeled as such in `basis`
 *    (PeptideU revenue = MRR estimate; North Blu is a waitlist brand).
 */
import type { Express, Request, Response } from "express";
import { pool, peptidePool } from "./db";
import { fsWindowRevenue } from "./lib/fitscript-revenue";
import { windowOf, type Window, pruneCache } from "./lib/window";
import { siteSalesSummary, siteConfigured } from "./realpeptides-site";
import { pawgenCommandBuild } from "./pawgen-command";
import { peptideuCommandBuild } from "./peptideu-command";
import { financeLevel, ensureFinanceTables } from "./finance";

const cache = new Map<string, { at: number; data: any }>();
// Portfolio overview tolerates a few minutes of staleness (the brand tabs are
// the live source). 5-min bucketed keys + a 4-min warmer = the page opens
// instantly from cache instead of fanning out six feeds per view. The picker
// sends minute-exact from/to, so raw window keys would never repeat.
const CACHE_MS = 5 * 60_000;
const BRAND_TIMEOUT_MS = 15_000;
const cacheKeyFor = (win: Window) => `d${win.days}@${Math.floor(win.to.getTime() / 300_000)}`;

/** One slow upstream must not hold the whole page — cap each brand fetch. */
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} feed timed out after ${BRAND_TIMEOUT_MS / 1000}s`)), BRAND_TIMEOUT_MS)),
  ]);
}

export interface BrandVitals {
  key: string;
  label: string;
  configured: boolean;
  error?: string;
  basis?: string;                 // how to read the numbers — shown in UI
  /** 'window' = sales inside the range; 'mrr' = monthly recurring (PeptideU). */
  revenueKind?: "window" | "mrr";
  revenue: number; revenuePrev: number;
  orders?: number;
  sessions?: number | null; sessionsPrev?: number | null;
  leads?: number | null; leadsPrev?: number | null;
  series?: number[];              // daily revenue (or leads for non-commerce)
}

const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

/** Pixel sessions per site for current + previous window, one query. */
async function pixelSessions(win: Window): Promise<Record<string, { cur: number; prev: number }>> {
  const r = await pool.query(
    `SELECT site,
            COUNT(*) FILTER (WHERE started_at >= $1 AND started_at <= $2)::int AS cur,
            COUNT(*) FILTER (WHERE started_at >= $3 AND started_at <= $4)::int AS prev
       FROM visitor_sessions
      WHERE started_at >= $3
      GROUP BY site`,
    [win.from, win.to, win.prevFrom, win.prevTo],
  );
  return Object.fromEntries(r.rows.map((x) => [x.site, { cur: x.cur, prev: x.prev }]));
}

/** All FitScript money comes from lib/fitscript-revenue (Stripe dead 09-02). */
async function fitscriptVitals(win: Window, px: Record<string, { cur: number; prev: number }>): Promise<BrandVitals> {
  const [cur, prev, signups] = await Promise.all([
    fsWindowRevenue(win.from, win.to),
    fsWindowRevenue(win.prevFrom, win.prevTo),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2)::int AS cur,
              COUNT(*) FILTER (WHERE created_at >= $3 AND created_at <= $4)::int AS prev
         FROM users WHERE created_at >= $3`,
      [win.from, win.to, win.prevFrom, win.prevTo],
    ),
  ]);
  const series: number[] = [];
  for (let t = win.from.getTime(); t <= win.to.getTime(); t += 86_400_000) {
    series.push((cur.byDay[new Date(t).toISOString().slice(0, 10)] ?? 0) / 100);
  }
  return {
    key: "fitscript", label: "FitScript", configured: true,
    basis: "Wizlo membership charges + supplement orders + lab orders, net of refunds (same module as the FitScript Overview)",
    revenue: cur.cents / 100, revenuePrev: prev.cents / 100, orders: cur.orders,
    sessions: px.fitscript?.cur ?? null, sessionsPrev: px.fitscript?.prev ?? null,
    leads: signups.rows[0].cur, leadsPrev: signups.rows[0].prev,
    series,
  };
}

async function realpeptidesVitals(win: Window, px: Record<string, { cur: number; prev: number }>): Promise<BrandVitals> {
  if (!siteConfigured()) return { key: "realpeptides", label: "Real Peptides", configured: false, error: "site feed not configured", revenue: 0, revenuePrev: 0 };
  const s = await siteSalesSummary(win);
  return {
    key: "realpeptides", label: "Real Peptides", configured: true,
    basis: "storefront paid orders, net of coupons & refunds",
    revenue: s.current.revenue, revenuePrev: s.previous.revenue, orders: s.current.orders,
    sessions: px.realpeptides?.cur ?? null, sessionsPrev: px.realpeptides?.prev ?? null,
    leads: null, leadsPrev: null,
    series: (s.daily ?? []).map((d: any) => d.revenue),
  };
}

async function pawgenVitals(win: Window): Promise<BrandVitals> {
  const d: any = await pawgenCommandBuild(win);
  return {
    key: "pawgen", label: "pawgen", configured: true,
    basis: "paid orders; leads = guide magnet",
    revenue: Number(d.sales?.current?.revenue ?? 0), revenuePrev: Number(d.sales?.previous?.revenue ?? 0),
    orders: Number(d.sales?.current?.orders ?? 0),
    sessions: d.traffic?.pixelInstalled ? Number(d.traffic?.current?.sessions ?? 0) : null,
    sessionsPrev: d.traffic?.pixelInstalled ? Number(d.traffic?.previous?.sessions ?? 0) : null,
    leads: Number(d.leads?.window ?? 0), leadsPrev: Number(d.leads?.previous ?? 0),
    series: (d.sales?.series ?? []).map((r: any) => Number(r.revenue ?? r.value ?? 0)),
  };
}

async function peptideuVitals(win: Window): Promise<BrandVitals> {
  if (!peptidePool) return { key: "peptideu", label: "PeptideU", configured: false, error: "PeptideU DB not connected", revenue: 0, revenuePrev: 0 };
  const d: any = await peptideuCommandBuild(win);
  const mrr = Number(d.members?.mrrEstimate ?? 0);
  const paying = Number(d.members?.paying ?? 0);
  // Growth = MRR movement across the window via tracked churn: paid App Store
  // subs never write membership_grants (comps only — verified 10-10), but a
  // lapse flips the profile off premium at subscription_expires_at. New subs
  // inside the window aren't individually dated, so this slightly UNDERSTATES
  // growth — stated in the basis label rather than hidden.
  const lapsed = await peptidePool.query(
    `SELECT count(*)::int AS n FROM profiles
      WHERE subscription_expires_at >= $1 AND subscription_expires_at <= $2 AND entitlement <> 'premium'`,
    [win.from, win.to],
  );
  const planMonthly = paying > 0 ? mrr / paying : 0;
  const mrrPrev = Math.round((paying + Number(lapsed.rows[0].n)) * planMonthly);
  return {
    key: "peptideu", label: "PeptideU", configured: true,
    revenueKind: "mrr",
    basis: `MRR estimate (${paying} paying × plan); growth = churn-tracked MRR change (new subs in-window not separately dated, so growth reads conservative); leads = app signups`,
    revenue: mrr, revenuePrev: mrrPrev,
    sessions: null, sessionsPrev: null,
    leads: Number(d.current?.signups ?? 0), leadsPrev: Number(d.previous?.signups ?? 0),
    series: (d.series ?? []).map((r: any) => Number(r.signups ?? 0)),
  };
}

async function northbluVitals(win: Window): Promise<BrandVitals> {
  const base = process.env.NORTHBLU_EMAIL_API_URL;
  const token = process.env.NORTHBLU_EMAIL_TOKEN;
  if (!base || !token) return { key: "northblu", label: "North Blu", configured: false, error: "email engine not configured", revenue: 0, revenuePrev: 0 };
  const r = await fetch(`${base.replace(/\/$/, "")}?days=${win.days}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`northblu email summary ${r.status}`);
  const j: any = await r.json();
  return {
    key: "northblu", label: "North Blu", configured: true,
    basis: "waitlist brand — no commerce yet; leads = new contacts",
    revenue: 0, revenuePrev: 0,
    sessions: null, sessionsPrev: null,
    leads: Number(j.totals?.newContacts ?? 0), leadsPrev: null,
    series: [],
  };
}

async function reverraVitals(win: Window): Promise<BrandVitals> {
  const base = process.env.REVERRA_SITE_API_URL;
  const token = process.env.REVERRA_SITE_OPS_TOKEN;
  if (!base || !token) return { key: "reverra", label: "Reverra", configured: false, error: "store not connected yet", revenue: 0, revenuePrev: 0 };
  const r = await fetch(`${base.replace(/\/$/, "")}/api/ops-summary?days=${win.days}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`reverra ops-summary ${r.status}`);
  const j: any = await r.json();
  return {
    key: "reverra", label: "Reverra", configured: true,
    basis: "storefront paid orders",
    revenue: Number(j.current?.revenueCents ?? 0) / 100, revenuePrev: Number(j.previous?.revenueCents ?? 0) / 100,
    orders: Number(j.current?.orders ?? 0),
    sessions: null, sessionsPrev: null, leads: null, leadsPrev: null,
    series: (j.daily ?? []).map((d: any) => Number(d.revenueCents ?? 0) / 100),
  };
}

/** Tracked expenses per brand in the window (finance module, cents → USD). */
async function expensesByBrand(win: Window): Promise<Record<string, number>> {
  await ensureFinanceTables();
  const r = await pool.query(
    `SELECT brand, SUM(amount_cents * (
        CASE WHEN recurring = 'monthly' THEN
          GREATEST(0, (
            (date_part('year', LEAST(COALESCE(ended_at, $2::date), $2::date)) * 12 + date_part('month', LEAST(COALESCE(ended_at, $2::date), $2::date)))
            - (date_part('year', GREATEST(entry_date, $1::date)) * 12 + date_part('month', GREATEST(entry_date, $1::date)))
            + 1
          ))::int * CASE WHEN entry_date <= $2::date AND COALESCE(ended_at, $2::date) >= $1::date THEN 1 ELSE 0 END
        ELSE CASE WHEN entry_date >= $1::date AND entry_date <= $2::date THEN 1 ELSE 0 END END
      ))::bigint AS cents
     FROM ops_finance_entries
     WHERE deleted_at IS NULL AND kind = 'expense'
     GROUP BY brand HAVING SUM(amount_cents) <> 0`,
    [win.from, win.to],
  );
  return Object.fromEntries(r.rows.map((x) => [x.brand, Number(x.cents) / 100]));
}

function opportunities(brands: BrandVitals[], expenses: Record<string, number>): Array<{ brand: string; kind: string; note: string }> {
  const out: Array<{ brand: string; kind: string; note: string }> = [];
  for (const b of brands) {
    if (!b.configured) { out.push({ brand: b.label, kind: "connect", note: `Feed not connected (${b.error}) — numbers are invisible until it is.` }); continue; }
    const rg = pct(b.revenue, b.revenuePrev);
    const sg = b.sessions != null && b.sessionsPrev != null ? pct(b.sessions, b.sessionsPrev) : null;
    const lg = b.leads != null && b.leadsPrev != null ? pct(b.leads, b.leadsPrev) : null;
    const exp = expenses[b.key] ?? 0;
    if (rg != null && rg <= -15 && (sg == null || sg >= -5)) {
      out.push({ brand: b.label, kind: "conversion", note: `Revenue ${rg}% vs prior window while traffic held${sg != null ? ` (${sg >= 0 ? "+" : ""}${sg}%)` : ""} — conversion is slipping, not demand.` });
    }
    if (lg != null && lg >= 25 && rg != null && rg < 10) {
      out.push({ brand: b.label, kind: "leads", note: `Leads +${lg}% but revenue only ${rg >= 0 ? "+" : ""}${rg}% — a lead surge not converting yet. Worth a flow/offer look.` });
    }
    if (exp > 0 && b.revenue > 0 && exp > b.revenue) {
      out.push({ brand: b.label, kind: "negative", note: `Tracked expenses ($${Math.round(exp).toLocaleString()}) exceed revenue ($${Math.round(b.revenue).toLocaleString()}) this window.` });
    }
    if (rg != null && rg >= 30) {
      out.push({ brand: b.label, kind: "momentum", note: `Revenue +${rg}% vs prior window — momentum worth feeding (ads/email).` });
    }
  }
  return out;
}

/** Growth models and any other consumer get the same cached overview the
 *  /command page serves — one source of portfolio truth. */
export async function getOverviewCached(): Promise<any> {
  const win = windowOf({});
  const ck = cacheKeyFor(win);
  const prevCk = `d${win.days}@${Math.floor(win.to.getTime() / 300_000) - 1}`;
  const hit = cache.get(ck) ?? cache.get(prevCk);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await buildOverview(win);
  cache.set(ck, { at: Date.now(), data });
  return data;
}

async function buildOverview(win: Window) {
      const px = await pixelSessions(win).catch(() => ({} as Record<string, { cur: number; prev: number }>));
      const settled = await Promise.allSettled([
        withTimeout(fitscriptVitals(win, px), "FitScript"),
        withTimeout(realpeptidesVitals(win, px), "Real Peptides"),
        withTimeout(pawgenVitals(win), "pawgen"),
        withTimeout(peptideuVitals(win), "PeptideU"),
        withTimeout(northbluVitals(win), "North Blu"),
        withTimeout(reverraVitals(win), "Reverra"),
      ]);
      const keys = ["fitscript", "realpeptides", "pawgen", "peptideu", "northblu", "reverra"];
      const labels: Record<string, string> = { fitscript: "FitScript", realpeptides: "Real Peptides", pawgen: "pawgen", peptideu: "PeptideU", northblu: "North Blu", reverra: "Reverra" };
      const brands: BrandVitals[] = settled.map((s, i) =>
        s.status === "fulfilled" ? s.value
          : { key: keys[i], label: labels[keys[i]], configured: false, error: String((s as PromiseRejectedResult).reason?.message ?? "feed failed").slice(0, 140), revenue: 0, revenuePrev: 0 });

      const expenses = await expensesByBrand(win).catch(() => ({} as Record<string, number>));
      const configured = brands.filter((b) => b.configured);
      // Window sales and monthly-recurring are different units — never summed together.
      const windowBrands = configured.filter((b) => (b.revenueKind ?? "window") === "window");
      const totalRevenue = windowBrands.reduce((a, b) => a + b.revenue, 0);
      const totalPrev = windowBrands.reduce((a, b) => a + b.revenuePrev, 0);
      const totalMrr = configured.filter((b) => b.revenueKind === "mrr").reduce((a, b) => a + b.revenue, 0);
      const best = [...windowBrands].sort((a, b) => b.revenue - a.revenue)[0] ?? null;
      const growth = windowBrands
        .map((b) => ({ key: b.key, label: b.label, growth: pct(b.revenue, b.revenuePrev) }))
        .filter((g) => g.growth != null && (brands.find((b) => b.key === g.key)!.revenuePrev >= 500))
        .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0));

      const data = {
        generatedAt: new Date().toISOString(),
        window: { from: win.from.toISOString(), to: win.to.toISOString(), days: win.days },
        brands: brands.map((b) => ({ ...b, growth: pct(b.revenue, b.revenuePrev), expenses: expenses[b.key] ?? 0, net: b.revenue - (expenses[b.key] ?? 0) })),
        totals: { revenue: totalRevenue, revenuePrev: totalPrev, growth: pct(totalRevenue, totalPrev), mrr: totalMrr, expenses: Object.values(expenses).reduce((a, v) => a + v, 0) },
        best: best ? { key: best.key, label: best.label, revenue: best.revenue } : null,
        fastestGrowth: growth[0] ?? null,
        opportunities: opportunities(brands, expenses),
        notes: [
          "Each brand's numbers come from the same feed its own tabs read — tiles here always match the brand pages.",
          "PeptideU is recurring revenue (MRR), shown per month and kept OUT of the summed window revenue; its growth is churn-tracked and reads conservative. Growth ranking requires ≥$500 prior-window revenue so tiny bases don't fake 500% spikes.",
          "Expenses/net use the Finance tab's tracked entries only.",
          "This page refreshes every few minutes; for live-by-the-minute numbers open the brand's own tab.",
        ],
      };
      return data;
}

export function registerCommandCenterRoutes(app: Express) {
  app.get("/api/ops/command/overview", async (req: Request & { adminEmail?: string }, res: Response) => {
    try {
      const win = windowOf(req.query as Record<string, unknown>);
      const ck = cacheKeyFor(win);
      // Fall back one bucket so a viewer arriving just after a bucket rollover
      // still gets the warmed copy instead of paying the full fan-out.
      const prevCk = `d${win.days}@${Math.floor(win.to.getTime() / 300_000) - 1}`;
      const hit = cache.get(ck) ?? cache.get(prevCk);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(scrub(hit.data, req.adminEmail));
      const data = await buildOverview(win);
      pruneCache(cache, CACHE_MS);
      cache.set(ck, { at: Date.now(), data });
      res.json(scrub(data, req.adminEmail));
    } catch (e: any) {
      console.error("[OPS][COMMAND] overview:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

/** Keep the default 30d window warm so the page opens instantly. */
export function startCommandCenterWarmer(): void {
  const warm = async () => {
    try {
      const win = windowOf({});
      const data = await buildOverview(win);
      pruneCache(cache, CACHE_MS);
      cache.set(cacheKeyFor(win), { at: Date.now(), data });
    } catch (e: any) {
      console.warn("[OPS][COMMAND] warmer:", e.message);
    }
  };
  setTimeout(warm, 15_000); // after boot settles
  setInterval(warm, 4 * 60_000);
  console.log("[OPS][COMMAND] cache warmer armed (30d window, 5m)");
}

/** Expenses/net are Finance-grant data — strip them for everyone else. */
function scrub(data: any, email: string | undefined) {
  if (financeLevel(email) !== "none") return data;
  return {
    ...data,
    brands: data.brands.map((b: any) => ({ ...b, expenses: null, net: null })),
    totals: { ...data.totals, expenses: null },
    opportunities: data.opportunities.filter((o: any) => o.kind !== "negative"),
  };
}
