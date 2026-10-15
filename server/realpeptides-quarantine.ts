/**
 * Quarantine inventory for Real Peptides (Justin, request #20).
 *
 * New batches must pass third-party COA testing before they can sell. The COA
 * tracker owns stock and has no quarantine concept, so a quarantined receipt is
 * modelled ops-side: the PO is received on the tracker as normal (so on-order
 * clears), then the quarantined units are pulled back out of live stock with an
 * audited move — "received but not for sale". A sidecar row keeps the held qty,
 * lot and lab so the COA tab can show "Sent to lab [date]". Releasing a lot adds
 * the units back to live stock and stamps the COA result.
 */
import type { Express, Request } from "express";
import { pool } from "./db";

function trackerCfg() {
  const token = process.env.COA_OPS_TOKEN;
  if (!token) return null;
  return { base: (process.env.COA_API_URL || "https://coa.realpeptides.co").replace(/\/$/, ""), token };
}

async function trackerPost(path: string, body: unknown) {
  const cfg = trackerCfg();
  if (!cfg) throw new Error("COA_OPS_TOKEN is not set on ops.");
  const r = await fetch(`${cfg.base}/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 120) }; }
  if (!r.ok) throw new Error(j.error || `tracker ${r.status}`);
  return j;
}

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rp_quarantine (
    id SERIAL PRIMARY KEY,
    sku_id INT NOT NULL,
    sku_code TEXT,
    product_name TEXT,
    po_id INT,
    item_id INT,
    qty INT NOT NULL,
    released_qty INT NOT NULL DEFAULT 0,
    lot TEXT,
    lab_name TEXT,
    status TEXT NOT NULL DEFAULT 'sent_to_lab',
    coa_result TEXT,
    sent_date DATE NOT NULL DEFAULT CURRENT_DATE,
    released_date DATE,
    created_by TEXT,
    released_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

const int = (v: unknown) => parseInt(String(v), 10);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
const by = (req: Request) => (req as any).adminEmail || "unknown";

async function checkinToQuarantine(body: any, who: string) {
  const poId = int(body.po_id), itemId = int(body.item_id), skuId = int(body.sku_id), qty = int(body.qty);
  if (![poId, itemId, skuId].every((n) => Number.isInteger(n)) || !(qty > 0))
    throw new Error("po_id, item_id, sku_id and a positive qty are required.");
  const checkin = await trackerPost(`/pos/${poId}/checkin`, { lines: [{ item_id: itemId, qty }], by: who });
  await trackerPost(`/skus/${skuId}/stock`, { delta: -qty, item: "stock", note: `Quarantine — sent to lab (PO #${poId})`, by: who });
  const row = await pool.query(
    `INSERT INTO rp_quarantine (sku_id, sku_code, product_name, po_id, item_id, qty, lot, lab_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [skuId, str(body.sku_code), str(body.product_name), poId, itemId, qty, str(body.lot), str(body.lab_name), who]);
  return { ok: true, id: row.rows[0].id, remaining: checkin.remaining };
}

async function releaseQuarantine(id: number, body: any, who: string) {
  const cur = (await pool.query(`SELECT * FROM rp_quarantine WHERE id = $1`, [id])).rows[0];
  if (!cur) throw new Error("Quarantine lot not found.");
  const open = Number(cur.qty) - Number(cur.released_qty);
  const qty = Math.min(int(body.qty) || open, open);
  if (!(qty > 0)) throw new Error("Nothing left to release on this lot.");
  const result = body.result === "received" ? "received" : "approved";
  await trackerPost(`/skus/${cur.sku_id}/stock`, { delta: qty, item: "stock", note: `Released from quarantine — COA ${result}`, by: who });
  const releasedQty = Number(cur.released_qty) + qty;
  const done = releasedQty >= Number(cur.qty);
  await pool.query(
    `UPDATE rp_quarantine SET released_qty = $2, status = $3, coa_result = $4,
       released_date = CASE WHEN $5 THEN CURRENT_DATE ELSE released_date END, released_by = $6, updated_at = NOW()
     WHERE id = $1`,
    [id, releasedQty, done ? "released" : "sent_to_lab", result, done, who]);
  return { ok: true, released: qty, done };
}

export function registerRpQuarantineRoutes(app: Express) {
  app.get("/api/ops/realpeptides/inventory/quarantine", async (_req, res) => {
    try {
      await ensureTable();
      const r = await pool.query(
        `SELECT id, sku_id, sku_code, product_name, po_id, item_id, qty, released_qty, lot, lab_name,
                status, coa_result, sent_date::text, released_date::text, created_by, released_by
         FROM rp_quarantine ORDER BY (status = 'sent_to_lab') DESC, created_at DESC`);
      res.json({ quarantine: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/inventory/quarantine", async (req, res) => {
    try {
      await ensureTable();
      res.json(await checkinToQuarantine(req.body ?? {}, by(req)));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/inventory/quarantine/:id/release", async (req, res) => {
    const id = int(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad quarantine id." });
    try {
      await ensureTable();
      res.json(await releaseQuarantine(id, req.body ?? {}, by(req)));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });
}
