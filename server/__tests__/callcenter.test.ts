/**
 * Call Center integration tests — real Express routes, real Postgres (scratch),
 * mocked external calls (no customer is ever dialed or messaged from tests).
 *
 *   createdb ops_callcenter_dev   (or set CC_TEST_DATABASE_URL)
 *   npm test
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import pg from "pg";
import type { AddressInfo } from "net";
import { Retell } from "retell-sdk";

// env comes from setup-env.ts (vitest setupFiles) — it runs before these imports
const TEST_KEY = "key_test_0000000000000000000000000000";

import { ensureCallCenterTables, createRequest, normalizePhone } from "../callcenter-db";
import { registerCallCenterWebhook } from "../callcenter-webhook";
import { registerCallCenterTools } from "../callcenter-tools";
import { processInboxOnce, applyInboxEvent, intentQueue, analysisNeedsTask } from "../callcenter-worker";
import { normalizeProductQuery } from "../callcenter-commerce";

const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
const pool = new pg.Pool({ connectionString: DB_URL });

const FRONT_DESK = "agent_067b4ec911fad52c81d22a0535";
const SUPPORT = "agent_aa811252242b2dca1907ff78ea";
const EDUCATION = "agent_934983123a41ba27f58830f6df";

let server: ReturnType<express.Express["listen"]>;
let base = "";

async function signedPost(path: string, payload: unknown, opts: { key?: string; timestamp?: number } = {}) {
  const body = JSON.stringify(payload);
  const sig = await Retell.sign(body, opts.key ?? TEST_KEY);
  const finalSig = opts.timestamp ? sig.replace(/^v=\d+/, `v=${opts.timestamp}`) : sig;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Retell-Signature": finalSig },
    body,
  });
}

function callPayload(event: string, overrides: Record<string, any> = {}) {
  return {
    event,
    call: {
      call_id: overrides.call_id ?? "call_test_1",
      call_type: "phone_call",
      agent_id: overrides.agent_id ?? FRONT_DESK,
      direction: "inbound",
      from_number: "+18135550100",
      to_number: "+18133300290",
      start_timestamp: 1760000000000,
      ...overrides,
    },
  };
}

beforeAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS cc_events, cc_call_attempts, cc_verifications, cc_tool_calls, cc_wholesale_inquiries, cc_webhook_inbox, cc_requests, cc_conversations, cc_contacts, cc_sync_state, cc_config_audit CASCADE`);
  await ensureCallCenterTables(pool as any);
  const app = express();
  registerCallCenterWebhook(app, pool as any);
  registerCallCenterTools(app, pool as any);
  app.use(express.json());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await pool.end();
});

/* ------------------------------------------------------------------ */

describe("webhook signature", () => {
  it("accepts a correctly signed event and persists it before 2xx", async () => {
    const r = await signedPost("/api/integrations/retell/webhook", callPayload("call_started"));
    expect(r.status).toBe(204);
    const row = await pool.query(`SELECT * FROM cc_webhook_inbox WHERE external_id = 'call_test_1'`);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].status).toBe("pending");
  });

  it("rejects a missing signature", async () => {
    const r = await fetch(`${base}/api/integrations/retell/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(callPayload("call_started")),
    });
    expect(r.status).toBe(401);
  });

  it("rejects a signature made with the wrong key", async () => {
    const r = await signedPost("/api/integrations/retell/webhook", callPayload("call_started"), { key: "key_wrong_000000000000000000000000000" });
    expect(r.status).toBe(401);
  });

  it("rejects a replayed (stale-timestamp) signature", async () => {
    const r = await signedPost("/api/integrations/retell/webhook", callPayload("call_started"), { timestamp: Date.now() - 10 * 60_000 });
    expect(r.status).toBe(401);
  });

  it("ignores signed events from agents outside the RP workspace allowlist", async () => {
    const r = await signedPost("/api/integrations/retell/webhook", callPayload("call_started", { call_id: "call_foreign", agent_id: "agent_someoneelse" }));
    expect(r.status).toBe(202);
    const row = await pool.query(`SELECT * FROM cc_webhook_inbox WHERE external_id = 'call_foreign'`);
    expect(row.rows.length).toBe(0);
  });
});

describe("inbox processing: duplicates, ordering, analysis", () => {
  it("a duplicate delivery dedupes to one inbox row", async () => {
    const payload = callPayload("call_ended", { call_id: "call_dup", end_timestamp: 1760000060000, duration_ms: 60000, call_status: "ended" });
    await signedPost("/api/integrations/retell/webhook", payload);
    await signedPost("/api/integrations/retell/webhook", payload);
    const rows = await pool.query(`SELECT * FROM cc_webhook_inbox WHERE external_id = 'call_dup'`);
    expect(rows.rows.length).toBe(1);
  });

  it("end before start, then analysis: ONE conversation, fields merged, one task", async () => {
    const id = "call_ooo";
    // end arrives first (dial failures can even arrive with no start at all)
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_ended", payload: callPayload("call_ended", { call_id: id, call_status: "ended", end_timestamp: 1760000090000, duration_ms: 90000, transcript: "Agent: hello\nUser: I need a callback about Bromantane" }) });
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_started", payload: callPayload("call_started", { call_id: id, call_status: "ongoing" }) });
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_analyzed", payload: callPayload("call_analyzed", {
      call_id: id, call_status: "ended", end_timestamp: 1760000090000,
      call_analysis: { call_summary: "Caller wants a callback about Bromantane.", custom_analysis_data: { intent: "support_callback", human_followup_requested: true, contact_name: "Sam", product_request: "Bromantane", contact_request: "tomorrow morning" } },
    }) });

    const convs = await pool.query(`SELECT * FROM cc_conversations WHERE external_id = $1`, [id]);
    expect(convs.rows.length).toBe(1);
    const c = convs.rows[0];
    expect(c.provider_status).toBe("ended"); // late call_started didn't un-end it
    expect(c.started_at).not.toBeNull();
    expect(c.summary).toContain("Bromantane");

    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = $1`, [c.id]);
    expect(reqs.rows.length).toBe(1);
    expect(reqs.rows[0].queue).toBe("support");
    expect(reqs.rows[0].needs_scheduling).toBe(true); // "tomorrow morning" has no timezone
    expect(reqs.rows[0].callback_window_raw).toBe("tomorrow morning");

    // replaying the same analysis creates no second task
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_analyzed", payload: callPayload("call_analyzed", {
      call_id: id, call_analysis: { call_summary: "dup", custom_analysis_data: { intent: "support_callback", human_followup_requested: true } },
    }) });
    const again = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = $1`, [c.id]);
    expect(again.rows.length).toBe(1);
  });

  it("a purely answered question creates no task; wrong_brand creates no lead", async () => {
    expect(analysisNeedsTask({ action_status: "answered", human_followup_requested: false }, {}).needs).toBe(false);
    expect(intentQueue("wrong_brand").queue).toBe("triage");
    const id = "call_answered";
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_analyzed", payload: callPayload("call_analyzed", {
      call_id: id, call_analysis: { call_summary: "Asked a price, got it.", custom_analysis_data: { intent: "product_price", action_status: "answered", human_followup_requested: "false" } },
    }) });
    const conv = await pool.query(`SELECT id FROM cc_conversations WHERE external_id = $1`, [id]);
    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = $1`, [conv.rows[0].id]);
    expect(reqs.rows.length).toBe(0);
  });

  it("stale analysis never reopens a staff-resolved outcome", async () => {
    const id = "call_staffdone";
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_ended", payload: callPayload("call_ended", { call_id: id, call_status: "ended" }) });
    const conv = (await pool.query(`SELECT id FROM cc_conversations WHERE external_id = $1`, [id])).rows[0];
    const { id: reqId } = await createRequest(pool as any, { conversationId: conv.id, concern: "handled by staff", source: "staff" });
    await pool.query(`UPDATE cc_requests SET state = 'resolved', staff_locked = TRUE, resolution = 'done' WHERE id = $1`, [reqId]);

    await applyInboxEvent(pool as any, { id: 0, event_type: "call_analyzed", payload: callPayload("call_analyzed", {
      call_id: id, call_analysis: { call_summary: "late analysis", custom_analysis_data: { intent: "support", human_followup_requested: true } },
    }) });
    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = $1`, [conv.id]);
    expect(reqs.rows.length).toBe(1);
    expect(reqs.rows[0].state).toBe("resolved");
    expect(reqs.rows[0].resolution).toBe("done");
  });

  it("a live-tool request suppresses the analysis duplicate", async () => {
    const id = "call_livetool";
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_started", payload: callPayload("call_started", { call_id: id }) });
    const conv = (await pool.query(`SELECT id FROM cc_conversations WHERE external_id = $1`, [id])).rows[0];
    await createRequest(pool as any, { conversationId: conv.id, concern: "saved live", source: "live_tool", idempotencyKey: `lt:${id}` });
    await applyInboxEvent(pool as any, { id: 0, event_type: "call_analyzed", payload: callPayload("call_analyzed", {
      call_id: id, call_analysis: { call_summary: "same request", custom_analysis_data: { human_followup_requested: true, intent: "support" } },
    }) });
    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = $1`, [conv.id]);
    expect(reqs.rows.length).toBe(1);
    expect(reqs.rows[0].source).toBe("live_tool");
  });

  it("worker retry path: a poisoned payload fails, backs off, dead-letters after max attempts", async () => {
    await pool.query(
      `INSERT INTO cc_webhook_inbox (provider, event_type, external_id, dedupe_key, payload) VALUES ('retell', 'call_ended', NULL, 'poison-1', '{"event":"call_ended"}')`,
    );
    for (let i = 0; i < 6; i++) {
      await pool.query(`UPDATE cc_webhook_inbox SET next_attempt_at = NOW() WHERE dedupe_key = 'poison-1'`);
      await processInboxOnce(pool as any);
    }
    const row = (await pool.query(`SELECT * FROM cc_webhook_inbox WHERE dedupe_key = 'poison-1'`)).rows[0];
    expect(row.status).toBe("dead");
    expect(row.last_error).toContain("no call/chat entity");
  });
});

describe("agent tools: auth, allowlist, idempotency, verification", () => {
  function toolPayload(agentId: string, callId: string, args: Record<string, any>) {
    return { name: "x", call: { call_id: callId, agent_id: agentId, call_type: "phone_call", from_number: "+18135550111", start_timestamp: 1760000000000 }, args };
  }

  it("rejects an unsigned tool call", async () => {
    const r = await fetch(`${base}/api/integrations/retell/tools/search-products`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toolPayload(FRONT_DESK, "call_t0", { query: "bpc" })),
    });
    expect(r.status).toBe(401);
  });

  it("enforces the server-side capability allowlist (education agent ≠ order data; unknown agent ≠ anything)", async () => {
    const r1 = await signedPost("/api/integrations/retell/tools/get-order-status", toolPayload(EDUCATION, "call_t1", {}));
    expect(r1.status).toBe(403);
    const r2 = await signedPost("/api/integrations/retell/tools/search-products", toolPayload("agent_unknown", "call_t2", { query: "bpc" }));
    expect(r2.status).toBe(403);
    // model args can't spoof authority — the signed envelope's agent wins
    const r3 = await signedPost("/api/integrations/retell/tools/get-order-status", { ...toolPayload(EDUCATION, "call_t3", {}), args: { agent_id: SUPPORT } });
    expect(r3.status).toBe(403);
  });

  it("order status requires a real verification grant on this conversation", async () => {
    const r = await signedPost("/api/integrations/retell/tools/get-order-status", toolPayload(SUPPORT, "call_t4", {}));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.status).toBe("verification_required");
  });

  it("verification stays honest when no delivery channel exists, and wrong codes rate-limit", async () => {
    // findOrder would hit the site feed; stub fetch so no external call happens
    const realFetch = global.fetch;
    vi.stubGlobal("fetch", (async (url: any, init?: any) => {
      if (String(url).includes("site.test")) return new Response(JSON.stringify({ orders: [{ id: "o1", number: "1001", createdAt: "2026-10-01", status: "PAID", items: [], email: "buyer@example.com" }] }), { status: 200 });
      return realFetch(url, init);
    }) as any);
    try {
      const start = await (await signedPost("/api/integrations/retell/tools/start-order-verification", toolPayload(SUPPORT, "call_t5", { order_reference: "1001" }))).json();
      expect(start.status).toBe("unavailable"); // no CC_VERIFY_WEBHOOK_URL → never fabricate a send
      const v = await pool.query(`SELECT * FROM cc_verifications WHERE conversation_external_id = 'call_t5'`);
      expect(v.rows.length).toBe(1);
      // guessing codes burns attempts and never verifies
      for (let i = 0; i < 5; i++) {
        const g = await (await signedPost("/api/integrations/retell/tools/verify-order-access", toolPayload(SUPPORT, "call_t5", { code: "000000" }))).json();
        expect(g.status).toBe("rejected");
      }
      const g6 = await (await signedPost("/api/integrations/retell/tools/verify-order-access", toolPayload(SUPPORT, "call_t5", { code: "000000" }))).json();
      expect(g6.customer_message).toContain("Too many");
      const status = await (await signedPost("/api/integrations/retell/tools/get-order-status", toolPayload(SUPPORT, "call_t5", {}))).json();
      expect(status.status).toBe("verification_required");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("create-followup is idempotent: a provider retry returns the ORIGINAL receipt", async () => {
    const payload = toolPayload(FRONT_DESK, "call_t6", { concern: "Call me about my Bromantane question", phone: "813-555-0111", contact_permission: true });
    const r1 = await (await signedPost("/api/integrations/retell/tools/create-followup", payload)).json();
    expect(r1.status).toBe("ok");
    const r2 = await (await signedPost("/api/integrations/retell/tools/create-followup", payload)).json();
    expect(r2.status).toBe("ok");
    expect(r2.receipt_id ?? r2.data?.request_id).toBe(r1.receipt_id ?? r1.data?.request_id);
    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = (SELECT id FROM cc_conversations WHERE external_id = 'call_t6')`);
    expect(reqs.rows.length).toBe(1);
    expect(reqs.rows[0].source).toBe("live_tool");
  });

  it("an explicitly declined contact request is respected — no task is scheduled", async () => {
    const r = await (await signedPost("/api/integrations/retell/tools/create-followup", toolPayload(FRONT_DESK, "call_t7", { concern: "question", contact_permission: false }))).json();
    expect(r.status).toBe("rejected");
    const reqs = await pool.query(`SELECT * FROM cc_requests WHERE conversation_id = (SELECT id FROM cc_conversations WHERE external_id = 'call_t7')`);
    expect(reqs.rows.length).toBe(0);
  });

  it("handoff options come only from configured destinations (none → callback fallback)", async () => {
    const r = await (await signedPost("/api/integrations/retell/tools/get-handoff-options", toolPayload(FRONT_DESK, "call_t8", {}))).json();
    expect(r.status).toBe("unavailable");
    expect(r.data.destinations).toEqual([]);
  });

  it("send-requested-resource reports honestly that no channel is connected", async () => {
    // not in any agent's capability set yet → allowlist blocks it entirely
    const r = await signedPost("/api/integrations/retell/tools/send-requested-resource", toolPayload(FRONT_DESK, "call_t9", {}));
    expect(r.status).toBe(403);
  });
});

describe("product matching", () => {
  it("fixes the known transcription slips and letter-by-letter spellings", () => {
    expect(normalizeProductQuery("bromatane")).toBe("bromantane");
    expect(normalizeProductQuery("Bromatane")).toBe("bromantane");
    expect(normalizeProductQuery("b r o m a n t a n e")).toBe("bromantane");
    expect(normalizeProductQuery("BPC 157")).toBe("bpc-157");
    expect(normalizeProductQuery("Pinealon")).toBe("pinealon"); // untouched
  });
  it("normalizes phones defensively", () => {
    expect(normalizePhone("(813) 555-0100")).toBe("+18135550100");
    expect(normalizePhone("1-813-555-0100")).toBe("+18135550100");
    expect(normalizePhone(null)).toBeNull();
  });
});
