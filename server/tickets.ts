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

const VALID_STATUSES = ["new", "triaged", "approved", "pr_open", "pr_implemented", "merged", "closed", "wontfix", "duplicate"] as const;
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

  // ─── Phase 3: AI auto-fix via PR ───────────────────────────────
  //
  // POST /api/ops/tickets/:id/open-fix-pr
  // Generates a structured fix proposal via Claude, then opens a real
  // PR on the FitScript repo with the proposal as a markdown file.
  // Human reviewer writes the actual code change on that branch.
  //
  // Required env:
  //   GITHUB_PAT_FITSCRIPT_FIX  — fine-grained PAT, contents:write +
  //                               pull-requests:write on markappz/Humn-Health
  //   GITHUB_REPO_OWNER         — default "markappz"
  //   GITHUB_REPO_NAME          — default "Humn-Health"
  //   GITHUB_BASE_BRANCH        — default "main"
  app.post("/api/ops/tickets/:id/open-fix-pr", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const ticketId = req.params.id;
    const pat = process.env.GITHUB_PAT_FITSCRIPT_FIX;
    const owner = process.env.GITHUB_REPO_OWNER || "markappz";
    const repo = process.env.GITHUB_REPO_NAME || "Humn-Health";
    const baseBranch = process.env.GITHUB_BASE_BRANCH || "main";

    if (!pat) return res.status(503).json({ error: "GITHUB_PAT_FITSCRIPT_FIX not configured" });
    if (!isAIConfigured()) return res.status(503).json({ error: "AI not configured" });

    try {
      await ensureTicketsTable();
      const tRes = await pool.query(`SELECT * FROM ops_tickets WHERE id = $1`, [ticketId]);
      if (tRes.rows.length === 0) return res.status(404).json({ error: "Ticket not found" });
      const ticket = tRes.rows[0];
      if (ticket.resolution_pr_url) {
        return res.status(400).json({ error: `Ticket already has a PR: ${ticket.resolution_pr_url}` });
      }

      // ── 1. Generate fix proposal via Claude ──
      const proposalPrompt = `You are a senior FitScript engineer. A bug report came in. Write a fix proposal a teammate can act on.

Ticket:
- URL: ${ticket.source_url}
- User note: ${ticket.user_note || "(none)"}
- Element CSS: ${ticket.element_selector || "(none)"}
- Console errors: ${ticket.console_errors ? JSON.stringify(ticket.console_errors).slice(0, 600) : "(none)"}
- Category: ${ticket.category}
- Severity: ${ticket.severity}
- AI summary (from initial triage): ${ticket.ai_summary || "(none)"}
- AI suggested-fix (from initial triage): ${ticket.ai_suggested_fix || "(none)"}

FitScript repo high-level structure:
- client/src/                 — React 18 + Tailwind + wouter (TS)
  - App.tsx                   — routes + providers
  - pages/                    — 65 route components
  - components/dashboard/     — body map, daily protocol, atlas card
  - components/labs/          — lab result components
  - components/ui/            — Shadcn primitives
  - lib/rating-system.ts      — Health Score calculation
  - hooks/                    — useAuth etc.
- server/
  - routes.ts                 — ALL 116 API endpoints (7000+ lines)
  - storage.ts                — DatabaseStorage CRUD
  - services/                 — protocol-engine, biomarker-knowledge, etc.
- shared/schema.ts            — Drizzle schema (60 tables)

Return ONLY JSON in this exact shape, no preamble, no markdown fences:
{
  "pr_title": "<one-line title under 72 chars, conventional-commits style>",
  "branch_name": "<kebab-case, prefix with fix/ for bugs, ux/ for UX, perf/ for performance, e.g. fix/labs-order-button-disabled>",
  "target_files": ["<best-guess file path>", ...],
  "diagnosis": "<2-3 paragraph technical analysis: what's failing, why, what to verify>",
  "proposed_change": "<step-by-step description of the code change, with file paths and pseudo-code or unified-diff style snippets if helpful>",
  "test_plan": "<how the reviewer should verify the fix>",
  "open_questions": "<list any uncertainties that the human needs to resolve before writing the code, or empty string>"
}

Rules:
- Be specific. Name actual likely file paths (e.g. client/src/pages/labs.tsx, server/routes.ts:5234).
- If the issue is ambiguous, populate open_questions and keep proposed_change conservative.
- target_files should be 1-4 likely files, not a wholesale list.
- Do NOT write fabricated file content. Describe the change; the human writes it.`;

      let proposal: any;
      try {
        const r: any = await (anthropic as any).messages.create({
          model: BEDROCK_MODELS.HIGH_IQ,
          max_tokens: 2000,
          messages: [{ role: "user", content: proposalPrompt }],
        });
        const text = r?.content?.[0]?.text ?? "";
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        proposal = JSON.parse(cleaned);
        logAiCost({
          userId: null,
          surface: "ops_ticket_fix_proposal",
          model: BEDROCK_MODELS.HIGH_IQ,
          inputTokens: r?.usage?.input_tokens ?? 0,
          outputTokens: r?.usage?.output_tokens ?? 0,
          metadata: { ticket_id: ticketId },
        }).catch(() => {});
      } catch (e: any) {
        return res.status(500).json({ error: `AI proposal generation failed: ${e.message}` });
      }

      const safeBranch = String(proposal.branch_name || `fix/ticket-${ticketId.slice(0, 8)}`)
        .toLowerCase().replace(/[^a-z0-9/_-]/g, "-").slice(0, 80);
      const prTitle = String(proposal.pr_title || `Fix: ${ticket.ai_summary || ticketId}`).slice(0, 200);

      // ── 2. GitHub API: branch → file → PR ──
      const gh = async (path: string, init: RequestInit = {}) => {
        const r = await fetch(`https://api.github.com${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            ...(init.headers || {}),
          },
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = (json as any)?.message || `GitHub ${r.status}`;
          throw new Error(`GitHub: ${msg}`);
        }
        return json;
      };

      // 2a. Look up the base branch's HEAD SHA
      const baseRef: any = await gh(`/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
      const baseSha = baseRef.object?.sha;
      if (!baseSha) throw new Error(`Could not resolve ${baseBranch} HEAD SHA`);

      // 2b. Create new branch from base
      try {
        await gh(`/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${safeBranch}`, sha: baseSha }),
        });
      } catch (e: any) {
        // 422 means branch already exists — that's fine, we'll commit on top of it
        if (!String(e.message).includes("Reference already exists")) throw e;
      }

      // 2c. Write FIX_PROPOSAL.md with the AI plan
      const proposalMd = [
        `# Fix proposal — ticket ${ticketId}`,
        ``,
        `**Source URL:** ${ticket.source_url}`,
        `**Reporter note:** ${ticket.user_note || "(none)"}`,
        `**Category:** ${ticket.category} · **Severity:** ${ticket.severity}`,
        ``,
        `## Diagnosis`,
        proposal.diagnosis || "(none)",
        ``,
        `## Target files`,
        ...(Array.isArray(proposal.target_files) ? proposal.target_files.map((f: string) => `- \`${f}\``) : ["(none specified)"]),
        ``,
        `## Proposed change`,
        proposal.proposed_change || "(none)",
        ``,
        `## Test plan`,
        proposal.test_plan || "(none)",
        ``,
        `## Open questions`,
        proposal.open_questions || "(none)",
        ``,
        `---`,
        `_Generated by ops.fitscript.me ticket triage. Reviewer: write the actual code on this branch, push, and request review._`,
      ].join("\n");

      const fixFilePath = `.ops/fix-proposals/ticket-${ticketId.slice(0, 8)}.md`;
      await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(fixFilePath)}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `chore(tickets): proposal for ${ticketId.slice(0, 8)} — ${prTitle.slice(0, 60)}`,
          content: Buffer.from(proposalMd, "utf8").toString("base64"),
          branch: safeBranch,
        }),
      });

      // 2d. Open the PR
      const prBody = [
        `**Ticket:** \`${ticketId}\``,
        `**Status:** Fix proposal generated by ops.fitscript.me ticket triage.`,
        ``,
        `## Diagnosis`,
        proposal.diagnosis || "(none)",
        ``,
        `## Proposed change`,
        proposal.proposed_change || "(none)",
        ``,
        `## Target files`,
        ...(Array.isArray(proposal.target_files) ? proposal.target_files.map((f: string) => `- \`${f}\``) : ["(none)"]),
        ``,
        `## Test plan`,
        proposal.test_plan || "(none)",
        ``,
        proposal.open_questions ? `## Open questions\n${proposal.open_questions}` : "",
        ``,
        `---`,
        `🤖 Generated from [ops ticket ${ticketId.slice(0, 8)}](https://ops.fitscript.me/tickets) · approved by ${adminEmail}`,
      ].join("\n");

      const pr: any = await gh(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: prTitle,
          head: safeBranch,
          base: baseBranch,
          body: prBody,
          draft: true, // Open as DRAFT so it doesn't trigger auto-merge or notifications
        }),
      });

      const prUrl = pr.html_url;
      const prNumber = pr.number;

      // ── 3. Update ticket: status pr_open + PR URL ──
      await pool.query(
        `UPDATE ops_tickets SET status = 'pr_open', resolution_pr_url = $1, updated_at = NOW()
         WHERE id = $2`,
        [prUrl, ticketId],
      );

      await logAdminAction({
        adminEmail,
        actionType: "ticket.open_fix_pr",
        targetKind: "ops_ticket",
        targetId: ticketId,
        targetLabel: prTitle,
        status: "ok",
        metadata: { pr_url: prUrl, pr_number: prNumber, branch: safeBranch, target_files: proposal.target_files },
      });

      res.json({
        ok: true,
        pr_url: prUrl,
        pr_number: prNumber,
        branch: safeBranch,
        proposal,
      });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "ticket.open_fix_pr",
        targetKind: "ops_ticket",
        targetId: ticketId,
        targetLabel: null,
        status: "failed",
        error: e.message,
      });
      console.error("[OPS][TICKETS] open-fix-pr failed:", e.message);
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

  // ─── Auto-implement (close the loop: Claude writes the actual code) ───
  //
  // Builds on /open-fix-pr (which generates a proposal + opens a DRAFT PR
  // with just the FIX_PROPOSAL.md file). This endpoint runs a Claude
  // tool-use agent on the existing PR branch:
  //   1. Read target files from GitHub (via Contents API)
  //   2. Feed Claude the proposal + file contents
  //   3. Claude iterates with read_file / edit_file / write_file tools
  //   4. Commit the final file state to the branch
  //   5. Update the PR body with the implementation summary
  //
  // Safety bounds (defensive — easier to relax than to apologize for):
  //   - Must be Peak-/admin-gated (opsGate already covers this at mount time)
  //   - Max 6 files modified
  //   - Max 800 LOC delta
  //   - Max 12 tool iterations
  //   - Path allowlist (no .git, .github, node_modules, package*.json, .env*)
  //   - PR stays DRAFT (admin must manually flip to ready-for-review)
  //   - Branch must already exist (so open-fix-pr must run first)
  //
  // Audit: logAdminAction with full metadata (files touched, LOC delta,
  // token cost, success/fail).
  app.post("/api/ops/tickets/:id/auto-implement", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const ticketId = req.params.id;
    const pat = process.env.GITHUB_PAT_FITSCRIPT_FIX;
    const owner = process.env.GITHUB_REPO_OWNER || "markappz";
    const repo = process.env.GITHUB_REPO_NAME || "Humn-Health";

    if (!pat) return res.status(503).json({ error: "GITHUB_PAT_FITSCRIPT_FIX not configured" });
    if (!isAIConfigured()) return res.status(503).json({ error: "AI not configured" });

    try {
      await ensureTicketsTable();
      const tRes = await pool.query(`SELECT * FROM ops_tickets WHERE id = $1`, [ticketId]);
      if (tRes.rows.length === 0) return res.status(404).json({ error: "Ticket not found" });
      const ticket = tRes.rows[0];
      if (!ticket.resolution_pr_url) {
        return res.status(400).json({
          error: "No fix PR yet for this ticket. Run /open-fix-pr first to create the branch + proposal.",
        });
      }

      // Extract PR number + branch from the existing PR URL
      const prNumberMatch = String(ticket.resolution_pr_url).match(/\/pull\/(\d+)/);
      if (!prNumberMatch) return res.status(400).json({ error: "Could not parse PR number from resolution_pr_url" });
      const prNumber = parseInt(prNumberMatch[1], 10);

      // ── GitHub helper (same shape as open-fix-pr) ──
      const gh = async (path: string, init: RequestInit = {}) => {
        const r = await fetch(`https://api.github.com${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            ...(init.headers || {}),
          },
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = (json as any)?.message || `GitHub ${r.status}`;
          throw new Error(`GitHub: ${msg}`);
        }
        return json;
      };

      // 1. Fetch PR detail to get the branch name + base
      const pr: any = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      const branch = pr.head.ref;
      const baseBranch = pr.base.ref;

      // 2. Read the FIX_PROPOSAL.md from the branch to recover the proposal JSON
      //    (Stored as markdown, not JSON — we'll regenerate the structured plan
      //    from the ticket since the markdown is human-readable, not parseable.)
      //    Easier path: re-prompt Claude with the same proposal structure used
      //    in open-fix-pr, but with INSTRUCTIONS to actually write code via tools.
      const planPrompt = `You are a senior FitScript engineer applying a fix for a user-reported bug. You have read_file, edit_file, and write_file tools to modify files on the fix branch. Make the minimum change that resolves the bug.

Bug context:
- URL: ${ticket.source_url}
- User note: ${ticket.user_note || "(none)"}
- Element CSS: ${ticket.element_selector || "(none)"}
- Console errors: ${ticket.console_errors ? JSON.stringify(ticket.console_errors).slice(0, 600) : "(none)"}
- Category: ${ticket.category}
- Severity: ${ticket.severity}
- Initial AI triage: ${ticket.ai_summary || "(none)"}
- Suggested-fix direction: ${ticket.ai_suggested_fix || "(none)"}

FitScript repo structure (markappz/Humn-Health):
- client/src/                 — React 18 + Tailwind + wouter (TS)
  - App.tsx                   — routes + providers
  - pages/                    — 65 route components
  - components/dashboard/     — dashboard surfaces
  - components/ui/            — Shadcn primitives
  - lib/, hooks/              — utilities
- server/
  - routes.ts                 — ALL API endpoints
  - storage.ts                — DatabaseStorage CRUD
  - services/                 — protocol-engine, biomarker-knowledge, atlas, etc.
- shared/schema.ts            — Drizzle schema

Working on branch: ${branch} (PR #${prNumber}, draft).

CONSTRAINTS:
- Modify at most 6 files total
- Keep total LOC delta under 800
- Do NOT touch: .git/**, .github/**, node_modules/**, package.json, package-lock.json, .env*, *.lock, scripts/migrations/** (DB changes need a separate migration review)
- Match existing code style. Use existing patterns. Don't introduce new dependencies.
- If you find the bug is more involved than expected (touching > 6 files or > 800 LOC), STOP, do NOT make changes, and reply with a one-paragraph explanation of why — that will get logged for human review.
- When you're done, just stop emitting tool calls — your final assistant message should be a 2-3 sentence summary of what you changed and why.

Start by reading the most likely target file based on the bug report.`;

      // ── Tool definitions ──
      const tools = [
        {
          name: "read_file",
          description: "Read a file from the fix branch. Returns the file contents as a string. Caches in memory so subsequent reads are free.",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Repo-relative path, e.g. 'client/src/pages/labs.tsx'" },
            },
            required: ["path"],
          },
        },
        {
          name: "edit_file",
          description: "Edit a file by string replacement. find must be EXACT and unique in the file. Returns success + lines changed. Use this for surgical edits. To create a new file, use write_file instead.",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              find: { type: "string", description: "Exact text to find. Must be unique in the file." },
              replace: { type: "string", description: "Replacement text." },
            },
            required: ["path", "find", "replace"],
          },
        },
        {
          name: "write_file",
          description: "Full-overwrite a file (or create new). Avoid for existing files unless the change is sweeping — prefer edit_file.",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ];

      // Path allowlist (deny anything matching the deny patterns)
      const PATH_DENY = [
        /^\.git\//,
        /^\.github\//,
        /^node_modules\//,
        /^dist\//,
        /^package(-lock)?\.json$/,
        /^\.env/,
        /\.lock$/,
        /^scripts\/migrations\//,
      ];
      const isAllowed = (p: string) => !PATH_DENY.some((re) => re.test(p));

      // File working set (read from GitHub on demand, cached in memory)
      const fileCache: Record<string, { content: string; originalSha: string | null; original: string; modified: boolean }> = {};
      const STAT = { reads: 0, edits: 0, writes: 0, totalLOCDelta: 0 };
      const MAX_FILES = 6;
      const MAX_LOC = 800;
      const MAX_ITERS = 12;

      async function fetchFile(path: string): Promise<{ content: string; sha: string | null }> {
        if (!isAllowed(path)) throw new Error(`Path not allowed: ${path}`);
        try {
          const r: any = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`);
          const content = Buffer.from(r.content, "base64").toString("utf8");
          return { content, sha: r.sha };
        } catch (e: any) {
          // 404 means file doesn't exist (new file) — return empty + no SHA
          if (String(e.message).includes("404") || String(e.message).includes("Not Found")) {
            return { content: "", sha: null };
          }
          throw e;
        }
      }

      async function executeTool(name: string, input: any): Promise<string> {
        if (name === "read_file") {
          const path: string = String(input.path);
          if (!isAllowed(path)) return JSON.stringify({ error: `path denied: ${path}` });
          if (!fileCache[path]) {
            const { content, sha } = await fetchFile(path);
            fileCache[path] = { content, originalSha: sha, original: content, modified: false };
          }
          STAT.reads++;
          return fileCache[path].content || "(empty file)";
        }
        if (name === "edit_file") {
          const path: string = String(input.path);
          if (!isAllowed(path)) return JSON.stringify({ error: `path denied: ${path}` });
          if (!fileCache[path]) {
            const { content, sha } = await fetchFile(path);
            fileCache[path] = { content, originalSha: sha, original: content, modified: false };
          }
          const entry = fileCache[path];
          const find = String(input.find ?? "");
          const replace = String(input.replace ?? "");
          if (!find) return JSON.stringify({ error: "find must be non-empty" });
          const occurrences = entry.content.split(find).length - 1;
          if (occurrences === 0) return JSON.stringify({ error: "find not present in file — read_file to inspect current contents" });
          if (occurrences > 1) return JSON.stringify({ error: `find matches ${occurrences} times — make it unique` });
          const before = entry.content.split("\n").length;
          entry.content = entry.content.replace(find, replace);
          entry.modified = entry.original !== entry.content;
          const after = entry.content.split("\n").length;
          STAT.edits++;
          STAT.totalLOCDelta += Math.abs(after - before);
          return JSON.stringify({ ok: true, lines_changed: Math.abs(after - before), occurrences_replaced: 1 });
        }
        if (name === "write_file") {
          const path: string = String(input.path);
          if (!isAllowed(path)) return JSON.stringify({ error: `path denied: ${path}` });
          const content = String(input.content ?? "");
          if (!fileCache[path]) {
            const { content: existing, sha } = await fetchFile(path);
            fileCache[path] = { content: existing, originalSha: sha, original: existing, modified: false };
          }
          const entry = fileCache[path];
          const before = entry.content.split("\n").length;
          entry.content = content;
          entry.modified = entry.original !== entry.content;
          const after = entry.content.split("\n").length;
          STAT.writes++;
          STAT.totalLOCDelta += Math.abs(after - before);
          return JSON.stringify({ ok: true, lines_changed: Math.abs(after - before), kind: entry.originalSha ? "overwrite" : "create" });
        }
        return JSON.stringify({ error: `unknown tool: ${name}` });
      }

      // ── 3. Run the Claude tool-use loop ──
      const messages: any[] = [{ role: "user", content: planPrompt }];
      let iterations = 0;
      let usageTotals = { input: 0, output: 0 };
      let lastSummary = "";

      while (iterations < MAX_ITERS) {
        const r: any = await (anthropic as any).messages.create({
          model: BEDROCK_MODELS.HIGH_IQ,
          max_tokens: 4096,
          tools,
          messages,
        });
        usageTotals.input += r?.usage?.input_tokens ?? 0;
        usageTotals.output += r?.usage?.output_tokens ?? 0;

        const toolUseBlocks = (r.content || []).filter((b: any) => b.type === "tool_use");
        const textBlocks = (r.content || []).filter((b: any) => b.type === "text");
        if (textBlocks.length > 0) lastSummary = textBlocks.map((b: any) => b.text).join("\n");

        if (r.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
          // Claude stopped — break the loop. lastSummary holds its closing message.
          break;
        }

        // Enforce file-count guardrail
        const modifiedFileCount = Object.values(fileCache).filter((f) => f.modified).length;
        if (modifiedFileCount >= MAX_FILES) {
          messages.push({ role: "assistant", content: r.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlocks[0].id,
                content: `Halted: file-edit cap reached (${MAX_FILES} files). Stop making changes and summarize what you've done so far.`,
                is_error: true,
              },
            ],
          });
          // Re-prompt once with the guardrail message; on the next loop Claude
          // should end_turn with a summary.
          iterations++;
          continue;
        }
        if (STAT.totalLOCDelta >= MAX_LOC) {
          messages.push({ role: "assistant", content: r.content });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlocks[0].id,
                content: `Halted: LOC-delta cap reached (${MAX_LOC}). Stop making changes and summarize what you've done so far.`,
                is_error: true,
              },
            ],
          });
          iterations++;
          continue;
        }

        // Execute every tool_use in this turn
        messages.push({ role: "assistant", content: r.content });
        const results: any[] = [];
        for (const block of toolUseBlocks) {
          try {
            const result = await executeTool(block.name, block.input);
            results.push({ type: "tool_result", tool_use_id: block.id, content: result });
          } catch (e: any) {
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ error: e.message }),
              is_error: true,
            });
          }
        }
        messages.push({ role: "user", content: results });
        iterations++;
      }

      logAiCost({
        userId: null,
        surface: "ops_ticket_auto_implement",
        model: BEDROCK_MODELS.HIGH_IQ,
        inputTokens: usageTotals.input,
        outputTokens: usageTotals.output,
        metadata: { ticket_id: ticketId, iterations },
      }).catch(() => {});

      const modifiedFiles = Object.entries(fileCache).filter(([, v]) => v.modified);
      if (modifiedFiles.length === 0) {
        // Claude decided not to modify anything — log + return.
        await logAdminAction({
          adminEmail,
          actionType: "ticket.auto_implement",
          targetKind: "ops_ticket",
          targetId: ticketId,
          targetLabel: ticket.ai_summary || ticket.source_url,
          status: "ok",
          metadata: { outcome: "no_op", reason: "Claude made no file changes", summary: lastSummary, iterations },
        });
        return res.json({
          ok: true,
          no_op: true,
          summary: lastSummary,
          iterations,
          pr_url: ticket.resolution_pr_url,
        });
      }

      // ── 4. Commit each modified file to the branch ──
      const commits: Array<{ path: string; sha: string }> = [];
      for (const [path, entry] of modifiedFiles) {
        const body: any = {
          message: `auto-impl(ticket ${ticketId.slice(0, 8)}): ${path}`,
          content: Buffer.from(entry.content, "utf8").toString("base64"),
          branch,
        };
        if (entry.originalSha) body.sha = entry.originalSha; // required for updates
        const commitRes: any = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        commits.push({ path, sha: commitRes.commit?.sha || "" });
      }

      // ── 5. Append auto-implement summary to the PR body ──
      const currentPr: any = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      const updatedBody = [
        currentPr.body || "",
        "",
        "---",
        "",
        "## 🤖 Auto-implementation",
        "",
        `**Approved by:** ${adminEmail}`,
        `**Files modified:** ${modifiedFiles.length}`,
        `**LOC delta:** ~${STAT.totalLOCDelta}`,
        `**Tool calls:** ${STAT.reads} reads, ${STAT.edits} edits, ${STAT.writes} writes (${iterations} turns)`,
        "",
        "### Files",
        ...modifiedFiles.map(([p]) => `- \`${p}\``),
        "",
        "### Claude's summary",
        "",
        lastSummary || "(no closing summary)",
        "",
        "_PR remains DRAFT. Manually flip to ready-for-review after you've eyeballed the diff._",
      ].join("\n");
      await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ body: updatedBody }),
      });

      await pool.query(
        `UPDATE ops_tickets SET status = 'pr_implemented', updated_at = NOW() WHERE id = $1`,
        [ticketId],
      );

      await logAdminAction({
        adminEmail,
        actionType: "ticket.auto_implement",
        targetKind: "ops_ticket",
        targetId: ticketId,
        targetLabel: ticket.ai_summary || ticket.source_url,
        status: "ok",
        metadata: {
          pr_number: prNumber,
          files_modified: modifiedFiles.map(([p]) => p),
          loc_delta: STAT.totalLOCDelta,
          iterations,
          tokens_in: usageTotals.input,
          tokens_out: usageTotals.output,
        },
      });

      res.json({
        ok: true,
        pr_url: ticket.resolution_pr_url,
        pr_number: prNumber,
        files_modified: modifiedFiles.map(([p]) => p),
        loc_delta: STAT.totalLOCDelta,
        iterations,
        summary: lastSummary,
      });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "ticket.auto_implement",
        targetKind: "ops_ticket",
        targetId: ticketId,
        targetLabel: null,
        status: "failed",
        error: e.message,
      });
      console.error("[OPS][TICKETS] auto-implement failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
