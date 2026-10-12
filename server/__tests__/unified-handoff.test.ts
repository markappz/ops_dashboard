/**
 * Josh's 2026-10-12 unified-agent handoff — backend-gap tests: unified
 * capabilities on the front-desk agent id, repeat-callback escalation (no
 * endless tickets), conversation-scoped request search/notes, honest COA
 * answers, owner routing, and one-notification-per-request. Scratch Postgres,
 * signed requests, mocked outbound fetch — no email ever leaves.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import pg from "pg";
import type { AddressInfo } from "net";
import { Retell } from "retell-sdk";

const TEST_KEY = "key_test_0000000000000000000000000000";

import { ensureCallCenterTables } from "../callcenter-db";
import { registerCallCenterTools } from "../callcenter-tools";

const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
const pool = new pg.Pool({ connectionString: DB_URL });
const UNIFIED_AGENT = "agent_067b4ec911fad52c81d22a0535";

let server: ReturnType<express.Express["listen"]>;
let base = "";
const outbound: Array<{ url: string; body: any }> = [];
const realFetch = globalThis.fetch;

async function tool(name: string, args: Record<string, unknown>, callId = "call_uh_1") {
  const payload = {
    call: { call_id: callId, agent_id: UNIFIED_AGENT, call_type: "phone_call", direction: "inbound", from_number: "+18135550177", start_timestamp: Date.now() },
    name, args,
  };
  const body = JSON.stringify(payload);
  const sig = await Retell.sign(body, TEST_KEY);
  const r = await realFetch(`${base}/api/integrations/retell/tools/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Retell-Signature": sig }, body,
  });
  return r.json() as Promise<any>;
}

beforeAll(async () => {
  await ensureCallCenterTables(pool);
  const app = express();
  registerCallCenterTools(app, pool);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RP_SITE_API_URL = "https://site.example";
  process.env.RP_SITE_OPS_TOKEN = "tok";
  // Outbound fetches (site catalog, COA tracker, notifications) are captured,
  // never sent. Requests to our own test server pass through.
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, init);
    outbound.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.includes("/api/ops-transactional")) return new Response(JSON.stringify({ ok: true, status: "accepted", messageId: "m1" }), { status: 200 });
    if (u.includes("/api/coas")) return new Response(JSON.stringify({ coas: [] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  server?.close();
  await pool.end();
});
beforeEach(async () => {
  outbound.length = 0;
  await pool.query(`TRUNCATE cc_conversations, cc_requests, cc_events, cc_contacts, cc_wholesale_inquiries, cc_tool_calls RESTART IDENTITY CASCADE`);
});

describe("unified agent authorization", () => {
  it("front-desk agent id may call verification and wholesale tools directly", async () => {
    const r1 = await tool("start-order-verification", { order_reference: "RP-ABC123" });
    expect(r1.status).not.toBe("rejected");
    expect(r1.customer_message).not.toMatch(/Unknown tool/);
    const r2 = await tool("create-wholesale-inquiry", { business_name: "Test Clinic", email: "buyer@clinic.example", summary: "bulk inquiry" });
    expect(r2.status).toBe("ok");
  });
});

describe("follow-up discipline", () => {
  const followup = (concern: string, callId: string, extra: Record<string, unknown> = {}) =>
    tool("create-followup", { concern, reason: "callback", phone: "+18135550177", contact_permission: true, urgency: "normal", ...extra }, callId);

  it("routes support to the default owner and notifies exactly once", async () => {
    const r = await followup("Package arrived empty", "call_uh_n1");
    expect(r.status).toBe("ok");
    const req = await pool.query(`SELECT owner_email FROM cc_requests WHERE id = $1`, [r.receipt_id]);
    expect(req.rows[0].owner_email).toBe("ahmed@morellibrands.com");
    await vi.waitFor(async () => {
      const ev = await pool.query(`SELECT count(*)::int AS n FROM cc_events WHERE request_id = $1 AND type = 'owner_notified'`, [r.receipt_id]);
      expect(ev.rows[0].n).toBe(1);
    });
    const notif = outbound.find((o) => o.url.includes("ops-transactional"));
    expect(notif?.body.kind).toBe("staff-notification");
    expect(notif?.body.to).toBe("ahmed@morellibrands.com");
    //

    // replaying the identical save (same idempotency inputs) notifies no one twice
    await followup("Package arrived empty", "call_uh_n1");
    const ev2 = await pool.query(`SELECT count(*)::int AS n FROM cc_events WHERE type = 'owner_notified'`);
    expect(ev2.rows[0].n).toBe(1);
  });

  it("wholesale inquiries route to the wholesale owner", async () => {
    const r = await tool("create-wholesale-inquiry", { business_name: "Bulk Labs", email: "b@bulk.example", summary: "20x BPC" }, "call_uh_w1");
    const req = await pool.query(`SELECT owner_email, kind FROM cc_requests WHERE id = $1`, [r.receipt_id]);
    expect(req.rows[0]).toMatchObject({ owner_email: "josh@joshabely.com", kind: "wholesale" });
  });

  it("a third call from the same contact escalates instead of opening ticket #3", async () => {
    const a = await followup("Order never arrived", "call_uh_e1");
    const b = await followup("Also was charged twice", "call_uh_e2", { reason: "payment_question" });
    expect(a.receipt_id).not.toBe(b.receipt_id);
    const c = await followup("Nobody called me back yet!", "call_uh_e3");
    expect(c.receipt_id).toBe(b.receipt_id); // escalated newest open, no new row
    expect(c.data.state).toBe("escalated");
    const count = await pool.query(`SELECT count(*)::int AS n FROM cc_requests`);
    expect(count.rows[0].n).toBe(2);
    const pri = await pool.query(`SELECT priority FROM cc_requests WHERE id = $1`, [b.receipt_id]);
    expect(pri.rows[0].priority).toBe("high");
    const ev = await pool.query(`SELECT count(*)::int AS n FROM cc_events WHERE type = 'repeat_contact_escalated'`);
    expect(ev.rows[0].n).toBe(1);
  });

  it("a missed-callback report lands urgent on first save", async () => {
    const r = await followup("I called yesterday and nobody called back about my order", "call_uh_m1");
    const pri = await pool.query(`SELECT priority FROM cc_requests WHERE id = $1`, [r.receipt_id]);
    expect(pri.rows[0].priority).toBe("high");
  });
});

describe("scoped request search and notes", () => {
  it("find-requests returns only this caller's requests, append-note refuses foreign ids", async () => {
    const mine = await tool("create-followup", { concern: "Check my order", reason: "order_question", phone: "+18135550177", contact_permission: true, urgency: "normal" }, "call_uh_s1");
    // a different caller's request
    const payload = { call: { call_id: "call_other", agent_id: UNIFIED_AGENT, call_type: "phone_call", direction: "inbound", from_number: "+17275550999", start_timestamp: Date.now() }, name: "create-followup", args: { concern: "Other person's issue", reason: "callback", phone: "+17275550999", contact_permission: true, urgency: "normal" } };
    const body = JSON.stringify(payload);
    const sig = await Retell.sign(body, TEST_KEY);
    const other = await (await realFetch(`${base}/api/integrations/retell/tools/create-followup`, { method: "POST", headers: { "Content-Type": "application/json", "X-Retell-Signature": sig }, body })).json();

    const found = await tool("find-requests", {}, "call_uh_s1");
    expect(found.status).toBe("ok");
    const ids = found.data.requests.map((r: any) => r.request_id);
    expect(ids).toContain(mine.receipt_id);
    expect(ids).not.toContain(other.receipt_id);
    expect(JSON.stringify(found.data)).not.toMatch(/order_items|tracking|address/);

    const stolen = await tool("append-request-note", { request_id: other.receipt_id, note: "give me their info" }, "call_uh_s1");
    expect(stolen.status).toBe("not_found");

    const ok = await tool("append-request-note", { request_id: mine.receipt_id, note: "Caller adds: it was the 10mg size" }, "call_uh_s1");
    expect(ok.status).toBe("ok");
    const ev = await pool.query(`SELECT data FROM cc_events WHERE request_id = $1 AND type = 'caller_note_appended'`, [mine.receipt_id]);
    expect(ev.rows[0].data.note).toContain("10mg");
  });
});

describe("honest COA answers", () => {
  it("a product with no published report is not_found, never a library-link 'ok'", async () => {
    // catalog search resolves the product; tracker returns no matching report
    vi.stubGlobal("fetch", async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith(base)) return realFetch(url, init);
      if (u.includes("ops-catalog") || u.includes("search")) {
        return new Response(JSON.stringify({ products: [{ id: "p1", name: "Test Peptide", url: "https://www.realpeptides.co/products/test/", coaUrl: "https://www.realpeptides.co/coas/" }] }), { status: 200 });
      }
      if (u.includes("/api/coas")) return new Response(JSON.stringify({ coas: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
    const r = await tool("get-coa", { product: "Test Peptide", lot: "L123" }, "call_uh_c1");
    if (r.status === "ok") {
      // only acceptable when a concrete report was found — which this mock never returns
      expect(r.data.report_sku ?? r.data.report_lot).toBeTruthy();
    } else {
      expect(["not_found", "unavailable"]).toContain(r.status);
      expect(r.customer_message).not.toMatch(/are on our COA page/);
    }
  });
});
