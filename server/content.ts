/**
 * Content library — file storage on S3 with metadata in RDS.
 *
 * Flow:
 *   1. Client POST /api/ops/content/presign with {filename, content_type, size_bytes}
 *      → server returns {key, uploadUrl} (15-min expiry)
 *   2. Client PUTs file directly to uploadUrl (browser → S3, no Express in path)
 *   3. Client POST /api/ops/content/files with {key, original_filename, ...}
 *      → server creates the ops_content_files row
 *   4. List/detail/download/delete via /api/ops/content/files/*
 *
 * Direct browser-to-S3 upload keeps multi-GB video files off our
 * Express server. Required: OPS_CONTENT_BUCKET env, AWS creds, and
 * CORS on the bucket allowing PUT from our origin.
 *
 * Required env:
 *   OPS_CONTENT_BUCKET — bucket name (e.g. fitscript-ops-content)
 *   AWS_REGION          — defaults to us-east-1
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY OR ECS task role for prod
 */
import type { Express, Request } from "express";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pool } from "./db";
import { logAdminAction } from "./lib/auditLog";

interface AdminReq extends Request {
  adminEmail?: string;
}

const BUCKET = process.env.OPS_CONTENT_BUCKET;
const REGION = process.env.AWS_REGION || "us-east-1";

// Lazy client init — never throws at import time.
let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) s3Client = new S3Client({ region: REGION });
  return s3Client;
}

function isConfigured(): { ok: boolean; reason?: string } {
  if (!BUCKET) return { ok: false, reason: "OPS_CONTENT_BUCKET env not set" };
  return { ok: true };
}

// Sanitize a filename for use in an S3 key path.
function safeFilename(name: string): string {
  return (name || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

// Single-PUT presigned uploads cap at 5 GB per S3 spec. Anything larger
// would need multipart; out of v1 scope.
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

let tableEnsured = false;
async function ensureContentTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_content_files (
      id UUID PRIMARY KEY,
      s3_key TEXT UNIQUE NOT NULL,
      original_filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes BIGINT,
      uploaded_by TEXT NOT NULL,
      uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
      project_id UUID REFERENCES ops_projects(id) ON DELETE SET NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_content_uploaded_at ON ops_content_files (uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_project ON ops_content_files (project_id);
    CREATE INDEX IF NOT EXISTS idx_content_uploader ON ops_content_files (uploaded_by);
  `);
  tableEnsured = true;
}

export function registerContentRoutes(app: Express) {
  ensureContentTable().catch((e) =>
    console.warn("[OPS][CONTENT] ensure table failed:", e.message),
  );

  // Health/config probe — used by the UI to detect "bucket not set" state.
  app.get("/api/ops/content/status", (_req, res) => {
    const cfg = isConfigured();
    res.json({
      configured: cfg.ok,
      reason: cfg.reason ?? null,
      bucket: cfg.ok ? BUCKET : null,
      region: REGION,
      max_bytes: MAX_BYTES,
    });
  });

  // Generate a presigned PUT URL for the browser to upload to.
  app.post("/api/ops/content/presign", async (req: AdminReq, res) => {
    const cfg = isConfigured();
    if (!cfg.ok) return res.status(503).json({ error: cfg.reason });
    const adminEmail = req.adminEmail || "unknown";
    const { filename, content_type, size_bytes } = req.body ?? {};
    if (!filename) return res.status(400).json({ error: "filename required" });
    const size = parseInt(String(size_bytes ?? 0));
    if (!size || size <= 0) return res.status(400).json({ error: "size_bytes required" });
    if (size > MAX_BYTES) {
      return res.status(400).json({ error: `File too large (max ${MAX_BYTES} bytes / 5 GB)` });
    }
    try {
      const id = randomUUID();
      const safe = safeFilename(filename);
      const key = `content/${id}/${safe}`;
      const cmd = new PutObjectCommand({
        Bucket: BUCKET!,
        Key: key,
        ContentType: content_type || "application/octet-stream",
        ContentLength: size,
        Metadata: {
          "uploaded-by": adminEmail,
          "original-filename": filename.slice(0, 200),
        },
      });
      const uploadUrl = await getSignedUrl(getS3(), cmd, { expiresIn: 15 * 60 });
      res.json({
        id,
        key,
        uploadUrl,
        expiresIn: 15 * 60,
        method: "PUT",
        required_headers: {
          "Content-Type": content_type || "application/octet-stream",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Record metadata for a successfully-uploaded file.
  app.post("/api/ops/content/files", async (req: AdminReq, res) => {
    try {
      await ensureContentTable();
      const adminEmail = req.adminEmail || "unknown";
      const {
        id,
        s3_key,
        original_filename,
        content_type,
        size_bytes,
        project_id,
        tags,
        description,
      } = req.body ?? {};
      if (!s3_key || !original_filename) {
        return res.status(400).json({ error: "s3_key and original_filename required" });
      }
      const finalId = id || randomUUID();
      const tagsArr = Array.isArray(tags) ? tags.slice(0, 20).map((t) => String(t).slice(0, 50)) : [];
      const r = await pool.query(
        `INSERT INTO ops_content_files
           (id, s3_key, original_filename, content_type, size_bytes, uploaded_by, project_id, tags, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          finalId,
          s3_key,
          original_filename,
          content_type || null,
          size_bytes || null,
          adminEmail,
          project_id || null,
          tagsArr,
          description?.trim() || null,
        ],
      );
      await logAdminAction({
        adminEmail,
        actionType: "content.upload",
        targetKind: "content_file",
        targetId: finalId,
        targetLabel: original_filename,
        status: "ok",
        metadata: { s3_key, size_bytes, content_type, project_id: project_id ?? null },
      });
      res.json({ file: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List files with optional filters.
  app.get("/api/ops/content/files", async (req, res) => {
    try {
      await ensureContentTable();
      const projectId = String(req.query.project_id || "").trim();
      const typePrefix = String(req.query.type || "").trim().toLowerCase();
      const q = String(req.query.q || "").trim().toLowerCase();

      const where: string[] = [];
      const params: any[] = [];

      if (projectId) {
        params.push(projectId);
        where.push(`f.project_id = $${params.length}`);
      }
      if (typePrefix && /^[a-z-]+$/.test(typePrefix)) {
        params.push(`${typePrefix}/%`);
        where.push(`lower(f.content_type) LIKE $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(lower(f.original_filename) LIKE $${params.length} OR lower(coalesce(f.description, '')) LIKE $${params.length})`);
      }

      const sql = `
        SELECT f.id, f.s3_key, f.original_filename, f.content_type, f.size_bytes,
               f.uploaded_by, f.uploaded_at, f.project_id, f.tags, f.description,
               p.name AS project_name
        FROM ops_content_files f
        LEFT JOIN ops_projects p ON p.id = f.project_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY f.uploaded_at DESC
        LIMIT 200
      `;
      const r = await pool.query(sql, params);
      res.json({ files: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // File detail with a fresh presigned download URL (15-min expiry).
  app.get("/api/ops/content/files/:id", async (req, res) => {
    try {
      await ensureContentTable();
      const cfg = isConfigured();
      const r = await pool.query(
        `SELECT f.*, p.name AS project_name
         FROM ops_content_files f
         LEFT JOIN ops_projects p ON p.id = f.project_id
         WHERE f.id = $1`,
        [req.params.id],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const file = r.rows[0];
      let downloadUrl: string | null = null;
      if (cfg.ok) {
        const cmd = new GetObjectCommand({ Bucket: BUCKET!, Key: file.s3_key });
        downloadUrl = await getSignedUrl(getS3(), cmd, { expiresIn: 15 * 60 });
      }
      res.json({ file, downloadUrl, downloadExpiresIn: 15 * 60 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update metadata (project, tags, description). Filename + S3 key are immutable.
  app.patch("/api/ops/content/files/:id", async (req: AdminReq, res) => {
    try {
      await ensureContentTable();
      const adminEmail = req.adminEmail || "unknown";
      const { project_id, tags, description } = req.body ?? {};
      const sets: string[] = [];
      const params: any[] = [];
      const changes: Record<string, unknown> = {};
      if (project_id !== undefined) {
        params.push(project_id || null);
        sets.push(`project_id = $${params.length}`);
        changes.project_id = project_id || null;
      }
      if (Array.isArray(tags)) {
        const tagsArr = tags.slice(0, 20).map((t) => String(t).slice(0, 50));
        params.push(tagsArr);
        sets.push(`tags = $${params.length}`);
        changes.tags = tagsArr;
      }
      if (description !== undefined) {
        params.push(description?.trim() || null);
        sets.push(`description = $${params.length}`);
        changes.description = description?.trim() || null;
      }
      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
      params.push(req.params.id);
      const r = await pool.query(
        `UPDATE ops_content_files SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      await logAdminAction({
        adminEmail,
        actionType: "content.update",
        targetKind: "content_file",
        targetId: req.params.id,
        targetLabel: r.rows[0].original_filename,
        status: "ok",
        metadata: { changes },
      });
      res.json({ file: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete S3 object + DB row.
  app.delete("/api/ops/content/files/:id", async (req: AdminReq, res) => {
    try {
      await ensureContentTable();
      const adminEmail = req.adminEmail || "unknown";
      const pre = await pool.query(
        `SELECT s3_key, original_filename FROM ops_content_files WHERE id = $1`,
        [req.params.id],
      );
      if (pre.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const { s3_key, original_filename } = pre.rows[0];
      // Best-effort S3 delete — if it fails (orphaned key, perms), still remove
      // the DB row so the operator can re-upload.
      let s3DeleteOk = true;
      let s3Error: string | null = null;
      const cfg = isConfigured();
      if (cfg.ok) {
        try {
          await getS3().send(new DeleteObjectCommand({ Bucket: BUCKET!, Key: s3_key }));
        } catch (e: any) {
          s3DeleteOk = false;
          s3Error = e.message;
        }
      }
      await pool.query(`DELETE FROM ops_content_files WHERE id = $1`, [req.params.id]);
      await logAdminAction({
        adminEmail,
        actionType: "content.delete",
        targetKind: "content_file",
        targetId: req.params.id,
        targetLabel: original_filename,
        status: s3DeleteOk ? "ok" : "failed",
        error: s3Error,
        metadata: { s3_key, s3_delete_ok: s3DeleteOk },
      });
      res.json({ ok: true, s3DeleteOk, s3Error });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
