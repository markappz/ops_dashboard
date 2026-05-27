/**
 * Tech ticket system — bug / UX / perf reports submitted live from
 * FitScript by users-in-experience, triaged by AI, fixed by admins
 * (or DIRT Phase 3 auto-PR).
 *
 * Schema: ops_tickets (id UUID, created_at, source_url, user_note,
 *   user_email, screenshot_s3_key, console_errors JSONB,
 *   element_selector, viewport, user_agent, status, category,
 *   severity, cluster_id, ai_summary, ai_suggested_fix, assignee_email)
 *
 * Endpoints:
 *   PUBLIC (API-key gated, outside /api/ops/* so opsGate doesn't block):
 *     POST /api/tickets/screenshot-presign — presigned S3 URL for screenshot
 *     POST /api/tickets/ingest             — submit a new report from FitScript
 *
 *   ADMIN (opsGate):
 *     GET    /api/ops/tickets                  — list with filters
 *     GET    /api/ops/tickets/:id              — detail (with screenshot URL)
 *     PATCH  /api/ops/tickets/:id              — update fields
 *     POST   /api/ops/tickets/:id/triage       — kick off AI triage (categorize + summarize)
 *     POST   /api/ops/tickets/:id/cluster      — mark as duplicate of another ticket
 *     DELETE /api/ops/tickets/:id              — hard delete
 *
 * Required env:
 *   OPS_TICKETS_API_KEY  — shared secret the FitScript app sends in
 *                          x-ops-tickets-key header on ingest
 *   OPS_CONTENT_BUCKET   — reuses the content library bucket for screenshot storage
 */
import type { Express, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { pool } from "./db";
import { logAdminAction } from "./lib/auditLog";
import { logAiCost } from "./aiCostLogger";

interface AdminReq extends Request {
  adminEmail?: string;
}

const BUCKET = process.env.OPS_CONTENT_BUCKET;
const REGION = process.env.AWS_REGION || "us-east-1";
let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) s3Client = new S3Client({ region: REGION });
  return s3Client;
}

const VALID_STATUSES = ["new", "triaged", "approved", "pr_open", "merged", "closed", "wontfix", "duplicate"] as const;
const VALID_CATEGORIES = ["bug", "ux", "performance", "feature", "question", "unknown"] as const;
const VALID_SEVERITIES = ["critical", "high", "medium", "low"] as const;

type Status = (typeof VALID_STATUSES)[number];
type Category = (typeof VALID_CATEGORIES)[number];
type Severity = (typeof VALID_SEVERITIES)[number];

function isValid<T extends readonly string[]>(arr: T, v: any): v is T[number] {
  return typeof v === "string" && (arr as readonly string[]).includes(v);
}

let tableEnsured = false;
async function ensureTicketsTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_tickets (
      id UUID PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      -- Reporter context
      source_url TEXT NOT NULL,
      user_note TEXT,
      user_email TEXT,
      screenshot_s3_key TEXT,
      console_errors JSONB,
      element_selector TEXT,
      viewport_width INT,
      viewport_height INT,
      user_agent TEXT,
      -- Triage state
      status TEXT NOT NULL DEFAULT 'new',
      category TEXT NOT NULL DEFAULT 'unknown',
      severity TEXT NOT NULL DEFAULT 'medium',
      cluster_id UUID REFERENCES ops_tickets(id) ON DELETE SET NULL,
      assignee_email TEXT,
      -- AI analysis
      ai_summary TEXT,
      ai_suggested_fix TEXT,
      ai_triaged_at TIMESTAMP,
      -- Resolution
      resolution_pr_url TEXT,
      closed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON ops_tickets (status);
    CREATE INDEX IF NOT EXISTS idx_tickets_category ON ops_tickets (category);
    CREATE INDEX IF NOT EXISTS idx_tickets_severity ON ops_tickets (severity);
    CREATE INDEX IF NOT EXISTS idx_tickets_cluster ON ops_tickets (cluster_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON ops_tickets (created_at DESC);
  `);
  tableEnsured = true;
}

// API-key middleware for the public ingest endpoint.
function requireIngestKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.OPS_TICKETS_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: "OPS_TICKETS_API_KEY not configured" });
  }
  const got = req.header("x-ops-tickets-key");
  if (!got || got !== expected) {
    return res.status(401).json({ error: "Invalid or missing x-ops-tickets-key" });
  }
  next();
}

// ─── AI triage helpers ─────────────────────────────────────────────

interface AITriageResult {
  category: Category;
  severity: Severity;
  summary: string;
  suggested_fix: string;
}

async function aiTriage(ticket: any): Promise<AITriageResult | null> {
  if (!isAIConfigured()) return null;
  const prompt = `You are triaging a bug report from a FitScript user. Categorize it and suggest a fix direction.

Report context:
- Page URL: ${ticket.source_url}
- User note: ${ticket.user_note || "(none)"}
- Element clicked (CSS): ${ticket.element_selector || "(none)"}
- Console errors: ${ticket.console_errors ? JSON.stringify(ticket.console_errors).slice(0, 800) : "(none)"}
- Viewport: ${ticket.viewport_width}x${ticket.viewport_height}
- User agent: ${(ticket.user_agent || "").slice(0, 200)}

Return ONLY JSON in this exact shape (no preamble, no markdown fences):
{
  "category": "bug" | "ux" | "performance" | "feature" | "question" | "unknown",
  "severity": "critical" | "high" | "medium" | "low",
  "summary": "<one-line summary of what's wrong, under 100 chars>",
  "suggested_fix": "<one-paragraph technical hypothesis of the root cause + suggested fix direction. Be specific: which file, which function, what to change.>"
}

Categorization rules:
- bug: something is broken / produces wrong output / throws an error
- ux: confusing flow, broken visual, dead-end, missing CTA, copy issue
- performance: slow load, lag, jank
- feature: user wants something that doesn't exist
- question: user is confused, not a system problem
- unknown: not enough info

Severity rules:
- critical: blocks core flow (signup, checkout, login broken)
- high: visible to many users, no workaround
- medium: visible but has workaround OR affects few users
- low: cosmetic, edge case, nice-to-have`;
  try {
    const r: any = await (anthropic as any).messages.create({
      model: BEDROCK_MODELS.FAST,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = r?.content?.[0]?.text ?? "";
    // Tolerant JSON parse — strip ``` fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!isValid(VALID_CATEGORIES, parsed.category)) parsed.category = "unknown";
    if (!isValid(VALID_SEVERITIES, parsed.severity)) parsed.severity = "medium";
    parsed.summary = String(parsed.summary || "").slice(0, 200);
    parsed.suggested_fix = String(parsed.suggested_fix || "").slice(0, 4000);
    logAiCost({
      userId: null,
      surface: "ops_ticket_triage",
      model: BEDROCK_MODELS.FAST,
      inputTokens: r?.usage?.input_tokens ?? 0,
      outputTokens: r?.usage?.output_tokens ?? 0,
      metadata: { ticket_id: ticket.id },
    }).catch(() => {});
    return parsed as AITriageResult;
  } catch (e) {
    console.warn("[OPS][TICKETS] AI triage failed:", (e as Error).message);
    return null;
  }
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerTicketRoutes(app: Express) {
  ensureTicketsTable().catch((e) =>
    console.warn("[OPS][TICKETS] ensure tables failed:", e.message),
  );

  // ─── PUBLIC INGEST — gated by x-ops-tickets-key, NOT by opsGate ─

  // Step 1: client requests a presigned URL to upload a screenshot.
  app.post("/api/tickets/screenshot-presign", requireIngestKey, async (req, res) => {
    if (!BUCKET) return res.status(503).json({ error: "OPS_CONTENT_BUCKET not configured" });
    const { content_type, size_bytes } = req.body ?? {};
    const size = parseInt(String(size_bytes ?? 0));
    if (!size || size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Screenshot must be 1–5,242,880 bytes" });
    }
    try {
      const key = `tickets/screenshots/${randomUUID()}.png`;
      const cmd = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: content_type || "image/png",
        ContentLength: size,
      });
      const uploadUrl = await getSignedUrl(getS3(), cmd, { expiresIn: 10 * 60 });
      res.json({ key, uploadUrl, expiresIn: 10 * 60 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Step 2: client POSTs the report metadata (after screenshot upload if any).
  app.post("/api/tickets/ingest", requireIngestKey, async (req, res) => {
    try {
      await ensureTicketsTable();
      const {
        source_url,
        user_note,
        user_email,
        screenshot_s3_key,
        console_errors,
        element_selector,
        viewport_width,
        viewport_height,
        user_agent,
      } = req.body ?? {};

      if (!source_url || typeof source_url !== "string") {
        return res.status(400).json({ error: "source_url required" });
      }
      const id = randomUUID();
      const r = await pool.query(
        `INSERT INTO ops_tickets
           (id, source_url, user_note, user_email, screenshot_s3_key, console_errors,
            element_selector, viewport_width, viewport_height, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, status, created_at`,
        [
          id,
          source_url.slice(0, 2000),
          user_note ? String(user_note).slice(0, 2000) : null,
          user_email ? String(user_email).toLowerCase().slice(0, 200) : null,
          screenshot_s3_key ? String(screenshot_s3_key).slice(0, 500) : null,
          console_errors ? JSON.stringify(console_errors).slice(0, 50000) : null,
          element_selector ? String(element_selector).slice(0, 1000) : null,
          viewport_width ? parseInt(viewport_width) : null,
          viewport_height ? parseInt(viewport_height) : null,
          user_agent ? String(user_agent).slice(0, 500) : null,
        ],
      );
      const ticket = r.rows[0];
      // Fire-and-forget AI triage so the ingest endpoint stays fast (<500ms).
      void (async () => {
        try {
          const fullRow = await pool.query(`SELECT * FROM ops_tickets WHERE id = $1`, [id]);
          const result = await aiTriage(fullRow.rows[0]);
          if (result) {
            await pool.query(
              `UPDATE ops_tickets
               SET category = $1, severity = $2, ai_summary = $3, ai_suggested_fix = $4,
                   ai_triaged_at = NOW(), status = CASE WHEN status = 'new' THEN 'triaged' ELSE status END,
                   updated_at = NOW()
               WHERE id = $5`,
              [result.category, result.severity, result.summary, result.suggested_fix, id],
            );
          }
        } catch (e) {
          console.warn(`[OPS][TICKETS] background triage failed for ${id}:`, (e as Error).message);
        }
      })();
      res.json({ ok: true, id: ticket.id, status: ticket.status, created_at: ticket.created_at });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── ADMIN routes (under opsGate) ────────────────────────────────

  app.get("/api/ops/tickets", async (req, res) => {
    try {
      await ensureTicketsTable();
      const where: string[] = [];
      const params: any[] = [];
      const status = String(req.query.status || "");
      const category = String(req.query.category || "");
      const severity = String(req.query.severity || "");
      const hideDups = req.query.hide_duplicates !== "false";

      if (isValid(VALID_STATUSES, status)) { params.push(status); where.push(`t.status = $${params.length}`); }
      if (isValid(VALID_CATEGORIES, category)) { params.push(category); where.push(`t.category = $${params.length}`); }
      if (isValid(VALID_SEVERITIES, severity)) { params.push(severity); where.push(`t.severity = $${params.length}`); }
      if (hideDups) where.push(`t.cluster_id IS NULL`);

      const sql = `
        SELECT t.id, t.source_url, t.user_note, t.user_email, t.screenshot_s3_key,
               t.element_selector, t.status, t.category, t.severity, t.cluster_id,
               t.ai_summary, t.ai_triaged_at, t.assignee_email, t.created_at, t.updated_at,
               (SELECT COUNT(*)::int FROM ops_tickets d WHERE d.cluster_id = t.id) AS duplicate_count
        FROM ops_tickets t
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY
          CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
          t.created_at DESC
        LIMIT 200
      `;
      const r = await pool.query(sql, params);
      // Status counts for filter badges
      const counts = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM ops_tickets WHERE cluster_id IS NULL GROUP BY status`,
      );
      const statusCounts: Record<string, number> = {};
      for (const row of counts.rows) statusCounts[row.status] = row.n;
      res.json({ tickets: r.rows, status_counts: statusCounts });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/tickets/:id", async (req, res) => {
    try {
      await ensureTicketsTable();
      const r = await pool.query(`SELECT * FROM ops_tickets WHERE id = $1`, [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const ticket = r.rows[0];
      let screenshotUrl: string | null = null;
      if (ticket.screenshot_s3_key && BUCKET) {
        try {
          const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: ticket.screenshot_s3_key });
          screenshotUrl = await getSignedUrl(getS3(), cmd, { expiresIn: 15 * 60 });
        } catch { /* fall through with null */ }
      }
      // Also fetch the cluster's duplicates if this is the canonical
      const dups = await pool.query(
        `SELECT id, user_note, user_email, ai_summary, created_at FROM ops_tickets WHERE cluster_id = $1 ORDER BY created_at DESC`,
        [ticket.id],
      );
      res.json({ ticket, screenshotUrl, screenshotExpiresIn: 15 * 60, duplicates: dups.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/tickets/:id", async (req: AdminReq, res) => {
    try {
      await ensureTicketsTable();
      const adminEmail = req.adminEmail || "unknown";
      const b = req.body ?? {};
      const sets: string[] = [];
      const params: any[] = [];
      const changes: Record<string, unknown> = {};
      if (b.status !== undefined) {
        if (!isValid(VALID_STATUSES, b.status)) return res.status(400).json({ error: "invalid status" });
        params.push(b.status); sets.push(`status = $${params.length}`); changes.status = b.status;
        if (b.status === "closed" || b.status === "wontfix" || b.status === "merged") {
          sets.push("closed_at = COALESCE(closed_at, NOW())");
        }
      }
      if (b.category !== undefined) {
        if (!isValid(VALID_CATEGORIES, b.category)) return res.status(400).json({ error: "invalid category" });
        params.push(b.category); sets.push(`category = $${params.length}`); changes.category = b.category;
      }
      if (b.severity !== undefined) {
        if (!isValid(VALID_SEVERITIES, b.severity)) return res.status(400).json({ error: "invalid severity" });
        params.push(b.severity); sets.push(`severity = $${params.length}`); changes.severity = b.severity;
      }
      if (b.assignee_email !== undefined) {
        const ae = b.assignee_email ? String(b.assignee_email).toLowerCase() : null;
        params.push(ae); sets.push(`assignee_email = $${params.length}`); changes.assignee_email = ae;
      }
      if (b.resolution_pr_url !== undefined) {
        params.push(b.resolution_pr_url || null); sets.push(`resolution_pr_url = $${params.length}`);
        changes.resolution_pr_url = b.resolution_pr_url || null;
      }
      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
      sets.push("updated_at = NOW()");
      params.push(req.params.id);
      const r = await pool.query(
        `UPDATE ops_tickets SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      await logAdminAction({
        adminEmail,
        actionType: "ticket.update",
        targetKind: "ops_ticket",
        targetId: req.params.id,
        targetLabel: r.rows[0].ai_summary || r.rows[0].source_url,
        status: "ok",
        metadata: { changes },
      });
      res.json({ ticket: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual re-triage (re-run AI categorization).
  app.post("/api/ops/tickets/:id/triage", async (req: AdminReq, res) => {
    try {
      await ensureTicketsTable();
      const r = await pool.query(`SELECT * FROM ops_tickets WHERE id = $1`, [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      const result = await aiTriage(r.rows[0]);
      if (!result) return res.status(503).json({ error: "AI triage unavailable" });
      const upd = await pool.query(
        `UPDATE ops_tickets
         SET category = $1, severity = $2, ai_summary = $3, ai_suggested_fix = $4,
             ai_triaged_at = NOW(), updated_at = NOW(),
             status = CASE WHEN status = 'new' THEN 'triaged' ELSE status END
         WHERE id = $5 RETURNING *`,
        [result.category, result.severity, result.summary, result.suggested_fix, req.params.id],
      );
      res.json({ ticket: upd.rows[0], ai: result });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Cluster a ticket as a duplicate of another.
  app.post("/api/ops/tickets/:id/cluster", async (req: AdminReq, res) => {
    try {
      await ensureTicketsTable();
      const adminEmail = req.adminEmail || "unknown";
      const targetId = String(req.body?.canonical_id || "").trim();
      if (!targetId) return res.status(400).json({ error: "canonical_id required" });
      if (targetId === req.params.id) return res.status(400).json({ error: "Cannot cluster a ticket with itself" });
      // Confirm canonical exists
      const t = await pool.query(`SELECT id FROM ops_tickets WHERE id = $1`, [targetId]);
      if (t.rows.length === 0) return res.status(400).json({ error: "canonical_id ticket not found" });
      // Refuse to cluster onto a ticket that's already a duplicate (no chains).
      const head = await pool.query(`SELECT cluster_id FROM ops_tickets WHERE id = $1`, [targetId]);
      if (head.rows[0]?.cluster_id) return res.status(400).json({ error: "Target ticket is itself a duplicate — cluster onto its canonical instead" });
      const upd = await pool.query(
        `UPDATE ops_tickets SET cluster_id = $1, status = 'duplicate', updated_at = NOW()
         WHERE id = $2 RETURNING id`,
        [targetId, req.params.id],
      );
      if (upd.rows.length === 0) return res.status(404).json({ error: "Not found" });
      await logAdminAction({
        adminEmail,
        actionType: "ticket.cluster",
        targetKind: "ops_ticket",
        targetId: req.params.id,
        targetLabel: `→ ${targetId}`,
        status: "ok",
        metadata: { canonical_id: targetId },
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/tickets/:id", async (req: AdminReq, res) => {
    try {
      await ensureTicketsTable();
      const adminEmail = req.adminEmail || "unknown";
      const r = await pool.query(`DELETE FROM ops_tickets WHERE id = $1 RETURNING ai_summary, source_url`, [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      await logAdminAction({
        adminEmail,
        actionType: "ticket.delete",
        targetKind: "ops_ticket",
        targetId: req.params.id,
        targetLabel: r.rows[0].ai_summary || r.rows[0].source_url,
        status: "ok",
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
