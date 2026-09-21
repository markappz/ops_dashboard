/**
 * PO batch/lot numbers for Real Peptides (Justin, request #7 — extends #6).
 *
 * POs live on the COA tracker, which ops can't extend, so the batch/lot number
 * a shipment carries is stored here in ops' own DB: one default at the PO level
 * (auto-fills every line at check-in) and an optional per-line override. Both
 * are kept for traceability, keyed by the tracker's PO and PO-item ids.
 */
import type { Express, Request } from "express";
import { pool } from "./db";

async function ensureTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_po_batches (
    po_id INT PRIMARY KEY,
    batch TEXT,
    changed_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_po_line_batches (
    item_id INT PRIMARY KEY,
    po_id INT NOT NULL,
    batch TEXT,
    changed_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

async function setPoBatch(poId: number, batch: string | null, by: string) {
  await pool.query(
    `INSERT INTO rp_po_batches (po_id, batch, changed_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (po_id) DO UPDATE SET batch = $2, changed_by = $3, updated_at = NOW()`,
    [poId, batch, by]);
}

async function setLineBatch(itemId: number, poId: number, batch: string | null, by: string) {
  await pool.query(
    `INSERT INTO rp_po_line_batches (item_id, po_id, batch, changed_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (item_id) DO UPDATE SET po_id = $2, batch = $3, changed_by = $4, updated_at = NOW()`,
    [itemId, poId, batch, by]);
}

async function saveBatches(poId: number, body: any, by: string) {
  await setPoBatch(poId, clean(body?.batch), by);
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  for (const l of lines) {
    const itemId = parseInt(String(l?.item_id), 10);
    if (Number.isInteger(itemId) && itemId > 0) await setLineBatch(itemId, poId, clean(l?.batch), by);
  }
}

export function registerRpPoBatchRoutes(app: Express) {
  app.get("/api/ops/realpeptides/inventory/po-batches", async (_req, res) => {
    try {
      await ensureTables();
      const po = await pool.query(`SELECT po_id, batch, changed_by, updated_at FROM rp_po_batches WHERE batch IS NOT NULL`);
      const lines = await pool.query(`SELECT item_id, po_id, batch, changed_by, updated_at FROM rp_po_line_batches WHERE batch IS NOT NULL`);
      res.json({ poBatches: po.rows, lineBatches: lines.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/inventory/po-batches/:poId", async (req: Request, res) => {
    try {
      await ensureTables();
      const poId = parseInt(req.params.poId, 10);
      if (!Number.isInteger(poId) || poId <= 0) return res.status(400).json({ error: "Bad PO id." });
      const by = (req as any).adminEmail || "unknown";
      await saveBatches(poId, req.body ?? {}, by);
      res.json({ ok: true, po_id: poId, batch: clean(req.body?.batch) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
