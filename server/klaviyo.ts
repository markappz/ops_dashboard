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
import { logAdminAction } from "./lib/auditLog";

interface AdminReq extends Request {
  adminEmail?: string;
}

export const KLAVIYO_BASE = "https://a.klaviyo.com/api";
// Pin the revision so contract changes don't silently break us.
// Bump deliberately when we want new endpoint behaviors.
export const KLAVIYO_REVISION = "2025-04-15";

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

// ─── Metric discovery (for campaign-values-reports conversion_metric_id) ───

interface KlaviyoMetric {
  id: string;
  attributes?: {
    name?: string;
    integration?: { category?: string; name?: string };
  };
}

interface ConversionMetric {
  id: string;
  name: string;
  isRevenueMetric: boolean;
}

type MetricPurpose = "campaign" | "flow";

// Cache per purpose. The same metric isn't always compatible across
// campaign-values-reports and flow-values-reports — Klaviyo's quirks.
const conversionMetricCache = new Map<
  MetricPurpose,
  { metric: ConversionMetric; fetchedAt: number }
>();
const METRIC_CACHE_TTL_MS = 1000 * 60 * 30; // 30 min

// Revenue-producing metric names from common ecommerce integrations.
// Override with KLAVIYO_CONVERSION_METRIC_NAME env if needed.
const REVENUE_METRIC_NAME_PRIORITY = [
  "placed order",
  "order placed",
  "order completed",
  "checkout completed",
];

// Engagement metric fallbacks (per-purpose, because Klaviyo accepts different
// ones for campaign vs flow values reports — empirically determined).
const ENGAGEMENT_FALLBACK_BY_PURPOSE: Record<MetricPurpose, string[]> = {
  campaign: ["opened email", "received email", "clicked email", "bounced email"],
  flow: ["bounced email", "received email", "opened email", "clicked email"],
};

function isUnsupportedConversionMetricError(e: any): boolean {
  const msg = String(e?.message || "");
  const bodyDetail = e?.body?.errors?.[0]?.detail || "";
  return /does not support querying for values data/i.test(msg + " " + bodyDetail);
}

async function getConversionMetric(
  purpose: MetricPurpose,
): Promise<ConversionMetric | null> {
  const cached = conversionMetricCache.get(purpose);
  if (cached && Date.now() - cached.fetchedAt < METRIC_CACHE_TTL_MS) {
    return cached.metric;
  }
  try {
    // /metrics/ does NOT accept page[size] — it 400s. Default returns all.
    const data = await klaviyoFetch<{ data: KlaviyoMetric[] }>("/metrics/");
    const all = data.data || [];

    const override = process.env.KLAVIYO_CONVERSION_METRIC_NAME?.toLowerCase();
    const revenueNames = override
      ? [override, ...REVENUE_METRIC_NAME_PRIORITY]
      : REVENUE_METRIC_NAME_PRIORITY;

    // Build candidate list: revenue first (flagged), then engagement fallbacks.
    const candidates: ConversionMetric[] = [];
    for (const wanted of revenueNames) {
      const match = all.find((m) => m.attributes?.name?.toLowerCase() === wanted);
      if (match) candidates.push({ id: match.id, name: match.attributes!.name!, isRevenueMetric: true });
    }
    for (const wanted of ENGAGEMENT_FALLBACK_BY_PURPOSE[purpose]) {
      const match = all.find((m) => m.attributes?.name?.toLowerCase() === wanted);
      if (match) candidates.push({ id: match.id, name: match.attributes!.name!, isRevenueMetric: false });
    }

    // Probe each candidate with a minimal report — first one that 200s wins.
    // This avoids the per-purpose compatibility surprises Klaviyo throws at us.
    const reportType =
      purpose === "campaign" ? "campaign-values-report" : "flow-values-report";
    const reportPath =
      purpose === "campaign" ? "/campaign-values-reports/" : "/flow-values-reports/";

    for (const cand of candidates) {
      try {
        await klaviyoFetch(reportPath, {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: reportType,
              attributes: {
                statistics: ["delivered"],
                timeframe: { key: "last_7_days" },
                conversion_metric_id: cand.id,
              },
            },
          }),
        });
        // Worked. Cache and return.
        conversionMetricCache.set(purpose, { metric: cand, fetchedAt: Date.now() });
        return cand;
      } catch (e: any) {
        if (isUnsupportedConversionMetricError(e)) {
          // Try next candidate.
          continue;
        }
        // Other errors (rate limit, network, etc.) — re-throw outward.
        throw e;
      }
    }
  } catch (e) {
    console.warn(
      `[KLAVIYO] ${purpose} metric discovery failed:`,
      (e as Error).message,
    );
  }
  return null;
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

  // Flip a flow between live and draft. Klaviyo doesn't distinguish "pause"
  // from "draft" via the API — both are just status changes.
  app.patch("/api/ops/klaviyo/flows/:id/status", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const { status } = req.body ?? {};
    const targetId = req.params.id;
    if (status !== "live" && status !== "draft" && status !== "manual") {
      return res.status(400).json({
        error: "status must be 'live', 'draft', or 'manual'",
      });
    }

    // Pre-fetch the flow name so a failed PATCH still produces a useful
    // audit row (otherwise the target_label is "unnamed" and an operator
    // has to cross-reference the ID).
    let flowName: string | null = null;
    try {
      const pre = await klaviyoFetch<{ data: any }>(
        `/flows/${encodeURIComponent(targetId)}/?fields[flow]=name`,
      );
      flowName = pre.data?.attributes?.name ?? null;
    } catch {
      // Name lookup is best-effort. If even the GET fails, fall through
      // to the PATCH so the error path still records something.
    }

    try {
      const data = await klaviyoFetch<{ data: any }>(
        `/flows/${encodeURIComponent(targetId)}/`,
        {
          method: "PATCH",
          body: JSON.stringify({
            data: {
              type: "flow",
              id: targetId,
              attributes: { status },
            },
          }),
        },
      );
      const newStatus = data.data?.attributes?.status ?? status;
      const name = data.data?.attributes?.name ?? flowName;
      await logAdminAction({
        adminEmail,
        actionType: `flow.${status === "live" ? "activate" : "deactivate"}`,
        targetKind: "klaviyo_flow",
        targetId,
        targetLabel: name,
        status: "ok",
        metadata: { newStatus },
      });
      console.log(
        `[OPS][KLAVIYO] flow ${targetId} → ${newStatus} by ${adminEmail}`,
      );
      res.json({ id: targetId, status: newStatus, name });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: `flow.${status === "live" ? "activate" : "deactivate"}`,
        targetKind: "klaviyo_flow",
        targetId,
        targetLabel: flowName,
        status: "failed",
        error: e.message,
      });
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Per-flow stats over a time window. Mirrors campaign-metrics:
  // one POST to Klaviyo returns all flows in the window — no N+1.
  app.get("/api/ops/klaviyo/flow-metrics", async (req, res) => {
    try {
      const days = Math.min(
        Math.max(parseInt((req.query.days as string) || "30"), 7),
        365,
      );
      const presetKey =
        days <= 7
          ? "last_7_days"
          : days <= 30
            ? "last_30_days"
            : days <= 90
              ? "last_90_days"
              : "last_365_days";

      const conv = await getConversionMetric("flow");
      if (!conv) {
        return res.json({
          metrics: {},
          revenueAvailable: false,
          warning: "No usable conversion metric found in this Klaviyo account.",
        });
      }

      // Same value-vs-engagement split as campaign-metrics — Klaviyo 400s
      // if you request `conversion_value` against a non-revenue metric.
      const FLOW_ENGAGEMENT_STATS = [
        "opens", "opens_unique", "clicks", "clicks_unique", "delivered",
        "bounced", "unsubscribes", "spam_complaints", "recipients",
        "open_rate", "click_rate", "click_to_open_rate", "bounce_rate",
        "unsubscribe_rate",
      ];
      const FLOW_VALUE_STATS = ["conversions", "conversion_uniques", "conversion_value", "revenue_per_recipient"];
      const stats = conv.isRevenueMetric ? [...FLOW_ENGAGEMENT_STATS, ...FLOW_VALUE_STATS] : FLOW_ENGAGEMENT_STATS;

      const body = {
        data: {
          type: "flow-values-report",
          attributes: {
            statistics: stats,
            timeframe: { key: presetKey },
            conversion_metric_id: conv.id,
          },
        },
      };

      const data = await klaviyoFetch<{
        data: { attributes?: { results?: any[] } };
      }>("/flow-values-reports/", {
        method: "POST",
        body: JSON.stringify(body),
      });

      const rows = data.data?.attributes?.results || [];
      const metrics: Record<string, any> = {};
      for (const row of rows) {
        const id = row.groupings?.flow_id;
        if (!id) continue;
        metrics[id] = row.statistics || {};
      }

      res.json({
        metrics,
        timeframe: presetKey,
        flowCount: Object.keys(metrics).length,
        revenueAvailable: conv.isRevenueMetric,
        conversionMetricName: conv.name,
        warning: conv.isRevenueMetric
          ? null
          : `Using ${conv.name} as the conversion metric. Revenue values will be 0 until a values-data-compatible revenue event exists.`,
      });
    } catch (e: any) {
      console.warn("[OPS][KLAVIYO] flow-metrics failed:", e.message);
      res.json({
        metrics: {},
        timeframe: null,
        flowCount: 0,
        revenueAvailable: false,
        conversionMetricName: null,
        warning: `Flow metrics unavailable: ${e.message}`,
      });
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

  // Campaign metrics for a date range. Returns a map of campaign_id → stats
  // (opens, opens_unique, clicks, clicks_unique, delivered, bounced,
  // unsubscribes, conversions, revenue). One Klaviyo POST returns all
  // email campaigns in the timeframe — no N+1 needed.
  app.get("/api/ops/klaviyo/campaign-metrics", async (req, res) => {
    try {
      const days = Math.min(
        Math.max(parseInt((req.query.days as string) || "30"), 7),
        365,
      );
      // Klaviyo timeframe options: today, yesterday, this_week, last_week,
      // last_7_days, last_30_days, last_90_days, last_365_days, this_month,
      // last_month, this_year, last_year, all_time, or custom {start,end}.
      const presetKey =
        days <= 7
          ? "last_7_days"
          : days <= 30
            ? "last_30_days"
            : days <= 90
              ? "last_90_days"
              : "last_365_days";

      const conv = await getConversionMetric("campaign");
      if (!conv) {
        return res.json({
          metrics: {},
          revenueAvailable: false,
          warning:
            "No usable conversion metric found in this Klaviyo account. Engagement and revenue stats will not load.",
        });
      }

      // Klaviyo's values-report 400s when you ask for `conversion_value` /
      // `revenue_per_recipient` against a metric that doesn't carry value
      // data (e.g. "Active on Site"). Only request value-based stats when
      // the metric is actually revenue-compatible.
      const ENGAGEMENT_STATS = [
        "opens", "opens_unique", "clicks", "clicks_unique", "delivered",
        "bounced", "unsubscribes", "unsubscribe_uniques", "spam_complaints",
        "recipients", "open_rate", "click_rate", "click_to_open_rate",
        "bounce_rate", "unsubscribe_rate",
      ];
      const VALUE_STATS = ["conversions", "conversion_uniques", "conversion_value", "revenue_per_recipient"];
      const stats = conv.isRevenueMetric ? [...ENGAGEMENT_STATS, ...VALUE_STATS] : ENGAGEMENT_STATS;

      const body = {
        data: {
          type: "campaign-values-report",
          attributes: {
            statistics: stats,
            timeframe: { key: presetKey },
            conversion_metric_id: conv.id,
          },
        },
      };

      const data = await klaviyoFetch<{ data: { attributes?: { results?: any[] } } }>(
        "/campaign-values-reports/",
        { method: "POST", body: JSON.stringify(body) },
      );

      const rows = data.data?.attributes?.results || [];
      const metrics: Record<string, any> = {};
      for (const row of rows) {
        const id = row.groupings?.campaign_id || row.groupings?.send_channel;
        if (!id) continue;
        metrics[id] = row.statistics || {};
      }

      res.json({
        metrics,
        timeframe: presetKey,
        campaignCount: Object.keys(metrics).length,
        revenueAvailable: conv.isRevenueMetric,
        conversionMetricName: conv.name,
        warning: conv.isRevenueMetric
          ? null
          : `Using ${conv.name} as the conversion metric. Revenue values will be 0 until a store integration (Shopify/Stripe) is connected in Klaviyo, or set KLAVIYO_CONVERSION_METRIC_NAME to your account's revenue event.`,
      });
    } catch (e: any) {
      // Degrade gracefully — return empty metrics + warning so the
      // rest of the Email page still renders. Klaviyo values-report can
      // 400 if the conversion metric isn't compatible with this report
      // type; surfacing a 400 to the client breaks the entire page.
      console.warn("[OPS][KLAVIYO] campaign-metrics failed:", e.message);
      res.json({
        metrics: {},
        timeframe: null,
        campaignCount: 0,
        revenueAvailable: false,
        conversionMetricName: null,
        warning: `Campaign metrics unavailable: ${e.message}`,
      });
    }
  });

  // Recent send audit log — most recent 50.
  // Per-member email engagement. Looks up the user's email in RDS, finds
  // the Klaviyo profile, pulls recent events and groups them by campaign/flow.
  // Used by the member-detail page.
  app.get("/api/ops/klaviyo/member/:userId/email-engagement", async (req, res) => {
    try {
      const userId = req.params.userId;
      const userRes = await pool.query(
        "SELECT email FROM users WHERE id = $1",
        [userId],
      );
      const email = userRes.rows[0]?.email;
      if (!email) {
        return res.status(404).json({ error: "user not found" });
      }

      // 1. Profile lookup by email.
      const profileRes = await klaviyoFetch<{ data: any[] }>(
        `/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`,
      );
      const profile = profileRes.data?.[0];
      if (!profile) {
        return res.json({
          email,
          profile_id: null,
          klaviyo_url: null,
          summary: { received: 0, opened: 0, clicked: 0, unsubscribed: false, last_engaged_at: null },
          campaigns: [],
          events: [],
          note: "No Klaviyo profile found for this email.",
        });
      }

      // 2. Recent events for this profile (last 50 across all metrics).
      const eventsRes = await klaviyoFetch<{ data: any[]; included?: any[] }>(
        `/events/?filter=equals(profile_id,"${profile.id}")` +
          `&sort=-datetime&page[size]=50&include=metric`,
      );
      const events = eventsRes.data || [];
      const metricMap: Record<string, string> = {};
      for (const inc of eventsRes.included || []) {
        if (inc.type === "metric") metricMap[inc.id] = inc.attributes?.name || "(unnamed)";
      }

      // Pre-compute campaign/flow aggregates and a flat timeline.
      const campaignAgg: Record<
        string,
        { name: string; type: "campaign" | "flow"; received: number; opened: number; clicked: number; revenue: number; lastAt: string }
      > = {};
      const summary = {
        received: 0,
        opened: 0,
        clicked: 0,
        unsubscribed: false,
        last_engaged_at: null as string | null,
      };
      const timeline: Array<{
        datetime: string;
        metric: string;
        campaign_name: string | null;
        flow_id: string | null;
        message_id: string | null;
        value: number;
      }> = [];

      for (const e of events) {
        const metric = metricMap[e.relationships?.metric?.data?.id] || "Unknown";
        const props = e.attributes?.event_properties || {};
        const dt = e.attributes?.datetime as string;
        const campaignName = (props["Campaign Name"] as string) || null;
        const flowId = (props["$flow"] as string) || null;
        const messageId = (props["$message"] as string) || null;
        const value = parseFloat(props["$value"] || "0");

        timeline.push({
          datetime: dt,
          metric,
          campaign_name: campaignName,
          flow_id: flowId,
          message_id: messageId,
          value,
        });

        // Summary counts (engagement metrics only).
        const isEngagement = ["Received Email", "Opened Email", "Clicked Email"].includes(metric);
        if (isEngagement) {
          if (!summary.last_engaged_at || dt > summary.last_engaged_at) {
            summary.last_engaged_at = dt;
          }
          if (metric === "Received Email") summary.received++;
          else if (metric === "Opened Email") summary.opened++;
          else if (metric === "Clicked Email") summary.clicked++;
        }
        if (metric === "Unsubscribed from Email Marketing") summary.unsubscribed = true;

        // Campaign/flow aggregation (only for email events with a campaign or flow tag).
        if (!isEngagement && metric !== "Bounced Email") continue;
        const key = campaignName
          ? `c:${campaignName}`
          : flowId
            ? `f:${flowId}`
            : null;
        if (!key) continue;
        if (!campaignAgg[key]) {
          campaignAgg[key] = {
            name: campaignName || `Flow ${flowId}`,
            type: campaignName ? "campaign" : "flow",
            received: 0,
            opened: 0,
            clicked: 0,
            revenue: 0,
            lastAt: dt,
          };
        }
        const agg = campaignAgg[key];
        if (dt > agg.lastAt) agg.lastAt = dt;
        if (metric === "Received Email") agg.received++;
        else if (metric === "Opened Email") agg.opened++;
        else if (metric === "Clicked Email") agg.clicked++;
        if (value > 0) agg.revenue += value;
      }

      const campaigns = Object.values(campaignAgg)
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

      res.json({
        email,
        profile_id: profile.id,
        klaviyo_url: `https://www.klaviyo.com/profile/${profile.id}`,
        summary,
        campaigns,
        events: timeline,
      });
    } catch (e: any) {
      console.error("[OPS][KLAVIYO] member engagement error:", e.message);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Profile manager ────────────────────────────────────────────
  //
  // Search by email, view full profile (attrs + lists + recent events +
  // suppression status), suppress / unsuppress. All writes audit-logged.

  // GET /profiles/search?q=<email>
  //
  // Klaviyo's profile email filter ONLY supports `equals` and `any` — no
  // contains/starts-with/ends-with. So we hybrid:
  //   - Full email (contains @) → direct exact Klaviyo lookup
  //   - Partial (no @) → first search RDS `users` for emails LIKE %q%,
  //     batch the matching emails into a Klaviyo `any(email,[...])` filter
  //     (max 100 per Klaviyo's any() limit). Returns up to 25 profiles.
  app.get("/api/ops/klaviyo/profiles/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ profiles: [] });

    const mapProfile = (p: any) => {
      const a = p.attributes || {};
      return {
        id: p.id,
        email: a.email ?? null,
        first_name: a.first_name ?? null,
        last_name: a.last_name ?? null,
        phone_number: a.phone_number ?? null,
        location: a.location ?? null,
        created: a.created ?? null,
        updated: a.updated ?? null,
        last_event_date: a.last_event_date ?? null,
        subscriptions: a.subscriptions ?? null,
      };
    };

    try {
      if (q.includes("@")) {
        // Exact email lookup. Also check RDS so we can flag "exists in
        // FitScript, missing in Klaviyo" — actionable for operators.
        const [klaviyoData, rdsData] = await Promise.all([
          klaviyoFetch<{ data: any[] }>(
            `/profiles/?filter=${encodeURIComponent(`equals(email,"${q}")`)}&page[size]=25`,
          ),
          pool.query(
            `SELECT id, email, first_name, last_name, created_at
             FROM users WHERE lower(email) = lower($1) LIMIT 1`,
            [q],
          ).catch(() => ({ rows: [] as any[] })),
        ]);
        const profiles = (klaviyoData.data || []).map(mapProfile);
        const rdsUser = rdsData.rows?.[0] || null;
        const rdsOnly = rdsUser && profiles.length === 0
          ? [{
              email: rdsUser.email,
              fitscript_user_id: rdsUser.id,
              first_name: rdsUser.first_name,
              last_name: rdsUser.last_name,
              created_at: rdsUser.created_at,
            }]
          : [];
        return res.json({
          profiles,
          query: q,
          mode: "exact",
          rds_only_users: rdsOnly,
        });
      }

      // Partial — search RDS users for matching emails, then bulk-resolve
      // those emails in Klaviyo via any(email, [...]).
      const rdsRes = await pool.query(
        `SELECT id, email, first_name, last_name, created_at
         FROM users
         WHERE email IS NOT NULL AND email ILIKE $1
         ORDER BY email ASC
         LIMIT 25`,
        [`%${q}%`],
      );
      const rdsRows: any[] = rdsRes.rows || [];
      if (rdsRows.length === 0) {
        return res.json({ profiles: [], query: q, mode: "partial-rds", rds_only_users: [], note: "No FitScript users match this query." });
      }
      const emails: string[] = rdsRows.map((r) => (r.email || "").toLowerCase()).filter(Boolean);
      const anyFilter = `any(email,[${emails.map((e) => `"${e}"`).join(",")}])`;
      const data = await klaviyoFetch<{ data: any[] }>(
        `/profiles/?filter=${encodeURIComponent(anyFilter)}&page[size]=25`,
      );
      const profiles = (data.data || []).map(mapProfile);
      const klaviyoEmails = new Set(profiles.map((p) => (p.email || "").toLowerCase()));
      const rdsOnly = rdsRows
        .filter((r) => !klaviyoEmails.has((r.email || "").toLowerCase()))
        .map((r) => ({
          email: r.email,
          fitscript_user_id: r.id,
          first_name: r.first_name,
          last_name: r.last_name,
          created_at: r.created_at,
        }));
      res.json({
        profiles,
        query: q,
        mode: "partial-rds",
        rds_matched: rdsRows.length,
        rds_only_users: rdsOnly,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // GET /profiles/:id — full profile detail with list memberships +
  // recent events (last 50 across all metrics).
  app.get("/api/ops/klaviyo/profiles/:id", async (req, res) => {
    const id = req.params.id;
    try {
      const [profileRes, listsRes, eventsRes] = await Promise.all([
        klaviyoFetch<{ data: any }>(`/profiles/${encodeURIComponent(id)}/`),
        klaviyoFetch<{ data: any[] }>(
          `/profiles/${encodeURIComponent(id)}/lists/?fields[list]=name,created`,
        ).catch(() => ({ data: [] })),
        klaviyoFetch<{ data: any[]; included?: any[] }>(
          `/events/?filter=equals(profile_id,"${id}")&sort=-datetime&page[size]=50&include=metric`,
        ).catch(() => ({ data: [], included: [] })),
      ]);

      const p = profileRes.data;
      const a = p?.attributes || {};
      const metricMap: Record<string, string> = {};
      for (const inc of eventsRes.included || []) {
        if (inc.type === "metric") metricMap[inc.id] = inc.attributes?.name || "(unnamed)";
      }
      const events = (eventsRes.data || []).map((e: any) => {
        const props = e.attributes?.event_properties || {};
        return {
          id: e.id,
          datetime: e.attributes?.datetime,
          metric: metricMap[e.relationships?.metric?.data?.id] || "Unknown",
          campaign_name: props["Campaign Name"] || null,
          flow_id: props["$flow"] || null,
          value: parseFloat(props["$value"] || "0") || 0,
        };
      });
      const lists = (listsRes.data || []).map((l: any) => ({
        id: l.id,
        name: l.attributes?.name ?? "(unnamed)",
        created: l.attributes?.created ?? null,
      }));

      res.json({
        id,
        email: a.email,
        first_name: a.first_name,
        last_name: a.last_name,
        phone_number: a.phone_number,
        location: a.location,
        properties: a.properties || {},
        created: a.created,
        updated: a.updated,
        last_event_date: a.last_event_date,
        subscriptions: a.subscriptions,
        predictive_analytics: a.predictive_analytics,
        klaviyo_url: `https://www.klaviyo.com/profile/${id}`,
        lists,
        events,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /profiles/:id/suppress — suppress the profile from receiving any
  // future marketing email. Klaviyo's profile-suppression-bulk-create-jobs
  // is async; the job is queued and Klaviyo processes within seconds.
  app.post("/api/ops/klaviyo/profiles/:id/suppress", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const id = req.params.id;
    // Look up email for the audit row.
    let email: string | null = null;
    try {
      const pre = await klaviyoFetch<{ data: any }>(`/profiles/${encodeURIComponent(id)}/`);
      email = pre.data?.attributes?.email ?? null;
    } catch { /* best effort */ }
    try {
      if (!email) throw new Error("could not resolve profile email — refusing to suppress");
      await klaviyoFetch("/profile-suppression-bulk-create-jobs/", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "profile-suppression-bulk-create-job",
            attributes: {
              profiles: { data: [{ type: "profile", attributes: { email } }] },
            },
          },
        }),
      });
      await logAdminAction({
        adminEmail,
        actionType: "profile.suppress",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "ok",
      });
      console.log(`[OPS][KLAVIYO] profile ${id} (${email}) suppressed by ${adminEmail}`);
      res.json({ ok: true, id, email });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "profile.suppress",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "failed",
        error: e.message,
      });
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /profiles/:id/unsuppress — remove suppression. Same async pattern.
  app.post("/api/ops/klaviyo/profiles/:id/unsuppress", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const id = req.params.id;
    let email: string | null = null;
    try {
      const pre = await klaviyoFetch<{ data: any }>(`/profiles/${encodeURIComponent(id)}/`);
      email = pre.data?.attributes?.email ?? null;
    } catch { /* best effort */ }
    try {
      if (!email) throw new Error("could not resolve profile email — refusing to unsuppress");
      await klaviyoFetch("/profile-unsuppression-bulk-create-jobs/", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "profile-unsuppression-bulk-create-job",
            attributes: {
              profiles: { data: [{ type: "profile", attributes: { email } }] },
            },
          },
        }),
      });
      await logAdminAction({
        adminEmail,
        actionType: "profile.unsuppress",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "ok",
      });
      console.log(`[OPS][KLAVIYO] profile ${id} (${email}) unsuppressed by ${adminEmail}`);
      res.json({ ok: true, id, email });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "profile.unsuppress",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "failed",
        error: e.message,
      });
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // PATCH /profiles/:id/tags — set the `tags` custom profile property.
  //
  // Klaviyo doesn't have a per-profile tag entity (tags are for lists /
  // segments / flows / campaigns). For Slack-style per-subscriber labels
  // we use a custom profile property named `tags` (string array). Klaviyo
  // PATCH properties is merge-on-write so we don't clobber other props.
  app.patch("/api/ops/klaviyo/profiles/:id/tags", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const id = req.params.id;
    const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : null;
    if (!rawTags) return res.status(400).json({ error: "tags array required" });
    const tags = Array.from(new Set(
      rawTags
        .map((t: any) => String(t).trim().toLowerCase())
        .filter((t: string) => t && t.length <= 50 && /^[a-z0-9_-][a-z0-9_-\s]*$/.test(t))
    )).slice(0, 30);

    let email: string | null = null;
    try {
      const pre = await klaviyoFetch<{ data: any }>(`/profiles/${encodeURIComponent(id)}/`);
      email = pre.data?.attributes?.email ?? null;
    } catch { /* best-effort */ }

    try {
      await klaviyoFetch(`/profiles/${encodeURIComponent(id)}/`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "profile",
            id,
            attributes: { properties: { tags } },
          },
        }),
      });
      await logAdminAction({
        adminEmail,
        actionType: "profile.tags.update",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "ok",
        metadata: { tags },
      });
      res.json({ ok: true, id, tags });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "profile.tags.update",
        targetKind: "klaviyo_profile",
        targetId: id,
        targetLabel: email,
        status: "failed",
        error: e.message,
      });
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /profiles/push — create a Klaviyo profile from an RDS user.
  // Used by the "FitScript users not yet in Klaviyo" amber card on
  // /email/profiles. Idempotent: if a profile already exists for the
  // email, Klaviyo returns it as a duplicate and we surface that as ok.
  app.post("/api/ops/klaviyo/profiles/push", async (req: AdminReq, res) => {
    const adminEmail = req.adminEmail || "unknown";
    const { fitscriptUserId, email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email required" });
    }
    let fitscriptId: string | null = fitscriptUserId || null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    let phone: string | null = null;
    // Pull canonical attrs from RDS — body fields are advisory only.
    try {
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, phone
         FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [email],
      );
      if (r.rows[0]) {
        fitscriptId = r.rows[0].id;
        firstName = r.rows[0].first_name || null;
        lastName = r.rows[0].last_name || null;
        phone = r.rows[0].phone || null;
      }
    } catch { /* best effort — RDS lookup is enrichment, not required */ }

    const attributes: any = { email };
    if (firstName) attributes.first_name = firstName;
    if (lastName) attributes.last_name = lastName;
    if (phone) attributes.phone_number = phone;
    if (fitscriptId) {
      attributes.properties = { fitscript_user_id: fitscriptId, pushed_from: "ops_dashboard" };
    }

    try {
      const r = await fetch(`${KLAVIYO_BASE}/profiles/`, {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${getKey()}`,
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          revision: KLAVIYO_REVISION,
        },
        body: JSON.stringify({ data: { type: "profile", attributes } }),
      });
      const body: any = await r.json().catch(() => ({}));

      // Klaviyo returns 409 with a "duplicate_profile" error code when a profile
      // already exists for the email. The error's meta.duplicate_profile_id
      // tells us which existing profile collided — return it as ok so the
      // operator's flow continues (idempotent "push").
      if (r.status === 409) {
        const dupId = body?.errors?.[0]?.meta?.duplicate_profile_id ?? null;
        await logAdminAction({
          adminEmail,
          actionType: "profile.push",
          targetKind: "klaviyo_profile",
          targetId: dupId ?? email,
          targetLabel: email,
          status: "ok",
          metadata: { existing: true, fitscript_user_id: fitscriptId },
        });
        return res.json({
          ok: true,
          profileId: dupId,
          email,
          already_existed: true,
        });
      }

      if (!r.ok) {
        const detail = body?.errors?.[0]?.detail || `Klaviyo ${r.status}`;
        throw new Error(detail);
      }

      const profileId = body?.data?.id ?? null;
      await logAdminAction({
        adminEmail,
        actionType: "profile.push",
        targetKind: "klaviyo_profile",
        targetId: profileId ?? email,
        targetLabel: email,
        status: "ok",
        metadata: { fitscript_user_id: fitscriptId, created: true },
      });
      console.log(
        `[OPS][KLAVIYO] profile pushed: email=${email} klaviyo_id=${profileId} by ${adminEmail}`,
      );
      res.json({ ok: true, profileId, email, already_existed: false });
    } catch (e: any) {
      await logAdminAction({
        adminEmail,
        actionType: "profile.push",
        targetKind: "klaviyo_profile",
        targetId: email,
        targetLabel: email,
        status: "failed",
        error: e.message,
        metadata: { fitscript_user_id: fitscriptId },
      });
      res.status(500).json({ error: e.message });
    }
  });

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
      throttlePercentage,
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
      sendMethod !== "static" &&
      sendMethod !== "throttled"
    ) {
      issues.push(
        "sendMethod must be immediate, static, smart_send_time, or throttled",
      );
    }
    if (sendMethod === "static" && !scheduledFor) {
      issues.push("scheduledFor is required when sendMethod=static");
    }
    if (sendMethod === "throttled") {
      if (
        typeof throttlePercentage !== "number" ||
        throttlePercentage < 1 ||
        throttlePercentage > 100
      ) {
        issues.push(
          "throttlePercentage (1-100) is required when sendMethod=throttled",
        );
      }
      // Klaviyo accepts datetime on throttled too (start time). Default to now
      // when not specified — server-side default keeps the API simple.
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
        if (sendMethod === "throttled") {
          // Spread the send over (100 / throttle_percentage) hours.
          // Examples: 50 → 2h, 25 → 4h, 13 → ~8h, 10 → 10h.
          return {
            method: "throttled",
            datetime: scheduledFor || new Date().toISOString(),
            options_throttled: { throttle_percentage: throttlePercentage },
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
 * Generic audit log for write actions performed through the ops dashboard.
 * action_type examples: "flow.activate", "flow.deactivate", "member.cancel",
 * "member.refund", "member.comp", "member.change_tier".
 *
 * Schema is deliberately loose (metadata jsonb + free-form action_type)
 * so any new admin action can append a row without a migration.
 */
// logAdminAction extracted to server/lib/auditLog.ts so DIRT (and any
// other future module) can share the same audit trail.

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
