/**
 * Klaviyo connector.
 *
 * Auth: KLAVIYO_API_KEY (private key, pk_*) in env. No OAuth — Klaviyo's
 * OAuth is for marketplace listings, not internal tools.
 *
 * Surfaces: account info, campaigns, flows, lists, segments, templates,
 * audience sizing, and outbound campaign sends from existing templates.
 * Send orchestration is the multi-step Klaviyo dance:
 *   1. POST /campaigns/                       — create draft + message
 *   2. POST /campaign-messages/{id}/assign-template/  — link template
 *   3. POST /campaign-send-jobs/              — actually fire / schedule
 * Every send is logged to ops_campaign_sends with the admin email.
 */
import type { Express, Request } from "express";
import { pool } from "./db";

interface AdminReq extends Request {
  adminEmail?: string;
}

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
// Pin the revision so contract changes don't silently break us.
// Bump deliberately when we want new endpoint behaviors.
const KLAVIYO_REVISION = "2025-04-15";

interface KlaviyoErr extends Error {
  status?: number;
  body?: unknown;
}

function getKey(): string | null {
  const k = process.env.KLAVIYO_API_KEY;
  if (!k || !k.startsWith("pk_")) return null;
  return k;
}

async function klaviyoFetch<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const key = getKey();
  if (!key) {
    const err: KlaviyoErr = new Error("KLAVIYO_API_KEY not configured");
    err.status = 503;
    throw err;
  }

  const url = path.startsWith("http") ? path : `${KLAVIYO_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      revision: KLAVIYO_REVISION,
      ...(init.headers || {}),
    },
  });

  if (res.status === 429) {
    // Honor Retry-After once. The dashboard isn't latency-critical so a
    // single retry is fine; deeper backoff lives upstream if we ever need it.
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return klaviyoFetch<T>(path, init);
  }

  const text = await res.text();
  const body = text ? safeJson(text) : null;

  if (!res.ok) {
    const err: KlaviyoErr = new Error(
      `Klaviyo ${res.status}: ${typeof body === "object" ? JSON.stringify(body) : text}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerKlaviyoRoutes(app: Express) {
  // Connection status — used by Integrations page.
  app.get("/api/ops/klaviyo/status", async (_req, res) => {
    if (!getKey()) {
      return res.json({
        configured: false,
        connected: false,
      });
    }
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        "/accounts/?fields[account]=contact_information,industry,timezone,locale"
      );
      const account = data.data?.[0];
      const contact = account?.attributes?.contact_information;
      res.json({
        configured: true,
        connected: true,
        accountId: account?.id ?? null,
        organization: contact?.organization_name ?? null,
        defaultSenderEmail: contact?.default_sender_email ?? null,
        defaultSenderName: contact?.default_sender_name ?? null,
        timezone: account?.attributes?.timezone ?? null,
      });
    } catch (e: any) {
      res.json({
        configured: true,
        connected: false,
        error: e.message || "klaviyo request failed",
      });
    }
  });

  // Recent email campaigns. Klaviyo requires filtering campaigns by channel.
  app.get("/api/ops/klaviyo/campaigns", async (_req, res) => {
    try {
      // Klaviyo /campaigns/ allows sort by: scheduled_at, created_at,
      // updated_at, id, name (each with optional - prefix). send_time is
      // not a valid sort field. Page size cap = 100.
      const data = await klaviyoFetch<{ data: any[] }>(
        `/campaigns/?filter=${encodeURIComponent('equals(messages.channel,"email")')}` +
          `&sort=-scheduled_at&page[size]=50`
      );
      const campaigns = (data.data || []).map((c) => ({
        id: c.id,
        name: c.attributes?.name ?? "(unnamed)",
        status: c.attributes?.status ?? null,
        archived: !!c.attributes?.archived,
        scheduledAt: c.attributes?.scheduled_at ?? null,
        sendTime: c.attributes?.send_time ?? null,
        createdAt: c.attributes?.created_at ?? null,
        updatedAt: c.attributes?.updated_at ?? null,
      }));
      res.json({ campaigns });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Live + draft flows (most recent first).
  app.get("/api/ops/klaviyo/flows", async (_req, res) => {
    try {
      // Klaviyo /flows/ page[size] cap = 50.
      const data = await klaviyoFetch<{ data: any[] }>(
        `/flows/?fields[flow]=name,status,trigger_type,created,updated` +
          `&sort=-updated&page[size]=50`
      );
      const flows = (data.data || []).map((f) => ({
        id: f.id,
        name: f.attributes?.name ?? "(unnamed)",
        status: f.attributes?.status ?? null,
        triggerType: f.attributes?.trigger_type ?? null,
        createdAt: f.attributes?.created ?? null,
        updatedAt: f.attributes?.updated ?? null,
      }));
      res.json({ flows });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Lists (manual audiences).
  app.get("/api/ops/klaviyo/lists", async (_req, res) => {
    try {
      // Klaviyo /lists/ page[size] cap = 10.
      const data = await klaviyoFetch<{ data: any[] }>(
        `/lists/?fields[list]=name,created,updated&page[size]=10`
      );
      const lists = (data.data || []).map((l) => ({
        id: l.id,
        name: l.attributes?.name ?? "(unnamed)",
        createdAt: l.attributes?.created ?? null,
        updatedAt: l.attributes?.updated ?? null,
      }));
      res.json({ lists });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Segments (dynamic audiences).
  app.get("/api/ops/klaviyo/segments", async (_req, res) => {
    try {
      // Klaviyo /segments/ page[size] cap = 10.
      const data = await klaviyoFetch<{ data: any[] }>(
        `/segments/?fields[segment]=name,is_active,created,updated&page[size]=10`
      );
      const segments = (data.data || []).map((s) => ({
        id: s.id,
        name: s.attributes?.name ?? "(unnamed)",
        isActive: !!s.attributes?.is_active,
        createdAt: s.attributes?.created ?? null,
        updatedAt: s.attributes?.updated ?? null,
      }));
      res.json({ segments });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Email templates (for the send composer).
  app.get("/api/ops/klaviyo/templates", async (_req, res) => {
    try {
      // Klaviyo caps /templates/ page[size] at 10 (other endpoints allow 100).
      const data = await klaviyoFetch<{ data: any[] }>(
        `/templates/?fields[template]=name,editor_type,created,updated&sort=-updated&page[size]=10`
      );
      const templates = (data.data || []).map((t) => ({
        id: t.id,
        name: t.attributes?.name ?? "(unnamed)",
        editorType: t.attributes?.editor_type ?? null,
        createdAt: t.attributes?.created ?? null,
        updatedAt: t.attributes?.updated ?? null,
      }));
      res.json({ templates });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Render a template (HTML preview) — used by the confirmation step.
  app.get("/api/ops/klaviyo/templates/:id/html", async (req, res) => {
    try {
      const data = await klaviyoFetch<{ data: any }>(
        `/templates/${encodeURIComponent(req.params.id)}/?fields[template]=name,html,text`
      );
      res.json({
        name: data.data?.attributes?.name ?? null,
        html: data.data?.attributes?.html ?? "",
        text: data.data?.attributes?.text ?? "",
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Estimate audience size given list + segment IDs.
  // Klaviyo dedups across lists/segments at send time; this is an
  // upper-bound sum, not the exact deduped recipient count.
  app.post("/api/ops/klaviyo/audience-size", async (req, res) => {
    try {
      const listIds = Array.isArray(req.body?.listIds) ? req.body.listIds : [];
      const segmentIds = Array.isArray(req.body?.segmentIds)
        ? req.body.segmentIds
        : [];
      if (listIds.length === 0 && segmentIds.length === 0) {
        return res.json({ total: 0, breakdown: [] });
      }

      const breakdown: Array<{
        kind: "list" | "segment";
        id: string;
        name: string;
        count: number;
      }> = [];

      for (const id of listIds) {
        const data = await klaviyoFetch<{ data: any }>(
          `/lists/${encodeURIComponent(id)}/?additional-fields[list]=profile_count` +
            `&fields[list]=name,profile_count`
        );
        breakdown.push({
          kind: "list",
          id,
          name: data.data?.attributes?.name ?? "(unnamed)",
          count: parseInt(data.data?.attributes?.profile_count ?? "0", 10) || 0,
        });
      }

      for (const id of segmentIds) {
        const data = await klaviyoFetch<{ data: any }>(
          `/segments/${encodeURIComponent(id)}/?additional-fields[segment]=profile_count` +
            `&fields[segment]=name,profile_count`
        );
        breakdown.push({
          kind: "segment",
          id,
          name: data.data?.attributes?.name ?? "(unnamed)",
          count: parseInt(data.data?.attributes?.profile_count ?? "0", 10) || 0,
        });
      }

      const total = breakdown.reduce((s, x) => s + x.count, 0);
      res.json({ total, breakdown });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Recent send audit log — most recent 50.
  app.get("/api/ops/klaviyo/sends", async (_req, res) => {
    try {
      await ensureSendsTable();
      const r = await pool.query(
        `SELECT id, admin_email, klaviyo_campaign_id, name, subject,
                recipient_count, audience_summary, send_method, scheduled_for,
                status, error, created_at
         FROM ops_campaign_sends
         ORDER BY created_at DESC
         LIMIT 50`
      );
      res.json({ sends: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Send a campaign from a template. Multi-step Klaviyo orchestration +
  // audit log row. Errors mid-flight roll forward — the audit row records
  // whichever step failed so the operator can retry deliberately.
  app.post("/api/ops/klaviyo/send", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const {
      name,
      templateId,
      subject,
      previewText,
      fromEmail,
      fromLabel,
      listIds = [],
      segmentIds = [],
      excludedSegmentIds = [],
      sendMethod = "immediate",
      scheduledFor,
      smartSendingEnabled = true,
    } = req.body || {};

    // Basic input validation. Klaviyo will catch deeper issues but cheap
    // checks here give better error messages and stop accidental sends.
    const issues: string[] = [];
    if (!name || typeof name !== "string") issues.push("name is required");
    if (!templateId || typeof templateId !== "string")
      issues.push("templateId is required");
    if (!subject || typeof subject !== "string")
      issues.push("subject is required");
    if (!fromEmail || typeof fromEmail !== "string")
      issues.push("fromEmail is required");
    if (!fromLabel || typeof fromLabel !== "string")
      issues.push("fromLabel is required");
    if (
      !Array.isArray(listIds) ||
      !Array.isArray(segmentIds) ||
      listIds.length + segmentIds.length === 0
    ) {
      issues.push("at least one list or segment must be included");
    }
    if (
      sendMethod !== "immediate" &&
      sendMethod !== "smart_send_time" &&
      sendMethod !== "static"
    ) {
      issues.push("sendMethod must be immediate, static, or smart_send_time");
    }
    if (sendMethod === "static" && !scheduledFor) {
      issues.push("scheduledFor is required when sendMethod=static");
    }
    if (issues.length > 0) {
      return res.status(400).json({ error: "validation failed", issues });
    }

    await ensureSendsTable();
    const auditId = (
      await pool.query(
        `INSERT INTO ops_campaign_sends
          (admin_email, name, subject, audience_summary, send_method,
           scheduled_for, status, recipient_count)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0)
         RETURNING id`,
        [
          adminEmail,
          name,
          subject,
          JSON.stringify({ listIds, segmentIds, excludedSegmentIds }),
          sendMethod,
          sendMethod === "static" ? scheduledFor : null,
        ]
      )
    ).rows[0].id;

    try {
      // Step 1: create the campaign + message envelope.
      const audiences: { included: string[]; excluded?: string[] } = {
        included: [...listIds, ...segmentIds],
      };
      if (excludedSegmentIds.length > 0) {
        audiences.excluded = excludedSegmentIds;
      }

      const sendStrategy: Record<string, any> = (() => {
        if (sendMethod === "static") {
          return {
            method: "static",
            datetime: scheduledFor,
            options_static: {
              is_local: false,
              send_past_recipients_immediately: false,
            },
          };
        }
        if (sendMethod === "smart_send_time") {
          return {
            method: "smart_send_time",
            datetime: scheduledFor || new Date().toISOString(),
          };
        }
        return { method: "immediate" };
      })();

      const createBody = {
        data: {
          type: "campaign",
          attributes: {
            name,
            audiences,
            send_strategy: sendStrategy,
            send_options: { use_smart_sending: smartSendingEnabled },
            "campaign-messages": {
              data: [
                {
                  type: "campaign-message",
                  attributes: {
                    definition: {
                      channel: "email",
                      label: name,
                      content: {
                        subject,
                        preview_text: previewText || "",
                        from_email: fromEmail,
                        from_label: fromLabel,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      };

      const created = await klaviyoFetch<any>("/campaigns/", {
        method: "POST",
        body: JSON.stringify(createBody),
      });
      const campaignId: string = created?.data?.id;
      if (!campaignId) throw new Error("campaign creation returned no id");

      // We only need the message id; skip the sparse fieldset entirely so
      // we don't trip Klaviyo's strict allowlist (label lives in definition,
      // not as a top-level field).
      const messages = await klaviyoFetch<any>(
        `/campaigns/${encodeURIComponent(campaignId)}/campaign-messages/`
      );
      const messageId: string | undefined = messages?.data?.[0]?.id;
      if (!messageId) throw new Error("no campaign-message id returned");

      // Step 2: bind the template to the message. Klaviyo exposes this as
      // a top-level action endpoint, not a sub-resource of campaign-messages
      // — message id goes in the body, not the URL.
      await klaviyoFetch("/campaign-message-assign-template/", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "campaign-message",
            id: messageId,
            relationships: {
              template: { data: { type: "template", id: templateId } },
            },
          },
        }),
      });

      // Step 3: submit the send job. This commits the send (or schedules
      // it based on the campaign's send_strategy).
      await klaviyoFetch("/campaign-send-jobs/", {
        method: "POST",
        body: JSON.stringify({
          data: { type: "campaign-send-job", id: campaignId },
        }),
      });

      await pool.query(
        `UPDATE ops_campaign_sends
         SET klaviyo_campaign_id = $1, status = 'submitted', updated_at = NOW()
         WHERE id = $2`,
        [campaignId, auditId]
      );

      console.log(
        `[OPS][KLAVIYO] send submitted by ${adminEmail}: campaign=${campaignId} method=${sendMethod}`
      );
      res.json({ success: true, campaignId, auditId });
    } catch (e: any) {
      console.error(`[OPS][KLAVIYO] send failed: ${e.message}`);
      await pool.query(
        `UPDATE ops_campaign_sends
         SET status = 'failed', error = $1, updated_at = NOW()
         WHERE id = $2`,
        [e.message?.slice(0, 1000) || "unknown error", auditId]
      );
      res.status(e.status || 500).json({ error: e.message, auditId });
    }
  });
}

async function ensureSendsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_campaign_sends (
      id SERIAL PRIMARY KEY,
      admin_email TEXT NOT NULL,
      klaviyo_campaign_id TEXT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      audience_summary JSONB NOT NULL,
      send_method TEXT NOT NULL,
      scheduled_for TIMESTAMP,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Utility for other server modules that want to push events into Klaviyo.
 * Not exposed on the HTTP API — call directly from server-side autonomy
 * jobs (e.g. when a churn-risk threshold trips, push an event that a
 * Klaviyo flow can listen for).
 */
export async function trackKlaviyoEvent(opts: {
  email: string;
  metric: string;
  properties?: Record<string, unknown>;
  value?: number;
  time?: Date;
}): Promise<void> {
  const body = {
    data: {
      type: "event",
      attributes: {
        properties: opts.properties || {},
        metric: { data: { type: "metric", attributes: { name: opts.metric } } },
        profile: { data: { type: "profile", attributes: { email: opts.email } } },
        ...(opts.value !== undefined ? { value: opts.value } : {}),
        ...(opts.time ? { time: opts.time.toISOString() } : {}),
      },
    },
  };
  await klaviyoFetch("/events/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
