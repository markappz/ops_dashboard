/**
 * Real Peptides → Content: what is actually live on realpeptides.co, read from the site's
 * token-gated /api/ops-content (the Clomark numbers on that tab describe a queue, not the site).
 */
import type { Express } from "express";

let cache: { at: number; data: unknown } | null = null;
const attrCache = new Map<number, { at: number; data: unknown }>();
const CACHE_MS = 10 * 60_000;

export function registerRpContentLive(app: Express) {
  // First-touch content attribution (realpeptides 6e273a2): revenue by the landing page that
  // started each buyer's first visit. Orders older than that deploy carry no attribution, so the
  // response's attributedOrders/totalOrders is a coverage ratio the UI must show.
  app.get("/api/ops/rp/attribution", async (req, res) => {
    const base = process.env.RP_SITE_API_URL?.replace(/\/$/, ""), token = process.env.RP_SITE_OPS_TOKEN;
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || "30"), 10) || 30));
    if (!base || !token) return res.json({ configured: false, hint: "Set RP_SITE_API_URL + RP_SITE_OPS_TOKEN." });
    const hit = attrCache.get(days);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json({ configured: true, ...(hit.data as object) });
    try {
      const r = await fetch(`${base}/api/ops-attribution?days=${days}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return res.status(502).json({ configured: true, error: `realpeptides.co /api/ops-attribution answered ${r.status}${r.status === 404 ? " (endpoint not deployed yet)" : ""}` });
      const data = await r.json();
      attrCache.set(days, { at: Date.now(), data });
      res.json({ configured: true, ...data });
    } catch (e: any) {
      res.status(502).json({ configured: true, error: e.message });
    }
  });

  app.get("/api/ops/rp/content-live", async (_req, res) => {
    const base = process.env.RP_SITE_API_URL?.replace(/\/$/, ""), token = process.env.RP_SITE_OPS_TOKEN;
    if (!base || !token) return res.json({ configured: false, hint: "Set RP_SITE_API_URL + RP_SITE_OPS_TOKEN." });
    if (cache && Date.now() - cache.at < CACHE_MS) return res.json({ configured: true, ...(cache.data as object) });
    try {
      const r = await fetch(`${base}/api/ops-content`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return res.status(502).json({ configured: true, error: `realpeptides.co /api/ops-content answered ${r.status}${r.status === 404 ? " (endpoint not deployed yet)" : ""}` });
      const data = await r.json();
      cache = { at: Date.now(), data };
      res.json({ configured: true, ...data });
    } catch (e: any) {
      res.status(502).json({ configured: true, error: e.message });
    }
  });
}
