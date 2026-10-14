/**
 * Hades support handoff (2026-10-13): authorization matrix for the
 * realpeptides:call-center grant, required resolution notes, structured
 * contact corrections with provenance, email_status capture, correction-
 * notification dedupe, and the 96h email-recovery audit. Scratch Postgres;
 * staff identity injected as the support login would be by requireAuth.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import pg from "pg";
import type { AddressInfo } from "net";

import { permitsRequest } from "../admin-auth";
import { ensureCallCenterTables, createRequest, suggestContact } from "../callcenter-db";
import { registerCallCenterRoutes } from "../callcenter";

const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
const pool = new pg.Pool({ connectionString: DB_URL });
const HADES = "support@realpeptides.co";
const GRANT = ["realpeptides:call-center"];

let server: ReturnType<express.Express["listen"]>;
let base = "";
const outbound: any[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureCallCenterTables(pool);
  process.env.RP_SITE_API_URL = "https://site.example";
  process.env.RP_SITE_OPS_TOKEN = "tok";
  const app = express();
  app.use(express.json());
  // requireAuth stand-in: the authenticated support login, as prod attaches it.
  app.use((req: any, _res, next) => { req.adminEmail = HADES; req.role = "viewer"; next(); });
  registerCallCenterRoutes(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(base) || u.startsWith("http://127.0.0.1")) return realFetch(url, init);
    outbound.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, status: "accepted", messageId: "m1" }), { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  server?.close();
  await pool.end();
});
beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 60));
  outbound.length = 0;
  await pool.query(`TRUNCATE cc_conversations, cc_requests, cc_events, cc_contacts, cc_call_attempts RESTART IDENTITY CASCADE`);
});

async function mkRequest(withEmail = false): Promise<number> {
  const contactId = await suggestContact(pool, { phone: "+18135550144", email: withEmail ? "cust@example.com" : null, name: "Pat Caller" });
  const { id } = await createRequest(pool, {
    contactId, kind: "support", reason: "order_question", concern: "Where is my order RP-ABC123?",
    orderReference: "RP-ABC123", ownerEmail: "ahmed@morellibrands.com", source: "live_tool",
    contactPermission: true,
  });
  return id;
}
const api = (path: string, method = "PATCH", body?: unknown) =>
  realFetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

describe("authorization matrix (permitsRequest — same check requireAuth runs)", () => {
  it("the grant opens exactly the four support mutations", () => {
    expect(permitsRequest(GRANT, "PATCH", "/api/ops/realpeptides/callcenter/requests/12")).toBe(true);
    expect(permitsRequest(GRANT, "POST", "/api/ops/realpeptides/callcenter/requests")).toBe(true);
    expect(permitsRequest(GRANT, "POST", "/api/ops/realpeptides/callcenter/requests/12/attempts")).toBe(true);
    expect(permitsRequest(GRANT, "PATCH", "/api/ops/realpeptides/callcenter/conversations/9")).toBe(true);
  });
  it("and nothing else — no settings, replay, backfill, audit, other brands, finance or admin", () => {
    for (const [m, p] of [
      ["PATCH", "/api/ops/realpeptides/callcenter/settings"],
      ["POST", "/api/ops/realpeptides/callcenter/inbox/3/replay"],
      ["POST", "/api/ops/realpeptides/callcenter/backfill"],
      ["POST", "/api/ops/realpeptides/callcenter/email-audit"],
      ["POST", "/api/ops/realpeptides/coa/upload"],
      ["POST", "/api/ops/pawgen/orders/9/refund"],
      ["POST", "/api/ops/finance/entries"],
      ["PATCH", "/api/ops/admins/someone"],
      ["POST", "/api/ops/email-plans/1/send-rp"],
    ] as const) {
      expect(permitsRequest(GRANT, m, p)).toBe(false);
    }
  });
  it("an account with no grants mutates nothing", () => {
    expect(permitsRequest([], "PATCH", "/api/ops/realpeptides/callcenter/requests/12")).toBe(false);
  });
});

describe("support workflow", () => {
  it("resolving without an outcome note is refused; with one it resolves, audited as the actual actor", async () => {
    const id = await mkRequest();
    const bad = await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { state: "resolved" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/resolution note is required/);
    expect((await pool.query(`SELECT state FROM cc_requests WHERE id = $1`, [id])).rows[0].state).toBe("assigned"); // owner set at create

    const ok = await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { state: "resolved", resolution: "Reshipped missing vial, customer confirmed." });
    expect(ok.status).toBe(200);
    const row = (await pool.query(`SELECT state, resolution, resolved_by FROM cc_requests WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ state: "resolved", resolved_by: HADES });
    const ev = await pool.query(`SELECT actor FROM cc_events WHERE request_id = $1 AND type = 'request_updated'`, [id]);
    expect(ev.rows[0].actor).toBe(HADES);

    // reopen works and is audited too
    const re = await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { state: "in_progress", note: "Customer called back — still missing." });
    expect(re.status).toBe(200);
    expect((await pool.query(`SELECT state FROM cc_requests WHERE id = $1`, [id])).rows[0].state).toBe("in_progress");
  });

  it("a no-answer attempt stays open and never resolves", async () => {
    const id = await mkRequest();
    const r = await api(`/api/ops/realpeptides/callcenter/requests/${id}/attempts`, "POST", { outcome: "no_answer" });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT state FROM cc_requests WHERE id = $1`, [id])).rows[0];
    expect(["in_progress", "new", "assigned"]).toContain(row.state);
    expect(row.state).not.toBe("resolved");
  });

  it("a contact correction persists on the contact with provenance and flips email_status", async () => {
    const id = await mkRequest(false);
    const r = await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { contact_email: "Pat.Caller@Example.com", contact_phone: "813-555-0199" });
    expect(r.status).toBe(200);
    const c = (await pool.query(`SELECT ct.email_norm, ct.phone_e164, r.email_status FROM cc_requests r JOIN cc_contacts ct ON ct.id = r.contact_id WHERE r.id = $1`, [id])).rows[0];
    expect(c.email_norm).toBe("pat.caller@example.com");
    expect(c.phone_e164).toMatch(/\+1813555\d+/);
    expect(c.email_status).toBe("confirmed");
    const ev = await pool.query(`SELECT data FROM cc_events WHERE request_id = $1 AND type = 'contact_corrected'`, [id]);
    expect(ev.rows[0].data.source).toBe("staff");
    expect(ev.rows[0].data.before).toBeTruthy();
  });

  it("a correction on an already-notified open request sends ONE labeled update, deduped on repeat", async () => {
    const id = await mkRequest(false);
    await pool.query(`INSERT INTO cc_events (request_id, actor_type, actor, type, data) VALUES ($1,'system','ops','owner_notified','{}')`, [id]);
    await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { contact_email: "fixed@example.com" });
    await vi.waitFor(async () => {
      const n = await pool.query(`SELECT count(*)::int AS n FROM cc_events WHERE request_id = $1 AND type = 'owner_update_notified'`, [id]);
      expect(n.rows[0].n).toBe(1);
    });
    await api(`/api/ops/realpeptides/callcenter/requests/${id}`, "PATCH", { contact_email: "fixed@example.com" }); // unchanged
    await new Promise((r) => setTimeout(r, 120));
    const n2 = await pool.query(`SELECT count(*)::int AS n FROM cc_events WHERE request_id = $1 AND type = 'owner_update_notified'`, [id]);
    expect(n2.rows[0].n).toBe(1);
    const update = outbound.find((o) => o.body?.update === "contact-correction");
    expect(update?.body.email).toBe("fixed@example.com");
  });
});

describe("96h email-recovery audit", () => {
  it("dry-run finds transcript evidence, flags ambiguity, marks phone-only; apply adopts only explicit", async () => {
    const mk = async (transcript: string | null, createdOffsetH: number) => {
      const conv = await pool.query(
        `INSERT INTO cc_conversations (provider, external_id, brand, channel, transcript) VALUES ('retell', 'c_' || gen_random_uuid(), 'realpeptides', 'voice', $1) RETURNING id`, [transcript]);
      const contactId = await suggestContact(pool, { phone: "+1813555" + String(1000 + Math.floor(Math.random() * 8999)) });
      const { id } = await createRequest(pool, { conversationId: conv.rows[0].id, contactId, kind: "support", reason: "callback", concern: "help", source: "live_tool" });
      await pool.query(`UPDATE cc_requests SET created_at = NOW() - make_interval(hours => $2) WHERE id = $1`, [id, createdOffsetH]);
      return id;
    };
    const explicit = await mk("agent: best email? user: it is jane.doe@gmail.com thanks", 10);
    const ambiguous = await mk("user: try a@x.com or maybe b@y.com", 10);
    const none = await mk("user: just call me back", 10);
    const old = await mk("user: old.caller@gmail.com", 120); // outside 96h — untouched

    const dry = await (await api(`/api/ops/realpeptides/callcenter/email-audit`, "POST", {})).json();
    expect(dry.dryRun).toBe(true);
    expect(dry.applied.map((a: any) => a.request)).toEqual([explicit]);
    expect(dry.applied[0]).toMatchObject({ email: "jane.doe@gmail.com", applied: false });
    expect(dry.candidates.map((c: any) => c.request)).toContain(ambiguous);
    expect(dry.phoneOnly.map((p: any) => p.request)).toContain(none);
    const touched = [...dry.applied, ...dry.candidates, ...dry.phoneOnly].map((x: any) => x.request);
    expect(touched).not.toContain(old); // outside the 96h cutoff — untouched

    const applied = await (await api(`/api/ops/realpeptides/callcenter/email-audit`, "POST", { apply: true })).json();
    expect(applied.dryRun).toBe(false);
    const got = (await pool.query(`SELECT ct.email_norm, r.email_status FROM cc_requests r JOIN cc_contacts ct ON ct.id = r.contact_id WHERE r.id = $1`, [explicit])).rows[0];
    expect(got).toMatchObject({ email_norm: "jane.doe@gmail.com", email_status: "confirmed" });
    const prov = await pool.query(`SELECT data FROM cc_events WHERE request_id = $1 AND type = 'contact_corrected'`, [explicit]);
    expect(prov.rows[0].data.source).toBe("transcript_backfill_96h");
    const amb = (await pool.query(`SELECT ct.email_norm FROM cc_requests r JOIN cc_contacts ct ON ct.id = r.contact_id WHERE r.id = $1`, [ambiguous])).rows[0];
    expect(amb.email_norm).toBeNull(); // never auto-copied
    expect((await pool.query(`SELECT email_status FROM cc_requests WHERE id = $1`, [none])).rows[0].email_status).toBe("unavailable");
  });
});
