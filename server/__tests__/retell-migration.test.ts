/**
 * Retell versioned-list migration tests (2026-10-12): the deprecated legacy
 * list endpoints are gone; these prove the new wrapper and the reconciler
 * behave per the migration spec — items envelopes, opaque-cursor paging,
 * channel filters, the chat POST switch, loud failures instead of empty
 * successes, idempotent replays, and a checkpoint that never advances past
 * an unpersisted page. Network is fully mocked; scratch Postgres only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from "vitest";
import pg from "pg";

import { retell, assertListPage, listPagesPost, RetellAuthError, channelFilter } from "../callcenter-retell";
import { ensureCallCenterTables, getSyncState, setSyncState } from "../callcenter-db";
import { reconcileOnce } from "../callcenter-worker";

const DB_URL = process.env.CC_TEST_DATABASE_URL || "postgresql://localhost:5432/ops_callcenter_dev";
const pool = new pg.Pool({ connectionString: DB_URL });
const FRONT_DESK = "agent_067b4ec911fad52c81d22a0535";
const CHAT_DESK = "agent_63e95e33b57ce9105b3e1c9264";

type MockRoute = (url: string, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | null;
let routes: MockRoute[] = [];
const seen: Array<{ url: string; method: string; body: any }> = [];

beforeAll(async () => {
  await ensureCallCenterTables(pool);
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    seen.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    for (const r of routes) {
      const hit = r(u, init);
      if (hit) {
        return new Response(JSON.stringify(hit.body ?? {}), {
          status: hit.status ?? 200,
          headers: { "Content-Type": "application/json", ...(hit.headers ?? {}) },
        });
      }
    }
    throw new Error(`unmocked fetch: ${init.method ?? "GET"} ${u}`);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});
beforeEach(async () => {
  routes = [];
  seen.length = 0;
  await pool.query(`TRUNCATE cc_conversations, cc_events, cc_sync_state RESTART IDENTITY CASCADE`);
});
afterEach(() => vi.useRealTimers());

const page = (items: unknown[], pagination_key: string | null, has_more: boolean) => ({ items, pagination_key, has_more });
const call = (id: string, ts: number, agent = FRONT_DESK) => ({ call_id: id, agent_id: agent, call_status: "ended", start_timestamp: ts, direction: "inbound" });
const chat = (id: string, ts: number, agent = CHAT_DESK) => ({ chat_id: id, agent_id: agent, chat_status: "ended", start_timestamp: ts });

describe("versioned list envelope", () => {
  it("parses items and refuses legacy arrays, auth bodies and malformed shapes", () => {
    expect(assertListPage(page([1, 2], null, false), "/x").items).toEqual([1, 2]);
    for (const bad of [[{ a: 1 }], { items: "no" }, { items: [] }, null, "html", { has_more: true }]) {
      expect(() => assertListPage(bad, "/x")).toThrow(/unexpected list response shape/);
    }
  });

  it("traverses every page, preserving filters and treating cursors as opaque", async () => {
    routes = [(u, i) => {
      if (!u.endsWith("/v3/list-calls")) return null;
      const b = JSON.parse(String(i.body));
      expect(b.filter_criteria.start_timestamp.op).toBe("bt"); // filters survive every page
      if (!b.pagination_key) return { body: page([call("c1", 5)], "cur%or 1", true) };
      if (b.pagination_key === "cur%or 1") return { body: page([call("c2", 4)], "k2", true) };
      expect(b.pagination_key).toBe("k2");
      return { body: page([call("c3", 3)], null, false) };
    }];
    const got: string[] = [];
    for await (const items of listPagesPost("/v3/list-calls", { limit: 200, filter_criteria: { start_timestamp: { type: "range", op: "bt", value: [0, 10] } } })) {
      got.push(...items.map((c: any) => c.call_id));
    }
    expect(got).toEqual(["c1", "c2", "c3"]);
  });

  it("fails loudly on a stuck cursor instead of looping or truncating", async () => {
    routes = [(u) => (u.endsWith("/v3/list-calls") ? { body: page([call("c1", 1)], "same", true) } : null)];
    const run = async () => { for await (const _ of listPagesPost("/v3/list-calls", {})) void _; };
    await expect(run()).rejects.toThrow(/did not advance/);
  });

  it("maps 401 to an auth error, never an empty success", async () => {
    routes = [() => ({ status: 401, body: { error: "bad key" } })];
    await expect(retell.listPhoneNumbers()).rejects.toThrow(RetellAuthError);
  });

  it("waits out one rate-limit using Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    routes = [(u) => {
      if (!u.endsWith("/v3/list-calls")) return null;
      return ++n === 1 ? { status: 429, headers: { "Retry-After": "1" }, body: {} } : { body: page([], null, false) };
    }];
    const run = (async () => { for await (const _ of listPagesPost("/v3/list-calls", {})) void _; })();
    await vi.advanceTimersByTimeAsync(1100);
    await run;
    expect(n).toBe(2);
  });
});

describe("unified agent list", () => {
  it("POSTs /v2/list-agents with the documented channel filter and no pagination_key_version", async () => {
    routes = [(u) => (u.endsWith("/v2/list-agents") ? { body: page([{ agent_id: FRONT_DESK }], null, false) } : null)];
    await retell.listAgents("voice");
    const r = seen.find((s) => s.url.endsWith("/v2/list-agents"))!;
    expect(r.method).toBe("POST");
    expect(r.body.filter_criteria).toEqual(channelFilter("voice"));
    expect(r.body.filter_criteria.channel.value).toBe("voice");
    expect("pagination_key_version" in r.body).toBe(false);
    expect(channelFilter("chat").channel.value).toBe("chat");
  });
});

describe("reconciliation on v3", () => {
  const mockCalls = (pages: Record<string, { items: unknown[]; next: string | null }>) => (u: string, i: RequestInit) => {
    if (!u.endsWith("/v3/list-calls")) return null;
    const key = JSON.parse(String(i.body)).pagination_key ?? "first";
    const p = pages[key];
    return p ? { body: page(p.items, p.next, p.next !== null) } : { body: page([], null, false) };
  };
  const mockChats = (items: unknown[]) => (u: string) => (u.endsWith("/v3/list-chats") ? { body: page(items, null, false) } : null);
  const noEnrich = (u: string) => (u.includes("/get-chat/") ? { body: null } : null);

  it("lists chats via POST, upserts both streams, dedupes replays and advances the watermark", async () => {
    const ts = Date.now() - 60_000;
    routes = [mockCalls({ first: { items: [call("c_a", ts), call("c_a", ts), call("c_other", ts, "agent_not_ours")], next: null } }), mockChats([chat("ch_a", ts)]), noEnrich];
    const r1 = await reconcileOnce(pool);
    expect(r1.calls).toBe(2); // same id twice = two upserts, ONE row
    expect(r1.chats).toBe(1);
    const chatReq = seen.find((s) => s.url.endsWith("/v3/list-chats"))!;
    expect(chatReq.method).toBe("POST"); // the method change the migration demands
    const rows = await pool.query(`SELECT external_id, channel FROM cc_conversations ORDER BY external_id`);
    expect(rows.rows.map((r) => r.external_id)).toEqual(["c_a", "ch_a"]); // foreign agent excluded, no dupes
    const wm = await getSyncState(pool, "reconcile_watermark");
    expect(wm.lastRunAdvanced).toBe(true);
    expect(Number(wm.upper)).toBeGreaterThan(0);

    seen.length = 0;
    const r2 = await reconcileOnce(pool); // replay of the overlap window
    expect((await pool.query(`SELECT count(*)::int AS n FROM cc_conversations`)).rows[0].n).toBe(2);
    expect(r2.calls).toBeLessThanOrEqual(2);
  });

  it("does NOT advance the watermark when one stream fails, and recovers the window later", async () => {
    const ts = Date.now() - 60_000;
    await setSyncState(pool, "reconcile_watermark", { upper: ts - 3600_000 });
    routes = [mockCalls({ first: { items: [call("c_ok", ts)], next: null } }), (u) => (u.endsWith("/v3/list-chats") ? { status: 500, body: { error: "boom" } } : null)];
    await reconcileOnce(pool);
    const wm = await getSyncState(pool, "reconcile_watermark");
    expect(wm.lastRunAdvanced).toBe(false);
    expect(Number(wm.upper)).toBe(ts - 3600_000); // checkpoint held
    expect(wm.lastError).toMatch(/500|boom/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM cc_conversations WHERE external_id = 'c_ok'`)).rows[0].n).toBe(1); // partial work kept, retryable

    routes = [mockCalls({ first: { items: [], next: null } }), mockChats([chat("ch_late", ts)]), noEnrich];
    await reconcileOnce(pool);
    const wm2 = await getSyncState(pool, "reconcile_watermark");
    expect(wm2.lastRunAdvanced).toBe(true); // clean run moves it
    expect((await pool.query(`SELECT count(*)::int AS n FROM cc_conversations WHERE external_id = 'ch_late'`)).rows[0].n).toBe(1);
  });

  it("enriches ended chats with transcripts via get-chat (v3 lists omit them) and preserves staff fields", async () => {
    const ts = Date.now() - 60_000;
    routes = [
      mockCalls({ first: { items: [], next: null } }),
      mockChats([chat("ch_t", ts)]),
      (u) => (u.endsWith("/get-chat/ch_t") ? { body: { ...chat("ch_t", ts), transcript: "agent: hi\nuser: hello" } } : null),
    ];
    await reconcileOnce(pool);
    const row1 = await pool.query(`SELECT id, transcript FROM cc_conversations WHERE external_id = 'ch_t'`);
    expect(row1.rows[0].transcript).toContain("hello");

    // Staff-owned fields survive a replay of the same provider record (follow-up
    // requests live in cc_requests, which reconcile never writes — preserved by construction).
    await pool.query(`UPDATE cc_conversations SET is_test = TRUE, issue_type = 'wholesale', intent = 'callback' WHERE external_id = 'ch_t'`);
    await reconcileOnce(pool);
    const row2 = await pool.query(`SELECT is_test, issue_type, intent, transcript FROM cc_conversations WHERE external_id = 'ch_t'`);
    expect(row2.rows[0]).toMatchObject({ is_test: true, issue_type: "wholesale", intent: "callback" });
    expect(row2.rows[0].transcript).toContain("hello");
  });

  it("returns empty cleanly when Retell has nothing in the window", async () => {
    routes = [mockCalls({}), mockChats([])];
    const r = await reconcileOnce(pool);
    expect(r).toEqual({ calls: 0, chats: 0 });
    expect((await getSyncState(pool, "reconcile_watermark")).lastRunAdvanced).toBe(true);
  });
});
