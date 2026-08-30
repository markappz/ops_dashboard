/**
 * Real Peptides email analytics — proxied from the site's token-gated
 * /api/ops-email-summary (the RP RDS is private; the standing rule is one
 * token-gated endpoint per cross-app read, never a second DB credential).
 * All aggregation happens site-side where Prisma and the Resend key live;
 * ops caches and renders.
 */
import type { Express } from "express";

const cache = new Map<number, { at: number; data: any }>();
const CACHE_MS = 10 * 60_000;

function cfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

export function registerRealPeptidesEmail(app: Express) {
  app.get("/api/ops/realpeptides/email", async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.range || "30"), 10) || 30));
    const c = cfg();
    if (!c) {
      return res.json({ configured: false, hint: "Connect the new realpeptides.co backend first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN)." });
    }
    const hit = cache.get(days);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
      const r = await fetch(`${c.base}/api/ops-email-summary?days=${days}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 404) {
        return res.json({ configured: false, hint: "Ops is wired and waiting — the site's /api/ops-email-summary isn't deployed yet. Email analytics appear automatically once the RP repo's email instrumentation ships." });
      }
      const text = await r.text();
      if (!r.ok) throw new Error(`ops-email-summary ${r.status}: ${text.slice(0, 160)}`);
      const data = { configured: true, ...JSON.parse(text) };
      cache.set(days, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][RP] email:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
