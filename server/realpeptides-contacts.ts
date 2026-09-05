/**
 * Real Peptides contacts / leads — proxied from the site's token-gated
 * /api/ops-contacts. The site's Postgres is the CRM and Resend mirrors it, so
 * this IS the Resend list without paging 57k contacts through Resend's API.
 * Campaign Refinery froze at the 2026-08-24 launch and is legacy only.
 */
import type { Express } from "express";

const cache = new Map<number, { at: number; data: any }>();
const CACHE_MS = 60_000;

function cfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

export async function siteContacts(days: number): Promise<any> {
  const c = cfg();
  if (!c) return { configured: false, hint: "Connect the new realpeptides.co backend first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN)." };
  const hit = cache.get(days);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const r = await fetch(`${c.base}/api/ops-contacts?days=${days}`, {
    headers: { Authorization: `Bearer ${c.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 404) {
    return { configured: false, hint: "Ops is wired and waiting — the site's /api/ops-contacts isn't deployed yet." };
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`ops-contacts ${r.status}: ${text.slice(0, 160)}`);
  const data = { configured: true, ...JSON.parse(text) };
  cache.set(days, { at: Date.now(), data });
  return data;
}

export function registerRealPeptidesContacts(app: Express) {
  app.get("/api/ops/realpeptides/contacts", async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.range || "30"), 10) || 30));
    try {
      res.json(await siteContacts(days));
    } catch (e: any) {
      console.error("[OPS][RP] contacts:", e.message);
      res.status(502).json({ error: e.message });
    }
  });
}
