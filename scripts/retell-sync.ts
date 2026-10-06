/**
 * Retell configuration sync for the RP Call Center.
 *
 *   npx tsx scripts/retell-sync.ts export            # snapshot current remote config
 *   npx tsx scripts/retell-sync.ts diff              # snapshot + show what apply would change (default)
 *   npx tsx scripts/retell-sync.ts apply             # make the changes (drafts only), snapshot before+after
 *   npx tsx scripts/retell-sync.ts rollback <dir>    # restore agents/LLMs from a snapshot directory
 *
 * What apply does — and all it does:
 *   • merges our custom-function tools into each LLM's general_tools, keyed by
 *     tool name with an "ops_cc_" prefix — existing end_call / agent_swap / any
 *     other tools are preserved untouched, never overwritten as a list;
 *   • replaces ONLY the marked [OPS-CALLCENTER-TOOLS] block inside each
 *     general_prompt (appends it if absent) — the SOPs around it stay intact;
 *   • sets agent webhook_url to our receiver, refusing to overwrite a
 *     DIFFERENT existing webhook unless --force-webhook is passed (so another
 *     system's integration is never silently disconnected).
 * It never publishes agents, never touches voices/models/KBs/phone routing,
 * and every write is reversible via rollback.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { retell, retellCfg } from "../server/callcenter-retell";
import { AGENT_CAPABILITIES } from "../server/callcenter-tools";

const BASE_URL = (process.env.OPS_PUBLIC_BASE_URL || "https://ops.fitscript.me").replace(/\/$/, "");
const TOOLS_URL = `${BASE_URL}/api/integrations/retell/tools`;
const SNAP_DIR = path.resolve(import.meta.dirname, "retell-snapshots");
const MARK_OPEN = "[OPS-CALLCENTER-TOOLS v1 — managed block, do not hand-edit]";
const MARK_CLOSE = "[/OPS-CALLCENTER-TOOLS]";
const PREFIX = "ops_cc_"; // our tools are namespaced so merge/removal is surgical

type Json = Record<string, any>;

/* ---------------- tool definitions (Retell custom tool schema) ---------------- */

function tool(name: string, description: string, parameters: Json, opts: Json = {}): Json {
  const headers: Json = {};
  if (process.env.RETELL_TOOL_AUTH_SECRET) headers["x-ops-tool-auth"] = process.env.RETELL_TOOL_AUTH_SECRET;
  return {
    type: "custom",
    name: `${PREFIX}${name.replace(/-/g, "_")}`,
    description,
    url: `${TOOLS_URL}/${name}`,
    method: "POST",
    ...(Object.keys(headers).length ? { headers } : {}),
    parameters,
    speak_during_execution: true,
    execution_message_description: "One sec, let me check that.",
    execution_message_type: "prompt",
    speak_after_execution: true,
    timeout_ms: opts.timeout_ms ?? 8000,
    max_retry: 0, // our endpoints are idempotent, but retries are owned server-side
    args_at_root: false,
    parameter_type: "json",
  };
}

const req = (props: Json, required: string[]): Json => ({ type: "object", properties: props, required });
const s = (description: string): Json => ({ type: "string", description });

const TOOL_DEFS: Record<string, Json> = {
  "search-products": tool("search-products", "Look up products in the live Real Peptides catalog by name. Returns exact names, options, current public prices and availability. Use for any product or price question.",
    req({ query: s("The product name the customer said, as heard (spelling mistakes are okay)") }, ["query"])),
  "get-product": tool("get-product", "Get full current details for one product found with search: exact options, sizes, public price, availability, product and COA links.",
    req({ product_id: s("product_id from a prior ops_cc_search_products result"), name: s("The product name, as backup if the id is stale") }, ["product_id"])),
  "get-coa": tool("get-coa", "Find where the public testing reports (COAs) for a product live. Lot-level matching stays unknown unless confirmed.",
    req({ product: s("Product name"), lot: s("Lot number if the customer has one") }, ["product"])),
  "start-order-verification": tool("start-order-verification", "Begin order verification. A code goes only to the contact already on the order — never to a number or email the caller provides. Required before any order details.",
    req({ order_reference: s("The order number the customer gives") }, ["order_reference"])),
  "verify-order-access": tool("verify-order-access", "Check the 6-digit verification code the customer reads back.",
    req({ code: s("The 6-digit code") }, ["code"])),
  "get-order-status": tool("get-order-status", "Get the verified order's status, items and tracking. Only works after verification succeeds on this same call.",
    req({}, [])),
  "create-followup": tool("create-followup", "Save a real follow-up request for the team. Only after this returns ok may you say the request is saved.",
    req({
      concern: s("What the customer needs, in one or two sentences"),
      reason: s("One of: callback, product_question, order_question, shipment_question, payment_question, other"),
      name: s("Customer's name if given"),
      phone: s("Confirmed callback number, only with permission"),
      email: s("Confirmed email, only with permission"),
      contact_permission: { type: "boolean", description: "Did the customer agree to be contacted?" },
      preferred_window: s("The customer's own words for when to call back"),
      timezone: s("Customer's timezone ONLY if they said it — never guess"),
      product: s("Product discussed, if any"),
      order_reference: s("Order number, if any"),
      urgency: s("normal or urgent"),
    }, ["concern"]), { timeout_ms: 10_000 }),
  "create-wholesale-inquiry": tool("create-wholesale-inquiry", "Save a wholesale/bulk request: business, exact products, options, quantities, labeling needs and timing. A human reviews and sends the quote — never invent pricing, MOQs or terms.",
    req({
      business_name: s("Business or clinic name"),
      contact_name: s("Contact person"),
      phone: s("Confirmed phone"),
      email: s("Confirmed email"),
      items: { type: "array", description: "Each product with option and quantity", items: { type: "object", properties: { product: s("Product name"), variant: s("Option/size"), qty: { type: "number", description: "Quantity" } } } },
      labeling: s("Label or documentation needs, if mentioned"),
      timing: s("When they need it, in their words"),
      summary: s("One-line summary of the request"),
    }, []), { timeout_ms: 10_000 }),
  "get-handoff-options": tool("get-handoff-options", "List who is available for a live transfer right now. If none, offer a saved callback instead. Never dial any number not returned here.",
    req({}, [])),
};

/* ---------------- prompt block ---------------- */

function promptBlock(toolNames: string[]): string {
  const has = (t: string) => toolNames.includes(t);
  const lines = [
    MARK_OPEN,
    "Live tools are connected on this line. Rules:",
    "- Product names, options and prices: ALWAYS check ops_cc_search_products / ops_cc_get_product before quoting. Quote only what the tool returns. If the tool is unavailable, say you can't check right now and offer to save the question — never guess a price or stock.",
  ];
  if (has("get-coa")) lines.push("- Testing reports: use ops_cc_get_coa. The newest public report does not prove which lot a customer received.");
  if (has("get-order-status")) lines.push("- Order details require verification first: ops_cc_start_order_verification, then ops_cc_verify_order_access, then ops_cc_get_order_status. Never reveal whether an order exists for an unverified caller, and never send the code anywhere the caller suggests.");
  if (has("create-wholesale-inquiry")) lines.push("- Wholesale requests: capture business, exact products/options/quantities, labeling and timing with ops_cc_create_wholesale_inquiry. A human sends every quote. No invented MOQs, discounts or terms, and no use-case interrogation on ordinary price requests.");
  lines.push(
    "- Follow-ups: save with ops_cc_create_followup. Say \"I've saved your request\" ONLY after it returns ok with a request id. A failed tool call or a plain conversation is not a saved ticket. Keep the customer's own words for callback timing; never invent a timezone.",
    "- Live transfers: offer only destinations from ops_cc_get_handoff_options. If none are available, save a callback request instead. Never transfer to the main inbound number.",
    "- Texting/emailing links is NOT connected on this line — never claim you sent one.",
    MARK_CLOSE,
  );
  return lines.join("\n");
}

function mergePrompt(current: string, block: string): string {
  const start = current.indexOf(MARK_OPEN);
  const end = current.indexOf(MARK_CLOSE);
  if (start !== -1 && end !== -1) return current.slice(0, start) + block + current.slice(end + MARK_CLOSE.length);
  return `${current.trimEnd()}\n\n${block}\n`;
}

/* ---------------- snapshot / diff / apply ---------------- */

async function snapshot(label: string): Promise<{ dir: string; agents: Json[]; chatAgents: Json[]; llms: Json[] }> {
  const [agents, chatAgents, llms] = await Promise.all([retell.listAgents(), retell.listChatAgents(), retell.listLlms()]);
  const dir = path.join(SNAP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, "chat-agents.json"), JSON.stringify(chatAgents, null, 2));
  fs.writeFileSync(path.join(dir, "llms.json"), JSON.stringify(llms, null, 2));
  console.log(`snapshot → ${dir}`);
  return { dir, agents, chatAgents, llms };
}

interface Plan {
  llmPatches: Array<{ llmId: string; agentLabel: string; patch: Json; addedTools: string[]; removedStale: string[] }>;
  agentPatches: Array<{ agentId: string; kind: "voice" | "chat"; patch: Json; warn?: string }>;
}

function buildPlan(snap: { agents: Json[]; chatAgents: Json[]; llms: Json[] }, forceWebhook: boolean): Plan {
  const llmById = new Map(snap.llms.map((l) => [l.llm_id, l]));
  const plan: Plan = { llmPatches: [], agentPatches: [] };
  const webhookUrl = `${BASE_URL}/api/integrations/retell/webhook`;

  const allAgents: Array<{ a: Json; kind: "voice" | "chat" }> = [
    ...snap.agents.map((a) => ({ a, kind: "voice" as const })),
    ...snap.chatAgents.map((a) => ({ a, kind: "chat" as const })),
  ];

  for (const { a, kind } of allAgents) {
    const caps = AGENT_CAPABILITIES[a.agent_id];
    if (!caps) continue; // not one of ours — never touched

    // Agent: webhook_url (refuse to clobber someone else's integration)
    if (a.webhook_url && a.webhook_url !== webhookUrl && !forceWebhook) {
      plan.agentPatches.push({ agentId: a.agent_id, kind, patch: {}, warn: `SKIPPED webhook: agent already posts to ${a.webhook_url} — rerun with --force-webhook after confirming a fanout plan` });
    } else if (a.webhook_url !== webhookUrl) {
      plan.agentPatches.push({ agentId: a.agent_id, kind, patch: { webhook_url: webhookUrl } });
    }

    // LLM: merge tools + prompt block (fetched live, not assumed from any doc)
    const llmId = a.response_engine?.llm_id;
    const llm = llmId ? llmById.get(llmId) : null;
    if (!llm) {
      console.warn(`! agent ${a.agent_id} (${a.agent_name}) has no retell-llm engine in this workspace — skipped`);
      continue;
    }
    const toolCaps = caps.filter((t) => t in TOOL_DEFS); // send-requested-resource stays unregistered until a channel exists
    const desiredTools = toolCaps.map((t) => TOOL_DEFS[t]);
    const existing: Json[] = llm.general_tools ?? [];
    const keep = existing.filter((t) => !String(t.name ?? "").startsWith(PREFIX));
    const removedStale = existing.filter((t) => String(t.name ?? "").startsWith(PREFIX) && !desiredTools.some((d) => d.name === t.name)).map((t) => t.name);
    const merged = [...keep, ...desiredTools];
    const newPrompt = mergePrompt(String(llm.general_prompt ?? ""), promptBlock(toolCaps));

    const toolsChanged = JSON.stringify(existing) !== JSON.stringify(merged);
    const promptChanged = newPrompt !== llm.general_prompt;
    if (toolsChanged || promptChanged) {
      plan.llmPatches.push({
        llmId: llm.llm_id,
        agentLabel: `${a.agent_name} (${kind})`,
        patch: { ...(toolsChanged ? { general_tools: merged } : {}), ...(promptChanged ? { general_prompt: newPrompt } : {}) },
        addedTools: desiredTools.map((d) => d.name).filter((n) => !existing.some((t) => t.name === n)),
        removedStale,
      });
    }
  }
  return plan;
}

function printPlan(plan: Plan): void {
  if (!plan.llmPatches.length && !plan.agentPatches.length) {
    console.log("\nRemote config already matches — nothing to apply.");
    return;
  }
  console.log("\n=== PLAN ===");
  for (const p of plan.agentPatches) {
    if (p.warn) console.log(`agent ${p.agentId} (${p.kind}): ${p.warn}`);
    else console.log(`agent ${p.agentId} (${p.kind}): set webhook_url → ${p.patch.webhook_url}`);
  }
  for (const p of plan.llmPatches) {
    console.log(`llm ${p.llmId} [${p.agentLabel}]:`);
    if (p.patch.general_tools) console.log(`  tools: +[${p.addedTools.join(", ") || "updated in place"}]${p.removedStale.length ? ` -[${p.removedStale.join(", ")}]` : ""} (end_call/agent_swap preserved: ${p.patch.general_tools.filter((t: Json) => !String(t.name).startsWith(PREFIX)).length})`);
    if (p.patch.general_prompt) console.log(`  prompt: ${MARK_OPEN.slice(0, 30)}… block ${String(p.patch.general_prompt).includes(MARK_OPEN) ? "written" : "ERROR"}`);
  }
}

async function apply(plan: Plan): Promise<void> {
  for (const p of plan.llmPatches) {
    await retell.updateLlm(p.llmId, p.patch);
    console.log(`✓ llm ${p.llmId} updated`);
  }
  for (const p of plan.agentPatches) {
    if (p.warn || !Object.keys(p.patch).length) continue;
    if (p.kind === "voice") await retell.updateAgent(p.agentId, p.patch);
    else await retell.updateChatAgent(p.agentId, p.patch);
    console.log(`✓ agent ${p.agentId} webhook set`);
  }
}

async function rollback(dir: string): Promise<void> {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  const llms: Json[] = read("llms.json");
  const agents: Json[] = read("agents.json");
  const chatAgents: Json[] = read("chat-agents.json");
  for (const l of llms) {
    if (!Object.keys(AGENT_CAPABILITIES).length) break;
    await retell.updateLlm(l.llm_id, { general_tools: l.general_tools ?? [], general_prompt: l.general_prompt ?? "" });
    console.log(`✓ llm ${l.llm_id} restored`);
  }
  for (const a of agents) {
    if (!AGENT_CAPABILITIES[a.agent_id]) continue;
    await retell.updateAgent(a.agent_id, { webhook_url: a.webhook_url ?? null });
    console.log(`✓ agent ${a.agent_id} webhook restored`);
  }
  for (const a of chatAgents) {
    if (!AGENT_CAPABILITIES[a.agent_id]) continue;
    await retell.updateChatAgent(a.agent_id, { webhook_url: a.webhook_url ?? null });
    console.log(`✓ chat agent ${a.agent_id} webhook restored`);
  }
}

/* ---------------- main ---------------- */

async function main() {
  if (!retellCfg()) {
    console.error("RETELL_API_KEY is not set. Add it to .env (local) or prod/ops-secrets (deploy).");
    process.exit(1);
  }
  const cmd = process.argv[2] ?? "diff";
  const forceWebhook = process.argv.includes("--force-webhook");

  if (cmd === "export") { await snapshot("export"); return; }
  if (cmd === "rollback") {
    const dir = process.argv[3];
    if (!dir || !fs.existsSync(dir)) { console.error("rollback needs a snapshot directory (see scripts/retell-snapshots/)"); process.exit(1); }
    await snapshot("pre-rollback");
    await rollback(dir);
    await snapshot("post-rollback");
    return;
  }

  const snap = await snapshot(cmd === "apply" ? "pre-apply" : "diff");
  const plan = buildPlan(snap, forceWebhook);
  printPlan(plan);

  if (cmd === "apply") {
    await apply(plan);
    const after = await snapshot("post-apply");
    // verify: every targeted LLM now carries the marked block + our tools
    const byId = new Map(after.llms.map((l) => [l.llm_id, l]));
    for (const p of plan.llmPatches) {
      const l = byId.get(p.llmId);
      const okTools = (l?.general_tools ?? []).some((t: Json) => String(t.name).startsWith(PREFIX));
      const okPrompt = String(l?.general_prompt ?? "").includes(MARK_OPEN);
      console.log(`${okTools && okPrompt ? "✓ verified" : "✗ VERIFY FAILED"} ${p.llmId}`);
    }
    console.log(`\nDone. These are DRAFT changes (version 0, unpublished). Rollback: npx tsx scripts/retell-sync.ts rollback <pre-apply snapshot dir>`);
  } else {
    console.log(`\nDry run — nothing written. Run "apply" to make these changes (drafts only).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
