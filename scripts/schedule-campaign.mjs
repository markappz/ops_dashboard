#!/usr/bin/env node
/**
 * Agent campaign scheduling pipe (2026-10-02). Creates a SCHEDULED Real Peptides campaign
 * through the ops API using OPS_AUTOMATION_TOKEN — a bearer that works for plan create/update
 * ONLY. The ops scheduler fires it at send time; a server-enforced 2h veto window keeps every
 * agent-scheduled campaign visible (and one-click cancellable) in Drafts & scheduled first.
 *
 * Usage:
 *   node scripts/schedule-campaign.mjs --title "..." --subject "..." --preheader "..." \
 *     --segment warmup-b --date 2026-10-03 --time 09:00 --tz America/Los_Angeles \
 *     --html-file /path/to/email.html [--ops https://ops.fitscript.me]
 * Token: OPS_AUTOMATION_TOKEN env, or ~/.ops-automation-token.
 */
import { readFileSync } from "fs";
import { homedir } from "os";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
const need = (k) => { if (!args[k]) { console.error(`missing --${k}`); process.exit(1); } return args[k]; };

const ops = args.ops || "https://ops.fitscript.me";
let token = process.env.OPS_AUTOMATION_TOKEN;
if (!token) { try { token = readFileSync(`${homedir()}/.ops-automation-token`, "utf8").trim(); } catch { /* fall through */ } }
if (!token) { console.error("no OPS_AUTOMATION_TOKEN (env or ~/.ops-automation-token)"); process.exit(1); }

const html = readFileSync(need("html-file"), "utf8");
if (!html.includes("{{{unsubscribeUrl}}}") && /^\s*(<!doctype|<html)/i.test(html)) {
  console.error("full-document email must include an {{{unsubscribeUrl}}} unsubscribe link");
  process.exit(1);
}

const body = {
  company: "realpeptides",
  title: need("title"),
  subject: need("subject"),
  preheader: args.preheader || null,
  status: "scheduled",
  send_date: need("date"),
  send_time: need("time"),
  send_tz: args.tz || "America/Los_Angeles",
  audience_id: need("segment"),
  html_b64: Buffer.from(html, "utf8").toString("base64"),
  notes: args.notes || "Scheduled by the agent pipe — 2h veto window enforced server-side.",
};

const r = await fetch(`${ops}/api/ops/email-plans`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`FAILED ${r.status}: ${j.error || JSON.stringify(j)}`); process.exit(1); }
console.log(`SCHEDULED plan ${j.id}: "${body.subject}" -> ${body.audience_id} at ${body.send_date} ${body.send_time} ${body.send_tz}`);
console.log(`Veto anytime: ops -> RP -> Broadcasts -> Drafts & scheduled -> open -> set status to draft.`);
