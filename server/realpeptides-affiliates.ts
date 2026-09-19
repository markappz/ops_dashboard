/**
 * Real Peptides affiliate program — proxied from the site's token-gated
 * /api/ops-affiliates. The header figures are the site's own program-summary
 * library (the monthly report email), so ops never disagrees with what the
 * client is told; the table is per-affiliate window activity plus anyone the
 * program still owes money. Money arrives in DOLLARS (site Decimals), not cents.
 */
import type { Express } from "express";
import { windowOf } from "./lib/window";

let cache: { at: number; key: string; data: any } | null = null;
const CACHE_MS = 5 * 60_000;

function cfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

export function registerRealPeptidesAffiliates(app: Express) {
  app.get("/api/ops/realpeptides/affiliates", async (req, res) => {
    const win = windowOf(req.query as Record<string, unknown>, 30);
    const c = cfg();
    if (!c) return res.json({ configured: false, hint: "Connect the site first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN)." });
    if (cache && cache.key === win.key && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
    try {
      const r = await fetch(`${c.base}/api/ops-affiliates?${win.site}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 404) {
        return res.json({ configured: true, pending: true, hint: "Ops is wired and waiting — the site's /api/ops-affiliates isn't deployed yet." });
      }
      const text = await r.text();
      if (!r.ok) throw new Error(`ops-affiliates ${r.status}: ${text.slice(0, 160)}`);
      const data = { configured: true, ...JSON.parse(text) };
      cache = { at: Date.now(), key: win.key, data };
      res.json(data);
    } catch (e: any) {
      console.error("[OPS][RP] affiliates:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
