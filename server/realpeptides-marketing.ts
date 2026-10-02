/**
 * Real Peptides marketing bridge — the ops side of the in-house email engine that replaced
 * Resend (account deactivated 2026-10-01). The engine, the suppression gate and the audit
 * trail live in the RP site repo behind the token-gated /api/ops-marketing; ops is the UI.
 *
 *   GET  /api/ops/realpeptides/marketing/segments     audience picker: segments + live counts
 *   POST /api/ops/realpeptides/marketing/test         one rendered test send { subject, html, to }
 *   POST /api/ops/email-plans/:id/send-rp             send a calendar plan through the engine
 *
 * send-rp is two-step like the engine itself: without { confirm: true } it returns the live
 * recipient count and sends nothing. The plan's audience_id column (Resend audience in its old
 * life) now holds an engine segment slug, empty = everyone. The engine's tag for the send is
 * stored in resend_broadcast_id so the analytics ledger (EmailEvent.broadcastId = tag) lines
 * up with the calendar row under the column's historical name.
 */
import type { Express } from "express";
import { pool } from "./db";

function cfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

async function bridge(path: string, init?: { method?: string; body?: unknown }) {
  const c = cfg();
  if (!c) throw new Error("Connect the RP backend first (RP_SITE_API_URL + RP_SITE_OPS_TOKEN).");
  const r = await fetch(`${c.base}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(290_000),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.error || `ops-marketing ${r.status}`);
  return j;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function registerRealPeptidesMarketing(app: Express) {
  let segCache: { at: number; data: any } | null = null;

  app.get("/api/ops/realpeptides/marketing/segments", async (_req, res) => {
    try {
      if (segCache && Date.now() - segCache.at < 5 * 60_000) return res.json(segCache.data);
      const data = await bridge("/api/ops-marketing?what=segments");
      segCache = { at: Date.now(), data };
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/ops/realpeptides/marketing/flows", async (_req, res) => {
    try {
      res.json(await bridge("/api/ops-marketing?what=flows"));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // ── Visual flow builder (2026-10-02): list + one write proxy for the custom-flow actions.
  app.get("/api/ops/realpeptides/marketing/custom-flows", async (_req, res) => {
    try {
      res.json(await bridge("/api/ops-marketing?what=custom-flows"));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/marketing/custom-flow", async (req, res) => {
    try {
      const action = String(req.body?.action ?? "");
      if (!action.startsWith("custom-flow-")) return res.status(400).json({ error: "not a custom-flow action" });
      res.json(await bridge("/api/ops-marketing", { method: "PUT", body: req.body }));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // One flow step rendered exactly as the engine would send it - the browser review gallery.
  app.post("/api/ops/realpeptides/marketing/render", async (req, res) => {
    try {
      const { flowKey, stepIndex, instant } = req.body ?? {};
      res.json(await bridge("/api/ops-marketing", { method: "PUT", body: { action: "render", flowKey, stepIndex, instant } }));
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // One-click import of the 388 bounce/complaint suppressions salvaged from Resend (bundled site-side).
  app.post("/api/ops/realpeptides/marketing/import-salvaged-suppressions", async (req: any, res) => {
    try {
      const out = await bridge("/api/ops-marketing", { method: "PUT", body: { action: "import-salvaged-suppressions" } });
      console.log(`[OPS][RP-MARKETING] salvaged suppression import by ${req.adminEmail}:`, JSON.stringify(out));
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Compliance import: unsubscribed addresses from the salvaged Resend export, chunked by the client.
  app.post("/api/ops/realpeptides/marketing/import-unsubscribes", async (req: any, res) => {
    try {
      const out = await bridge("/api/ops-marketing", { method: "PUT", body: { action: "import-unsubscribes", emails: req.body?.emails ?? [] } });
      console.log(`[OPS][RP-MARKETING] unsubscribe import chunk by ${req.adminEmail}:`, JSON.stringify(out));
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Audience browser + audience-wide activity feed + broadcast live preview.
  app.get("/api/ops/realpeptides/marketing/contacts", async (req, res) => {
    try {
      const qs = new URLSearchParams();
      for (const k of ["q", "page", "pageSize"]) if (req.query[k]) qs.set(k, String(req.query[k]));
      res.json(await bridge(`/api/ops-marketing?what=contacts&${qs}`));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/ops/realpeptides/marketing/recent-events", async (req, res) => {
    try {
      res.json(await bridge(`/api/ops-marketing?what=recent-events&limit=${Number(req.query.limit) || 100}`));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  const decodeHtml = (body: any): string => {
    if (body?.html_b64) { try { return Buffer.from(String(body.html_b64), "base64").toString("utf8"); } catch { /* fall through */ } }
    return body?.html ?? "";
  };
  app.post("/api/ops/realpeptides/marketing/render-broadcast", async (req, res) => {
    try {
      res.json(await bridge("/api/ops-marketing", { method: "PUT", body: { action: "render-broadcast", html: decodeHtml(req.body) } }));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  app.get("/api/ops/realpeptides/marketing/site-emails", async (_req, res) => {
    try { res.json(await bridge("/api/ops-marketing?what=site-emails")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // The in-dashboard copy editor: override CRUD + sample-value draft preview.
  app.get("/api/ops/realpeptides/marketing/overrides", async (_req, res) => {
    try { res.json(await bridge("/api/ops-marketing?what=overrides")); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/ops/realpeptides/marketing/override", async (req, res) => {
    try { res.json(await bridge(`/api/ops-marketing?what=override&alias=${encodeURIComponent(String(req.query.alias || ""))}`)); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/realpeptides/marketing/set-override", async (req: any, res) => {
    try {
      const { alias, html_b64, subject, enabled } = req.body ?? {};
      const out = await bridge("/api/ops-marketing", { method: "PUT", body: { action: "set-override", alias, html_b64, subject, enabled, updatedBy: req.adminEmail ?? null } });
      console.log(`[OPS][RP-EDITOR] override ${alias} saved (enabled=${out.enabled}) by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/realpeptides/marketing/delete-override", async (req: any, res) => {
    try {
      const out = await bridge("/api/ops-marketing", { method: "PUT", body: { action: "delete-override", alias: req.body?.alias } });
      console.log(`[OPS][RP-EDITOR] override ${req.body?.alias} deleted by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.post("/api/ops/realpeptides/marketing/render-draft", async (req, res) => {
    try { res.json(await bridge("/api/ops-marketing", { method: "PUT", body: { action: "render-draft", html_b64: req.body?.html_b64 ?? "" } })); }
    catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Per-contact engagement timeline for the Activity view.
  app.get("/api/ops/realpeptides/marketing/activity", async (req, res) => {
    try {
      const email = String(req.query.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "email is required" });
      res.json(await bridge(`/api/ops-marketing?what=activity&email=${encodeURIComponent(email)}`));
    } catch (e: any) {
      res.status(e.message?.includes("no marketing contact") ? 404 : 502).json({ error: e.message });
    }
  });

  // Segment rows for CSV export - the client assembles and downloads the file.
  app.get("/api/ops/realpeptides/marketing/export", async (req: any, res) => {
    try {
      const slug = String(req.query.segment || "").trim();
      const out = await bridge(`/api/ops-marketing?what=export${slug ? `&segment=${encodeURIComponent(slug)}` : ""}`);
      console.log(`[OPS][RP-MARKETING] export ${out.segment} (${out.rows?.length} rows) by ${req.adminEmail}`);
      res.json(out);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post("/api/ops/realpeptides/marketing/test", async (req: any, res) => {
    try {
      const { subject, to } = req.body ?? {};
      const html = decodeHtml(req.body);
      if (!subject || !html || !to) return res.status(400).json({ error: "subject, html and to are required" });
      const out = await bridge("/api/ops-marketing", { method: "POST", body: { action: "test", subject, html, to } });
      console.log(`[OPS][RP-MARKETING] test send to ${to} by ${req.adminEmail}`);
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
      if (p.company !== "realpeptides") return res.status(400).json({ error: "send-rp is the Real Peptides engine door; use push for other brands." });
      if (p.status === "sent") return res.status(409).json({ error: "This plan has already been sent — duplicate a new plan rather than re-sending." });
      if (!p.subject) return res.status(400).json({ error: "Add a subject line first." });
      if (!p.html) return res.status(400).json({ error: "Add the email design (HTML) first." });

      const segment = p.audience_id?.trim() || undefined;
      if (!req.body?.confirm) {
        const preview = await bridge("/api/ops-marketing", { method: "POST", body: { action: "preview", segment } });
        return res.json({ preview: true, recipients: preview.recipients, segment: preview.segment });
      }

      const tag = `ops-${p.id}-${slugify(p.title || p.subject)}`;
      const out = await bridge("/api/ops-marketing", {
        method: "POST",
        body: { action: "send", confirm: true, subject: p.subject, html: p.html, segment, tag },
      });
      await pool.query(
        `UPDATE ops_email_plans SET resend_broadcast_id = $2, status = 'sent', updated_at = NOW() WHERE id = $1`,
        [p.id, out.tag],
      );
      console.log(`[OPS][RP-MARKETING] plan ${p.id} "${p.title}" sent to ${out.sent}/${out.of} (${out.tag}) by ${req.adminEmail}`);
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
}
