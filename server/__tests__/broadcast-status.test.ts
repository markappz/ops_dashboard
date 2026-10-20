/**
 * Campaign #81 regression suite (2026-10-13): the ALB cut a synchronous
 * 34k-recipient dispatch at its idle timeout; ops recorded send_failed and
 * "no sends" for a campaign Mailgun fully delivered. These tests pin the
 * rebuilt contract: transport errors are AMBIGUOUS (never a failure verdict),
 * send_failed requires engine-confirmed zero evidence, partials are labeled
 * partials, retries can never double-send, and the reconciler repairs stale
 * state from evidence alone. Scratch Postgres + fully mocked engine.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import pg from "pg";

process.env.OPS_BROADCAST_POLL_MS = "30";
process.env.OPS_BROADCAST_POLL_BUDGET_MS = "2000";

import { firePlan, reconcilePendingSends, reconcilePlanFromEvidence, broadcastVerdict, broadcastHtmlProblem } from "../realpeptides-marketing";
import { EngineRefusal } from "../brand-engines";
import { pool } from "../db";

const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
const scratch = new pg.Pool({ connectionString: DB_URL });

type EngineScript = {
  dispatch?: (body: any) => { status?: number; body: any };
  status?: (tag: string) => { status?: number; body: any };
  tagStats?: (tag: string) => any;
};
let engine: EngineScript = {};
let dispatches: any[] = [];

beforeAll(async () => {
  await scratch.query(`
    CREATE TABLE IF NOT EXISTS ops_email_plans (
      id SERIAL PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, subject TEXT,
      preheader TEXT, status TEXT NOT NULL DEFAULT 'idea', send_date DATE, send_time TEXT,
      from_address TEXT, audience_id TEXT, html TEXT, notes TEXT, resend_broadcast_id TEXT,
      created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      send_tz TEXT, sent_count INT, total_count INT, status_note TEXT)`);
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.includes("/api/ops-marketing")) throw new Error(`unmocked fetch ${u}`);
    const qs = new URL(u).searchParams;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      dispatches.push(body);
      const r = engine.dispatch?.(body) ?? { body: { error: "no dispatch script" }, status: 500 };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    if (qs.get("what") === "broadcast-status") {
      const r = engine.status?.(qs.get("tag")!) ?? { body: { tag: qs.get("tag"), status: "UNKNOWN" } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    if (qs.get("what") === "tag-stats") {
      return new Response(JSON.stringify(engine.tagStats?.(qs.get("tag")!) ?? { sent: 0, delivered: 0, bounced: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await scratch.end();
  await pool.end().catch(() => {});
});
beforeEach(async () => {
  engine = {};
  dispatches = [];
  await scratch.query(`TRUNCATE ops_email_plans RESTART IDENTITY`);
});

async function plan(status = "sending"): Promise<{ id: number; title: string | null; subject: string | null; html: string | null; audience_id: string | null }> {
  const r = await scratch.query(
    `INSERT INTO ops_email_plans (company, title, subject, html, status) VALUES ('realpeptides', 'BPC-157 vs. TB-500', 'BPC-157 vs. TB-500 🧬', '<p>hi {{{unsubscribeUrl}}}</p>', $1) RETURNING id, title, subject, html, audience_id`,
    [status],
  );
  return r.rows[0];
}
const rowOf = async (id: number) => (await scratch.query(`SELECT status, status_note, sent_count, total_count, resend_broadcast_id FROM ops_email_plans WHERE id = $1`, [id])).rows[0];

describe("verdict mapping", () => {
  it("distinguishes total failure, partial and completed; zero-evidence is the only failure", () => {
    expect(broadcastVerdict({ status: "COMPLETED", sent: 100, of: 100 }).status).toBe("sent");
    expect(broadcastVerdict({ status: "PARTIAL", sent: 60, of: 100 }).status).toBe("sent_partial");
    expect(broadcastVerdict({ status: "FAILED", sent: 40, of: 100 }).status).toBe("sent_partial");
    expect(broadcastVerdict({ status: "FAILED", sent: 0, of: 100 }).status).toBe("send_failed");
    expect(broadcastVerdict({ status: "SENDING", sent: 10, of: 100 }).status).toBe("sending");
  });
});

describe("firePlan", () => {
  it("writes the tag BEFORE dispatch and completes async jobs as sent", async () => {
    const p = await plan();
    let polls = 0;
    engine.dispatch = () => ({ body: { async: true, accepted: true, jobId: "j1", tag: "t", status: "QUEUED", sent: 0, of: 34476 } });
    engine.status = (tag) => ({ body: { tag, status: ++polls < 2 ? "SENDING" : "COMPLETED", sent: 34476, of: 34476 } });
    const out = await firePlan("realpeptides", p, "test");
    const row = await rowOf(p.id);
    expect(row.resend_broadcast_id).toMatch(/^ops-1-/);
    expect(row.status).toBe("sent");
    expect(row.sent_count).toBe(34476);
    expect(out.sent).toBe(34476);
  });

  it("ackAfterDispatch (human click): returns dispatched immediately, background poll still lands the verdict", async () => {
    const p = await plan();
    engine.dispatch = () => ({ body: { async: true, accepted: true, jobId: "j9", tag: "t", status: "QUEUED", sent: 0, of: 50476 } });
    engine.status = (tag) => ({ body: { tag, status: "COMPLETED", sent: 50476, of: 50476 } });
    const out = await firePlan("realpeptides", p, "paul", { ackAfterDispatch: true });
    expect(out.dispatched).toBe(true);
    expect(out.of).toBe(50476);
    expect((await rowOf(p.id)).status).toBe("sending"); // honest interim state at ack time
    await vi.waitFor(async () => {
      const row = await rowOf(p.id);
      expect(row.status).toBe("sent");
      expect(row.sent_count).toBe(50476);
    }, { timeout: 2000 });
  });

  it("#81 regression: a 504 at dispatch leaves 'sending' + tag — NEVER send_failed", async () => {
    const p = await plan();
    engine.dispatch = () => ({ status: 504, body: { error: "upstream timeout" } });
    await firePlan("realpeptides", p, "scheduler");
    const row = await rowOf(p.id);
    expect(row.status).toBe("sending");
    expect(row.status_note).toMatch(/NOT marked failed/);
    expect(row.resend_broadcast_id).toMatch(/^ops-1-/); // analytics linkage survives the failure
  });

  it("partial batch failure lands sent_partial with honest counts", async () => {
    const p = await plan();
    engine.dispatch = () => ({ body: { async: true, accepted: true, tag: "t", status: "QUEUED", sent: 0, of: 1000 } });
    engine.status = (tag) => ({ body: { tag, status: "PARTIAL", sent: 600, of: 1000 } });
    await firePlan("realpeptides", p, "test");
    const row = await rowOf(p.id);
    expect(row.status).toBe("sent_partial");
    expect(row.sent_count).toBe(600);
    expect(row.status_note).toMatch(/partial: 600\/1000/);
  });

  it("legacy synchronous engines still mark sent from the direct response", async () => {
    const p = await plan();
    engine.dispatch = () => ({ body: { sent: 120, of: 120, tag: "t" } }); // no async flag
    await firePlan("pawgen" in {} ? "pawgen" : "realpeptides", p, "test");
    expect((await rowOf(p.id)).status).toBe("sent");
  });

  it("repeated execution (retry / concurrent scheduler) cannot double-send: engine idempotency is honored", async () => {
    const p = await plan();
    let accepted = 0;
    engine.dispatch = () => {
      const first = dispatches.length === 1;
      if (first) accepted++;
      return { body: { async: true, accepted: first, tag: "t", status: first ? "QUEUED" : "COMPLETED", sent: first ? 0 : 500, of: 500 } };
    };
    engine.status = (tag) => ({ body: { tag, status: "COMPLETED", sent: 500, of: 500 } });
    await firePlan("realpeptides", p, "manual");
    await firePlan("realpeptides", p, "scheduler"); // same plan again
    expect(accepted).toBe(1); // only one real dispatch was ever accepted
    expect((await rowOf(p.id)).status).toBe("sent");
  });

  it("ambiguous poll timeouts exhaust the budget into 'sending', never a verdict", async () => {
    const p = await plan();
    engine.dispatch = () => ({ body: { async: true, accepted: true, tag: "t", status: "QUEUED", sent: 0, of: 10 } });
    engine.status = () => ({ status: 502, body: { error: "gateway" } });
    await firePlan("realpeptides", p, "test");
    const row = await rowOf(p.id);
    expect(row.status).toBe("sending");
    expect(row.status_note).toMatch(/reconciler/);
  });
});

describe("reconciliation", () => {
  it("failure after acceptance but before persistence: stale 'sending' resolves to sent from job evidence", async () => {
    const p = await plan("sending");
    await scratch.query(`UPDATE ops_email_plans SET resend_broadcast_id = 'ops-1-x', updated_at = NOW() - interval '20 minutes' WHERE id = $1`, [p.id]);
    engine.status = (tag) => ({ body: { tag, status: "COMPLETED", sent: 34476, of: 34476 } });
    const fixed = await reconcilePendingSends();
    expect(fixed).toBe(1);
    const row = await rowOf(p.id);
    expect(row.status).toBe("sent");
    expect(row.sent_count).toBe(34476);
  });

  it("pre-job-era campaign (the actual #81 repair): send_failed flips to sent on ledger evidence, with no dispatch", async () => {
    const p = await plan("send_failed");
    await scratch.query(`UPDATE ops_email_plans SET resend_broadcast_id = NULL WHERE id = $1`, [p.id]);
    engine.status = (tag) => ({ body: { tag, status: "UNKNOWN" } });
    engine.tagStats = () => ({ sent: 34476, delivered: 34463, bounced: 13 });
    const out = await reconcilePlanFromEvidence(p.id);
    expect(out.status).toBe("sent");
    expect(out.note).toMatch(/34476 sent, 34463 delivered, 13 bounced/);
    expect(dispatches.length).toBe(0); // evidence-only: nothing was sent to do this
    expect((await rowOf(p.id)).status).toBe("sent");
  });

  it("plan #98 regression: an engine 4xx refusal is DEFINITIVE — send_failed with the engine's reason, surfaced to the caller", async () => {
    const p = await plan();
    engine.dispatch = () => ({ status: 400, body: { error: "full-document broadcast HTML must include an {{{unsubscribeUrl}}} unsubscribe link" } });
    await expect(firePlan("realpeptides", p, "josh")).rejects.toThrow(EngineRefusal);
    const row = await rowOf(p.id);
    expect(row.status).toBe("send_failed");
    expect(row.status_note).toMatch(/engine refused: .*unsubscribeUrl/);
  });

  it("plan #98 regression: ops refuses a full-document HTML with no unsubscribe link BEFORE dispatch", async () => {
    const r = await scratch.query(
      `INSERT INTO ops_email_plans (company, title, subject, html, status) VALUES ('realpeptides', 'Halloween launch', 'Spooky 🎃', '<!doctype html><html><body>sale</body></html>', 'approved') RETURNING id, title, subject, html, audience_id`,
    );
    const p = r.rows[0];
    await expect(firePlan("realpeptides", p, "josh")).rejects.toThrow(/unsubscribe link/);
    expect(dispatches.length).toBe(0); // never reached the engine
    const row = await rowOf(p.id);
    expect(row.status).toBe("send_failed");
    expect(row.status_note).toMatch(/refused before dispatch/);
  });

  it("broadcastHtmlProblem: fragments pass (engine shell adds the footer), full docs need a token in any accepted form", () => {
    expect(broadcastHtmlProblem("<p>hi</p>")).toBeNull();
    expect(broadcastHtmlProblem(null)).toBeNull();
    expect(broadcastHtmlProblem("<!doctype html><html><body>x</body></html>")).toMatch(/unsubscribe/);
    expect(broadcastHtmlProblem('<html><body><a href="{{{unsubscribeUrl}}}">out</a></body></html>')).toBeNull();
    expect(broadcastHtmlProblem('<html><body><a href="{{unsubscribeUrl}}">out</a></body></html>')).toBeNull();
    expect(broadcastHtmlProblem('<!DOCTYPE html><body>{{{RESEND_UNSUBSCRIBE_URL}}}</body>')).toBeNull();
  });

  it("true zero-evidence failure stays send_failed", async () => {
    const p = await plan("sending");
    await scratch.query(`UPDATE ops_email_plans SET resend_broadcast_id = 'ops-1-x', updated_at = NOW() - interval '20 minutes' WHERE id = $1`, [p.id]);
    engine.status = (tag) => ({ body: { tag, status: "UNKNOWN" } });
    engine.tagStats = () => ({ sent: 0, delivered: 0, bounced: 0 });
    await reconcilePendingSends();
    const row = await rowOf(p.id);
    expect(row.status).toBe("send_failed");
    expect(row.status_note).toMatch(/no engine job and no ledger activity/);
  });
});
