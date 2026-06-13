/**
 * Labs admin — ops dashboard surface for managing FitScript lab tests.
 * Reads the shared RDS (catalog cache, mappings, orders) and triggers
 * FitScript's internal endpoints for anything that must touch Junction
 * (catalog sync, per-order refresh) so FitScript stays the single Junction owner.
 * Raw SQL only (Drizzle crashes in this repo — see DECISIONS.md).
 */
import type { Express } from "express";
import { randomUUID } from "crypto";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pool } from "./db";

const FITSCRIPT_URL = process.env.FITSCRIPT_INTERNAL_URL || "https://fitscript.me";
const OPS_KEY = process.env.OPS_TICKETS_API_KEY || "";
const BUCKET = process.env.OPS_CONTENT_BUCKET;
const REGION = process.env.AWS_REGION || "us-east-1";
let _s3: S3Client | null = null;
const s3 = () => (_s3 ??= new S3Client({ region: REGION }));
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

export function registerLabsRoutes(app: Express) {
  // ── Catalog (cached Junction lab tests) ──────────────────────────────────
  app.get("/api/ops/labs/catalog", async (req, res) => {
    try {
      const env = (req.query.env as string) || "sandbox";
      const r = await pool.query(
        `SELECT junction_lab_test_id, slug, name, sample_type, method, price_cents,
                is_active, status, fasting, lab_name, marker_count,
                common_tat_days, worst_case_tat_days, synced_at
           FROM junction_lab_catalog WHERE env=$1 ORDER BY name`, [env]);
      res.json({ env, tests: r.rows, lastSynced: r.rows[0]?.synced_at ?? null });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ops/labs/catalog/sync", async (req, res) => {
    try {
      const env = req.body?.env === "production" ? "production" : "sandbox";
      const { status, json } = await callFitscript("/api/internal/labs/catalog-sync", { env });
      if (status >= 300) return res.status(502).json({ error: json.error || "sync failed" });
      res.json(json);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // ── Lab Test Builder (create custom Junction lab tests) ──────────────────
  app.get("/api/ops/labs/junction-labs", async (_req, res) => {
    const { status, json } = await getFitscript("/api/internal/labs/labs");
    if (status >= 300) return res.status(502).json({ error: json.error || "failed" });
    res.json(json);
  });

  app.get("/api/ops/labs/markers", async (req, res) => {
    const qs = new URLSearchParams();
    for (const k of ["name", "labId", "page", "size"]) if (req.query[k]) qs.set(k, String(req.query[k]));
    const { status, json } = await getFitscript(`/api/internal/labs/markers?${qs.toString()}`);
    if (status >= 300) return res.status(502).json({ error: json.error || "failed" });
    res.json(json);
  });

  app.post("/api/ops/labs/lab-tests", async (req, res) => {
    const { status, json } = await callFitscript("/api/internal/labs/lab-tests", req.body);
    if (status >= 300) return res.status(502).json({ error: json.error || "create failed" });
    res.json(json);
  });

  // ── Mappings (panel ↔ Junction test) — direct shared-table writes ────────
  app.get("/api/ops/labs/mappings", async (req, res) => {
    try {
      const env = (req.query.env as string) || null;
      const r = await pool.query(
        `SELECT m.id, m.panel_slug, m.env, m.collection_method, m.junction_lab_test_id,
                m.enabled, m.approval_status, m.notes, m.updated_at,
                m.display_name, m.subtitle, m.description, m.image_url, m.price_cents,
                c.name AS test_name, c.status AS test_status, c.price_cents AS test_price_cents
           FROM lab_test_mappings m
           LEFT JOIN junction_lab_catalog c
             ON c.junction_lab_test_id = m.junction_lab_test_id AND c.env = m.env
           ${env ? "WHERE m.env=$1" : ""}
           ORDER BY m.panel_slug, m.collection_method`,
        env ? [env] : []);
      res.json({ mappings: r.rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Single mapping (for the full-page editor).
  app.get("/api/ops/labs/mappings/:id", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT m.*, c.name AS test_name, c.price_cents AS test_price_cents
           FROM lab_test_mappings m
           LEFT JOIN junction_lab_catalog c ON c.junction_lab_test_id=m.junction_lab_test_id AND c.env=m.env
          WHERE m.id=$1`, [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: "mapping not found" });
      res.json({ mapping: r.rows[0] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Edit a mapping — enable/disable, repoint the Junction test, change method,
  // or override display name / image / price. Only provided fields change.
  app.patch("/api/ops/labs/mappings/:id", async (req, res) => {
    try {
      const b = req.body || {};
      const sets: string[] = []; const vals: any[] = [];
      const put = (col: string, val: any) => { sets.push(`${col}=$${sets.length + 1}`); vals.push(val); };
      if (typeof b.enabled === "boolean") put("enabled", b.enabled);
      if (typeof b.notes === "string") put("notes", b.notes);
      if (typeof b.junctionLabTestId === "string" && b.junctionLabTestId) put("junction_lab_test_id", b.junctionLabTestId);
      if (typeof b.collectionMethod === "string" && b.collectionMethod) put("collection_method", b.collectionMethod);
      if ("displayName" in b) put("display_name", b.displayName || null);
      if ("subtitle" in b) put("subtitle", b.subtitle || null);
      if ("description" in b) put("description", b.description || null);
      if ("imageUrl" in b) put("image_url", b.imageUrl || null);
      if ("priceCents" in b) put("price_cents", b.priceCents == null || b.priceCents === "" ? null : Math.round(Number(b.priceCents)));
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      sets.push(`updated_at=now()`);
      vals.push(req.params.id);
      const r = await pool.query(
        `UPDATE lab_test_mappings SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`, vals);
      if (!r.rowCount) return res.status(404).json({ error: "mapping not found" });
      res.json({ ok: true, mapping: r.rows[0] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Create a mapping (panel_slug + method + a catalog test).
  app.post("/api/ops/labs/mappings", async (req, res) => {
    try {
      const { panelSlug, env, collectionMethod, junctionLabTestId, enabled, notes, displayName, subtitle, description, imageUrl, priceCents } = req.body || {};
      if (!panelSlug || !env || !collectionMethod || !junctionLabTestId) {
        return res.status(400).json({ error: "panelSlug, env, collectionMethod, junctionLabTestId required" });
      }
      const r = await pool.query(
        `INSERT INTO lab_test_mappings (panel_slug, env, collection_method, junction_lab_test_id, enabled, notes, display_name, subtitle, description, image_url, price_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [panelSlug, env, collectionMethod, junctionLabTestId, enabled ?? false, notes ?? null,
         displayName || null, subtitle || null, description || null, imageUrl || null, priceCents == null || priceCents === "" ? null : Math.round(Number(priceCents))]);
      res.json({ ok: true, mapping: r.rows[0] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Panel image upload (S3) ──────────────────────────────────────────────
  // Upload a panel image to the ops content bucket; returns an ops-proxied URL
  // stored on the mapping. Served back via the signed-redirect route below.
  app.post("/api/ops/labs/upload-image", upload.single("file"), async (req: any, res) => {
    try {
      if (!BUCKET) return res.status(503).json({ error: "OPS_CONTENT_BUCKET not set" });
      const file = req.file;
      if (!file) return res.status(400).json({ error: "no file" });
      if (!/^image\//.test(file.mimetype)) return res.status(400).json({ error: "must be an image" });
      const ext = (file.originalname.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const key = `labs/${randomUUID()}.${ext}`;
      await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: file.mimetype }));
      res.json({ ok: true, url: `/api/ops/labs/image/${encodeURIComponent(key)}`, key });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Serve an uploaded panel image via a short-lived signed redirect (private bucket).
  app.get("/api/ops/labs/image/:key", async (req, res) => {
    try {
      if (!BUCKET) return res.status(503).end();
      const key = decodeURIComponent(req.params.key);
      const url = await getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
      res.redirect(url);
    } catch (e: any) { res.status(404).end(); }
  });

  // ── Panels (DB-backed product catalog CMS — content only, NO PHI) ────────
  app.get("/api/ops/labs/panels", async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT slug, name, subtitle, short_description, price_cents, markers_count,
                panel_type, category, tag, popular, image_url, is_active, sort_order, updated_at
           FROM lab_panels ORDER BY sort_order, name`);
      res.json({ panels: r.rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/ops/labs/panels/:slug", async (req, res) => {
    try {
      const r = await pool.query(`SELECT * FROM lab_panels WHERE slug=$1`, [req.params.slug]);
      if (!r.rowCount) return res.status(404).json({ error: "panel not found" });
      res.json({ panel: r.rows[0] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  const PANEL_SCALARS: Record<string, string> = {
    name: "name", subtitle: "subtitle", description: "description", shortDescription: "short_description",
    priceCents: "price_cents", markersCount: "markers_count", turnaround: "turnaround",
    fasting: "fasting", fastingHours: "fasting_hours", popular: "popular", tag: "tag",
    panelType: "panel_type", category: "category", hsaFsaEligible: "hsa_fsa_eligible",
    icon: "icon", imageUrl: "image_url", isActive: "is_active", sortOrder: "sort_order",
  };
  const PANEL_JSON: Record<string, string> = {
    benefits: "benefits", categories: "categories", bestFor: "best_for",
    relatedTreatments: "related_treatments", faqs: "faqs",
  };

  async function notifyFitscriptRefresh() {
    await callFitscript("/api/internal/labs/refresh-panels", {}).catch(() => {});
  }

  app.patch("/api/ops/labs/panels/:slug", async (req, res) => {
    try {
      const b = req.body || {};
      const sets: string[] = []; const vals: any[] = [];
      for (const [k, col] of Object.entries(PANEL_SCALARS)) {
        if (k in b) { sets.push(`${col}=$${sets.length + 1}`); vals.push(b[k] === "" ? null : b[k]); }
      }
      for (const [k, col] of Object.entries(PANEL_JSON)) {
        if (k in b) { sets.push(`${col}=$${sets.length + 1}::jsonb`); vals.push(JSON.stringify(b[k] ?? null)); }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      sets.push(`updated_at=now()`);
      vals.push(req.params.slug);
      const r = await pool.query(`UPDATE lab_panels SET ${sets.join(", ")} WHERE slug=$${vals.length} RETURNING slug`, vals);
      if (!r.rowCount) return res.status(404).json({ error: "panel not found" });
      await notifyFitscriptRefresh();
      res.json({ ok: true, slug: r.rows[0].slug });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ops/labs/panels", async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.slug || !b.name) return res.status(400).json({ error: "slug + name required" });
      await pool.query(
        `INSERT INTO lab_panels (slug, name, subtitle, description, short_description, price_cents, panel_type, is_active, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true, COALESCE((SELECT max(sort_order)+1 FROM lab_panels),0))`,
        [b.slug, b.name, b.subtitle ?? null, b.description ?? null, b.shortDescription ?? null,
         b.priceCents == null ? null : Math.round(Number(b.priceCents)), b.panelType ?? "specialty"]);
      await notifyFitscriptRefresh();
      res.json({ ok: true, slug: b.slug });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Orders (live status from shared RDS) ─────────────────────────────────
  app.get("/api/ops/labs/orders", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt((req.query.limit as string) || "100"), 500);
      const params: any[] = [];
      let where = `WHERE o.junction_order_id IS NOT NULL`;
      if (status) { params.push(status); where += ` AND o.status=$${params.length}`; }
      params.push(limit);
      const r = await pool.query(
        `SELECT o.id, o.user_id, u.email AS user_email, o.panel_name, o.panel_slug,
                o.collection_method, o.status, o.low_level_status, o.junction_env,
                o.fulfillment_mode, o.price_cents, o.created_at, o.paid_at, o.last_event_at,
                o.requisition_url IS NOT NULL AS has_requisition,
                o.results_pdf_key IS NOT NULL AS has_results_pdf
           FROM lab_orders o LEFT JOIN users u ON u.id = o.user_id
           ${where} ORDER BY o.created_at DESC LIMIT $${params.length}`, params);
      res.json({ orders: r.rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/ops/labs/orders/:id", async (req, res) => {
    try {
      const [o, bm, ev] = await Promise.all([
        pool.query(`SELECT o.*, u.email AS user_email FROM lab_orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1`, [req.params.id]),
        pool.query(`SELECT biomarker_name, value, unit, status FROM biomarker_results WHERE lab_order_id=$1 ORDER BY biomarker_name`, [req.params.id]),
        pool.query(`SELECT event_type, message, created_at FROM lab_order_events WHERE lab_order_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]),
      ]);
      if (!o.rowCount) return res.status(404).json({ error: "order not found" });
      res.json({ order: o.rows[0], biomarkers: bm.rows, events: ev.rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Stream a stored lab document (results or requisition PDF) through
  // FitScript's ops-keyed internal endpoint — FitScript owns the private bucket.
  app.get("/api/ops/labs/orders/:id/:doc.pdf", async (req, res) => {
    const doc = req.params.doc;
    if (doc !== "results" && doc !== "requisition") return res.status(400).json({ error: "doc must be results or requisition" });
    try {
      const r = await fetch(`${FITSCRIPT_URL}/api/internal/labs/orders/${req.params.id}/${doc}.pdf`, {
        headers: { "x-ops-key": OPS_KEY },
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return res.status(r.status).json({ error: txt || `${doc} PDF unavailable` });
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${doc}-${req.params.id}.pdf"`);
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Refresh / refund / cancel one order (via FitScript — single owner).
  for (const action of ["refresh", "refund", "cancel"]) {
    app.post(`/api/ops/labs/orders/:id/${action}`, async (req, res) => {
      try {
        const { status, json } = await callFitscript(`/api/internal/labs/orders/${req.params.id}/${action}`, {});
        if (status >= 300) return res.status(502).json({ error: json.error || `${action} failed` });
        res.json(json);
      } catch (e: any) { res.status(502).json({ error: e.message }); }
    });
  }
}
