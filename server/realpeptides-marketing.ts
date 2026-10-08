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
import { ENGINES, engineBridge, hasEngine, type EngineCapability } from "./brand-engines";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Fire one plan through its brand's engine bridge — shared by the send-rp route (human click)
 * and the scheduler (fires plans the human explicitly set to "scheduled" with a date/time/tz).
 * The caller owns status transitions AROUND this; this does the send + marks sent.
 */
export async function firePlan(
  company: string,
  p: { id: number; title: string | null; subject: string | null; html: string | null; audience_id: string | null },
  by: string,
): Promise<{ sent: number; of: number; tag: string }> {
  const segment = p.audience_id?.trim() || undefined;
  const tag = `ops-${p.id}-${slugify(p.title || p.subject || "broadcast")}`;
  const out = await engineBridge(company, "", {
    method: "POST",
    body: { action: "send", confirm: true, subject: p.subject, html: p.html, segment, tag },
  });
  await pool.query(
    `UPDATE ops_email_plans SET resend_broadcast_id = $2, status = 'sent', updated_at = NOW() WHERE id = $1`,
    [p.id, out.tag],
  );
  console.log(`[OPS][MARKETING] ${company} plan ${p.id} "${p.title}" sent to ${out.sent}/${out.of} (${out.tag}) by ${by}`);
  return out;
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
      res.status(502).json({ error: e.message });
    }
  });
}
