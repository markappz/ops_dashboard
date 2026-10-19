/**
 * Brand marketing bridge — the ops side of the in-house email engines that replaced
 * Resend (account deactivated 2026-10-01). Each engine, its suppression gate and its audit
 * trail live in the brand's own repo behind a token-gated ops-marketing endpoint; ops is the
 * UI. The registry (server/brand-engines.ts) says which brands have one and what it serves.
 *
 *   GET  /api/ops/:company/marketing/segments     audience picker: segments + live counts
 *   POST /api/ops/:company/marketing/test         one rendered test send { subject, html, to }
 *   POST /api/ops/email-plans/:id/send-rp         send a calendar plan through the plan's engine
 *
 * send-rp is two-step like the engines themselves: without { confirm: true } it returns the
 * live recipient count and sends nothing. The plan's audience_id column (Resend audience in its
 * old life) now holds an engine segment slug, empty = everyone. The engine's tag for the send is
 * stored in resend_broadcast_id so the analytics ledger (EmailEvent.broadcastId = tag) lines
 * up with the calendar row under the column's historical name.
 *
 * Capability-gated extras (flows / overrides / site-emails / custom-flows) answer 501 for
 * brands whose engine doesn't serve them — RP is the only one that does today.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { pool } from "./db";
import { ENGINES, engineBridge, EngineRefusal, hasEngine, type EngineCapability } from "./brand-engines";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Ops-side mirror of every engine's compliance guard (plan #98, 2026-10-19: the RP engine
 * refused a full-document campaign with no unsubscribe link AT FIRE TIME and the human only
 * saw send_failed). Fragments are fine — the engine shell adds the footer. A full document
 * must carry its own {{{unsubscribeUrl}}} (or {{unsubscribeUrl}} / RESEND_UNSUBSCRIBE_URL).
 * Returns the actionable problem, or null when the HTML is sendable. Exported for tests.
 */
export function broadcastHtmlProblem(html: string | null | undefined): string | null {
  if (!html || !/^\s*(<!doctype|<html)/i.test(html)) return null;
  if (/\{\{\{?\s*(unsubscribeUrl|RESEND_UNSUBSCRIBE_URL)\s*\}?\}\}/.test(html)) return null;
  return 'This full-document HTML has no unsubscribe link, so every engine will refuse to send it. Add <a href="{{{unsubscribeUrl}}}">Unsubscribe</a> to the footer (the placeholder becomes each recipient\'s one-click link at send time).';
}

/**
 * Fire one plan through its brand's engine bridge — shared by the send-rp route (human click)
 * and the scheduler (fires plans the human explicitly set to "scheduled" with a date/time/tz).
 * The caller owns status transitions AROUND this; this does the send + marks sent.
 */
// Lazy so tests can shrink them after import (ESM hoisting).
const pollEveryMs = () => Number(process.env.OPS_BROADCAST_POLL_MS || 20_000);
const pollBudgetMs = () => Number(process.env.OPS_BROADCAST_POLL_BUDGET_MS || 90 * 60_000);

/** Evidence → row status. Exported for tests. */
export function broadcastVerdict(job: { status: string; sent: number; of: number }): { status: "sent" | "sent_partial" | "send_failed" | "sending"; note: string | null } {
  switch (job.status) {
    case "COMPLETED": return { status: "sent", note: null };
    case "PARTIAL": return { status: "sent_partial", note: `partial: ${job.sent}/${job.of} sent before a chunk failed — resume continues from the failed chunk, never re-sending earlier ones` };
    case "FAILED": return job.sent > 0
      ? { status: "sent_partial", note: `partial: ${job.sent}/${job.of} sent, then the engine stopped` }
      : { status: "send_failed", note: "engine confirmed zero recipients were sent" };
    case "QUEUED": case "SENDING": return { status: "sending", note: null };
    default: return { status: "sending", note: `unknown engine job status "${job.status}" — left for reconciliation` };
  }
}

async function applyVerdict(planId: number, v: { status: string; note: string | null }, counts: { sent: number; of: number }, tag: string): Promise<void> {
  await pool.query(
    `UPDATE ops_email_plans SET status = $2, status_note = $3, sent_count = $4, total_count = $5, resend_broadcast_id = COALESCE(resend_broadcast_id, $6), updated_at = NOW() WHERE id = $1`,
    [planId, v.status, v.note, counts.sent, counts.of, tag],
  );
}

/**
 * Fire one plan through its brand's engine bridge — shared by the send-rp route (human click)
 * and the scheduler. Rebuilt after campaign #81 (2026-10-12): the engine's ALB cut the
 * synchronous 34k-recipient send at its idle timeout, ops recorded send_failed, and 34,476
 * delivered emails wore a "failed" badge. The rules now:
 *
 *   1. The tag is written to the row BEFORE dispatch — whatever happens, analytics can
 *      always find the campaign.
 *   2. The RP engine answers with an async JOB (idempotent by tag — our retry can never
 *      double-send); we poll its status. Engines that still answer synchronously
 *      (pawgen/PU/NB, small lists) are handled as before.
 *   3. A transport error is AMBIGUOUS, never a failure verdict: the row stays 'sending'
 *      and reconcilePendingSends() resolves it from engine evidence. 'send_failed' is
 *      written only when the engine itself confirms zero sends.
 */
export async function firePlan(
  company: string,
  p: { id: number; title: string | null; subject: string | null; html: string | null; audience_id: string | null },
  by: string,
): Promise<{ sent: number; of: number; tag: string }> {
  const segment = p.audience_id?.trim() || undefined;
  const tag = `ops-${p.id}-${slugify(p.title || p.subject || "broadcast")}`;

  // Refuse ops-side what the engine would refuse at dispatch — with the reason attached.
  const problem = broadcastHtmlProblem(p.html);
  if (problem) {
    await applyVerdict(p.id, { status: "send_failed", note: `refused before dispatch: ${problem}` }, { sent: 0, of: 0 }, tag);
    throw new EngineRefusal(company, 400, problem);
  }

  await pool.query(
    `UPDATE ops_email_plans SET resend_broadcast_id = $2, updated_at = NOW() WHERE id = $1`,
    [p.id, tag],
  );
  let out: any;
  try {
    out = await engineBridge(company, "", {
      method: "POST",
      body: { action: "send", confirm: true, subject: p.subject, html: p.html, segment, tag },
    });
  } catch (e) {
    if (e instanceof EngineRefusal) {
      // Definitive: the engine said no and dispatched nothing. Record WHY and surface it.
      await applyVerdict(p.id, { status: "send_failed", note: `engine refused: ${e.message}` }, { sent: 0, of: 0 }, tag);
      console.error(`[OPS][MARKETING] ${company} plan ${p.id} refused by engine: ${e.message}`);
      throw e;
    }
    // Ambiguous: the engine may be sending right now (that is exactly what #81 was).
    await pool.query(
      `UPDATE ops_email_plans SET status = 'sending', status_note = $2, updated_at = NOW() WHERE id = $1`,
      [p.id, `dispatch transport error (${String((e as Error).message).slice(0, 120)}) — awaiting engine evidence, NOT marked failed`],
    );
    console.error(`[OPS][MARKETING] ${company} plan ${p.id} dispatch ambiguous: ${(e as Error).message} — left 'sending' for reconciliation`);
    return { sent: 0, of: 0, tag };
  }

  if (!out?.async) {
    // Legacy synchronous engines: the response IS the completed send.
    await applyVerdict(p.id, { status: "sent", note: null }, { sent: out.sent ?? 0, of: out.of ?? 0 }, tag);
    console.log(`[OPS][MARKETING] ${company} plan ${p.id} "${p.title}" sent to ${out.sent}/${out.of} (${out.tag}) by ${by}`);
    return out;
  }

  console.log(`[OPS][MARKETING] ${company} plan ${p.id} "${p.title}" dispatched as job ${out.jobId ?? out.tag} (${out.of} recipients) by ${by}`);
  const deadline = Date.now() + pollBudgetMs();
  let last = { status: String(out.status ?? "QUEUED"), sent: Number(out.sent ?? 0), of: Number(out.of ?? 0) };
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, pollEveryMs()));
    try {
      const j = await engineBridge(company, `?what=broadcast-status&tag=${encodeURIComponent(tag)}`, { timeoutMs: 20_000 });
      if (j?.status) last = { status: String(j.status), sent: Number(j.sent ?? 0), of: Number(j.of ?? last.of) };
    } catch {
      continue; // transient poll failure — keep waiting; reconciler is the backstop
    }
    const v = broadcastVerdict(last);
    if (v.status !== "sending") {
      await applyVerdict(p.id, v, { sent: last.sent, of: last.of }, tag);
      console.log(`[OPS][MARKETING] ${company} plan ${p.id} "${p.title}" ${v.status}: ${last.sent}/${last.of} (${tag})`);
      return { sent: last.sent, of: last.of, tag };
    }
    await pool.query(`UPDATE ops_email_plans SET sent_count = $2, total_count = $3, updated_at = NOW() WHERE id = $1`, [p.id, last.sent, last.of]);
  }
  await pool.query(
    `UPDATE ops_email_plans SET status = 'sending', status_note = 'poll budget exhausted — reconciler will resolve from engine evidence', updated_at = NOW() WHERE id = $1`,
    [p.id],
  );
  return { sent: last.sent, of: last.of, tag };
}

/**
 * Resolve plans stuck in 'sending' from ENGINE evidence (called every scheduler tick).
 * UNKNOWN job + zero ledger activity is the only path to send_failed here.
 */
export async function reconcilePendingSends(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, company, resend_broadcast_id AS tag FROM ops_email_plans
      WHERE status = 'sending' AND updated_at < NOW() - interval '10 minutes' AND resend_broadcast_id IS NOT NULL`,
  );
  let fixed = 0;
  for (const r of rows) {
    try {
      const j = await engineBridge(r.company, `?what=broadcast-status&tag=${encodeURIComponent(r.tag)}`, { timeoutMs: 20_000 });
      if (j?.status === "UNKNOWN") {
        // Pre-job send or never dispatched: fall back to the analytics ledger.
        const a = await engineBridge(r.company, `?what=tag-stats&tag=${encodeURIComponent(r.tag)}`, { timeoutMs: 20_000 }).catch(() => null);
        const sent = Number(a?.sent ?? 0);
        if (sent > 0) {
          await applyVerdict(r.id, { status: "sent", note: `reconciled from ledger evidence (${sent} sends under this tag)` }, { sent, of: sent }, r.tag);
        } else {
          await applyVerdict(r.id, { status: "send_failed", note: "no engine job and no ledger activity under this tag" }, { sent: 0, of: 0 }, r.tag);
        }
        fixed++;
        continue;
      }
      const v = broadcastVerdict({ status: String(j.status), sent: Number(j.sent ?? 0), of: Number(j.of ?? 0) });
      if (v.status !== "sending") {
        await applyVerdict(r.id, v, { sent: Number(j.sent ?? 0), of: Number(j.of ?? 0) }, r.tag);
        fixed++;
      }
    } catch (e) {
      console.error(`[OPS][MARKETING] reconcile plan ${r.id} failed: ${(e as Error).message}`);
    }
  }
  return fixed;
}

/**
 * One alert email through a configured engine's test-send pipe (full-doc aware, real
 * transport). Brand-neutral: prefers the RP engine, falls back to the first configured one.
 */
export async function sendOpsAlert(to: string, subject: string, html: string): Promise<void> {
  const company = hasEngine("realpeptides")
    ? "realpeptides"
    : Object.keys(ENGINES).find(hasEngine);
  if (!company) throw new Error("No email engine is configured on ops — alert email has no transport.");
  await engineBridge(company, "", { method: "POST", body: { action: "test", subject, html, to } });
}

/**
 * Evidence-only status repair for ONE plan (the #81/#76 reconciliation): job
 * status first, then the webhook ledger by tag. There is NO send path here —
 * it can only re-describe what already happened.
 */
export async function reconcilePlanFromEvidence(planId: number): Promise<{ status: string; note: string | null; sent: number; of: number; tag: string }> {
  const { rows } = await pool.query(`SELECT id, company, title, subject, resend_broadcast_id FROM ops_email_plans WHERE id = $1`, [planId]);
  const p = rows[0];
  if (!p) throw new Error(`no plan ${planId}`);
  const tag = p.resend_broadcast_id || `ops-${p.id}-${slugify(p.title || p.subject || "broadcast")}`;
  const j = await engineBridge(p.company, `?what=broadcast-status&tag=${encodeURIComponent(tag)}`, { timeoutMs: 20_000 });
  if (j?.status && j.status !== "UNKNOWN") {
    const v = broadcastVerdict({ status: String(j.status), sent: Number(j.sent ?? 0), of: Number(j.of ?? 0) });
    if (v.status !== "sending") await applyVerdict(p.id, v, { sent: Number(j.sent ?? 0), of: Number(j.of ?? 0) }, tag);
    return { ...v, sent: Number(j.sent ?? 0), of: Number(j.of ?? 0), tag };
  }
  const stats = await engineBridge(p.company, `?what=tag-stats&tag=${encodeURIComponent(tag)}`, { timeoutMs: 20_000 });
  const sent = Number(stats?.sent ?? 0);
  const v = sent > 0
    ? { status: "sent" as const, note: `reconciled from ledger: ${sent} sent, ${stats.delivered ?? 0} delivered, ${stats.bounced ?? 0} bounced under ${tag}` }
    : { status: "send_failed" as const, note: "no job and zero ledger activity under this tag" };
  await applyVerdict(p.id, v, { sent, of: sent }, tag);
  return { ...v, sent, of: sent, tag };
}

export function registerRealPeptidesMarketing(app: Express) {
  const segCache = new Map<string, { at: number; data: any }>();

  /** Unknown brands 404 before we touch the bridge. */
  const brandGate = (req: Request, res: Response, next: NextFunction) => {
    if (!ENGINES[String(req.params.company)]) return res.status(404).json({ error: `No such brand "${req.params.company}".` });
    next();
  };
  /** Extras exist only where the engine serves them (RP today) — 501, never a confusing 502. */
  const capGate = (cap: EngineCapability) => (req: Request, res: Response, next: NextFunction) => {
    const e = ENGINES[String(req.params.company)];
    if (!e) return res.status(404).json({ error: `No such brand "${req.params.company}".` });
    if (!e.capabilities.includes(cap)) {
      return res.status(501).json({ error: `The ${e.label} engine doesn't serve ${cap} — this view is available only for brands whose engine supports it.` });
    }
    next();
  };
  const company = (req: Request) => String(req.params.company);

  // Evidence-only repair (Paul-triggered): fixes a plan's displayed status from
  // engine job + ledger truth. Cannot send, resend or schedule anything.
  app.post("/api/ops/email-plans/:id/reconcile", async (req, res) => {
    try {
      res.json(await reconcilePlanFromEvidence(Number(req.params.id)));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/ops/:company/marketing/segments", brandGate, async (req, res) => {
    try {
      const c = company(req);
      const hit = segCache.get(c);
      if (hit && Date.now() - hit.at < 5 * 60_000) return res.json(hit.data);
      const data = await engineBridge(c, "?what=segments");
      segCache.set(c, { at: Date.now(), data });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/ops/:company/marketing/flows", capGate("flows"), async (req, res) => {
    try {
      res.json(await engineBridge(company(req), "?what=flows"));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // ── Visual flow builder (2026-10-02): list + one write proxy for the custom-flow actions.
  app.get("/api/ops/:company/marketing/custom-flows", capGate("custom-flows"), async (req, res) => {
    try {
      res.json(await engineBridge(company(req), "?what=custom-flows"));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/ops/:company/marketing/custom-flow", capGate("custom-flows"), async (req, res) => {
    try {
      const action = String(req.body?.action ?? "");
      if (!action.startsWith("custom-flow-")) return res.status(400).json({ error: "not a custom-flow action" });
      res.json(await engineBridge(company(req), "", { method: "PUT", body: req.body }));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // One flow step rendered exactly as the engine would send it - the browser review gallery.
  app.post("/api/ops/:company/marketing/render", capGate("custom-flows"), async (req, res) => {
    try {
      const { flowKey, stepIndex, instant } = req.body ?? {};
      res.json(await engineBridge(company(req), "", { method: "PUT", body: { action: "render", flowKey, stepIndex, instant } }));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // One-click import of the 388 bounce/complaint suppressions salvaged from Resend (bundled
  // site-side). RP-only by nature: it's a one-off migration tool, not part of the contract.
  app.post("/api/ops/realpeptides/marketing/import-salvaged-suppressions", async (req: any, res) => {
    try {
      const out = await engineBridge("realpeptides", "", { method: "PUT", body: { action: "import-salvaged-suppressions" } });
      console.log(`[OPS][RP-MARKETING] salvaged suppression import by ${req.adminEmail}:`, JSON.stringify(out));
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Compliance import: unsubscribed addresses from the salvaged Resend export, chunked by the
  // client. Same one-off RP migration tool as above.
  app.post("/api/ops/realpeptides/marketing/import-unsubscribes", async (req: any, res) => {
    try {
      const out = await engineBridge("realpeptides", "", { method: "PUT", body: { action: "import-unsubscribes", emails: req.body?.emails ?? [] } });
      console.log(`[OPS][RP-MARKETING] unsubscribe import chunk by ${req.adminEmail}:`, JSON.stringify(out));
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Audience browser + audience-wide activity feed + broadcast live preview.
  app.get("/api/ops/:company/marketing/contacts", brandGate, async (req, res) => {
    try {
      const qs = new URLSearchParams();
      for (const k of ["q", "page", "pageSize"]) if (req.query[k]) qs.set(k, String(req.query[k]));
      res.json(await engineBridge(company(req), `?what=contacts&${qs}`));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/ops/:company/marketing/recent-events", brandGate, async (req, res) => {
    try {
      res.json(await engineBridge(company(req), `?what=recent-events&limit=${Number(req.query.limit) || 100}`));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  const decodeHtml = (body: any): string => {
    if (body?.html_b64) { try { return Buffer.from(String(body.html_b64), "base64").toString("utf8"); } catch { /* fall through */ } }
    return body?.html ?? "";
  };
  // Live preview of a broadcast body in the brand's shell. An engine that doesn't implement
  // the render-broadcast action answers with its own error; the builder falls back to raw HTML.
  app.post("/api/ops/:company/marketing/render-broadcast", brandGate, async (req, res) => {
    try {
      res.json(await engineBridge(company(req), "", { method: "PUT", body: { action: "render-broadcast", html: decodeHtml(req.body) } }));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  app.get("/api/ops/:company/marketing/site-emails", capGate("site-emails"), async (req, res) => {
    try { res.json(await engineBridge(company(req), "?what=site-emails")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // The in-dashboard copy editor: override CRUD + sample-value draft preview.
  app.get("/api/ops/:company/marketing/overrides", capGate("overrides"), async (req, res) => {
    try { res.json(await engineBridge(company(req), "?what=overrides")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/ops/:company/marketing/override", capGate("overrides"), async (req, res) => {
    try { res.json(await engineBridge(company(req), `?what=override&alias=${encodeURIComponent(String(req.query.alias || ""))}`)); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/:company/marketing/set-override", capGate("overrides"), async (req: any, res) => {
    try {
      const { alias, html_b64, subject, enabled } = req.body ?? {};
      const out = await engineBridge(company(req), "", { method: "PUT", body: { action: "set-override", alias, html_b64, subject, enabled, updatedBy: req.adminEmail ?? null } });
      console.log(`[OPS][EDITOR] ${company(req)} override ${alias} saved (enabled=${out.enabled}) by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/:company/marketing/delete-override", capGate("overrides"), async (req: any, res) => {
    try {
      const out = await engineBridge(company(req), "", { method: "PUT", body: { action: "delete-override", alias: req.body?.alias } });
      console.log(`[OPS][EDITOR] ${company(req)} override ${req.body?.alias} deleted by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/:company/marketing/render-draft", capGate("overrides"), async (req, res) => {
    try { res.json(await engineBridge(company(req), "", { method: "PUT", body: { action: "render-draft", html_b64: req.body?.html_b64 ?? "" } })); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Per-contact engagement timeline for the Activity view.
  app.get("/api/ops/:company/marketing/activity", brandGate, async (req, res) => {
    try {
      const email = String(req.query.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "email is required" });
      res.json(await engineBridge(company(req), `?what=activity&email=${encodeURIComponent(email)}`));
    } catch (e: any) {
      res.status(e.message?.includes("no marketing contact") ? 404 : 502).json({ error: e.message });
    }
  });

  // Segment rows for CSV export - the client assembles and downloads the file.
  app.get("/api/ops/:company/marketing/export", brandGate, async (req: any, res) => {
    try {
      const slug = String(req.query.segment || "").trim();
      const out = await engineBridge(company(req), `?what=export${slug ? `&segment=${encodeURIComponent(slug)}` : ""}`);
      console.log(`[OPS][MARKETING] ${company(req)} export ${out.segment} (${out.rows?.length} rows) by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/ops/:company/marketing/test", brandGate, async (req: any, res) => {
    try {
      const { subject, to } = req.body ?? {};
      const html = decodeHtml(req.body);
      if (!subject || !html || !to) return res.status(400).json({ error: "subject, html and to are required" });
      const out = await engineBridge(company(req), "", { method: "POST", body: { action: "test", subject, html, to } });
      console.log(`[OPS][MARKETING] ${company(req)} test send to ${to} by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) {
      if (e instanceof EngineRefusal) return res.status(422).json({ error: e.message });
      res.status(502).json({ error: e.message });
    }
  });


  app.post("/api/ops/email-plans/:id/send-rp", async (req: any, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM ops_email_plans WHERE id = $1", [parseInt(req.params.id, 10)]);
      const p = rows[0];
      if (!p) return res.status(404).json({ error: "Plan not found" });
      if (!hasEngine(p.company)) return res.status(400).json({ error: `No email engine is configured for ${p.company} — use Push to Resend for this brand.` });
      if (p.status === "sent") return res.status(409).json({ error: "This plan has already been sent — duplicate a new plan rather than re-sending." });
      if (!p.subject) return res.status(400).json({ error: "Add a subject line first." });
      if (!p.html) return res.status(400).json({ error: "Add the email design (HTML) first." });
      const problem = broadcastHtmlProblem(p.html);
      if (problem) return res.status(400).json({ error: problem });

      // The automation bearer may preflight (audience resolve + count) but never fire.
      if (req.adminEmail === "automation:claude" && req.body?.confirm) {
        return res.status(403).json({ error: "automation may preview, never send - scheduling is the only agent path to a send" });
      }
      const segment = p.audience_id?.trim() || undefined;
      if (!req.body?.confirm) {
        const preview = await engineBridge(p.company, "", { method: "POST", body: { action: "preview", segment } });
        return res.json({ preview: true, recipients: preview.recipients, segment: preview.segment });
      }

      const out = await firePlan(p.company, p, req.adminEmail ?? "ops");
      res.json({ ok: true, ...out });
    } catch (e: any) {
      // A refusal is actionable — show the human the engine's reason, not a generic 502.
      if (e instanceof EngineRefusal) return res.status(422).json({ error: e.message });
      res.status(502).json({ error: e.message });
    }
  });
}
