/**
 * Brand email analytics proxies — PeptideU + pawgen, same standing rule as RP:
 * one token-gated summary endpoint per app (aggregation happens where the data
 * and the Resend key live), ops caches and renders. Env per brand:
 *   PEPTIDEU_EMAIL_API_URL / PEPTIDEU_EMAIL_TOKEN
 *   PAWGEN_EMAIL_API_URL   / PAWGEN_EMAIL_TOKEN
 */
import type { Express } from "express";

const CACHE_MS = 10 * 60_000;

function register(app: Express, slug: string, envPrefix: string, hint: string) {
  const cache = new Map<number, { at: number; data: any }>();
  app.get(`/api/ops/${slug}/email`, async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.range || "30"), 10) || 30));
    const base = process.env[`${envPrefix}_EMAIL_API_URL`];
    const token = process.env[`${envPrefix}_EMAIL_TOKEN`];
    if (!base || !token) return res.json({ configured: false, hint });
    const hit = cache.get(days);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${slug} email summary ${r.status}: ${text.slice(0, 160)}`);
      const data = { configured: true, ...JSON.parse(text) };
      cache.set(days, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      console.error(`[OPS][${slug}] email:`, e.message);
      res.status(502).json({ error: e.message });
    }
  });
}

/** One upstream summary fetch, shared by the per-brand routes and the blended view. */
async function fetchSummary(base: string, token: string, days: number): Promise<any> {
  const r = await fetch(`${base.replace(/\/$/, "")}?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const BLENDED_BRANDS: Array<{ slug: string; label: string; env: () => { base?: string; token?: string } }> = [
  { slug: "realpeptides", label: "Real Peptides", env: () => ({ base: process.env.RP_SITE_API_URL ? `${process.env.RP_SITE_API_URL.replace(/\/$/, "")}/api/ops-email-summary` : undefined, token: process.env.RP_SITE_OPS_TOKEN }) },
  { slug: "peptideu", label: "PeptideU", env: () => ({ base: process.env.PEPTIDEU_EMAIL_API_URL, token: process.env.PEPTIDEU_EMAIL_TOKEN }) },
  { slug: "pawgen", label: "pawgen", env: () => ({ base: process.env.PAWGEN_EMAIL_API_URL, token: process.env.PAWGEN_EMAIL_TOKEN }) },
];

/**
 * Blended view: every brand's summary in one payload, plus combined totals so
 * one tab answers "how is email doing across the companies". Rates are
 * tracked-send weighted, never averaged. A brand that errors or isn't wired
 * reports itself instead of hiding — a blank brand must be visible.
 */
function registerBlended(app: Express) {
  const cache = new Map<number, { at: number; data: any }>();
  app.get("/api/ops/email/blended", async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.range || "30"), 10) || 30));
    const hit = cache.get(days);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    const brands = await Promise.all(BLENDED_BRANDS.map(async (b) => {
      const { base, token } = b.env();
      if (!base || !token) return { slug: b.slug, label: b.label, configured: false as const };
      try {
        const s = await fetchSummary(base, token, days);
        return { slug: b.slug, label: b.label, configured: true as const, totals: s.totals, flows: s.flows ?? [], campaigns: s.campaigns ?? [] };
      } catch (e: any) {
        console.error(`[OPS][blended] ${b.slug}:`, e.message);
        return { slug: b.slug, label: b.label, configured: false as const, error: e.message };
      }
    }));
    const live = brands.filter((b) => b.configured) as Array<any>;
    const sum = (f: (t: any) => number) => live.reduce((n, b) => n + (f(b.totals) || 0), 0);
    const tracked = (t: any) => t.trackedSends ?? t.sends ?? 0;
    const wRate = (k: "openRate" | "clickRate") => {
      const den = live.reduce((n, b) => n + (b.totals[k] === null ? 0 : tracked(b.totals)), 0);
      if (!den) return null;
      return live.reduce((n, b) => n + (b.totals[k] ?? 0) * (b.totals[k] === null ? 0 : tracked(b.totals)), 0) / den;
    };
    const campaigns = live
      .flatMap((b) => (b.campaigns ?? []).map((c: any) => ({ ...c, brand: b.slug, brandLabel: b.label })))
      .sort((a, b) => new Date(b.sentAt ?? b.lastSeen ?? 0).getTime() - new Date(a.sentAt ?? a.lastSeen ?? 0).getTime())
      .slice(0, 60);
    const data = {
      days,
      brands: brands.map(({ campaigns: _c, flows: _f, ...rest }) => rest),
      combined: {
        marketableContacts: sum((t) => t.marketableContacts),
        unsubscribed: sum((t) => t.unsubscribed),
        suppressed: sum((t) => (t.suppressedBounced || 0) + (t.suppressedComplained || 0)),
        sends: sum((t) => t.sends),
        openRate: wRate("openRate"),
        clickRate: wRate("clickRate"),
        attributedOrders: sum((t) => t.attributedOrders),
        attributedRevenueCents: sum((t) => t.attributedRevenueCents),
      },
      campaigns,
    };
    cache.set(days, { at: Date.now(), data });
    res.json(data);
  });
}

export function registerBrandEmail(app: Express) {
  registerBlended(app);
  register(app, "peptideu", "PEPTIDEU",
    "Set PEPTIDEU_EMAIL_API_URL + PEPTIDEU_EMAIL_TOKEN (the ops-email-summary edge function) to light this up.");
  register(app, "pawgen", "PAWGEN",
    "Ops is wired and waiting — pawgen's /api/ops-email-summary isn't deployed yet. Analytics appear automatically once the pawgen repo ships its email instrumentation.");
}
