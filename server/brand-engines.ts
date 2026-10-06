/**
 * Brand email engine registry — the one place that knows which brands send
 * through their own in-house engine (the ops-marketing HTTP contract) and
 * which still ride Resend/Klaviyo.
 *
 * Every engine implements the same token-gated contract the RP site shipped
 * first (2026-10-01, after Resend deactivated the account):
 *   GET  ?what=segments | contacts | recent-events | activity | export
 *   POST { action: "preview" | "test" | "send", ... }
 * Capability-gated extras (flows, overrides, site-emails, custom-flows) exist
 * only where the engine serves them — RP today; pawgen/PeptideU engines ship
 * the base contract first.
 *
 * peptideu's base is the FULL Supabase function URL, so its path stays "".
 */
import "dotenv/config";
import type { Express } from "express";

export type EngineCapability = "flows" | "overrides" | "site-emails" | "custom-flows";

export interface BrandEngine {
  slug: string;
  label: string;
  base?: string;
  token?: string;
  path: string;
  capabilities: EngineCapability[];
  alertFrom: string;
}

export const ENGINES: Record<string, BrandEngine | undefined> = {
  realpeptides: {
    slug: "realpeptides",
    label: "Real Peptides",
    base: process.env.RP_SITE_API_URL,
    token: process.env.RP_SITE_OPS_TOKEN,
    path: "/api/ops-marketing",
    capabilities: ["flows", "overrides", "site-emails", "custom-flows"],
    alertFrom: "realpeptides",
  },
  pawgen: {
    slug: "pawgen",
    label: "pawgen",
    base: process.env.PAWGEN_SITE_API_URL,
    token: process.env.PAWGEN_SITE_OPS_TOKEN,
    path: "/api/ops-marketing",
    // pawgen's engine serves the flows contract since 2026-10-06 (lib/flowsOps.server.ts
    // in the pawgen repo). No site-emails catalog yet.
    capabilities: ["flows", "overrides", "custom-flows"],
    alertFrom: "pawgen",
  },
  peptideu: {
    slug: "peptideu",
    label: "PeptideU",
    base: process.env.PEPTIDEU_ENGINE_URL,
    token: process.env.PEPTIDEU_ENGINE_TOKEN,
    path: "",
    // PeptideU's ops-marketing fn serves the flows contract since 2026-10-06.
    capabilities: ["flows", "overrides", "custom-flows"],
    alertFrom: "peptideu",
  },
  northblu: {
    slug: "northblu",
    label: "North Blu",
    base: process.env.NORTHBLU_SITE_API_URL,
    token: process.env.NORTHBLU_SITE_OPS_TOKEN,
    path: "/api/ops-marketing",
    // Base contract only (2026-10-06 waitlist launch) — no flows yet.
    capabilities: [],
    alertFrom: "northblu",
  },
};

export const hasEngine = (c: string) => {
  const e = ENGINES[c];
  return Boolean(e?.base && e?.token);
};

export const hasCapability = (c: string, cap: EngineCapability) =>
  Boolean(ENGINES[c]?.capabilities.includes(cap));

/** Which brands can fire a scheduled send right now (env wired). */
export const engineCompanies = () => Object.keys(ENGINES).filter(hasEngine);

const ENV_HINT: Record<string, string> = {
  realpeptides: "RP_SITE_API_URL + RP_SITE_OPS_TOKEN",
  pawgen: "PAWGEN_SITE_API_URL + PAWGEN_SITE_OPS_TOKEN",
  peptideu: "PEPTIDEU_ENGINE_URL + PEPTIDEU_ENGINE_TOKEN",
  northblu: "NORTHBLU_SITE_API_URL + NORTHBLU_SITE_OPS_TOKEN",
};

/**
 * One HTTP call against a brand's engine. `query` is the query string
 * ("?what=segments", "" for POST/PUT actions) appended to base+path.
 */
export async function engineBridge(
  company: string,
  query = "",
  init?: { method?: string; body?: unknown; timeoutMs?: number },
) {
  const e = ENGINES[company];
  if (!e) throw new Error(`No engine registered for "${company}".`);
  if (!e.base || !e.token) {
    throw new Error(`Connect the ${e.label} engine first (${ENV_HINT[company] ?? "its API URL + token"}).`);
  }
  const r = await fetch(`${e.base.replace(/\/$/, "")}${e.path}${query}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${e.token}`, "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init?.timeoutMs ?? 290_000),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.error || `${e.slug} engine ${r.status}`);
  return j;
}

/** The client's one question: which brands have an engine, and what can it do. */
export function registerEngineRoutes(app: Express) {
  app.get("/api/ops/engines", (_req, res) => {
    const out: Record<string, { configured: boolean; label: string; capabilities: EngineCapability[] }> = {};
    for (const [slug, e] of Object.entries(ENGINES)) {
      if (!e) continue;
      out[slug] = { configured: hasEngine(slug), label: e.label, capabilities: e.capabilities };
    }
    res.json(out);
  });
}
