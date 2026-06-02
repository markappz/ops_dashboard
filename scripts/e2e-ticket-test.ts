/**
 * End-to-end test of the user-report → AI-triage → fix-proposal → auto-implement flow.
 *
 * What it does:
 *   1. Submit a real test ticket via the local ops ingest endpoint
 *   2. Wait for AI triage to complete (ai_summary + ai_suggested_fix populated)
 *   3. Sign an admin session cookie locally using OPS_SESSION_SECRET
 *   4. POST /api/ops/tickets/:id/open-fix-pr → creates branch + DRAFT PR on Humn-Health
 *   5. POST /api/ops/tickets/:id/auto-implement → Claude reads target files + commits diff
 *   6. Print the PR URL so we can inspect on GitHub
 *
 * Prereqs:
 *   - Local ops dashboard running on $OPS_PORT (default 5001)
 *   - .env has DATABASE_URL, OPS_TICKETS_API_KEY, OPS_SESSION_SECRET, ADMIN_EMAILS, AWS creds
 *   - GITHUB_PAT_FITSCRIPT_FIX exported into the ops process (we'll borrow `gh auth token`)
 *
 * Usage:
 *   npx tsx scripts/e2e-ticket-test.ts
 */
import "dotenv/config";
import { createHmac } from "crypto";

const PORT = process.env.OPS_PORT || "5001";
const BASE = `http://localhost:${PORT}`;
const API_KEY = process.env.OPS_TICKETS_API_KEY;
const SESSION_SECRET = process.env.OPS_SESSION_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || "").split(",")[0]?.trim();

if (!API_KEY) { console.error("OPS_TICKETS_API_KEY missing from env"); process.exit(2); }
if (!SESSION_SECRET) { console.error("OPS_SESSION_SECRET missing from env"); process.exit(2); }
if (!ADMIN_EMAIL) { console.error("ADMIN_EMAILS missing from env"); process.exit(2); }

function b64url(buf: Buffer | string) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signCookie(email: string): string {
  const payload = { email, exp: Date.now() + 60 * 60 * 1000 }; // 1h
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", SESSION_SECRET!).update(body).digest());
  return `ops_session=${body}.${sig}`;
}

async function call(path: string, init: RequestInit = {}, adminAuth = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((init.headers as any) || {}) };
  if (adminAuth) headers["Cookie"] = signCookie(ADMIN_EMAIL!);
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  const txt = await r.text();
  let json: any = null;
  try { json = JSON.parse(txt); } catch { /* */ }
  return { status: r.status, ok: r.ok, json, text: txt };
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`[e2e] BASE=${BASE}  ADMIN_EMAIL=${ADMIN_EMAIL}`);

  // ── Step 1: Submit test ticket via ingest ────────────────────────────
  console.log("\n[1/5] Submitting test ticket via ingest…");
  const ingest = await call("/api/tickets/ingest", {
    method: "POST",
    headers: { "x-ops-tickets-key": API_KEY! },
    body: JSON.stringify({
      source_url: "https://fitscript.me/",
      user_note:
        "The homepage FAQ section in client/src/pages/homepage.tsx still says \"$27/mo\" and \"Health Membership\" when answering \"What's included in the free version?\" — both are stale after the May 26 tier collapse. The entry tier is now Protocol at $20/mo with a 7-day free trial. Please update the homepage FAQ to reflect Protocol $20/mo (7-day free trial) instead of the old $27/mo Health Membership wording.",
      user_email: "test-suite@fitscript.me",
      viewport_width: 1440,
      viewport_height: 900,
      user_agent: "ticket-system-e2e-test/1.0",
    }),
  });
  if (!ingest.ok) {
    console.error("[e2e] ingest failed:", ingest.status, ingest.text);
    process.exit(1);
  }
  const ticketId: string = ingest.json.id;
  console.log(`  ✓ ticket ingested: ${ticketId}`);
  console.log(`    category=${ingest.json.category}  severity=${ingest.json.severity}`);

  // ── Step 2: Wait for AI triage to complete ──────────────────────────
  console.log("\n[2/5] Waiting for AI triage…");
  let triaged = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const t = await call(`/api/ops/tickets/${ticketId}`, {}, true);
    if (!t.ok) {
      console.error("[e2e] get-ticket failed:", t.status, t.text);
      process.exit(1);
    }
    if (t.json.ticket?.ai_summary) {
      triaged = true;
      console.log(`  ✓ triaged after ${(i + 1) * 2}s`);
      console.log(`    ai_summary: ${t.json.ticket.ai_summary}`);
      console.log(`    ai_suggested_fix: ${(t.json.ticket.ai_suggested_fix || "").slice(0, 160)}…`);
      break;
    }
  }
  if (!triaged) {
    console.error("[e2e] AI triage didn't complete within 60s");
    process.exit(1);
  }

  // ── Step 2.5: Promote ticket to 'approved' so the fix-PR endpoint accepts it ──
  console.log("\n[2.5/5] Promoting ticket to 'approved'…");
  const promote = await call(`/api/ops/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "approved" }),
  }, true);
  if (!promote.ok) { console.error("[e2e] promote failed:", promote.status, promote.text); process.exit(1); }
  console.log("  ✓ status='approved'");

  // ── Step 3: Open fix proposal PR ────────────────────────────────────
  console.log("\n[3/5] Opening fix proposal PR…");
  const step1 = await call(`/api/ops/tickets/${ticketId}/open-fix-pr`, { method: "POST" }, true);
  if (!step1.ok) {
    console.error("[e2e] open-fix-pr failed:", step1.status, step1.text);
    process.exit(1);
  }
  console.log(`  ✓ PR opened: ${step1.json.pr_url}`);
  console.log(`    branch=${step1.json.branch}  target_files=${JSON.stringify(step1.json.proposal?.target_files)}`);

  // ── Step 4: Auto-implement (Claude writes the actual code) ─────────
  console.log("\n[4/5] Running auto-implement (Claude editing files)…");
  const step2 = await call(`/api/ops/tickets/${ticketId}/auto-implement`, { method: "POST" }, true);
  if (!step2.ok) {
    console.error("[e2e] auto-implement failed:", step2.status, step2.text);
    process.exit(1);
  }
  if (step2.json.no_op) {
    console.log(`  ⚠ Claude made no changes. Summary: ${step2.json.summary}`);
  } else {
    console.log(`  ✓ Code committed`);
    console.log(`    files: ${JSON.stringify(step2.json.files_modified)}`);
    console.log(`    LOC delta: ${step2.json.loc_delta}  iterations: ${step2.json.iterations}`);
    console.log(`    summary: ${(step2.json.summary || "").slice(0, 200)}…`);
  }

  // ── Step 5: Final report ───────────────────────────────────────────
  console.log("\n[5/5] DONE — verify on GitHub:");
  console.log(`  PR: ${step1.json.pr_url}`);
  console.log(`  Ticket ID: ${ticketId}`);
  console.log(`\n  Cleanup (optional): visit the PR to close + delete branch, and:`);
  console.log(`    curl -X DELETE -H "Cookie: $(node -e 'console.log(...)')"  ${BASE}/api/ops/tickets/${ticketId}`);
}

main().catch((e) => {
  console.error("[e2e] FAILED:", e?.message || e);
  process.exit(1);
});
