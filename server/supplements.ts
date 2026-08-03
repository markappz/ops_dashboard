/**
 * Supplements admin — ops dashboard surface for the FitScript supplement
 * catalog. Reads/edits supplement_catalog directly on the shared RDS, and
 * triggers FitScript's internal endpoints for anything that needs FitScript's
 * own logic (the Fullscript API + sharp image normalization, which this repo
 * doesn't have). Raw SQL only (Drizzle crashes in this repo — see DECISIONS.md).
 */
import type { Express } from "express";
import multer from "multer";
import { pool } from "./db";

const FITSCRIPT_URL = process.env.FITSCRIPT_INTERNAL_URL || "https://fitscript.me";
const OPS_KEY = process.env.OPS_TICKETS_API_KEY || "";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function callFitscript(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${FITSCRIPT_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-key": OPS_KEY },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function getFitscript(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${FITSCRIPT_URL}${path}`, { headers: { "x-ops-key": OPS_KEY } });
  const text = await r.text();
  let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

const COLS = `id, fulfillment_sku, display_name, brand, image_url, msrp_cents, availability, active, atlas_selected, evidence_tier, category_ids, sort_order`;

export function registerSupplementsRoutes(app: Express) {
  // ── Catalog (direct DB) ───────────────────────────────────────────────────
  app.get("/api/ops/supplements", async (req, res) => {
    try {
      const q = ((req.query.q as string) || "").trim().toLowerCase();
      const limit = Math.min(parseInt(String(req.query.limit ?? "300"), 10) || 300, 500);
      const r = q
        ? await pool.query(
            `SELECT ${COLS} FROM supplement_catalog
              WHERE LOWER(display_name) LIKE $1 OR LOWER(COALESCE(brand,'')) LIKE $1 OR LOWER(COALESCE(fulfillment_sku,'')) LIKE $1
              ORDER BY sort_order NULLS LAST, display_name LIMIT $2`, [`%${q}%`, limit])
        : await pool.query(`SELECT ${COLS} FROM supplement_catalog ORDER BY sort_order NULLS LAST, display_name LIMIT $1`, [limit]);
      const t = await pool.query(
        `SELECT count(*)::int c, count(*) FILTER (WHERE image_url LIKE '/uploads/supplement-images/%')::int hosted FROM supplement_catalog`);
      res.json({ items: r.rows, total: t.rows[0].c, hosted: t.rows[0].hosted });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Single product — full row (all pricing / info / curation / Fullscript refs) ─
  app.get("/api/ops/supplements/:id", async (req, res) => {
    try {
      const r = await pool.query(`SELECT * FROM supplement_catalog WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ item: r.rows[0] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Curation (direct DB). Pricing/description come from Fullscript (read-only). ─
  app.patch("/api/ops/supplements/:id", async (req, res) => {
    try {
      const sets: string[] = []; const vals: any[] = [req.params.id]; let i = 2;
      for (const key of ["active", "atlas_selected", "sort_order", "evidence_tier", "why_this_one", "primary_benefit", "typical_dose"] as const) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${i++}`); vals.push(req.body[key]); }
      }
      for (const key of ["biomarker_targets", "certifications"] as const) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${i++}::jsonb`); vals.push(JSON.stringify(req.body[key])); }
      }
      if (!sets.length) { res.status(400).json({ error: "No updatable fields" }); return; }
      await pool.query(`UPDATE supplement_catalog SET ${sets.join(", ")} WHERE id = $1`, vals);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Sync from Fullscript (proxy → FitScript; inserts new + updates + hosts) ─
  app.post("/api/ops/supplements/sync", async (req, res) => {
    try {
      const env = req.body?.env === "production" ? "production" : undefined;
      const { status, json } = await callFitscript("/api/internal/supplements/sync", env ? { env } : {});
      if (status >= 300) { res.status(502).json({ error: json.error || "sync failed" }); return; }
      res.json(json);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // ── Bulk image host/normalize (proxy → FitScript) ─────────────────────────
  app.post("/api/ops/supplements/rehost-images", async (req, res) => {
    try {
      const { status, json } = await callFitscript(
        `/api/internal/supplements/rehost-images${req.query.force === "true" ? "?force=true" : ""}`, {});
      res.status(status >= 300 ? 502 : 200).json(json);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/ops/supplements/rehost-status", async (_req, res) => {
    try {
      const { status, json } = await getFitscript("/api/internal/supplements/rehost-status");
      res.status(status >= 300 ? 502 : 200).json(json);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // ── Manual per-SKU image replace — forward the file to FitScript (sharp lives there) ─
  app.post("/api/ops/supplements/:id/image", upload.single("image"), async (req: any, res) => {
    try {
      if (!req.file?.buffer) { res.status(400).json({ error: "No image uploaded" }); return; }
      const fd = new FormData();
      fd.append("image", new Blob([req.file.buffer], { type: req.file.mimetype || "image/png" }), req.file.originalname || "upload.png");
      const r = await fetch(`${FITSCRIPT_URL}/api/internal/supplements/${req.params.id}/image`, {
        method: "POST", headers: { "x-ops-key": OPS_KEY }, body: fd as any,
      });
      const text = await r.text();
      let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      res.status(r.status >= 300 ? 502 : 200).json(json);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
}
