/**
 * Team task board — a Monday-style kanban the growth team runs itself.
 * Tasks are cross-brand (each carries a company tag) but the board lives
 * in the Real Peptides section where Josh works. Assignees come from the
 * ops team roster (ops_admins), so there's nothing to configure.
 */
import type { Express } from "express";
import { pool } from "./db";
import { listAdminsFromDb } from "./admin-auth";

const STATUSES = new Set(["inbox", "ready", "in_progress", "complete", "on_hold"]);
const PRIORITIES = new Set(["low", "medium", "high"]);
const COMPANIES = new Set(["realpeptides", "fitscript", "peptideu", "pawgen", "other"]);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_tasks (
      id           SERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'inbox',
      priority     TEXT NOT NULL DEFAULT 'medium',
      company      TEXT,
      assignee     TEXT,
      due_date     DATE,
      labels       TEXT[] NOT NULL DEFAULT '{}',
      position     DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
}

const cleanLabels = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((l) => String(l).trim()).filter(Boolean))].slice(0, 8) : [];

export function registerTasksRoutes(app: Express) {
  /** Board state: every open task, done ones from the last 30 days, and the team roster. */
  app.get("/api/ops/tasks", async (_req, res) => {
    try {
      await ensureTable();
      const { rows } = await pool.query(`
        SELECT * FROM ops_tasks
        WHERE status != 'complete' OR completed_at > NOW() - INTERVAL '30 days'
        ORDER BY position ASC, created_at ASC`);
      const team = (await listAdminsFromDb()).map((a) => a.email);
      res.json({ tasks: rows, team });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/tasks", async (req: any, res) => {
    try {
      await ensureTable();
      const title = String(req.body?.title || "").trim();
      if (!title) return res.status(400).json({ error: "The task needs a title" });
      const status = STATUSES.has(req.body?.status) ? req.body.status : "inbox";
      const max = await pool.query("SELECT COALESCE(MAX(position), 0) AS p FROM ops_tasks WHERE status = $1", [status]);
      const { rows } = await pool.query(
        `INSERT INTO ops_tasks (title, description, status, priority, company, assignee, due_date, labels, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          title,
          req.body?.description ? String(req.body.description) : null,
          status,
          PRIORITIES.has(req.body?.priority) ? req.body.priority : "medium",
          COMPANIES.has(req.body?.company) ? req.body.company : null,
          req.body?.assignee ? String(req.body.assignee).toLowerCase() : null,
          req.body?.due_date || null,
          cleanLabels(req.body?.labels),
          Number(max.rows[0].p) + 1,
          req.adminEmail || null,
        ],
      );
      res.json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/tasks/:id", async (req: any, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body ?? {};
      if (b.status !== undefined && !STATUSES.has(b.status)) return res.status(400).json({ error: "Bad status" });
      if (b.priority !== undefined && !PRIORITIES.has(b.priority)) return res.status(400).json({ error: "Bad priority" });
      if (b.company !== undefined && b.company !== null && !COMPANIES.has(b.company)) return res.status(400).json({ error: "Bad company" });
      const { rows } = await pool.query(
        `UPDATE ops_tasks SET
           title       = COALESCE($2, title),
           description = CASE WHEN $3 THEN $4 ELSE description END,
           status      = COALESCE($5, status),
           priority    = COALESCE($6, priority),
           company     = CASE WHEN $7 THEN $8 ELSE company END,
           assignee    = CASE WHEN $9 THEN $10 ELSE assignee END,
           due_date    = CASE WHEN $11 THEN $12::date ELSE due_date END,
           labels      = CASE WHEN $13 THEN $14 ELSE labels END,
           position    = COALESCE($15, position),
           completed_at = CASE
             WHEN $5 = 'complete' AND status != 'complete' THEN NOW()
             WHEN $5 IS NOT NULL AND $5 != 'complete' THEN NULL
             ELSE completed_at END,
           updated_at  = NOW()
         WHERE id = $1 RETURNING *`,
        [
          id,
          b.title !== undefined ? String(b.title).trim() || null : null,
          b.description !== undefined, b.description ? String(b.description) : null,
          b.status ?? null,
          b.priority ?? null,
          b.company !== undefined, b.company ?? null,
          b.assignee !== undefined, b.assignee ? String(b.assignee).toLowerCase() : null,
          b.due_date !== undefined, b.due_date || null,
          b.labels !== undefined, cleanLabels(b.labels),
          typeof b.position === "number" && Number.isFinite(b.position) ? b.position : null,
        ],
      );
      if (!rows[0]) return res.status(404).json({ error: "Task not found" });
      res.json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/tasks/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM ops_tasks WHERE id = $1", [parseInt(req.params.id, 10)]);
      if (!rowCount) return res.status(404).json({ error: "Task not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
