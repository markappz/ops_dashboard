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
  `);
  tableEnsured = true;
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
}
