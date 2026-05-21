/**
 * Shared audit-log writer for every admin write action across the ops
 * dashboard. Writes to `ops_admin_actions` (lazily-created table).
 *
 * Used by both Klaviyo write endpoints AND DIRT write tools.
 * Never throws — audit-log failures must not break the user flow.
 */
import { pool } from "../db";

let tableEnsured = false;

async function ensureTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_admin_actions (
      id SERIAL PRIMARY KEY,
      admin_email TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_label TEXT,
      status TEXT NOT NULL,
      error TEXT,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created
      ON ops_admin_actions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_target
      ON ops_admin_actions (target_kind, target_id, created_at DESC);
  `);
  tableEnsured = true;
}

export async function logAdminAction(args: {
  adminEmail: string;
  actionType: string;
  targetKind: string;
  targetId: string;
  targetLabel?: string | null;
  status: "ok" | "failed";
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO ops_admin_actions
       (admin_email, action_type, target_kind, target_id, target_label, status, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.adminEmail,
        args.actionType,
        args.targetKind,
        args.targetId,
        args.targetLabel ?? null,
        args.status,
        args.error ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    );
  } catch (e) {
    console.warn("[OPS AUDIT] log failed:", (e as Error).message);
  }
}
