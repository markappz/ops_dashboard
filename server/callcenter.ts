/**
 * Call Center staff API — /api/ops/realpeptides/callcenter/* (behind opsGate:
 * admins full, viewers read-only, plus the realpeptides:call-center grant for
 * follow-up work). UI lives in client/src/pages/callcenter/.
 */
import type { Express, Request, Response } from "express";
import { pool } from "./db";
import {
  createRequest, logCcEvent, getSyncState, setSyncState,
  REQUEST_STATES, CALL_OUTCOMES, QUEUES,
} from "./callcenter-db";
import { processInboxOnce, reconcileOnce } from "./callcenter-worker";
import { retellCfg, retell, RP_VOICE_AGENTS, RP_CHAT_AGENTS } from "./callcenter-retell";
import { commerceHealth } from "./callcenter-commerce";
import { verifyChannelPing } from "./callcenter-tools";

const BUSINESS_TZ = "America/New_York";

function daysParam(req: Request, dflt = 30): number {
  return Math.min(365, Math.max(1, parseInt(String(req.query.days ?? dflt), 10) || dflt));
}

const adminOf = (req: Request): string => (req as any).adminEmail || "ops";

export function registerCallCenterRoutes(app: Express) {
  /* ---------------- overview ---------------- */

  app.get("/api/ops/realpeptides/callcenter/overview", async (req, res) => {
    try {
      const days = daysParam(req);
      const [convs, byDay, byIntent, reqStats, overdue, attempts] = await Promise.all([
        pool.query(
          `SELECT channel,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE provider_status = 'ended' AND COALESCE(disconnect_reason,'') NOT ILIKE '%error%')::int AS answered,
                  COUNT(*) FILTER (WHERE COALESCE(disconnect_reason,'') ILIKE '%error%' OR provider_status = 'error')::int AS failed
             FROM cc_conversations
            WHERE NOT is_test AND brand = 'realpeptides'
              AND COALESCE(started_at, created_at) >= NOW() - make_interval(days => $1)
            GROUP BY channel`,
          [days],
        ),
        pool.query(
          `SELECT to_char(COALESCE(started_at, created_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS day,
                  COUNT(*)::int AS calls
             FROM cc_conversations
            WHERE NOT is_test AND brand = 'realpeptides'
              AND COALESCE(started_at, created_at) >= NOW() - make_interval(days => $1)
            GROUP BY 1 ORDER BY 1`,
          [days, BUSINESS_TZ],
        ),
        pool.query(
          `SELECT COALESCE(intent, '(none)') AS intent, COUNT(*)::int AS n
             FROM cc_conversations
            WHERE NOT is_test AND brand = 'realpeptides'
              AND COALESCE(started_at, created_at) >= NOW() - make_interval(days => $1)
            GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
          [days],
        ),
        pool.query(
          `SELECT state, queue, COUNT(*)::int AS n FROM cc_requests
            WHERE brand = 'realpeptides' AND created_at >= NOW() - make_interval(days => $1)
            GROUP BY state, queue`,
          [days],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM cc_requests
            WHERE brand = 'realpeptides' AND state NOT IN ('resolved','closed_no_action')
              AND ((due_at IS NOT NULL AND due_at < NOW()) OR (callback_at IS NOT NULL AND callback_at < NOW()))`,
        ),
        pool.query(
          `SELECT outcome, COUNT(*)::int AS n FROM cc_call_attempts
            WHERE created_at >= NOW() - make_interval(days => $1) GROUP BY outcome`,
          [days],
        ),
      ]);
      const totalCalls = convs.rows.filter((r) => r.channel === "voice").reduce((a, r) => a + r.total, 0);
      res.json({
        rangeDays: days,
        timezone: BUSINESS_TZ,
        channels: convs.rows,
        byDay: byDay.rows,
        byIntent: byIntent.rows,
        requests: reqStats.rows,
        overdue: overdue.rows[0].n,
        attempts: attempts.rows,
        // explicit math so nobody re-derives it differently: zero-call days count
        avgDailyCalls: { value: +(totalCalls / days).toFixed(2), numerator: totalCalls, denominatorDays: days, note: `voice conversations ÷ ${days} calendar days (${BUSINESS_TZ}), test sessions excluded` },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- conversations ---------------- */

  app.get("/api/ops/realpeptides/callcenter/conversations", async (req, res) => {
    try {
      const days = daysParam(req, 30);
      const where: string[] = [`c.brand = 'realpeptides'`, `COALESCE(c.started_at, c.created_at) >= NOW() - make_interval(days => $1)`];
      const params: any[] = [days];
      const add = (cond: string, v: any) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
      if (req.query.channel) add(`c.channel = ?`, String(req.query.channel));
      if (req.query.agent) add(`c.agent_id = ?`, String(req.query.agent));
      if (req.query.intent) add(`c.intent ILIKE ?`, `%${req.query.intent}%`);
      if (req.query.status) add(`c.provider_status = ?`, String(req.query.status));
      if (String(req.query.test ?? "") !== "include") where.push(`NOT c.is_test`);
      if (req.query.q) {
        params.push(`%${String(req.query.q).trim()}%`);
        const p = `$${params.length}`;
        where.push(`(c.from_number ILIKE ${p} OR c.summary ILIKE ${p} OR c.external_id ILIKE ${p} OR ct.name ILIKE ${p} OR ct.email_norm ILIKE ${p} OR ct.business_name ILIKE ${p})`);
      }
      if (req.query.followup === "open") where.push(`EXISTS (SELECT 1 FROM cc_requests r WHERE r.conversation_id = c.id AND r.state NOT IN ('resolved','closed_no_action'))`);
      if (req.query.followup === "none") where.push(`NOT EXISTS (SELECT 1 FROM cc_requests r WHERE r.conversation_id = c.id)`);
      const page = Math.max(0, parseInt(String(req.query.page ?? 0), 10) || 0);
      params.push(50, page * 50);
      const rows = await pool.query(
        `SELECT c.id, c.external_id, c.channel, c.call_type, c.direction, c.from_number, c.agent_id, c.agent_name,
                c.started_at, c.ended_at, c.duration_ms, c.provider_status, c.disconnect_reason, c.summary, c.intent,
                c.analysis_status, c.is_test, ct.name AS contact_name, ct.business_name,
                (SELECT COUNT(*)::int FROM cc_requests r WHERE r.conversation_id = c.id) AS request_count,
                (SELECT MIN(r.state) FROM cc_requests r WHERE r.conversation_id = c.id AND r.state NOT IN ('resolved','closed_no_action')) AS open_state
           FROM cc_conversations c LEFT JOIN cc_contacts ct ON ct.id = c.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(c.started_at, c.created_at) DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({ conversations: rows.rows, page, agents: { ...RP_VOICE_AGENTS, ...RP_CHAT_AGENTS } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/realpeptides/callcenter/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const conv = (await pool.query(`SELECT c.*, ct.name AS contact_name, ct.business_name, ct.phone_e164, ct.email_norm, ct.verification_state
                                        FROM cc_conversations c LEFT JOIN cc_contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [id])).rows[0];
      if (!conv) return res.status(404).json({ error: "Not found" });
      const [events, requests, tools] = await Promise.all([
        pool.query(`SELECT * FROM cc_events WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT 500`, [id]),
        pool.query(`SELECT r.*, w.id AS wholesale_inquiry_id, w.business_name AS wi_business, w.stage AS wi_stage, w.quote_ref AS wi_quote_ref
                      FROM cc_requests r LEFT JOIN cc_wholesale_inquiries w ON w.request_id = r.id
                     WHERE r.conversation_id = $1 ORDER BY r.id ASC`, [id]),
        pool.query(`SELECT tool, idempotency_key, status, created_at, response->>'customer_message' AS customer_message
                      FROM cc_tool_calls WHERE conversation_external_id = $1 ORDER BY id ASC LIMIT 100`, [conv.external_id]),
      ]);
      res.json({ conversation: conv, events: events.rows, requests: requests.rows, toolCalls: tools.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/realpeptides/callcenter/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (typeof req.body?.is_test !== "boolean") return res.status(400).json({ error: "is_test boolean required" });
      await pool.query(`UPDATE cc_conversations SET is_test = $2, updated_at = NOW() WHERE id = $1`, [id, req.body.is_test]);
      await logCcEvent(pool, { conversationId: id, actorType: "staff", actor: adminOf(req), type: "test_flag", data: { is_test: req.body.is_test } });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- follow-up requests ---------------- */

  app.get("/api/ops/realpeptides/callcenter/requests", async (req, res) => {
    try {
      const view = String(req.query.view ?? "open");
      const me = adminOf(req);
      const where: string[] = [`r.brand = 'realpeptides'`];
      const params: any[] = [];
      const add = (cond: string, v?: any) => { if (v !== undefined) { params.push(v); where.push(cond.replace("?", `$${params.length}`)); } else where.push(cond); };
      if (req.query.queue && QUEUES.includes(String(req.query.queue) as any)) add(`r.queue = ?`, String(req.query.queue));
      switch (view) {
        case "my": add(`r.owner_email = ?`, me); add(`r.state NOT IN ('resolved','closed_no_action')`); break;
        case "unassigned": add(`r.owner_email IS NULL AND r.state NOT IN ('resolved','closed_no_action')`); break;
        case "due_today": add(`r.state NOT IN ('resolved','closed_no_action') AND (r.due_at::date = (NOW() AT TIME ZONE '${BUSINESS_TZ}')::date OR r.callback_at::date = (NOW() AT TIME ZONE '${BUSINESS_TZ}')::date)`); break;
        case "overdue": add(`r.state NOT IN ('resolved','closed_no_action') AND ((r.due_at IS NOT NULL AND r.due_at < NOW()) OR (r.callback_at IS NOT NULL AND r.callback_at < NOW()))`); break;
        case "awaiting": add(`r.state = 'awaiting_customer'`); break;
        case "resolved": add(`r.state IN ('resolved','closed_no_action')`); add(`r.updated_at >= NOW() - interval '30 days'`); break;
        default: add(`r.state NOT IN ('resolved','closed_no_action')`);
      }
      if (req.query.snoozed !== "include") where.push(`(r.snoozed_until IS NULL OR r.snoozed_until < NOW())`);
      const rows = await pool.query(
        `SELECT r.*, c.external_id, c.channel, c.from_number, c.summary AS conversation_summary,
                ct.name AS contact_name, ct.business_name, ct.phone_e164, ct.email_norm,
                (SELECT COUNT(*)::int FROM cc_call_attempts a WHERE a.request_id = r.id) AS attempt_count,
                (SELECT MAX(a.created_at) FROM cc_call_attempts a WHERE a.request_id = r.id) AS last_attempt_at
           FROM cc_requests r
           LEFT JOIN cc_conversations c ON c.id = r.conversation_id
           LEFT JOIN cc_contacts ct ON ct.id = r.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                   COALESCE(r.callback_at, r.due_at, r.created_at) ASC
          LIMIT 200`,
        params,
      );
      res.json({ requests: rows.rows, view });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/callcenter/requests", async (req: any, res) => {
    try {
      const b = req.body ?? {};
      if (!b.concern) return res.status(400).json({ error: "concern is required" });
      const { id } = await createRequest(pool, {
        conversationId: b.conversation_id ?? null,
        contactId: b.contact_id ?? null,
        kind: b.kind, reason: b.reason, queue: b.queue,
        concern: String(b.concern).slice(0, 2000),
        orderReference: b.order_reference ?? null,
        priority: b.priority, ownerEmail: b.owner_email ?? null,
        callbackAt: b.callback_at ? new Date(b.callback_at) : null,
        callbackTz: b.callback_tz ?? null,
        dueAt: b.due_at ? new Date(b.due_at) : null,
        source: "staff",
      });
      res.json({ ok: true, id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/realpeptides/callcenter/requests/:id", async (req: any, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const b = req.body ?? {};
      const me = adminOf(req);
      const cur = (await pool.query(`SELECT * FROM cc_requests WHERE id = $1`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: "Not found" });

      const sets: string[] = ["updated_at = NOW()", "staff_locked = TRUE"];
      const params: any[] = [id];
      const set = (col: string, v: any) => { params.push(v); sets.push(`${col} = $${params.length}`); };

      if (b.owner_email !== undefined) {
        set("owner_email", b.owner_email || null);
        if (b.owner_email && cur.state === "new") set("state", "assigned");
      }
      if (b.state !== undefined) {
        if (!REQUEST_STATES.includes(b.state)) return res.status(400).json({ error: `state must be one of ${REQUEST_STATES.join(", ")}` });
        set("state", b.state);
        if (b.state === "resolved" || b.state === "closed_no_action") {
          set("resolved_at", new Date()); set("resolved_by", me);
          if (b.resolution) set("resolution", String(b.resolution).slice(0, 2000));
        }
      } else if (b.resolution !== undefined) set("resolution", String(b.resolution).slice(0, 2000));
      if (b.snooze_until !== undefined) {
        set("snoozed_until", b.snooze_until ? new Date(b.snooze_until) : null);
        set("snooze_reason", b.snooze_reason ? String(b.snooze_reason).slice(0, 300) : null);
      }
      if (b.callback_at !== undefined) {
        set("callback_at", b.callback_at ? new Date(b.callback_at) : null);
        set("callback_tz", b.callback_tz ?? cur.callback_tz ?? BUSINESS_TZ);
        set("needs_scheduling", false);
        if (b.callback_at && !["resolved", "closed_no_action"].includes(b.state ?? cur.state)) set("state", "scheduled");
      }
      if (b.due_at !== undefined) set("due_at", b.due_at ? new Date(b.due_at) : null);
      if (b.priority !== undefined) set("priority", String(b.priority));
      if (b.queue !== undefined && QUEUES.includes(b.queue)) set("queue", b.queue);
      if (b.order_reference !== undefined) set("order_reference", b.order_reference || null);

      await pool.query(`UPDATE cc_requests SET ${sets.join(", ")} WHERE id = $1`, params);
      await logCcEvent(pool, { requestId: id, conversationId: cur.conversation_id, actorType: "staff", actor: me, type: "request_updated", data: b });
      if (b.note) {
        await logCcEvent(pool, { requestId: id, conversationId: cur.conversation_id, actorType: "staff", actor: me, type: "note", data: { note: String(b.note).slice(0, 4000) } });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Record a human callback attempt. Clicking Call NEVER resolves the task. */
  app.post("/api/ops/realpeptides/callcenter/requests/:id/attempts", async (req: any, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const outcome = String(req.body?.outcome ?? "attempted");
      if (!CALL_OUTCOMES.includes(outcome as any)) return res.status(400).json({ error: `outcome must be one of ${CALL_OUTCOMES.join(", ")}` });
      const cur = (await pool.query(`SELECT conversation_id, contact_id FROM cc_requests WHERE id = $1`, [id])).rows[0];
      if (!cur) return res.status(404).json({ error: "Not found" });
      // double-click guard: identical outcome within 20s is the same attempt
      const dup = await pool.query(
        `SELECT id FROM cc_call_attempts WHERE request_id = $1 AND staff_email = $2 AND outcome = $3 AND created_at > NOW() - interval '20 seconds'`,
        [id, adminOf(req), outcome],
      );
      if (dup.rows[0]) return res.json({ ok: true, id: dup.rows[0].id, deduped: true });
      const ins = await pool.query(
        `INSERT INTO cc_call_attempts (request_id, contact_id, staff_email, provider, outcome, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, cur.contact_id, adminOf(req), String(req.body?.provider ?? "manual"), outcome, req.body?.notes ? String(req.body.notes).slice(0, 2000) : null],
      );
      await pool.query(`UPDATE cc_requests SET state = CASE WHEN state = 'new' THEN 'in_progress' WHEN state = 'assigned' THEN 'in_progress' ELSE state END, staff_locked = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
      await logCcEvent(pool, { requestId: id, conversationId: cur.conversation_id, actorType: "staff", actor: adminOf(req), type: "call_attempt", data: { outcome } });
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- wholesale view ---------------- */

  app.get("/api/ops/realpeptides/callcenter/wholesale", async (req, res) => {
    try {
      const rows = await pool.query(
        `SELECT w.*, r.state, r.queue, r.owner_email, r.priority, r.callback_window_raw, r.created_at AS requested_at,
                r.conversation_id, c.external_id, c.channel, c.from_number
           FROM cc_wholesale_inquiries w
           JOIN cc_requests r ON r.id = w.request_id
           LEFT JOIN cc_conversations c ON c.id = r.conversation_id
          ORDER BY w.created_at DESC LIMIT 200`,
      );
      res.json({ inquiries: rows.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ---------------- settings + health ---------------- */

  app.get("/api/ops/realpeptides/callcenter/health", async (_req, res) => {
    try {
      const [inbox, lastHook, watermarks, dests, verifyPing, verifyLast, verifyDelivered] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int AS n FROM cc_webhook_inbox GROUP BY status`),
        pool.query(`SELECT MAX(received_at) AS at FROM cc_webhook_inbox`),
        pool.query(`SELECT key, value, updated_at FROM cc_sync_state WHERE key IN ('reconcile_watermark','backfill_watermark')`),
        getSyncState(pool, "handoff_destinations"),
        verifyChannelPing(),
        getSyncState(pool, "verify_last_send"),
        pool.query(`SELECT MAX(sent_at) AS at FROM cc_verifications WHERE delivery_status = 'delivered'`),
      ]);
      let phone: any = { connected: false, note: "No phone number is attached in Retell — the public line still rings Google Voice. Porting/purchase is a Paul decision, not automated here." };
      if (retellCfg()) {
        try {
          const nums = await retell.listPhoneNumbers();
          if (nums.length) phone = { connected: true, numbers: nums.map((n: any) => n.phone_number_pretty ?? n.phone_number) };
        } catch { phone = { connected: false, note: "Retell unreachable" }; }
      }
      res.json({
        retell: { configured: !!retellCfg(), agents: Object.keys(RP_VOICE_AGENTS).length + Object.keys(RP_CHAT_AGENTS).length },
        webhook: {
          url: `${process.env.OPS_PUBLIC_BASE_URL || "https://ops.fitscript.me"}/api/integrations/retell/webhook`,
          lastReceived: lastHook.rows[0].at,
          inbox: Object.fromEntries(inbox.rows.map((r) => [r.status, r.n])),
        },
        reconcile: watermarks.rows,
        phone,
        sms: { connected: false, note: "Two-way SMS needs a connected messaging number/provider (Google Voice does not forward SMS into Retell). Shows here once configured and tested." },
        dialer: { connected: false, note: "Human browser dialer needs a telephony provider (e.g. Twilio Voice JS SDK) + approved caller ID. Until then Call buttons offer a labeled tel: fallback and log attempts manually." },
        // Three distinct truths, never conflated: env present, endpoint
        // answering, and a real send actually accepted/delivered.
        verification: {
          connected: verifyPing.configured && verifyPing.reachable,
          configured: verifyPing.configured,
          reachable: verifyPing.reachable,
          lastSend: verifyLast ?? null,
          lastConfirmedDelivery: verifyDelivered.rows[0].at,
          note: !verifyPing.configured
            ? "Order-verification codes ride the RP site's /api/ops-transactional (defaults from RP_SITE_API_URL + RP_SITE_OPS_TOKEN; CC_VERIFY_WEBHOOK_URL/TOKEN override)."
            : !verifyPing.reachable
              ? `Configured but the endpoint isn't answering${verifyPing.detail ? ` (${verifyPing.detail})` : ""} — has the RP site build with /api/ops-transactional deployed?`
              : "Endpoint reachable. Send status tracks to provider-accepted; inbox receipt is confirmed manually in the E2E check (the engine doesn't store delivered events).",
        },
        sendResource: { connected: false, note: "send-requested-resource stays disabled until an approved SMS/email channel is connected." },
        commerce: commerceHealth(),
        handoffDestinations: dests ?? [],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/realpeptides/callcenter/deadletters", async (_req, res) => {
    try {
      const rows = await pool.query(
        `SELECT id, event_type, external_id, attempts, last_error, received_at FROM cc_webhook_inbox
          WHERE status IN ('dead','failed') ORDER BY received_at DESC LIMIT 100`,
      );
      res.json({ rows: rows.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/callcenter/inbox/:id/replay", async (req: any, res) => {
    try {
      const r = await pool.query(
        `UPDATE cc_webhook_inbox SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL WHERE id = $1 RETURNING id`,
        [parseInt(String(req.params.id), 10)],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/callcenter/reconcile", async (_req, res) => {
    try {
      const out = await reconcileOnce(pool);
      await processInboxOnce(pool);
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/callcenter/backfill", async (_req, res) => {
    try {
      const out = await reconcileOnce(pool, { full: true });
      res.json({ ok: true, ...out, note: "Resumable — run again to continue from the stored cursor." });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/realpeptides/callcenter/settings", async (req: any, res) => {
    try {
      if (Array.isArray(req.body?.handoff_destinations)) {
        const dests = req.body.handoff_destinations.slice(0, 20).map((d: any) => ({
          key: String(d.key ?? "").slice(0, 60),
          label: String(d.label ?? "").slice(0, 120),
          number: String(d.number ?? "").slice(0, 30),
          hours: d.hours ? String(d.hours).slice(0, 120) : null,
          enabled: !!d.enabled,
        })).filter((d: any) => d.key && d.label);
        await setSyncState(pool, "handoff_destinations", dests);
        await logCcEvent(pool, { actorType: "staff", actor: adminOf(req), type: "settings_updated", data: { handoff_destinations: dests.length } });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
