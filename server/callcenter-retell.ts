/**
 * Retell API client + webhook/tool signature verification for the RP Call Center.
 *
 * All Retell credentials stay server-side. The webhook-verification key may be a
 * different API key than the server key (Retell "webhook badge" keys) — default
 * to the same one. fetch-based like every other integration in this repo; the
 * retell-sdk dependency is used only for its signature verifier/signer, so the
 * exact documented HMAC scheme (v=<ts>,d=<hmac(body+ts)>, 5-min window) is used
 * rather than a hand-rolled copy.
 */
import { Retell } from "retell-sdk";

const API_BASE = "https://api.retellai.com";

export function retellCfg(): { apiKey: string; webhookKey: string } | null {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) return null;
  return { apiKey, webhookKey: process.env.RETELL_WEBHOOK_API_KEY || apiKey };
}

export function verifyRetellSignature(rawBody: string, signature: string | undefined): Promise<boolean> {
  const c = retellCfg();
  if (!c || typeof signature !== "string" || !signature) return Promise.resolve(false);
  return Retell.verify(rawBody, c.webhookKey, signature).catch(() => false);
}

/** Known RP workspace agents (server-side allowlist seed; see callcenter-tools). */
export const RP_VOICE_AGENTS: Record<string, string> = {
  agent_067b4ec911fad52c81d22a0535: "Front Desk — Marissa",
  agent_aa811252242b2dca1907ff78ea: "Customer Support — Grace",
  agent_dbff7019c07d8782878ec50373: "Wholesale — Sloane",
  agent_934983123a41ba27f58830f6df: "Product Education — Sloane",
};
export const RP_CHAT_AGENTS: Record<string, string> = {
  agent_63e95e33b57ce9105b3e1c9264: "Chat Desk — Marissa",
  agent_68c03ff37ba998b8614c589575: "Support Chat — Grace",
  agent_4a61971caaad5b15a227645157: "Wholesale Chat — Sloane",
  agent_0bc0cf30289731847b7c9e6655: "Education Chat — Sloane",
};

export function knownAgentIds(): Set<string> {
  const extra = (process.env.CC_EXTRA_AGENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...Object.keys(RP_VOICE_AGENTS), ...Object.keys(RP_CHAT_AGENTS), ...extra]);
}

export function agentLabel(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return RP_VOICE_AGENTS[agentId] || RP_CHAT_AGENTS[agentId] || null;
}

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const c = retellCfg();
  if (!c) throw new Error("Retell not configured (RETELL_API_KEY)");
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (r.status === 429) throw new RetellRateLimited(path, Number(r.headers.get("retry-after")) || null);
  if (r.status === 401 || r.status === 403) throw new RetellAuthError(path, r.status);
  if (!r.ok) throw new Error(`retell ${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export class RetellRateLimited extends Error {
  constructor(path: string, public retryAfterSec: number | null = null) {
    super(`retell rate-limited on ${path}`);
  }
}

/** 401/403: actionable auth failure — callers must surface it, never retry into it or report empty. */
export class RetellAuthError extends Error {
  constructor(path: string, public status: number) {
    super(`retell auth failed (${status}) on ${path} — check RETELL_API_KEY permissions`);
  }
}

/* ------------------------------------------------------------------ */
/* Versioned list pagination (migration 2026-10-12: Retell removed the
 * legacy top-level-array list endpoints; the replacements return
 * { items, pagination_key, has_more }).                               */
/* ------------------------------------------------------------------ */

export type ListPage<T = any> = { items: T[]; pagination_key?: string | null; has_more: boolean };

/** A list response must be the new envelope. Anything else — a legacy array,
 *  an auth body, HTML — is a FAILURE, never an empty success. */
export function assertListPage<T>(raw: unknown, path: string): ListPage<T> {
  const p = raw as ListPage<T>;
  if (!p || typeof p !== "object" || Array.isArray(p) || !Array.isArray(p.items) || typeof p.has_more !== "boolean") {
    throw new Error(`retell ${path}: unexpected list response shape (expected items/has_more envelope)`);
  }
  return p;
}

const MAX_LIST_PAGES = 25;

/**
 * Page through a versioned POST list endpoint. Filters/sort/limit in `body`
 * are preserved verbatim on every page; only pagination_key changes (cursors
 * are opaque). A stuck or missing cursor while has_more=true is an error —
 * silent truncation and infinite loops are both worse than failing.
 * One bounded 429 wait (Retry-After-aware, ≤15s) per run; beyond that the
 * caller's own retry cadence takes over.
 */
export async function* listPagesPost<T = any>(path: string, body: Record<string, unknown>, opts: { maxPages?: number } = {}): AsyncGenerator<T[]> {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  let cursor: string | undefined;
  let waited = false;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`retell ${path}: more than ${maxPages} pages claimed — refusing to truncate silently`);
    const pageBody = { ...body, ...(cursor ? { pagination_key: cursor } : {}) };
    let raw: unknown;
    try {
      raw = await req<unknown>("POST", path, pageBody, 30_000);
    } catch (e) {
      if (e instanceof RetellRateLimited && !waited) {
        waited = true;
        await new Promise((res) => setTimeout(res, Math.min((e.retryAfterSec ?? 5), 15) * 1000));
        raw = await req<unknown>("POST", path, pageBody, 30_000);
      } else throw e;
    }
    const parsed = assertListPage<T>(raw, path);
    yield parsed.items;
    if (!parsed.has_more) return;
    const next = parsed.pagination_key ?? undefined;
    if (!next || next === cursor) throw new Error(`retell ${path}: has_more=true but cursor ${next ? "did not advance" : "missing"}`);
    cursor = next;
  }
}

/** Same discipline for the versioned GET lists (cursor via query string). */
async function listAllGet<T = any>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_LIST_PAGES) throw new Error(`retell ${path}: more than ${MAX_LIST_PAGES} pages claimed — refusing to truncate silently`);
    const q = cursor ? `${path}${path.includes("?") ? "&" : "?"}pagination_key=${encodeURIComponent(cursor)}` : path;
    const parsed = assertListPage<T>(await req<unknown>("GET", q), path);
    out.push(...parsed.items);
    if (!parsed.has_more) return out;
    const next = parsed.pagination_key ?? undefined;
    if (!next || next === cursor) throw new Error(`retell ${path}: has_more=true but cursor ${next ? "did not advance" : "missing"}`);
    cursor = next;
  }
}

async function listAllPost<T = any>(path: string, body: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  for await (const items of listPagesPost<T>(path, body)) out.push(...items);
  return out;
}

export const channelFilter = (channel: "voice" | "chat") => ({ channel: { type: "string", op: "eq", value: channel } });

/* ---- endpoints verified against the live API on 2026-10-06 ---- */

export const retell = {
  /* Unified agent list (POST /v2/list-agents) replaced GET /list-agents and
   * GET /list-chat-agents on 2026-07-31. The channel filter preserves the old
   * voice-vs-chat discovery — unfiltered it returns BOTH channels, and the
   * two agent kinds still use different get/update endpoints below. */
  listAgents: (channel?: "voice" | "chat") =>
    listAllPost<any>("/v2/list-agents", { limit: 200, ...(channel ? { filter_criteria: channelFilter(channel) } : {}) }),
  getAgent: (id: string) => req<any>("GET", `/get-agent/${id}`),
  updateAgent: (id: string, patch: unknown) => req<any>("PATCH", `/update-agent/${id}`, patch),
  getChatAgent: (id: string) => req<any>("GET", `/get-chat-agent/${id}`),
  updateChatAgent: (id: string, patch: unknown) => req<any>("PATCH", `/update-chat-agent/${id}`, patch),
  listLlms: () => listAllGet<any>("/v2/list-retell-llms"),
  getLlm: (id: string) => req<any>("GET", `/get-retell-llm/${id}`),
  updateLlm: (id: string, patch: unknown) => req<any>("PATCH", `/update-retell-llm/${id}`, patch),
  listPhoneNumbers: () => listAllGet<any>("/v2/list-phone-numbers"),
  getCall: (callId: string) => req<any>("GET", `/v2/get-call/${callId}`),
  /** v3 (2026-06-15 migration): POST, RangeFilter criteria, items envelope. */
  listCallPages: (body: Record<string, unknown>) => listPagesPost<any>("/v3/list-calls", body),
  getChat: (chatId: string) => req<any>("GET", `/get-chat/${chatId}`),
  /** v3: now a POST like calls. NOTE: v3 chat items omit transcripts — the
   *  worker enriches ended chats via getChat, never assumes they are inline. */
  listChatPages: (body: Record<string, unknown>) => listPagesPost<any>("/v3/list-chats", body),
};
