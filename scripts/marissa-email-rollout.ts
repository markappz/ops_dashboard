/**
 * Marissa email-intake rollout (2026-10-13, Hades handoff §2-3).
 * PAUL RUNS THIS — it mutates the LIVE phone agent's draft and publishes.
 *
 *   npx tsx scripts/marissa-email-rollout.ts          # dry-run: show the plan
 *   npx tsx scripts/marissa-email-rollout.ts publish  # do it
 *
 * What it does, in order (draft-only until the final publish step):
 *   1. Snapshot agent + LLM to scripts/retell-snapshots/ (rollback material).
 *   2. Refuse to run if the published agent version isn't the expected one
 *      (never overwrite newer approved changes).
 *   3. Create/refresh the agent draft pointing at the LLM's latest version.
 *   4. Patch the LLM draft: general_tools = current 11 + ops_cc_find_requests
 *      + ops_cc_append_request_note (updated schemas), general_prompt = the
 *      canonical SOP at server/callcenter-sop/unified-marissa-prompt.txt.
 *   5. Point the agent draft at the new LLM version and publish the agent.
 *   6. Verify: published version advanced, prompt carries the email passage,
 *      13 ops tools present, voice/webhook/phone untouched.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AGENT = "agent_067b4ec911fad52c81d22a0535";
const LLM = "llm_7f48e2539263a16c18670dd64f41";
const EXPECTED_PUBLISHED = 7;
const SOP = fs.readFileSync(path.join(__dirname, "../server/callcenter-sop/unified-marissa-prompt.txt"), "utf8");

const H = { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" };
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`https://api.retellai.com${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${p} ${r.status}: ${text.slice(0, 200)}`);
  return j;
};

// The two new tool definitions, same source of truth the sync uses.
import { TOOL_DEFS_EXPORT } from "./retell-sync";

async function main() {
  const publish = process.argv[2] === "publish";
  const agent = await api("GET", `/get-agent/${AGENT}`);
  console.log(`published agent v${agent.version} (is_published=${agent.is_published}), engine ${JSON.stringify(agent.response_engine)}`);
  if (agent.version !== EXPECTED_PUBLISHED) {
    throw new Error(`Published version is v${agent.version}, expected v${EXPECTED_PUBLISHED} — someone shipped newer changes; re-review before rolling out.`);
  }
  const llm = await api("GET", `/get-retell-llm/${LLM}`);
  const dir = path.join(__dirname, "retell-snapshots", `${new Date().toISOString().replace(/[:.]/g, "-")}-email-rollout`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(agent, null, 2));
  fs.writeFileSync(path.join(dir, "llm.json"), JSON.stringify(llm, null, 2));
  console.log(`snapshot → ${dir}`);

  const keep = (llm.general_tools ?? []).filter((t: any) => !["ops_cc_find_requests", "ops_cc_append_request_note"].includes(t.name));
  // Replace ops_ tools with the canonical defs (updated followup/append schemas), keep native tools.
  const native = keep.filter((t: any) => !String(t.name ?? "").startsWith("ops_cc_"));
  const desired = [...native, ...Object.values(TOOL_DEFS_EXPORT)];
  console.log(`tools: ${llm.general_tools.length} → ${desired.length} (adds find_requests, append_request_note; refreshes ops schemas)`);
  console.log(`prompt: ${llm.general_prompt.length} chars → ${SOP.length} chars (email-intake passage added)`);
  if (!publish) {
    console.log("\nDRY RUN — nothing written. Run with `publish` to roll out.");
    return;
  }

  // Retell version model (probed 2026-10-14): no free-floating drafts — a new
  // draft agent version is CREATED from a base, its LLM becomes draftable,
  // and publish-agent-version makes it live.
  const draft = await api("POST", `/create-agent-version/${AGENT}`, { base_version: EXPECTED_PUBLISHED });
  console.log(`agent draft v${draft.version} created from v${draft.base_version} (engine ${JSON.stringify(draft.response_engine)})`);

  let newLlmVersion: number;
  try {
    const updatedLlm = await api("PATCH", `/update-retell-llm/${LLM}`, { general_tools: desired, general_prompt: SOP });
    newLlmVersion = updatedLlm.version;
    console.log(`llm updated -> v${newLlmVersion} (is_published=${updatedLlm.is_published})`);
  } catch (e) {
    // Some workspaces require targeting the draft agent's engine version explicitly.
    const dv = draft.response_engine?.version;
    console.log(`default llm patch refused (${(e as Error).message.slice(0, 80)}) — retrying against draft engine version ${dv}`);
    const updatedLlm = await api("PATCH", `/update-retell-llm/${LLM}?version=${dv}`, { general_tools: desired, general_prompt: SOP });
    newLlmVersion = updatedLlm.version;
    console.log(`llm updated -> v${newLlmVersion}`);
  }

  await api("PATCH", `/update-agent/${AGENT}`, { response_engine: { type: "retell-llm", llm_id: LLM, version: newLlmVersion } });
  await api("POST", `/publish-agent-version/${AGENT}`, { version: draft.version, version_title: "email-intake + request tools (2026-10-14)" });
  console.log(`published agent v${draft.version}`);

  const check = await api("GET", `/get-agent/${AGENT}`);
  const checkLlm = await api("GET", `/get-retell-llm/${check.response_engine.llm_id}?version=${check.response_engine.version}`);
  const toolNames = (checkLlm.general_tools ?? []).map((t: any) => t.name);
  console.log("VERIFY:", JSON.stringify({
    agentVersion: check.version,
    isPublished: check.is_published,
    voice: check.voice_id,
    webhookOk: check.webhook_url?.includes("ops.fitscript.me"),
    promptHasEmailAsk: checkLlm.general_prompt.includes("best email for our support team"),
    hasFindRequests: toolNames.includes("ops_cc_find_requests"),
    hasAppendNote: toolNames.includes("ops_cc_append_request_note"),
    toolCount: toolNames.length,
  }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
