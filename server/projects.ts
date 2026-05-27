/**
 * Project management — simple shared project list for the FitScript team.
 *
 * Schema: ops_projects (id UUID, name, description, status, owner_email,
 *   due_date, created_by, created_at, updated_at).
 *
 * Endpoints (all gated by opsGate):
 *   GET    /api/ops/projects                  — list (optional ?status= filter)
 *   POST   /api/ops/projects                  — create
 *   PATCH  /api/ops/projects/:id              — update any subset of fields
 *   DELETE /api/ops/projects/:id              — soft-delete (status='archived')
 *
 * Writes are audit-logged via logAdminAction.
 */
import type { Express, Request } from "express";
import { randomUUID } from "crypto";
import { pool } from "./db";
import { logAdminAction } from "./lib/auditLog";

interface AdminReq extends Request {
  adminEmail?: string;
}

const VALID_STATUSES = ["active", "on_hold", "done", "archived"] as const;
type ProjectStatus = (typeof VALID_STATUSES)[number];

let tableEnsured = false;
async function ensureProjectsTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_projects (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      owner_email TEXT,
      due_date DATE,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_projects_status ON ops_projects (status);
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON ops_projects (owner_email);

    CREATE TABLE IF NOT EXISTS ops_project_tasks (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES ops_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_email TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON ops_project_tasks (project_id, sort_order ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee ON ops_project_tasks (assignee_email) WHERE assignee_email IS NOT NULL;
  `);
  tableEnsured = true;
}

const VALID_TASK_STATUSES = ["todo", "doing", "done"] as const;
type TaskStatus = (typeof VALID_TASK_STATUSES)[number];
function isValidTaskStatus(s: any): s is TaskStatus {
  return typeof s === "string" && (VALID_TASK_STATUSES as readonly string[]).includes(s);
}

function isValidStatus(s: any): s is ProjectStatus {
  return typeof s === "string" && (VALID_STATUSES as readonly string[]).includes(s);
}

export function registerProjectRoutes(app: Express) {
  // List projects. Optional ?status= filter; defaults to all non-archived.
  app.get("/api/ops/projects", async (req, res) => {
    try {
      await ensureProjectsTable();
      const statusFilter = String(req.query.status || "").trim();
      const includeArchived = req.query.includeArchived === "true";

      let sql = `SELECT id, name, description, status, owner_email, due_date,
                        created_by, created_at, updated_at
                 FROM ops_projects`;
      const params: any[] = [];

      if (statusFilter && isValidStatus(statusFilter)) {
        sql += ` WHERE status = $1`;
        params.push(statusFilter);
      } else if (!includeArchived) {
        sql += ` WHERE status <> 'archived'`;
      }

      // Sort: active first, then by due_date (NULLs last), then most-recent first.
      sql += ` ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'done' THEN 2 WHEN 'archived' THEN 3 ELSE 4 END,
        due_date ASC NULLS LAST,
        created_at DESC`;

      const r = await pool.query(sql, params);
      res.json({ projects: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create a project.
  app.post("/api/ops/projects", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const { name, description, status, owner_email, due_date } = req.body ?? {};
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name required" });
      }
      const s = isValidStatus(status) ? status : "active";
      const id = randomUUID();
      const r = await pool.query(
        `INSERT INTO ops_projects (id, name, description, status, owner_email, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, status, owner_email, due_date, created_by, created_at, updated_at`,
        [
          id,
          name.trim(),
          description?.trim() || null,
          s,
          owner_email?.trim().toLowerCase() || null,
          due_date || null,
          adminEmail,
        ],
      );
      await logAdminAction({
        adminEmail,
        actionType: "project.create",
        targetKind: "ops_project",
        targetId: id,
        targetLabel: name.trim(),
        status: "ok",
        metadata: { owner: owner_email ?? null, status: s, due_date: due_date ?? null },
      });
      res.json({ project: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update any subset of fields.
  app.patch("/api/ops/projects/:id", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const id = req.params.id;
      const b = req.body ?? {};
      const sets: string[] = [];
      const params: any[] = [];
      const allowed: Array<[string, (v: any) => any]> = [
        ["name", (v) => (typeof v === "string" && v.trim() ? v.trim() : null)],
        ["description", (v) => (typeof v === "string" ? v.trim() || null : null)],
        ["status", (v) => (isValidStatus(v) ? v : null)],
        ["owner_email", (v) => (typeof v === "string" ? v.trim().toLowerCase() || null : null)],
        ["due_date", (v) => (v || null)],
      ];
      const changes: Record<string, unknown> = {};
      for (const [field, normalize] of allowed) {
        if (Object.prototype.hasOwnProperty.call(b, field)) {
          const val = normalize(b[field]);
          if (field === "name" && val === null) {
            return res.status(400).json({ error: "name cannot be empty" });
          }
          if (field === "status" && val === null) {
            return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
          }
          params.push(val);
          sets.push(`${field} = $${params.length}`);
          changes[field] = val;
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
      sets.push("updated_at = NOW()");
      params.push(id);

      const r = await pool.query(
        `UPDATE ops_projects SET ${sets.join(", ")} WHERE id = $${params.length}
         RETURNING id, name, description, status, owner_email, due_date, created_by, created_at, updated_at`,
        params,
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Project not found" });
      await logAdminAction({
        adminEmail,
        actionType: "project.update",
        targetKind: "ops_project",
        targetId: id,
        targetLabel: r.rows[0].name,
        status: "ok",
        metadata: { changes },
      });
      res.json({ project: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Soft-delete (archive). Use PATCH with status='archived' as the
  // primary archive flow; DELETE is for hard removal when operators
  // really want to nuke a row.
  app.delete("/api/ops/projects/:id", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const id = req.params.id;
      const r = await pool.query(
        `DELETE FROM ops_projects WHERE id = $1 RETURNING name`,
        [id],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Project not found" });
      await logAdminAction({
        adminEmail,
        actionType: "project.delete",
        targetKind: "ops_project",
        targetId: id,
        targetLabel: r.rows[0].name,
        status: "ok",
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Project tasks (subtasks) ──────────────────────────────────

  // List tasks for a project (default sort: status order then sort_order then created_at)
  app.get("/api/ops/projects/:projectId/tasks", async (req, res) => {
    try {
      await ensureProjectsTable();
      const r = await pool.query(
        `SELECT id, project_id, title, status, assignee_email, sort_order,
                created_by, created_at, updated_at, completed_at
         FROM ops_project_tasks
         WHERE project_id = $1
         ORDER BY
           CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
           sort_order ASC,
           created_at ASC`,
        [req.params.projectId],
      );
      res.json({ tasks: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create a task in a project
  app.post("/api/ops/projects/:projectId/tasks", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const projectId = req.params.projectId;
      const { title, status, assignee_email } = req.body ?? {};
      const t = String(title || "").trim();
      if (!t) return res.status(400).json({ error: "title required" });
      const s = isValidTaskStatus(status) ? status : "todo";
      const id = randomUUID();
      // Verify project exists
      const proj = await pool.query(`SELECT id FROM ops_projects WHERE id = $1`, [projectId]);
      if (proj.rows.length === 0) return res.status(404).json({ error: "Project not found" });
      const r = await pool.query(
        `INSERT INTO ops_project_tasks (id, project_id, title, status, assignee_email, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, projectId, t, s, assignee_email?.trim().toLowerCase() || null, adminEmail],
      );
      await logAdminAction({
        adminEmail,
        actionType: "task.create",
        targetKind: "ops_project_task",
        targetId: id,
        targetLabel: t,
        status: "ok",
        metadata: { project_id: projectId, task_status: s },
      });
      res.json({ task: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update a task — any subset of {title, status, assignee_email}
  app.patch("/api/ops/projects/:projectId/tasks/:taskId", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const taskId = req.params.taskId;
      const b = req.body ?? {};
      const sets: string[] = [];
      const params: any[] = [];
      const changes: Record<string, unknown> = {};
      if (typeof b.title === "string") {
        const t = b.title.trim();
        if (!t) return res.status(400).json({ error: "title cannot be empty" });
        params.push(t);
        sets.push(`title = $${params.length}`);
        changes.title = t;
      }
      if (b.status !== undefined) {
        if (!isValidTaskStatus(b.status)) return res.status(400).json({ error: "invalid status" });
        params.push(b.status);
        sets.push(`status = $${params.length}`);
        changes.status = b.status;
        // Auto-set completed_at when moving to done; clear when moving away.
        if (b.status === "done") sets.push("completed_at = COALESCE(completed_at, NOW())");
        else sets.push("completed_at = NULL");
      }
      if (b.assignee_email !== undefined) {
        const ae = (b.assignee_email || "").trim().toLowerCase() || null;
        params.push(ae);
        sets.push(`assignee_email = $${params.length}`);
        changes.assignee_email = ae;
      }
      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
      sets.push("updated_at = NOW()");
      params.push(taskId);
      const r = await pool.query(
        `UPDATE ops_project_tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Task not found" });
      await logAdminAction({
        adminEmail,
        actionType: "task.update",
        targetKind: "ops_project_task",
        targetId: taskId,
        targetLabel: r.rows[0].title,
        status: "ok",
        metadata: { changes },
      });
      res.json({ task: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a task
  app.delete("/api/ops/projects/:projectId/tasks/:taskId", async (req: AdminReq, res) => {
    try {
      await ensureProjectsTable();
      const adminEmail = req.adminEmail || "unknown";
      const taskId = req.params.taskId;
      const r = await pool.query(
        `DELETE FROM ops_project_tasks WHERE id = $1 RETURNING title`,
        [taskId],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Task not found" });
      await logAdminAction({
        adminEmail,
        actionType: "task.delete",
        targetKind: "ops_project_task",
        targetId: taskId,
        targetLabel: r.rows[0].title,
        status: "ok",
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
