/**
 * Change requests: anyone on the team can ask for a dashboard change in plain
 * English, from the page they're on or through Dirt. Each request is stored,
 * posted to the ops Slack channel, and handed to GitHub (repository_dispatch)
 * where a Claude Code job builds it on a branch, runs typecheck + build, and
 * opens a pull request. The PR comes back here; an admin approves (merge →
 * CI deploys) or rejects (PR closed). Nothing reaches main without a human.
 */
import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { pool } from "./db";

const REPO = process.env.OPS_GITHUB_REPO || "markappz/ops_dashboard";
const GH = "https://api.github.com";

export type RequestStatus = "queued" | "building" | "pr_open" | "failed" | "approved" | "merged" | "rejected";

function ghToken(): string | null {
  return process.env.GITHUB_PAT_OPS || process.env.GITHUB_PAT_FITSCRIPT_FIX || null;
}

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ops_change_requests (
    id SERIAL PRIMARY KEY,
    company TEXT, area TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
    requested_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    branch TEXT, pr_number INTEGER, pr_url TEXT, summary TEXT, error TEXT,
    decided_by TEXT, decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function gh(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const token = ghToken();
  if (!token) throw new Error("No GitHub token on ops (GITHUB_PAT_OPS)");
  const r = await fetch(`${GH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "fitscript-ops", "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

export async function postSlack(text: string): Promise<void> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) }); }
  catch (e: any) { console.warn("[OPS][requests] slack:", e.message); }
}

async function setStatus(id: number, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`UPDATE ops_change_requests SET ${sets}, updated_at = NOW() WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
}

/** Kick the GitHub job. Failing to dispatch keeps the request queued for a human. */
async function dispatch(row: any): Promise<void> {
  const r = await gh(`/repos/${REPO}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ event_type: "change_request", client_payload: { id: row.id, title: row.title, body: row.body, area: row.area, company: row.company, requested_by: row.requested_by } }),
  });
  if (r.status !== 204) throw new Error(`GitHub dispatch ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`);
  await setStatus(row.id, { status: "building" });
}

export async function createChangeRequest(input: { title: string; body: string; area?: string | null; company?: string | null; requestedBy: string }) {
  await ensureTable();
  const title = input.title.trim().slice(0, 140);
  const body = input.body.trim();
  if (!title || !body) throw new Error("A title and a description are required");
  const { rows } = await pool.query(
    `INSERT INTO ops_change_requests (company, area, title, body, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.company ?? null, input.area ?? null, title, body, input.requestedBy]);
  const row = rows[0];
  let note = "";
  try { await dispatch(row); note = " · Claude Code is building it now"; }
  catch (e: any) { note = ` · waiting for a human (${e.message})`; await setStatus(row.id, { error: e.message }); }
  await postSlack(`🛠️ Change request #${row.id} from ${row.requested_by}${row.area ? ` (${row.area})` : ""}: *${title}*\n${body.slice(0, 600)}${note}`);
  return (await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [row.id])).rows[0];
}

function ciTokenOk(req: Request): boolean {
  const expected = process.env.OPS_CI_TOKEN;
  if (!expected) return false;
  const given = String(req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  return given.length === expected.length && given === expected;
}

export function registerChangeRequests(app: Express) {
  ensureTable().catch((e) => console.error("[OPS][requests] table:", e.message));

  app.get("/api/ops/change-requests", async (_req, res) => {
    try {
      await ensureTable();
      const { rows } = await pool.query(`SELECT * FROM ops_change_requests ORDER BY created_at DESC LIMIT 200`);
      res.json({ requests: rows, pipeline: { github: !!ghToken(), ci: !!process.env.OPS_CI_TOKEN, repo: REPO } });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/ops/change-requests", async (req: Request & { adminEmail?: string }, res) => {
    try {
      const row = await createChangeRequest({ title: req.body?.title ?? "", body: req.body?.body ?? "", area: req.body?.area, company: req.body?.company, requestedBy: req.adminEmail || "unknown" });
      res.json(row);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  /** Re-run a failed or queued request. */
  app.post("/api/ops/change-requests/:id/retry", async (req, res) => {
    try {
      const row = (await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [req.params.id])).rows[0];
      if (!row) return res.status(404).json({ error: "not found" });
      await setStatus(row.id, { error: null, pr_number: null, pr_url: null, branch: null, summary: null });
      await dispatch(row);
      res.json((await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [row.id])).rows[0]);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  /** Called by the GitHub job with the outcome (bearer OPS_CI_TOKEN). */
  app.post("/api/ops/change-requests/:id/result", async (req, res) => {
    if (!ciTokenOk(req)) return res.status(401).json({ error: "unauthorized" });
    const { ok, pr_number, pr_url, branch, summary, error } = req.body || {};
    const id = parseInt(String(req.params.id), 10);
    try {
      if (ok) await setStatus(id, { status: "pr_open", pr_number: pr_number ?? null, pr_url: pr_url ?? null, branch: branch ?? null, summary: summary ?? null, error: null });
      else await setStatus(id, { status: "failed", error: String(error || "build failed").slice(0, 2000), summary: summary ?? null, branch: branch ?? null });
      const row = (await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [id])).rows[0];
      await postSlack(ok
        ? `✅ Change request #${id} *${row?.title}* is ready for review: ${pr_url}\n${String(summary || "").slice(0, 500)}\nApprove or reject in ops → Settings → Requests.`
        : `❌ Change request #${id} *${row?.title}* failed to build: ${String(error || "").slice(0, 300)}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** Admin decision: approve = squash-merge the PR (CI deploys); reject = close PR + delete branch. */
  app.post("/api/ops/change-requests/:id/decide", async (req: Request & { adminEmail?: string; role?: string }, res) => {
    if (req.role === "viewer") return res.status(403).json({ error: "admins only" });
    const decision = String(req.body?.decision || "");
    const id = parseInt(String(req.params.id), 10);
    try {
      const row = (await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [id])).rows[0];
      if (!row) return res.status(404).json({ error: "not found" });
      if (decision === "approve") {
        if (!row.pr_number) return res.status(400).json({ error: "No pull request to merge yet" });
        const m = await gh(`/repos/${REPO}/pulls/${row.pr_number}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash", commit_title: `${row.title} (#${row.pr_number})` }) });
        if (m.status !== 200) return res.status(502).json({ error: `GitHub merge ${m.status}: ${m.body?.message || ""}` });
        await setStatus(id, { status: "merged", decided_by: req.adminEmail, decided_at: new Date() });
        if (row.branch) await gh(`/repos/${REPO}/git/refs/heads/${row.branch}`, { method: "DELETE" });
        await postSlack(`🚀 Change request #${id} *${row.title}* approved by ${req.adminEmail} — merged, deploying.`);
      } else if (decision === "reject") {
        // Closing the PR / deleting the branch is best-effort: the decision stands even if GitHub is unreachable.
        try {
          if (row.pr_number) await gh(`/repos/${REPO}/pulls/${row.pr_number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
          if (row.branch) await gh(`/repos/${REPO}/git/refs/heads/${row.branch}`, { method: "DELETE" });
        } catch (e: any) { console.warn("[OPS][requests] reject cleanup:", e.message); }
        await setStatus(id, { status: "rejected", decided_by: req.adminEmail, decided_at: new Date() });
        await postSlack(`🛑 Change request #${id} *${row.title}* rejected by ${req.adminEmail}.`);
      } else return res.status(400).json({ error: "decision must be approve or reject" });
      res.json((await pool.query("SELECT * FROM ops_change_requests WHERE id = $1", [id])).rows[0]);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
}

export function newCiToken(): string { return randomBytes(24).toString("hex"); }
