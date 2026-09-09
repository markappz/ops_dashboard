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

export function registerBrandEmail(app: Express) {
  register(app, "peptideu", "PEPTIDEU",
    "Set PEPTIDEU_EMAIL_API_URL + PEPTIDEU_EMAIL_TOKEN (the ops-email-summary edge function) to light this up.");
  register(app, "pawgen", "PAWGEN",
    "Ops is wired and waiting — pawgen's /api/ops-email-summary isn't deployed yet. Analytics appear automatically once the pawgen repo ships its email instrumentation.");
}
