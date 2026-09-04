/**
 * Email content calendar — plan campaigns weeks out, per brand, inside the
 * Email tab. A plan holds the schedule slot, the copy, and the pasted HTML
 * design (Josh designs elsewhere and drops the HTML in; ops previews it).
 *
 * Resend is the send rail. The key is env-gated per company
 * (RESEND_API_KEY_<COMPANY>, e.g. RESEND_API_KEY_REALPEPTIDES) — until it's
 * set, the calendar plans and previews; once set, "Push to Resend" creates
 * the broadcast and schedules it for the plan's date, all from ops.
 */
import type { Express } from "express";
import { pool } from "./db";

const COMPANIES = new Set(["realpeptides", "fitscript", "peptideu", "pawgen"]);
const STATUSES = new Set(["idea", "draft", "approved", "scheduled", "sent"]);
const RESEND = "https://api.resend.com";

function resendKey(company: string): string | null {
  return process.env[`RESEND_API_KEY_${company.toUpperCase()}`] || null;
}
function defaultFrom(company: string): string | null {
  return process.env[`RESEND_FROM_${company.toUpperCase()}`] || null;
}

async function resend(key: string, path: string, init?: RequestInit) {
  const r = await fetch(`${RESEND}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(j?.message || j?.error || `Resend ${r.status}`);
  return j;
}

// ── Resend → calendar pull ──────────────────────────────────────────
// Josh's AI uploads broadcasts straight into Resend; the calendar pulls them
// back so ops is never behind. Runs on calendar load, throttled per company.
// Resend is the source of truth for anything it knows about: linked plans
// take their status / schedule / subject from the broadcast on every pull.
const lastPull = new Map<string, number>();
const PULL_INTERVAL_MS = 5 * 60_000;
const PULL_LOOKBACK_MS = 90 * 86_400_000;

function resendStatusToPlan(s: string): string | null {
  const v = String(s || "").toLowerCase();
  if (v === "draft") return "draft";
  if (v === "scheduled" || v === "queued") return "scheduled";
  if (v === "sent" || v === "delivered") return "sent";
  return null; // canceled etc — leave the plan alone
}

/** scheduled_at/sent_at ISO → ET calendar slot. */
function toEtSlot(iso: string | null | undefined): { date: string | null; time: string | null } {
  if (!iso) return { date: null, time: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: null, time: null };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

async function pullFromResend(company: string): Promise<void> {
  const key = resendKey(company);
  if (!key) return;
  const now = Date.now();
  if (now - (lastPull.get(company) ?? 0) < PULL_INTERVAL_MS) return;
  lastPull.set(company, now);

  const list = await resend(key, "/broadcasts");
  const broadcasts = (list.data ?? [])
    .filter((b: any) => b.created_at && Date.parse(b.created_at) > now - PULL_LOOKBACK_MS)
    .slice(0, 200);
  if (!broadcasts.length) return;

  const { rows: existing } = await pool.query(
    "SELECT id, resend_broadcast_id, status FROM ops_email_plans WHERE company = $1 AND resend_broadcast_id IS NOT NULL",
    [company]);
  const byBroadcast = new Map(existing.map((p: any) => [p.resend_broadcast_id, p]));

  let created = 0, updated = 0;
  for (const b of broadcasts) {
    const status = resendStatusToPlan(b.status);
    if (!status) continue;
    const slot = toEtSlot(b.scheduled_at ?? b.sent_at);
    const linked = byBroadcast.get(b.id);
    if (linked) {
      if (linked.status !== status || slot.date) {
        await pool.query(
          `UPDATE ops_email_plans SET status = $2,
                  send_date = COALESCE($3::date, send_date), send_time = COALESCE($4, send_time),
                  updated_at = NOW()
           WHERE id = $1`, [linked.id, status, slot.date, slot.time]);
        updated++;
      }
      continue;
    }
    // New broadcast born in Resend — pull the full record for subject/html.
    let detail: any = b;
    try { detail = await resend(key, `/broadcasts/${b.id}`); } catch { /* list fields suffice */ }
    await pool.query(
      `INSERT INTO ops_email_plans (company, title, subject, preheader, status, send_date, send_time, from_address, audience_id, html, notes, resend_broadcast_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'resend-sync')`,
      [
        company,
        detail.name || detail.subject || "Untitled broadcast",
        detail.subject ?? null,
        detail.preview_text ?? null,
        status,
        slot.date, slot.time,
        detail.from ?? null,
        detail.audience_id ?? null,
        detail.html ?? null,
        "Created in Resend",
        b.id,
      ]);
    created++;
  }
  if (created || updated) console.log(`[OPS][EMAIL-PLAN] resend pull (${company}): ${created} new, ${updated} updated`);
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_email_plans (
      id                  SERIAL PRIMARY KEY,
      company             TEXT NOT NULL,
      title               TEXT NOT NULL,
      subject             TEXT,
      preheader           TEXT,
      status              TEXT NOT NULL DEFAULT 'idea',
      send_date           DATE,
      send_time           TEXT,
      from_address        TEXT,
      audience_id         TEXT,
      html                TEXT,
      notes               TEXT,
      resend_broadcast_id TEXT,
      created_by          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function registerEmailPlannerRoutes(app: Express) {
  /** Plans for a company. HTML is omitted from the list (fetch one plan for it). */
  app.get("/api/ops/email-plans", async (req, res) => {
    try {
      await ensureTable();
      const company = String(req.query.company || "");
      if (!COMPANIES.has(company)) return res.status(400).json({ error: "company required" });
      try { await pullFromResend(company); }
      catch (e: any) { console.warn(`[OPS][EMAIL-PLAN] resend pull failed (${company}):`, e.message); }
      const { rows } = await pool.query(
        `SELECT id, company, title, subject, preheader, status, send_date, send_time,
                from_address, audience_id, notes, resend_broadcast_id,
                (html IS NOT NULL AND html != '') AS has_design,
                created_by, created_at, updated_at
         FROM ops_email_plans WHERE company = $1
         ORDER BY send_date ASC NULLS LAST, id ASC`, [company]);
      res.json({ plans: rows, resendConnected: !!resendKey(company), defaultFrom: defaultFrom(company) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/email-plans/:id", async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM ops_email_plans WHERE id = $1", [parseInt(req.params.id, 10)]);
      if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
      res.json(rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/email-plans", async (req: any, res) => {
    try {
      await ensureTable();
      const b = req.body ?? {};
      const company = String(b.company || "");
      const title = String(b.title || "").trim();
      if (!COMPANIES.has(company)) return res.status(400).json({ error: "company required" });
      if (!title) return res.status(400).json({ error: "The email needs a working title" });
      const { rows } = await pool.query(
        `INSERT INTO ops_email_plans (company, title, subject, preheader, status, send_date, send_time, from_address, audience_id, html, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          company, title,
          b.subject ? String(b.subject) : null,
          b.preheader ? String(b.preheader) : null,
          STATUSES.has(b.status) ? b.status : "idea",
          b.send_date || null,
          b.send_time ? String(b.send_time) : null,
          b.from_address ? String(b.from_address) : defaultFrom(company),
          b.audience_id ? String(b.audience_id) : null,
          b.html ? String(b.html) : null,
          b.notes ? String(b.notes) : null,
          req.adminEmail || null,
        ],
      );
      res.json({ ok: true, id: rows[0].id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/email-plans/:id", async (req, res) => {
    try {
      const b = req.body ?? {};
      if (b.status !== undefined && !STATUSES.has(b.status)) return res.status(400).json({ error: "Bad status" });
      const { rows } = await pool.query(
        `UPDATE ops_email_plans SET
           title        = COALESCE($2, title),
           subject      = CASE WHEN $3  THEN $4  ELSE subject END,
           preheader    = CASE WHEN $5  THEN $6  ELSE preheader END,
           status       = COALESCE($7, status),
           send_date    = CASE WHEN $8  THEN $9::date ELSE send_date END,
           send_time    = CASE WHEN $10 THEN $11 ELSE send_time END,
           from_address = CASE WHEN $12 THEN $13 ELSE from_address END,
           audience_id  = CASE WHEN $14 THEN $15 ELSE audience_id END,
           html         = CASE WHEN $16 THEN $17 ELSE html END,
           notes        = CASE WHEN $18 THEN $19 ELSE notes END,
           updated_at   = NOW()
         WHERE id = $1 RETURNING id`,
        [
          parseInt(req.params.id, 10),
          b.title !== undefined ? String(b.title).trim() || null : null,
          b.subject !== undefined, b.subject ? String(b.subject) : null,
          b.preheader !== undefined, b.preheader ? String(b.preheader) : null,
          b.status ?? null,
          b.send_date !== undefined, b.send_date || null,
          b.send_time !== undefined, b.send_time ? String(b.send_time) : null,
          b.from_address !== undefined, b.from_address ? String(b.from_address) : null,
          b.audience_id !== undefined, b.audience_id ? String(b.audience_id) : null,
          b.html !== undefined, b.html ? String(b.html) : null,
          b.notes !== undefined, b.notes ? String(b.notes) : null,
        ],
      );
      if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/email-plans/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM ops_email_plans WHERE id = $1", [parseInt(req.params.id, 10)]);
      if (!rowCount) return res.status(404).json({ error: "Plan not found" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Resend audiences for the audience picker. */
  app.get("/api/ops/email-plans/resend/audiences", async (req, res) => {
    const company = String(req.query.company || "");
    const key = COMPANIES.has(company) ? resendKey(company) : null;
    if (!key) return res.json({ connected: false, audiences: [] });
    try {
      const j = await resend(key, "/audiences");
      res.json({ connected: true, audiences: (j.data ?? []).map((a: any) => ({ id: a.id, name: a.name })) });
    } catch (e: any) {
      res.status(502).json({ connected: true, error: e.message, audiences: [] });
    }
  });

  /**
   * Push a plan to Resend: create the broadcast from the stored design, and
   * schedule it for the plan's date + time when one is set. Re-pushing a plan
   * that already has a broadcast makes a NEW broadcast (Resend broadcasts
   * aren't editable via API once created) — the plan tracks the latest id.
   */
  app.post("/api/ops/email-plans/:id/push", async (req: any, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM ops_email_plans WHERE id = $1", [parseInt(req.params.id, 10)]);
      const p = rows[0];
      if (!p) return res.status(404).json({ error: "Plan not found" });
      const key = resendKey(p.company);
      if (!key) return res.status(503).json({ error: `Resend isn't connected for ${p.company} yet — set RESEND_API_KEY_${p.company.toUpperCase()} on ops.` });
      if (!p.subject) return res.status(400).json({ error: "Add a subject line first." });
      if (!p.html) return res.status(400).json({ error: "Paste the email design (HTML) first." });
      if (!p.from_address) return res.status(400).json({ error: "Set the from address first." });
      if (!p.audience_id) return res.status(400).json({ error: "Pick the Resend audience first." });

      const broadcast = await resend(key, "/broadcasts", {
        method: "POST",
        body: JSON.stringify({
          name: p.title,
          audience_id: p.audience_id,
          from: p.from_address,
          subject: p.subject,
          preview_text: p.preheader || undefined,
          html: p.html,
        }),
      });

      let scheduledFor: string | null = null;
      if (p.send_date && req.body?.schedule !== false) {
        // send_date is a plain date; send_time defaults to 10:00 ET.
        const time = /^\d{2}:\d{2}$/.test(p.send_time || "") ? p.send_time : "10:00";
        scheduledFor = `${String(p.send_date).slice(0, 10)}T${time}:00-04:00`;
        await resend(key, `/broadcasts/${broadcast.id}/send`, {
          method: "POST",
          body: JSON.stringify({ scheduled_at: scheduledFor }),
        });
      }

      await pool.query(
        `UPDATE ops_email_plans SET resend_broadcast_id = $2, status = $3, updated_at = NOW() WHERE id = $1`,
        [p.id, broadcast.id, scheduledFor ? "scheduled" : "approved"]);
      console.log(`[OPS][EMAIL-PLAN] ${p.company} "${p.title}" → Resend ${broadcast.id}${scheduledFor ? ` scheduled ${scheduledFor}` : ""} by ${req.adminEmail}`);
      res.json({ ok: true, broadcastId: broadcast.id, scheduledFor });
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });
}
