/**
 * Real Peptides wholesale inquiries — proxied from the site's token-gated
 * /api/ops-wholesale (the inquiries already live in the site's DB; this just
 * puts the queue on ops instead of Paul's inbox). Status updates pass through
 * so the team can work NEW → CONTACTED → APPROVED/DECLINED from here.
 */
import type { Express } from "express";

let cache: { at: number; key: string; data: any } | null = null;
const CACHE_MS = 5 * 60_000;

function cfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

export function registerRealPeptidesWholesale(app: Express) {
  app.get("/api/ops/realpeptides/wholesale", async (req, res) => {
    const days = Math.min(730, Math.max(1, parseInt(String(req.query.range || "90"), 10) || 90));
    const c = cfg();
    if (!c) return res.json({ configured: false, hint: "Connect the new realpeptides.co backend first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN)." });
    const key = String(days);
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
    try {
      const r = await fetch(`${c.base}/api/ops-wholesale?days=${days}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 404) {
        return res.json({ configured: false, hint: "Ops is wired and waiting — the site's /api/ops-wholesale isn't deployed yet. Inquiries appear automatically once the RP repo ships it (branch ops-wholesale-endpoint)." });
      }
      const text = await r.text();
      if (!r.ok) throw new Error(`ops-wholesale ${r.status}: ${text.slice(0, 160)}`);
      const data = { configured: true, ...JSON.parse(text) };
      cache = { at: Date.now(), key, data };
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][RP] wholesale:", e.message);
      res.status(502).json({ error: e.message });
    }
  });

  app.patch("/api/ops/realpeptides/wholesale/:id", async (req: any, res) => {
    const c = cfg();
    if (!c) return res.status(503).json({ error: "Site not configured" });
    try {
      const r = await fetch(`${c.base}/api/ops-wholesale`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: req.params.id, status: req.body?.status }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json(j);
      cache = null;
      console.log(`[OPS][RP] wholesale ${j.ref} → ${j.status} by ${req.adminEmail || "ops"}`);
      res.json(j);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
}
