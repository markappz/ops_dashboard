import type { Express, Request, Response } from "express";

/**
 * tryrealpep.co guide-funnel report (Josh's 9-guide launch, 2026-10-11).
 * Pure proxy to the site's token-gated /api/ops-guide-funnel — the engine
 * computes everything (handle vs coupon attribution, net revenue on the
 * admin definition); ops renders it. 5-minute cache, same pattern as the
 * other RP site feeds.
 */
const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 5 * 60_000;

export function registerRpGuideFunnelRoutes(app: Express) {
  app.get("/api/ops/realpeptides/guide-funnel", async (req: Request, res: Response) => {
    const base = process.env.RP_SITE_API_URL;
    const token = process.env.RP_SITE_OPS_TOKEN;
    if (!base || !token) {
      return res.json({ configured: false, hint: "Set RP_SITE_API_URL + RP_SITE_OPS_TOKEN on ops to read the guide-funnel report." });
    }
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1), 365);
    const key = `d${days}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/api/ops-guide-funnel?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      // 404 = the engine build carrying the feed isn't deployed yet — a connect
      // state, not an error (ops can ship first; the tab waits gracefully).
      if (r.status === 404) {
        return res.json({ configured: false, hint: "The site's guide-funnel feed isn't live yet — it ships with the real-peptides engine deploy. This tab lights up on its own once that lands." });
      }
      if (!r.ok) throw new Error(`site ${r.status}: ${text.slice(0, 160)}`);
      const data = { configured: true, ...JSON.parse(text) };
      cache.set(key, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error("[OPS][RP] guide-funnel:", (e as Error).message);
      res.status(502).json({ configured: true, error: (e as Error).message });
    }
  });
}
