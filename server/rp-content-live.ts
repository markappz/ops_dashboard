/**
 * Real Peptides → Content: what is actually live on realpeptides.co, read from the site's
 * token-gated /api/ops-content (the Clomark numbers on that tab describe a queue, not the site).
 */
import type { Express } from "express";

let cache: { at: number; data: unknown } | null = null;
const CACHE_MS = 10 * 60_000;

export function registerRpContentLive(app: Express) {
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
