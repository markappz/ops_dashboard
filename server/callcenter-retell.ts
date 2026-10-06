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
  if (r.status === 429) throw new RetellRateLimited(path);
  if (!r.ok) throw new Error(`retell ${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export class RetellRateLimited extends Error {
  constructor(path: string) {
    super(`retell rate-limited on ${path}`);
  }
}

/* ---- endpoints verified against the live API on 2026-10-06 ---- */

export const retell = {
  listAgents: () => req<any[]>("GET", "/list-agents"),
  getAgent: (id: string) => req<any>("GET", `/get-agent/${id}`),
  updateAgent: (id: string, patch: unknown) => req<any>("PATCH", `/update-agent/${id}`, patch),
  listChatAgents: () => req<any[]>("GET", "/list-chat-agents"),
  getChatAgent: (id: string) => req<any>("GET", `/get-chat-agent/${id}`),
  updateChatAgent: (id: string, patch: unknown) => req<any>("PATCH", `/update-chat-agent/${id}`, patch),
  listLlms: () => req<any[]>("GET", "/list-retell-llms"),
  getLlm: (id: string) => req<any>("GET", `/get-retell-llm/${id}`),
  updateLlm: (id: string, patch: unknown) => req<any>("PATCH", `/update-retell-llm/${id}`, patch),
  listPhoneNumbers: () => req<any[]>("GET", "/list-phone-numbers"),
  getCall: (callId: string) => req<any>("GET", `/v2/get-call/${callId}`),
  /** v2 list-calls is a POST with filter_criteria/pagination_key — NOT the old GET. */
  listCalls: (body: { filter_criteria?: any; sort_order?: string; limit?: number; pagination_key?: string }) =>
    req<any[]>("POST", "/v2/list-calls", body, 30_000),
  getChat: (chatId: string) => req<any>("GET", `/get-chat/${chatId}`),
  listChats: () => req<any[]>("GET", "/list-chat", undefined, 30_000),
};
