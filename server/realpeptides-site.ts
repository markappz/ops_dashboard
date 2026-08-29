/**
 * Real Peptides sales via the NEW realpeptides.co (Next.js on Vercel).
 *
 * The Vercel rebuild retired WordPress entirely — /wp-json/* 404s — so the
 * WooCommerce connector went dark at launch. The new site's backend is the
 * dev team's own commerce API; ops reads a token-gated summary endpoint they
 * expose (same cross-app pattern as the COA tracker's /api/ops-summary:
 * one shared bearer token, read-only by construction, no DB credential).
 *
 * Contract (spec shared with the Vercel team):
 *   GET {RP_SITE_API_URL}/api/ops-summary?days=N
 *   Authorization: Bearer {RP_SITE_OPS_TOKEN}
 *   → { current, previous: { revenueCents, grossCents?, orders, customers,
 *       itemsSold?, refundsCents?, couponsCents? },
 *       daily: [{ date, revenueCents, orders }],
 *       topProducts: [{ name, units, revenueCents, orders }], pending? }
 *
 * Until both env vars land every caller gets `{ configured: false }` and the
 * UI shows the connect state — never a fabricated zero.
 */
import type { SalesSummary, SalesWindow } from "./woocommerce";

const cache = new Map<number, { at: number; data: SalesSummary }>();
const CACHE_MS = 10 * 60_000;

function config() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  if (!base || !token) return null;
  return { base: base.replace(/\/$/, ""), token };
}

export const siteConfigured = () => !!config();

const dollars = (cents: unknown) => Math.round(Number(cents ?? 0)) / 100;

function window(w: any): SalesWindow {
  const revenue = dollars(w?.revenueCents);
  const orders = Number(w?.orders ?? 0);
  return {
    revenue,
    grossSales: w?.grossCents !== undefined ? dollars(w.grossCents) : revenue,
    orders,
    aov: orders ? Math.round((revenue / orders) * 100) / 100 : 0,
    customers: Number(w?.customers ?? 0),
    itemsSold: Number(w?.itemsSold ?? 0),
    refunds: dollars(w?.refundsCents),
    coupons: dollars(w?.couponsCents),
  };
}

export async function siteSalesSummary(range: number): Promise<SalesSummary> {
  const cfg = config();
  if (!cfg) throw new Error("New-site API not configured (RP_SITE_API_URL / RP_SITE_OPS_TOKEN)");
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const r = await fetch(`${cfg.base}/api/ops-summary?days=${range}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": "FitScriptOps/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`realpeptides.co ops-summary ${r.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);

  const data: SalesSummary = {
    configured: true,
    source: "woocommerce", // keeps the client type stable; the card reads the label below
    range,
    current: window(j.current),
    previous: window(j.previous),
    daily: (j.daily ?? []).map((d: any) => ({ date: String(d.date), revenue: dollars(d.revenueCents), orders: Number(d.orders ?? 0) })),
    topProducts: (j.topProducts ?? []).map((p: any) => ({ name: String(p.name), units: Number(p.units ?? 0), revenue: dollars(p.revenueCents), orders: Number(p.orders ?? 0) })),
    pending: Number(j.pending ?? 0),
    fetchedAt: new Date().toISOString(),
  };
  cache.set(range, { at: Date.now(), data });
  return data;
}
