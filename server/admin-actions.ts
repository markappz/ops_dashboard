/**
 * Surfaces the ops_admin_actions audit log written by other modules.
 *
 * Today the only writer is the Klaviyo flow enable/disable endpoint
 * (flow.activate / flow.deactivate). When future write surfaces are
 * built (cancel, refund, comp, tier change), they should append rows
 * via the logAdminAction helper in server/klaviyo.ts — eventually that
 * helper should move into this file as a shared util, but it's
 * co-located there for now to avoid a circular import while small.
 */
import type { Express } from "express";
import { pool } from "./db";

export function registerAdminActionsRoutes(app: Express) {
  app.get("/api/ops/admin-actions", async (req, res) => {
    try {
      const limit = Math.min(
        Math.max(parseInt((req.query.limit as string) || "100"), 1),
        500,
      );
      const targetKind = (req.query.target_kind as string) || null;
      const targetId = (req.query.target_id as string) || null;
      const adminEmail = (req.query.admin_email as string) || null;

      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (targetKind) {
        conditions.push(`target_kind = $${idx++}`);
        params.push(targetKind);
      }
      if (targetId) {
        conditions.push(`target_id = $${idx++}`);
        params.push(targetId);
      }
      if (adminEmail) {
        conditions.push(`admin_email = $${idx++}`);
        params.push(adminEmail);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // ops_admin_actions is lazily created the first time the Klaviyo flow
      // endpoint runs (ensureAdminActionsTable). If it doesn't exist yet,
      // return an empty list so the UI renders cleanly.
      const exists = await pool.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ops_admin_actions')",
      );
      if (!exists.rows[0].exists) {
        return res.json({ actions: [], totals: { ok: 0, failed: 0 }, byKind: [] });
      }

      const rowsRes = await pool.query(
        `SELECT id, admin_email, action_type, target_kind, target_id, target_label, status, error, metadata, created_at
         FROM ops_admin_actions
         ${where}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        [...params, limit],
      );

      const totalsRes = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'ok') AS ok,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM ops_admin_actions
         ${where}`,
        params,
      );

      const byKindRes = await pool.query(
        `SELECT target_kind, COUNT(*) AS n
         FROM ops_admin_actions
         ${where}
         GROUP BY target_kind ORDER BY n DESC`,
        params,
      );

      res.json({
        actions: rowsRes.rows,
        totals: {
          ok: parseInt(totalsRes.rows[0].ok),
          failed: parseInt(totalsRes.rows[0].failed),
        },
        byKind: byKindRes.rows.map((r: any) => ({
          target_kind: r.target_kind,
          count: parseInt(r.n),
        })),
      });
    } catch (e: any) {
      console.error("[OPS] admin-actions error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
