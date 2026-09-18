/**
 * Inventory holds for Real Peptides (Justin, 2026-09-18).
 *
 * A SKU can be flagged "on hold" — unavailable for sale even with stock on hand,
 * e.g. while its COA is still pending. The flag lives here in ops' own DB, keyed
 * by the tracker SKU id, with a full who/when/why audit (an optional note). It is
 * mirrored best-effort to the COA tracker so the storefront feed can honor it;
 * ops stays the record for the toggle and its history.
 */
import type { Express, Request } from "express";
import { pool } from "./db";

function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  return token ? { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token } : null;
}

async function ensureTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_inventory_holds (
    sku_id INT PRIMARY KEY,
    on_hold BOOLEAN NOT NULL DEFAULT FALSE,
    note TEXT,
    changed_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_inventory_hold_log (
    id SERIAL PRIMARY KEY,
    sku_id INT NOT NULL,
    sku_code TEXT,
    product_name TEXT,
    on_hold BOOLEAN NOT NULL,
    note TEXT,
    changed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

/** Tell the tracker (storefront's source of truth) so its public feed can hide held SKUs. */
async function mirrorToTracker(skuId: number, onHold: boolean, by: string) {
  const t = trackerCfg();
  if (!t) return;
  try {
    await fetch(`${t.base}/api/skus/${skuId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ on_hold: onHold, by }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    console.warn("[OPS][RP] hold mirror skipped:", e.message);
  }
}

async function recordHold(skuId: number, onHold: boolean, note: string | null, by: string, sku: { sku_code?: unknown; product_name?: unknown }) {
  await pool.query(
    `INSERT INTO rp_inventory_holds (sku_id, on_hold, note, changed_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (sku_id) DO UPDATE SET on_hold = $2, note = $3, changed_by = $4, updated_at = NOW()`,
    [skuId, onHold, note, by]);
  await pool.query(
    `INSERT INTO rp_inventory_hold_log (sku_id, sku_code, product_name, on_hold, note, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [skuId, sku.sku_code ?? null, sku.product_name ?? null, onHold, note, by]);
}

export function registerRpHoldRoutes(app: Express) {
  app.get("/api/ops/realpeptides/inventory/holds", async (_req, res) => {
    try {
      await ensureTables();
      const holds = await pool.query(`SELECT sku_id, on_hold, note, changed_by, updated_at FROM rp_inventory_holds WHERE on_hold = TRUE`);
      const log = await pool.query(
        `SELECT id, sku_id, sku_code, product_name, on_hold, note, changed_by, created_at
         FROM rp_inventory_hold_log ORDER BY created_at DESC LIMIT 50`);
      res.json({ holds: holds.rows, log: log.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/inventory/holds/:skuId", async (req: Request, res) => {
    try {
      await ensureTables();
      const skuId = parseInt(req.params.skuId, 10);
      if (!Number.isInteger(skuId) || skuId <= 0) return res.status(400).json({ error: "Bad SKU id." });
      const onHold = !!req.body?.on_hold;
      const raw = req.body?.note;
      const note = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : null;
      const by = (req as any).adminEmail || "unknown";
      await recordHold(skuId, onHold, note, by, req.body ?? {});
      mirrorToTracker(skuId, onHold, by);
      console.log(`[OPS][RP] hold ${onHold ? "set" : "cleared"} on SKU ${skuId} by ${by}${note ? ` — ${note}` : ""}`);
      res.json({ ok: true, sku_id: skuId, on_hold: onHold, note, changed_by: by });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
