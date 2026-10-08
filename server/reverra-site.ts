/**
 * Reverra sales via the Reverra D2C store — custom Next.js 16 + Prisma on
 * Docker (repo alfredintel/reverra-d2c-store; 49% BRANDMAXXER). Same
 * token-gated /api/ops-* pattern as realpeptides.co.
 *
 * Contract:
 *   GET {REVERRA_SITE_API_URL}/api/ops-summary?days=N|from=&to=
 *   Authorization: Bearer {REVERRA_SITE_OPS_TOKEN}
 *   → { current, previous: { revenueCents, grossCents, orders, customers,
 *       itemsSold, refundsCents, couponsCents },
 *       daily: [{ date, revenueCents, orders }],
 *       topProducts: [{ name, units, revenueCents, orders }], pending }
 *
 * Until both env vars land every caller gets `{ configured: false }` and the
 * UI shows the connect state — never a fabricated zero.
 */
import type { Express, Request, Response } from "express";
import { pruneCache, windowOf } from "./lib/window";

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 60_000;

function config() {
  const base = process.env.REVERRA_SITE_API_URL;
  const token = process.env.REVERRA_SITE_OPS_TOKEN;
  if (!base || !token) return null;
  return { base: base.replace(/\/$/, ""), token };
}

const dollars = (cents: unknown) => Math.round(Number(cents ?? 0)) / 100;

function window(w: any) {
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

export function registerReverra(app: Express) {
  app.get("/api/ops/reverra/summary", async (req: Request, res: Response) => {
    const cfg = config();
    if (!cfg) {
      return res.json({
        configured: false,
        hint: "Reverra store not connected — set REVERRA_SITE_API_URL + REVERRA_SITE_OPS_TOKEN.",
      });
    }
    const win = windowOf(req.query as Record<string, unknown>);
    const hit = cache.get(win.key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const r = await fetch(`${cfg.base}/api/ops-summary?${win.site}`, {
        headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": "BrandmaxxerOps/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`reverra ops-summary ${r.status}: ${text.slice(0, 160)}`);
      const j = JSON.parse(text);
      const data = {
        configured: true,
        generatedAt: new Date().toISOString(),
        range: win.days,
        current: window(j.current),
        previous: window(j.previous),
        daily: (j.daily ?? []).map((d: any) => ({
          date: String(d.date),
          revenue: dollars(d.revenueCents),
          orders: Number(d.orders ?? 0),
        })),
        topProducts: (j.topProducts ?? []).map((p: any) => ({
          name: String(p.name),
          units: Number(p.units ?? 0),
          revenue: dollars(p.revenueCents),
          orders: Number(p.orders ?? 0),
        })),
        pending: Number(j.pending ?? 0),
      };
      pruneCache(cache, CACHE_MS);
      cache.set(win.key, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][reverra] summary:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
