/**
 * Call Center persistence helpers. Tables come from callcenter-schema.sql
 * (applied at boot, same pattern as tracking-schema.sql). Raw SQL only.
 *
 * Testability: every helper takes the pool as its first argument so the
 * vitest suite can point them at a scratch database without env juggling.
 */
import type { Pool, PoolClient } from "pg";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

export async function ensureCallCenterTables(pool: Pool): Promise<void> {
  const schemaPath = path.resolve(import.meta.dirname, "callcenter-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
}

export const REQUEST_STATES = ["new", "assigned", "in_progress", "awaiting_customer", "scheduled", "resolved", "closed_no_action"] as const;
export const CALL_OUTCOMES = ["attempted", "no_answer", "voicemail", "connected", "failed"] as const;
export const QUEUES = ["support", "wholesale", "sales_recovery", "affiliate", "triage"] as const;
export type Queue = (typeof QUEUES)[number];

export const FOLLOWUP_REASONS = [
  "callback", "product_question", "order_question", "needs_quote", "quote_question",
  "payment_question", "payment_review", "paid_waiting_fulfillment", "shipment_question",
  "affiliate_question", "sales_recovery", "other",
] as const;

/** Reason → queue mapping (prompt §2 wholesale additions + §8 ownership). */
export const REASON_QUEUE: Record<string, Queue> = {
  callback: "support",
  product_question: "support",
  order_question: "support",
  shipment_question: "support",
  needs_quote: "wholesale",
  quote_question: "wholesale",
  payment_question: "wholesale",
  payment_review: "wholesale",
  paid_waiting_fulfillment: "wholesale",
  affiliate_question: "affiliate",
  sales_recovery: "sales_recovery",
  other: "triage",
};

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 32);
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Accept a webhook event into the durable inbox. Returns the row id, or null
 * when the dedupe key already exists (duplicate delivery — safely ignored).
 */
export async function acceptWebhookEvent(
  pool: Pool,
  args: { eventType: string; externalId: string | null; payload: unknown },
): Promise<number | null> {
  const dedupeKey = `${args.eventType}:${args.externalId ?? "?"}:${digestOf(args.payload)}`;
  const r = await pool.query(
    `INSERT INTO cc_webhook_inbox (provider, event_type, external_id, dedupe_key, payload)
     VALUES ('retell', $1, $2, $3, $4)
     ON CONFLICT (provider, dedupe_key) DO NOTHING
     RETURNING id`,
    [args.eventType, args.externalId, dedupeKey, JSON.stringify(args.payload)],
  );
  return r.rows[0]?.id ?? null;
}

export async function logCcEvent(
  db: Pool | PoolClient,
  e: { conversationId?: number | null; requestId?: number | null; actorType: string; actor?: string | null; type: string; data?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO cc_events (conversation_id, request_id, actor_type, actor, type, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.conversationId ?? null, e.requestId ?? null, e.actorType, e.actor ?? null, e.type, JSON.stringify(e.data ?? {})],
  );
}

/**
 * Find-or-create a contact suggested by a phone/email seen on a conversation.
 * A matching number only SUGGESTS identity (shared/reassigned numbers exist),
 * so matches stay 'suggested' and people are never merged by name.
 */
export async function suggestContact(
  db: Pool | PoolClient,
  c: { brand?: string; phone?: string | null; email?: string | null; name?: string | null; businessName?: string | null },
): Promise<number | null> {
  const brand = c.brand || "realpeptides";
  const phone = normalizePhone(c.phone);
  const email = normalizeEmail(c.email);
  if (!phone && !email) return null;
  const existing = await db.query(
    `SELECT id, name, business_name FROM cc_contacts
      WHERE brand = $1 AND ((($2::text IS NOT NULL) AND phone_e164 = $2) OR (($3::text IS NOT NULL) AND email_norm = $3))
      ORDER BY (phone_e164 = $2) DESC NULLS LAST, id ASC LIMIT 1`,
    [brand, phone, email],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    // enrich blanks only — never overwrite a staff-entered name with analysis text
    if ((!row.name && c.name) || (!row.business_name && c.businessName)) {
      await db.query(
        `UPDATE cc_contacts SET name = COALESCE(name, $2), business_name = COALESCE(business_name, $3), updated_at = NOW() WHERE id = $1`,
        [row.id, c.name ?? null, c.businessName ?? null],
      );
    }
    return row.id;
  }
  const ins = await db.query(
    `INSERT INTO cc_contacts (brand, name, business_name, phone_e164, phone_raw, email_norm, email_raw, verification_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'suggested') RETURNING id`,
    [brand, c.name ?? null, c.businessName ?? null, phone, c.phone ?? null, email, c.email ?? null],
  );
  return ins.rows[0].id;
}

export interface CreateRequestInput {
  brand?: string;
  conversationId?: number | null;
  contactId?: number | null;
  kind?: string;
  reason?: string;
  queue?: Queue;
  concern?: string | null;
  intent?: string | null;
  productRefs?: unknown[];
  orderReference?: string | null;
  wholesaleRefs?: Record<string, unknown>;
  priority?: string;
  ownerEmail?: string | null;
  contactPermission?: boolean | null;
  contactChannel?: string | null;
  callbackWindowRaw?: string | null;
  callbackAt?: Date | null;
  callbackTz?: string | null;
  needsScheduling?: boolean;
  dueAt?: Date | null;
  source: "live_tool" | "webhook_analysis" | "staff";
  idempotencyKey?: string | null;
}

/**
 * Create a follow-up request. With an idempotency key, a duplicate insert
 * returns the EXISTING row (original receipt) instead of a second task.
 */
export async function createRequest(db: Pool | PoolClient, r: CreateRequestInput): Promise<{ id: number; created: boolean }> {
  const queue = r.queue || REASON_QUEUE[r.reason ?? "other"] || "triage";
  if (r.idempotencyKey) {
    const dup = await db.query(`SELECT id FROM cc_requests WHERE idempotency_key = $1`, [r.idempotencyKey]);
    if (dup.rows[0]) return { id: dup.rows[0].id, created: false };
  }
  const ins = await db.query(
    `INSERT INTO cc_requests (brand, conversation_id, contact_id, kind, reason, queue, concern, intent,
       product_refs, order_reference, wholesale_refs, priority, contact_permission, contact_channel,
       callback_window_raw, callback_at, callback_tz, needs_scheduling, due_at, owner_email, state, source, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       CASE WHEN $20::text IS NULL THEN 'new' ELSE 'assigned' END, $21, $22)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      r.brand || "realpeptides", r.conversationId ?? null, r.contactId ?? null, r.kind || "support",
      r.reason ?? null, queue, r.concern ?? null, r.intent ?? null,
      JSON.stringify(r.productRefs ?? []), r.orderReference ?? null, JSON.stringify(r.wholesaleRefs ?? {}),
      r.priority || "normal", r.contactPermission ?? null, r.contactChannel ?? null,
      r.callbackWindowRaw ?? null, r.callbackAt ?? null, r.callbackTz ?? null,
      r.needsScheduling ?? false, r.dueAt ?? null, r.ownerEmail ?? null,
      r.source, r.idempotencyKey ?? null,
    ],
  );
  if (!ins.rows[0]) {
    // lost a race on the idempotency key — fetch the winner
    const dup = await db.query(`SELECT id FROM cc_requests WHERE idempotency_key = $1`, [r.idempotencyKey]);
    if (dup.rows[0]) return { id: dup.rows[0].id, created: false };
    throw new Error("request insert returned no row");
  }
  await logCcEvent(db, {
    conversationId: r.conversationId, requestId: ins.rows[0].id,
    actorType: r.source === "staff" ? "staff" : r.source === "live_tool" ? "agent_tool" : "system",
    actor: r.ownerEmail ?? r.source, type: "request_created",
    data: { reason: r.reason, queue, source: r.source },
  });
  return { id: ins.rows[0].id, created: true };
}

/** Tool receipt: insert-or-return-original so a provider retry after commit never double-writes. */
export async function toolReceipt(
  pool: Pool,
  t: { conversationExternalId: string | null; agentId: string | null; tool: string; idempotencyKey: string; args: unknown },
): Promise<{ existing: any | null; record: (response: unknown, status?: string) => Promise<void> }> {
  const ins = await pool.query(
    `INSERT INTO cc_tool_calls (conversation_external_id, agent_id, tool, idempotency_key, args)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tool, idempotency_key) DO NOTHING RETURNING id`,
    [t.conversationExternalId, t.agentId, t.tool, t.idempotencyKey, JSON.stringify(t.args ?? {})],
  );
  if (!ins.rows[0]) {
    const prev = await pool.query(
      `SELECT response, status FROM cc_tool_calls WHERE tool = $1 AND idempotency_key = $2`,
      [t.tool, t.idempotencyKey],
    );
    return { existing: prev.rows[0] ?? { response: null, status: "pending" }, record: async () => {} };
  }
  const id = ins.rows[0].id;
  return {
    existing: null,
    record: async (response, status = "ok") => {
      await pool.query(`UPDATE cc_tool_calls SET response = $2, status = $3 WHERE id = $1`, [id, JSON.stringify(response), status]);
    },
  };
}

export async function getSyncState(pool: Pool, key: string): Promise<any> {
  const r = await pool.query(`SELECT value FROM cc_sync_state WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSyncState(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO cc_sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}
