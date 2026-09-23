/**
 * "Fresh until" dates for Real Peptides COAs (Justin, 2026-09-22).
 *
 * When a lot hasn't changed there's no point retesting, so a SKU can be marked
 * "fresh until <date>" to defer its COA renewal. The date lives here in ops'
 * own DB, keyed by the tracker SKU id, and is mirrored best-effort to the COA
 * tracker. Until the date passes the ops UI treats the SKU as current; on or
 * after it, normal COA logic resumes. Clearing the date reverts immediately.
 */
import type { Express, Request } from "express";
import { pool } from "./db";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_coa_fresh_until (
    sku_id INT PRIMARY KEY,
    fresh_until DATE,
    changed_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

/** Tell the tracker so its schedulers can honor the deferral too. */
async function mirrorToTracker(skuId: number, freshUntil: string | null, by: string) {
  const t = trackerCfg();
  if (!t) return;
  try {
    await fetch(`${t.base}/api/skus/${skuId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fresh_until: freshUntil, by }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    console.warn("[OPS][RP] fresh-until mirror skipped:", e.message);
  }
}

async function record(skuId: number, freshUntil: string | null, by: string) {
  await pool.query(
    `INSERT INTO rp_coa_fresh_until (sku_id, fresh_until, changed_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sku_id) DO UPDATE SET fresh_until = $2, changed_by = $3, updated_at = NOW()`,
    [skuId, freshUntil, by]);
}

export function registerRpCoaFreshRoutes(app: Express) {
  app.get("/api/ops/realpeptides/coa/fresh-until", async (_req, res) => {
    try {
      await ensureTable();
      const r = await pool.query(
        `SELECT sku_id, to_char(fresh_until, 'YYYY-MM-DD') AS fresh_until, changed_by, updated_at
         FROM rp_coa_fresh_until WHERE fresh_until IS NOT NULL`);
      const map: Record<number, string> = {};
      for (const row of r.rows) map[row.sku_id] = row.fresh_until;
      res.json({ freshUntil: map, rows: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/coa/fresh-until/:skuId", async (req: Request, res) => {
    try {
      await ensureTable();
      const skuId = parseInt(req.params.skuId, 10);
      if (!Number.isInteger(skuId) || skuId <= 0) return res.status(400).json({ error: "Bad SKU id." });
      const raw = req.body?.fresh_until;
      if (raw != null && !(typeof raw === "string" && ISO_DATE.test(raw))) {
        return res.status(400).json({ error: "Fresh-until date must be YYYY-MM-DD or null to clear." });
      }
      const freshUntil = raw == null || raw === "" ? null : raw;
      const by = (req as any).adminEmail || "unknown";
      await record(skuId, freshUntil, by);
      mirrorToTracker(skuId, freshUntil, by);
      console.log(`[OPS][RP] fresh-until ${freshUntil ? `set to ${freshUntil}` : "cleared"} on SKU ${skuId} by ${by}`);
      res.json({ ok: true, sku_id: skuId, fresh_until: freshUntil, changed_by: by });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
