/**
 * Call Center worker loops:
 *  1. Inbox processor — applies durably-stored webhook events to conversations
 *     with per-field monotonic guards, retry backoff, and a dead-letter state.
 *  2. Reconciliation — server-side Retell list APIs refresh detail and backfill
 *     history behind a watermark with a small overlap window.
 *
 * Both follow the repo's loop pattern (setInterval + claim-by-UPDATE so two
 * ECS tasks during a rolling deploy never double-process a row).
 */
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "./db";
import {
  createRequest, logCcEvent, suggestContact, getSyncState, setSyncState,
} from "./callcenter-db";
import { retell, retellCfg, knownAgentIds, agentLabel, RetellRateLimited } from "./callcenter-retell";
import { findWholesaleMatch } from "./callcenter-commerce";

const MAX_ATTEMPTS = 5;

/* ------------------------------------------------------------------ */
/* Conversation upsert with monotonic guards                           */
/* ------------------------------------------------------------------ */

function toDate(ms: unknown): Date | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

function channelOf(payload: any): "voice" | "chat" {
  return payload?.chat || String(payload?.event ?? "").startsWith("chat_") ? "chat" : "voice";
}

/**
 * Merge a Retell call/chat object into cc_conversations. Field-level guards
 * make this safe for duplicates and out-of-order delivery:
 *  - started_at only fills in when missing (an end event may arrive first);
 *  - end fields are authoritative whenever present;
 *  - a transcript never shrinks unless it comes from an end/analysis payload;
 *  - analysis only sets analysis fields, never un-ends a conversation.
 */
export async function upsertConversation(
  db: Pool | PoolClient,
  entity: any,
  opts: { channel: "voice" | "chat"; eventType: string },
): Promise<number> {
  const externalId = String(entity.call_id ?? entity.chat_id ?? "");
  if (!externalId) throw new Error("payload has no call_id/chat_id");
  const isEnd = /(_ended|_analyzed)$/.test(opts.eventType) || opts.eventType === "reconcile";
  const analysis = entity.call_analysis ?? entity.chat_analysis ?? null;
  const custom = analysis?.custom_analysis_data ?? null;
  const transcript: string | null = entity.transcript ?? null;
  const ts = Number(entity.end_timestamp ?? entity.start_timestamp ?? Date.now());

  const r = await db.query(
    `INSERT INTO cc_conversations (provider, external_id, brand, channel, call_type, direction,
        from_number, to_number, agent_id, agent_version, agent_name,
        started_at, ended_at, duration_ms, provider_status, disconnect_reason,
        summary, transcript, transcript_object, recording_url,
        analysis, analysis_status, analyzed_at, intent,
        last_event_type, last_event_ts, transcript_version)
     VALUES ('retell', $1, 'realpeptides', $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, CASE WHEN $16::text IS NULL THEN 0 ELSE $24::bigint END)
     ON CONFLICT (provider, external_id) DO UPDATE SET
        call_type   = COALESCE(EXCLUDED.call_type, cc_conversations.call_type),
        direction   = COALESCE(EXCLUDED.direction, cc_conversations.direction),
        from_number = COALESCE(EXCLUDED.from_number, cc_conversations.from_number),
        to_number   = COALESCE(EXCLUDED.to_number, cc_conversations.to_number),
        agent_id    = COALESCE(EXCLUDED.agent_id, cc_conversations.agent_id),
        agent_version = COALESCE(EXCLUDED.agent_version, cc_conversations.agent_version),
        agent_name  = COALESCE(EXCLUDED.agent_name, cc_conversations.agent_name),
        started_at  = COALESCE(cc_conversations.started_at, EXCLUDED.started_at),
        ended_at    = COALESCE(EXCLUDED.ended_at, cc_conversations.ended_at),
        duration_ms = COALESCE(EXCLUDED.duration_ms, cc_conversations.duration_ms),
        provider_status = CASE
          WHEN cc_conversations.provider_status = 'ended' AND EXCLUDED.provider_status = 'ongoing' THEN 'ended'
          ELSE COALESCE(EXCLUDED.provider_status, cc_conversations.provider_status) END,
        disconnect_reason = COALESCE(EXCLUDED.disconnect_reason, cc_conversations.disconnect_reason),
        summary     = COALESCE(EXCLUDED.summary, cc_conversations.summary),
        transcript  = CASE
          WHEN EXCLUDED.transcript IS NULL THEN cc_conversations.transcript
          WHEN $25::boolean THEN EXCLUDED.transcript
          WHEN cc_conversations.transcript IS NULL THEN EXCLUDED.transcript
          WHEN length(EXCLUDED.transcript) >= length(cc_conversations.transcript) THEN EXCLUDED.transcript
          ELSE cc_conversations.transcript END,
        transcript_object = COALESCE(EXCLUDED.transcript_object, cc_conversations.transcript_object),
        recording_url = COALESCE(EXCLUDED.recording_url, cc_conversations.recording_url),
        analysis    = COALESCE(EXCLUDED.analysis, cc_conversations.analysis),
        analysis_status = CASE WHEN EXCLUDED.analysis IS NOT NULL THEN 'received' ELSE cc_conversations.analysis_status END,
        analyzed_at = COALESCE(EXCLUDED.analyzed_at, cc_conversations.analyzed_at),
        intent      = COALESCE(EXCLUDED.intent, cc_conversations.intent),
        last_event_type = EXCLUDED.last_event_type,
        last_event_ts   = GREATEST(COALESCE(cc_conversations.last_event_ts, 0), COALESCE(EXCLUDED.last_event_ts, 0)),
        updated_at  = NOW()
     RETURNING id`,
    [
      externalId, opts.channel,
      entity.call_type ?? (opts.channel === "chat" ? "chat" : null),
      entity.direction ?? (entity.call_type === "web_call" || opts.channel === "chat" ? "web" : null),
      entity.from_number ?? null, entity.to_number ?? null,
      entity.agent_id ?? null, entity.agent_version ?? null,
      entity.agent_name ?? agentLabel(entity.agent_id) ?? null,
      toDate(entity.start_timestamp), toDate(entity.end_timestamp),
      Number.isFinite(Number(entity.duration_ms)) ? Number(entity.duration_ms) : null,
      entity.call_status ?? entity.chat_status ?? null,
      entity.disconnection_reason ?? null,
      analysis?.call_summary ?? analysis?.chat_summary ?? null,
      transcript,
      entity.transcript_object ? JSON.stringify(entity.transcript_object) : null,
      entity.recording_url ?? null,
      analysis ? JSON.stringify(analysis) : null,
      analysis ? "received" : "pending",
      analysis ? new Date() : null,
      custom?.intent ?? null,
      opts.eventType, ts,
      isEnd,
    ],
  );
  return r.rows[0].id;
}

/* ------------------------------------------------------------------ */
/* Analysis → follow-up routing                                        */
/* ------------------------------------------------------------------ */

function truthy(v: unknown): boolean {
  return v === true || /^(true|yes|y|1)$/i.test(String(v ?? "").trim());
}

export function intentQueue(intent: string | null | undefined): { kind: string; queue: "support" | "wholesale" | "sales_recovery" | "affiliate" | "triage" } {
  const s = String(intent ?? "").toLowerCase();
  if (!s) return { kind: "triage", queue: "triage" };
  if (s.includes("wholesale") || s.includes("bulk")) return { kind: "wholesale", queue: "wholesale" };
  if (s.includes("affiliate")) return { kind: "affiliate", queue: "affiliate" };
  if (s.includes("checkout") || s.includes("cart") || s.includes("abandon")) return { kind: "sales_recovery", queue: "sales_recovery" };
  if (s.includes("order") || s.includes("ship") || s.includes("support") || s.includes("product") || s.includes("coa") || s.includes("education")) {
    return { kind: "support", queue: "support" };
  }
  if (s.includes("wrong_brand") || s.includes("wrong brand")) return { kind: "triage", queue: "triage" };
  return { kind: "triage", queue: "triage" };
}

/** Does this analysis warrant a human task at all? Answered questions don't. */
export function analysisNeedsTask(custom: any, entity: any): { needs: boolean; why: string } {
  if (truthy(custom?.human_followup_requested)) return { needs: true, why: "human_followup_requested" };
  const action = String(custom?.action_status ?? "").toLowerCase();
  if (/(unresolved|follow|escalat|promis|pending|review|callback)/.test(action)) return { needs: true, why: `action_status=${action}` };
  if (custom?.contact_request && String(custom.contact_request).trim() && !/^(no|none|n\/a)$/i.test(String(custom.contact_request).trim())) {
    return { needs: true, why: "contact_request present" };
  }
  const openQ = custom?.open_questions;
  if (openQ && String(openQ).trim() && !/^(no|none|n\/a|\[\])$/i.test(String(openQ).trim())) {
    return { needs: true, why: "open_questions present" };
  }
  // In-call tool/transfer failure with no resolution → keep it actionable.
  if (String(entity?.disconnection_reason ?? "").includes("error")) return { needs: true, why: `disconnect=${entity.disconnection_reason}` };
  return { needs: false, why: "answered" };
}

async function routeAnalysis(pool: Pool, conversationId: number, entity: any): Promise<void> {
  const conv = (await pool.query(`SELECT * FROM cc_conversations WHERE id = $1`, [conversationId])).rows[0];
  if (!conv || conv.is_test) return;
  const analysis = entity.call_analysis ?? entity.chat_analysis ?? {};
  const custom = analysis.custom_analysis_data ?? {};
  const externalId = conv.external_id;

  // Live tools already saved the request mid-call? Then analysis adds nothing.
  const live = await pool.query(
    `SELECT id FROM cc_requests WHERE conversation_id = $1 AND source = 'live_tool' LIMIT 1`,
    [conversationId],
  );
  if (live.rows[0]) {
    await logCcEvent(pool, { conversationId, actorType: "system", type: "analysis_skipped", data: { reason: "live_tool request exists", requestId: live.rows[0].id } });
    return;
  }

  // Explicit staff outcomes are never reopened by stale analysis.
  const staffDone = await pool.query(
    `SELECT id FROM cc_requests WHERE conversation_id = $1 AND (staff_locked OR state IN ('resolved','closed_no_action')) LIMIT 1`,
    [conversationId],
  );
  if (staffDone.rows[0]) {
    await logCcEvent(pool, { conversationId, actorType: "system", type: "analysis_skipped", data: { reason: "staff-owned outcome exists" } });
    return;
  }

  const intent = custom.intent ?? null;
  const { kind, queue } = intentQueue(intent);
  const wrongBrand = /wrong[_ ]?brand/i.test(String(intent ?? ""));
  const { needs, why } = analysisNeedsTask(custom, entity);
  if (wrongBrand || !needs) {
    await logCcEvent(pool, { conversationId, actorType: "system", type: "analysis_no_task", data: { intent, why: wrongBrand ? "wrong_brand" : why } });
    return;
  }

  const contactId = await suggestContact(pool, {
    phone: conv.from_number, name: custom.contact_name ?? null, businessName: custom.business_name ?? null,
  });
  if (contactId && !conv.contact_id) {
    await pool.query(`UPDATE cc_conversations SET contact_id = $2, updated_at = NOW() WHERE id = $1`, [conversationId, contactId]);
  }

  // A wholesale caller with an existing quote is linked, never re-entered as a new lead.
  let wholesaleRefs: Record<string, unknown> = {};
  if (queue === "wholesale") {
    try {
      const match = await findWholesaleMatch({ phone: conv.from_number, email: null, business: custom.business_name ?? null });
      if (match) wholesaleRefs = { orderRef: match.ref, status: match.status, existing: true };
    } catch { /* best effort — the link can be added by staff */ }
  }

  const contactReq = String(custom.contact_request ?? "").trim() || null;
  await createRequest(pool, {
    conversationId, contactId,
    kind, queue,
    reason: queue === "wholesale" ? (wholesaleRefs.existing ? "quote_question" : "needs_quote") : "callback",
    concern: custom.inquiry_summary ?? analysis.call_summary ?? analysis.chat_summary ?? null,
    intent,
    productRefs: custom.product_request ? [{ name: String(custom.product_request) }] : [],
    orderReference: custom.order_reference ?? null,
    wholesaleRefs,
    // The model's time wording is kept verbatim; nothing is normalized without
    // a timezone, so ambiguous requests stay visibly needs_scheduling.
    callbackWindowRaw: contactReq,
    needsScheduling: !!contactReq,
    source: "webhook_analysis",
    idempotencyKey: `analysis:${externalId}`,
  });
}

/* ------------------------------------------------------------------ */
/* Inbox processing                                                    */
/* ------------------------------------------------------------------ */

export async function applyInboxEvent(pool: Pool, row: { id: number; event_type: string; payload: any }): Promise<void> {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  const eventType = row.event_type;
  const entity = payload?.call ?? payload?.chat ?? null;
  if (!entity || !(entity.call_id || entity.chat_id)) {
    throw new Error(`event ${eventType} has no call/chat entity`);
  }
  const channel = channelOf(payload);
  const conversationId = await upsertConversation(pool, entity, { channel, eventType });

  if (eventType.startsWith("transfer_")) {
    await logCcEvent(pool, {
      conversationId, actorType: "provider", actor: eventType, type: eventType,
      data: { destination: payload.transfer_destination ?? null, option: payload.transfer_option ?? null },
    });
    return;
  }
  await logCcEvent(pool, { conversationId, actorType: "provider", actor: "retell", type: eventType, data: { inboxId: row.id } });

  if (eventType === "call_analyzed" || eventType === "chat_analyzed") {
    await routeAnalysis(pool, conversationId, entity);
  }
}

export async function processInboxOnce(pool: Pool, batch = 25): Promise<number> {
  const claimed = await pool.query(
    `UPDATE cc_webhook_inbox SET status = 'processing', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM cc_webhook_inbox
         WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
         ORDER BY id ASC LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, event_type, external_id, payload, attempts`,
    [batch],
  );
  let okCount = 0;
  for (const row of claimed.rows) {
    try {
      await applyInboxEvent(pool, row);
      await pool.query(`UPDATE cc_webhook_inbox SET status = 'processed', processed_at = NOW(), last_error = NULL WHERE id = $1`, [row.id]);
      okCount++;
    } catch (e: any) {
      const dead = row.attempts >= MAX_ATTEMPTS;
      const backoffSec = Math.min(30 * 2 ** row.attempts, 3600);
      await pool.query(
        `UPDATE cc_webhook_inbox SET status = $2, last_error = $3, next_attempt_at = NOW() + make_interval(secs => $4) WHERE id = $1`,
        [row.id, dead ? "dead" : "failed", String(e.message).slice(0, 500), backoffSec],
      );
      console.error(`[OPS][CC] inbox ${row.id} ${row.event_type} failed (attempt ${row.attempts}${dead ? ", DEAD-LETTERED" : ""}): ${e.message}`);
    }
  }
  return okCount;
}

/* ------------------------------------------------------------------ */
/* Reconciliation + resumable backfill                                 */
/* ------------------------------------------------------------------ */

const OVERLAP_MS = 15 * 60_000;

export async function reconcileOnce(pool: Pool, opts: { full?: boolean } = {}): Promise<{ calls: number; chats: number }> {
  if (!retellCfg()) return { calls: 0, chats: 0 };
  const agents = knownAgentIds();
  const wmKey = opts.full ? "backfill_watermark" : "reconcile_watermark";
  const state = (await getSyncState(pool, wmKey)) ?? {};
  const lower = opts.full ? 0 : Math.max(0, Number(state.upper ?? Date.now() - 24 * 3600_000) - OVERLAP_MS);
  const runStart = Date.now();

  let calls = 0;
  let paginationKey: string | undefined = opts.full ? state.cursor ?? undefined : undefined;
  try {
    for (let page = 0; page < 8; page++) {
      const body: any = { sort_order: "descending", limit: 200 };
      if (paginationKey) body.pagination_key = paginationKey;
      body.filter_criteria = { start_timestamp: { lower_threshold: lower } };
      let rows: any[];
      try {
        rows = await retell.listCalls(body);
      } catch (e) {
        if (e instanceof RetellRateLimited) break; // next tick resumes
        // Schema drift fallback: current docs say filter_criteria, but if the
        // API rejects ours, pull unfiltered and stop at the watermark locally.
        delete body.filter_criteria;
        rows = await retell.listCalls(body);
        rows = rows.filter((c) => Number(c.start_timestamp ?? 0) >= lower);
      }
      if (!rows.length) { paginationKey = undefined; break; }
      for (const call of rows) {
        if (call.agent_id && !agents.has(String(call.agent_id))) continue; // RP workspace agents only
        await upsertConversation(pool, call, { channel: "voice", eventType: "reconcile" });
        calls++;
      }
      paginationKey = rows[rows.length - 1]?.call_id;
      if (!paginationKey || rows.length < 200) { paginationKey = undefined; break; }
    }
  } catch (e: any) {
    console.error("[OPS][CC] reconcile calls failed:", e.message);
  }

  let chats = 0;
  try {
    const allChats = await retell.listChats();
    for (const chat of allChats) {
      if (chat.agent_id && !agents.has(String(chat.agent_id))) continue;
      if (!opts.full && Number(chat.start_timestamp ?? 0) < lower) continue;
      await upsertConversation(pool, chat, { channel: "chat", eventType: "reconcile" });
      chats++;
    }
  } catch (e: any) {
    console.error("[OPS][CC] reconcile chats failed:", e.message);
  }

  await setSyncState(pool, wmKey, { upper: runStart, cursor: paginationKey ?? null, lastRun: new Date().toISOString(), calls, chats });
  return { calls, chats };
}

/** Optional retention: scrub transcripts/recordings/analysis + inbox payloads. */
export async function applyRetentionOnce(pool: Pool): Promise<void> {
  const days = parseInt(process.env.CC_RETENTION_DAYS || "0", 10);
  if (!days || days < 30) return; // unset or implausibly small → keep everything
  await pool.query(
    `UPDATE cc_conversations SET transcript = NULL, transcript_object = NULL, recording_url = NULL, analysis = NULL
      WHERE started_at < NOW() - make_interval(days => $1) AND (transcript IS NOT NULL OR recording_url IS NOT NULL OR analysis IS NOT NULL)`,
    [days],
  );
  await pool.query(`DELETE FROM cc_webhook_inbox WHERE received_at < NOW() - make_interval(days => $1)`, [days]);
}

export function startCallCenterLoops(): void {
  const pool = defaultPool;
  setInterval(() => {
    processInboxOnce(pool).catch((e) => console.error(`[OPS][CC] inbox loop crashed: ${e.message}`));
  }, 10_000);
  setInterval(() => {
    reconcileOnce(pool).catch((e) => console.error(`[OPS][CC] reconcile loop crashed: ${e.message}`));
  }, 10 * 60_000);
  setInterval(() => {
    applyRetentionOnce(pool).catch((e) => console.error(`[OPS][CC] retention loop crashed: ${e.message}`));
  }, 6 * 3600_000);
  console.log("[OPS][CC] call-center loops armed (inbox 10s, reconcile 10m, retention 6h)");
}
