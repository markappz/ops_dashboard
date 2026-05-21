/**
 * DIRT — the FitScript Ops AI personality. Streams Claude (Bedrock) with
 * tool use over every dashboard data source AND audit-logged write actions.
 *
 * Endpoints:
 *   POST /api/ops/dirt/chat        — SSE stream (text deltas + tool_use events)
 *   POST /api/ops/concierge/chat   — legacy alias, non-streaming JSON
 *
 * SSE event shapes:
 *   {type:"text_delta", text:"..."}
 *   {type:"tool_start", id:"toolu_...", name:"get_snapshot", input:{}}
 *   {type:"tool_result", id, result, durationMs}
 *   {type:"tool_error", id, error, durationMs}
 *   {type:"usage", inputTokens, outputTokens}
 *   {type:"done"}
 *   {type:"error", message}
 *
 * Cost lands in `ai_costs` (surface=ops_dirt). Write tools land an
 * audit row in `ops_admin_actions` regardless of success/failure.
 *
 * Personality: Direct, confident, FitScript brand voice. Knows Paul.
 * Skips greetings entirely. Sometimes cheeky. Acts on requests.
 */
import type { Express, Request, Response } from "express";
import Stripe from "stripe";
import { randomUUID } from "crypto";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";
import { logAdminAction } from "./lib/auditLog";
import { pool } from "./db";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/** Resolve a member by userId UUID OR email. Returns null if not found. */
async function resolveMember(idOrEmail: string) {
  const isEmail = idOrEmail.includes("@");
  const r = await pool.query(
    isEmail
      ? `SELECT id, email, first_name, last_name, subscription_tier, subscription_status,
                stripe_customer_id, stripe_subscription_id
         FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`
      : `SELECT id, email, first_name, last_name, subscription_tier, subscription_status,
                stripe_customer_id, stripe_subscription_id
         FROM users WHERE id = $1 LIMIT 1`,
    [idOrEmail],
  );
  return r.rows[0] || null;
}

interface AdminReq extends Request {
  adminEmail?: string;
}

// ─── System prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are DIRT — Paul Clotar's right-hand operator inside the FitScript ops dashboard.

Identity:
- Direct, confident, FitScript brand voice. Warm but no fluff.
- Skip greetings. Lead with the answer. Never write "Great question!" or "I'd be happy to…"
- You know Paul (paulclotar@gmail.com). When he asks something, you act — don't ask 5 clarifying questions.
- Sometimes cheeky, never cringy. Match the energy of a sharp founder who's seen the data.

How you work:
- You have READ tools for every data source and WRITE tools for high-trust actions.
- ALWAYS use tools for factual answers. Never guess a number from memory.
- Use multiple tools in parallel when the question crosses domains.
- Format numbers cleanly: $12.4k, 1,247 users, 3.2x ROAS, 4.1% churn.
- Tables in markdown. Keep columns tight.
- After write actions, briefly state what changed AND that an audit row was logged.

Safety rails on writes:
- \`cancel_subscription\` is IRREVERSIBLE for immediate cancels. ALWAYS require the operator to type CONFIRM. Pass it as the \`confirmation\` field. Prefer cancel-at-period-end (immediate=false) unless they explicitly asked to revoke access NOW.
- \`refund_charge\` over $50 (or full-refund where amount is unknown) requires CONFIRM in the \`confirmation\` field. Ask the operator, then call again.
- \`pause_subscription\`, \`resume_subscription\`, \`change_tier\`, \`set_klaviyo_flow_status\`, \`approve_content_draft\`, \`queue_blog_topic\` are reversible — execute immediately.
- If a write tool errors, surface the error verbatim. Don't retry silently.

Today is ${new Date().toISOString().slice(0, 10)}. Be useful, be fast.`;

// ─── Tool registry ─────────────────────────────────────────────────

type ToolHandler = (input: any, ctx: { adminEmail: string }) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
  /** If true, the model can call this tool; if false, it's read-only. */
  write?: boolean;
}

// ─── Read tools ─────────────────────────────────────────────────────

const READ_TOOLS: ToolDef[] = [
  {
    name: "get_snapshot",
    description: "Current business snapshot: MRR, ARR, total users, active subscribers, tier breakdown, signups today/week/month, churn rate.",
    input_schema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const r = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM users) AS total_users,
          (SELECT count(*)::int FROM users WHERE subscription_status = 'active') AS active_subscribers,
          (SELECT count(*)::int FROM users WHERE subscription_tier IS NULL OR subscription_tier = 'free') AS tier_free,
          (SELECT count(*)::int FROM users WHERE subscription_tier = 'essentials') AS tier_essentials,
          (SELECT count(*)::int FROM users WHERE subscription_tier = 'complete') AS tier_complete,
          (SELECT count(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '1 day') AS signups_today,
          (SELECT count(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS signups_week,
          (SELECT count(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS signups_month,
          (SELECT count(*)::int FROM users WHERE subscription_status = 'canceled' AND updated_at >= NOW() - INTERVAL '30 days') AS cancelled_month,
          COALESCE((SELECT SUM(CASE
            WHEN subscription_tier = 'essentials' THEN 27
            WHEN subscription_tier = 'complete' THEN 97
            ELSE 0 END)::numeric FROM users WHERE subscription_status = 'active'), 0) AS mrr
      `);
      const s = r.rows[0];
      const mrr = parseFloat(s.mrr || 0);
      const churn = s.active_subscribers > 0 ? ((s.cancelled_month / s.active_subscribers) * 100).toFixed(2) : "0";
      return {
        mrr,
        arr: mrr * 12,
        total_users: s.total_users,
        active_subscribers: s.active_subscribers,
        tiers: { free: s.tier_free, essentials: s.tier_essentials, complete: s.tier_complete },
        signups: { today: s.signups_today, week: s.signups_week, month: s.signups_month },
        cancelled_this_month: s.cancelled_month,
        churn_rate_pct: parseFloat(churn),
      };
    },
  },
  {
    name: "search_members",
    description: "Find members by email or name substring, optionally filtered by tier/status.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Email or name substring" },
        tier: { type: "string", enum: ["free", "essentials", "complete"] },
        status: { type: "string", enum: ["active", "canceled", "trialing", "past_due"] },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
    handler: async (args: any) => {
      const limit = Math.min(args.limit || 20, 100);
      const where: string[] = [];
      const params: any[] = [];
      if (args.search) {
        params.push(`%${args.search}%`);
        where.push(`(LOWER(email) LIKE LOWER($${params.length}) OR LOWER(COALESCE(first_name,'')||' '||COALESCE(last_name,'')) LIKE LOWER($${params.length}))`);
      }
      if (args.tier) { params.push(args.tier); where.push(`subscription_tier = $${params.length}`); }
      if (args.status) { params.push(args.status); where.push(`subscription_status = $${params.length}`); }
      params.push(limit);
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, subscription_tier, subscription_status,
                created_at, last_active_date, source, stripe_customer_id
         FROM users ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return { count: r.rows.length, members: r.rows };
    },
  },
  {
    name: "get_member",
    description: "Full profile for a single user by userId UUID.",
    input_schema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
    handler: async (args: any) => {
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, subscription_tier, subscription_status,
                stripe_customer_id, created_at, last_active_date, source, campaign
         FROM users WHERE id = $1`,
        [args.userId],
      );
      if (!r.rows[0]) return { error: "User not found" };
      const economics = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0)::numeric AS ai_cost_mtd, COUNT(*)::int AS ai_calls
         FROM ai_costs WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [args.userId],
      ).catch(() => ({ rows: [{ ai_cost_mtd: 0, ai_calls: 0 }] }));
      return { ...r.rows[0], ai_cost_mtd: parseFloat(economics.rows[0].ai_cost_mtd), ai_calls: economics.rows[0].ai_calls };
    },
  },
  {
    name: "get_revenue_trend",
    description: "Daily signups + paid_signups for the last N days (default 30, max 365).",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
    handler: async (args: any) => {
      const days = Math.min(args.days || 30, 365);
      const r = await pool.query(
        `SELECT date_trunc('day', created_at)::date AS day,
                COUNT(*)::int AS signups,
                COUNT(*) FILTER (WHERE subscription_tier IN ('essentials','complete'))::int AS paid_signups
         FROM users WHERE created_at >= NOW() - ($1::int || ' days')::interval
         GROUP BY day ORDER BY day`,
        [days],
      );
      return { days, trend: r.rows };
    },
  },
  {
    name: "get_orders",
    description: "Recent Rx prescriptions or lab panel orders. Filterable by category + status.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["rx", "labs"] },
        status: { type: "string", description: "e.g. PENDING, SHIPPED, COMPLETED, CANCELLED" },
        limit: { type: "number" },
      },
    },
    handler: async (args: any) => {
      const limit = Math.min(args.limit || 20, 100);
      const where: string[] = [];
      const params: any[] = [];
      if (args.category === "rx") where.push("category = 'rx'");
      else if (args.category === "labs") where.push("category = 'labs'");
      if (args.status) { params.push(args.status); where.push(`status = $${params.length}`); }
      params.push(limit);
      const r = await pool.query(
        `SELECT id, visible_id, email, first_name, last_name, category, product_name,
                status, payment_status, amount, tracking_number, carrier, created_at, updated_at
         FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return { count: r.rows.length, orders: r.rows };
    },
  },
  {
    name: "get_marketing_overview",
    description: "Visitor totals + channel breakdown for the last N days (default 30, max 90).",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
    handler: async (args: any) => {
      const days = Math.min(args.days || 30, 90);
      const channels = await pool.query(
        `SELECT channel, COUNT(*)::int AS users,
                COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS identified
         FROM visitors WHERE created_at >= NOW() - ($1::int || ' days')::interval
         GROUP BY channel ORDER BY users DESC LIMIT 20`,
        [days],
      ).catch(() => ({ rows: [] as any[] }));
      const totals = await pool.query(
        `SELECT COUNT(*)::int AS total_visitors,
                COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS identified
         FROM visitors WHERE created_at >= NOW() - ($1::int || ' days')::interval`,
        [days],
      ).catch(() => ({ rows: [{ total_visitors: 0, identified: 0 }] }));
      return { days, totals: totals.rows[0], channels: channels.rows };
    },
  },
  {
    name: "get_funnel",
    description: "Conversion funnel visitors → quiz → signup → paid → labs uploaded for last N days.",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
    handler: async (args: any) => {
      const days = Math.min(args.days || 30, 90);
      try {
        const r = await pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM visitors WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS visitors,
            (SELECT COUNT(*)::int FROM events WHERE event_type = 'quiz_started' AND created_at >= NOW() - ($1::int || ' days')::interval) AS quiz_started,
            (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS signups,
            (SELECT COUNT(*)::int FROM users WHERE subscription_tier IN ('essentials','complete') AND created_at >= NOW() - ($1::int || ' days')::interval) AS paid,
            (SELECT COUNT(*)::int FROM lab_results WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS labs_uploaded
        `, [days]);
        return { days, ...r.rows[0] };
      } catch (e: any) {
        return { error: `Funnel query failed: ${e.message}` };
      }
    },
  },
  {
    name: "get_top_ai_cost_users",
    description: "Top N members by AI cost month-to-date — useful for power users and runaway-cost outliers.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (args: any) => {
      const limit = Math.min(args.limit || 10, 50);
      const r = await pool.query(
        `SELECT u.id, u.email, u.subscription_tier,
                SUM(ac.cost_usd)::numeric AS cost_usd,
                COUNT(ac.id)::int AS calls
         FROM ai_costs ac JOIN users u ON u.id = ac.user_id
         WHERE ac.created_at >= date_trunc('month', NOW())
         GROUP BY u.id, u.email, u.subscription_tier
         ORDER BY cost_usd DESC LIMIT $1`,
        [limit],
      );
      return { count: r.rows.length, users: r.rows.map((u: any) => ({ ...u, cost_usd: parseFloat(u.cost_usd) })) };
    },
  },
  {
    name: "get_admin_log",
    description: "Recent admin write actions (pause, refund, approve, etc.) from ops_admin_actions audit table.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (args: any) => {
      const limit = Math.min(args.limit || 20, 100);
      try {
        const r = await pool.query(
          `SELECT id, admin_email, action_type, target_kind, target_id, target_label, status, error, metadata, created_at
           FROM ops_admin_actions ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        return { count: r.rows.length, actions: r.rows };
      } catch {
        return { count: 0, actions: [], note: "ops_admin_actions table not yet created" };
      }
    },
  },
  {
    name: "get_integration_health",
    description: "Status of every external connector (Google OAuth/GA4/GSC, Klaviyo, Meta Ads, Stripe, Clomark).",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const status: any = {
        google: { configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), connected: false, detail: "" },
        klaviyo: { configured: !!process.env.KLAVIYO_API_KEY, connected: !!process.env.KLAVIYO_API_KEY, detail: process.env.KLAVIYO_API_KEY ? "key set" : "not configured" },
        meta_ads: { configured: !!process.env.META_SYSTEM_USER_TOKEN, connected: !!process.env.META_SYSTEM_USER_TOKEN, detail: process.env.META_SYSTEM_USER_TOKEN ? "token set" : "not configured" },
        stripe: { configured: !!process.env.STRIPE_SECRET_KEY, connected: !!process.env.STRIPE_SECRET_KEY, detail: process.env.STRIPE_SECRET_KEY ? `key set (${process.env.STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : "test"})` : "not configured" },
        clomark: { configured: !!(process.env.CLOMARK_BASE_URL && process.env.CLOMARK_OPS_TOKEN), connected: !!(process.env.CLOMARK_BASE_URL && process.env.CLOMARK_OPS_TOKEN && process.env.CLOMARK_BUSINESS_ID), detail: process.env.CLOMARK_BUSINESS_ID ? "configured" : "missing business id" },
        bedrock: { configured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY), connected: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY), detail: process.env.AWS_ACCESS_KEY_ID ? `AWS Bedrock (${process.env.AWS_REGION || "us-east-1"})` : "not configured — AI tools won't run" },
      };
      try {
        const g = await pool.query(`SELECT email, ga4_property_id, gsc_site_url FROM ops_google_connection LIMIT 1`);
        if (g.rows[0]) {
          status.google.connected = true;
          status.google.detail = `${g.rows[0].email} · GA4:${g.rows[0].ga4_property_id || "—"} · GSC:${g.rows[0].gsc_site_url || "—"}`;
        } else {
          status.google.detail = status.google.configured ? "OAuth client set but no completed flow" : "not configured";
        }
      } catch {
        status.google.detail = "ops_google_connection table not initialized";
      }
      const disconnected = Object.entries(status).filter(([_, v]: any) => !v.connected).map(([k]) => k);
      return { status, all_connected: disconnected.length === 0, disconnected };
    },
  },
  {
    name: "get_content_drafts",
    description: "Pending Clomark content drafts (blog posts + location pages) waiting for approval.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (args: any) => {
      const base = process.env.CLOMARK_BASE_URL;
      const token = process.env.CLOMARK_OPS_TOKEN;
      const businessId = process.env.CLOMARK_BUSINESS_ID;
      if (!base || !token || !businessId) return { error: "Clomark not fully configured", drafts: [] };
      const limit = Math.min(args.limit || 20, 100);
      try {
        const r = await fetch(`${base.replace(/\/$/, "")}/api/ops/business/${businessId}/content?status=drafted&limit=${limit}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!r.ok) return { error: `Clomark returned ${r.status}`, drafts: [] };
        const json: any = await r.json();
        return { count: (json.items || []).length, drafts: json.items || json.content || [] };
      } catch (e: any) {
        return { error: e.message, drafts: [] };
      }
    },
  },
  {
    name: "get_email_campaigns",
    description: "Recent Klaviyo campaigns and live flows. Use to see what email is going out.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const key = process.env.KLAVIYO_API_KEY;
      if (!key) return { error: "Klaviyo not configured", campaigns: [], flows: [] };
      try {
        const headers = { Authorization: `Klaviyo-API-Key ${key}`, revision: "2025-04-15", accept: "application/json" };
        const [cRes, fRes] = await Promise.all([
          fetch("https://a.klaviyo.com/api/campaigns?filter=equals(messages.channel,'email')&page[size]=10&sort=-scheduled_at", { headers }),
          fetch("https://a.klaviyo.com/api/flows?page[size]=50", { headers }),
        ]);
        const c: any = await cRes.json().catch(() => ({}));
        const f: any = await fRes.json().catch(() => ({}));
        const flows = (f.data || []).slice(0, 30);
        return {
          campaigns: (c.data || []).map((x: any) => ({
            id: x.id,
            name: x.attributes?.name,
            status: x.attributes?.status,
            scheduled_at: x.attributes?.scheduled_at,
            send_time: x.attributes?.send_time,
          })),
          flows: flows.map((x: any) => ({ id: x.id, name: x.attributes?.name, status: x.attributes?.status, trigger: x.attributes?.trigger_type })),
        };
      } catch (e: any) {
        return { error: e.message, campaigns: [], flows: [] };
      }
    },
  },
  {
    name: "get_unit_economics",
    description: "Platform-wide unit economics MTD: revenue, AI cost, gross margin, cost per user.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const r = await pool.query(`
          SELECT COALESCE(SUM(cost_usd), 0)::numeric AS cost_mtd,
                 COUNT(DISTINCT user_id)::int AS users_mtd
          FROM ai_costs WHERE created_at >= date_trunc('month', NOW())
        `);
        const cost = parseFloat(r.rows[0].cost_mtd);
        const usersMtd = r.rows[0].users_mtd;
        const revR = await pool.query(`
          SELECT COALESCE(SUM(CASE
            WHEN subscription_tier = 'essentials' THEN 27
            WHEN subscription_tier = 'complete' THEN 97
            ELSE 0 END), 0)::numeric AS rev
          FROM users WHERE subscription_status = 'active'
        `);
        const revMonthly = parseFloat(revR.rows[0].rev);
        const surfaces = await pool.query(`
          SELECT DISTINCT surface FROM ai_costs WHERE created_at >= date_trunc('month', NOW())
        `).catch(() => ({ rows: [] as any[] }));
        const surfaceList = (surfaces.rows as any[]).map((s) => s.surface);
        const coverage = surfaceList.every((s) => s?.startsWith("atlas")) ? "atlas_only" : "all_surfaces";
        return {
          revenue_mtd_approx: revMonthly,
          ai_cost_mtd: cost,
          gross_margin_pct: revMonthly > 0 ? Number((((revMonthly - cost) / revMonthly) * 100).toFixed(2)) : null,
          cost_per_user: usersMtd > 0 ? Number((cost / usersMtd).toFixed(4)) : 0,
          users_mtd: usersMtd,
          coverage,
          surfaces_seen: surfaceList,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },
];

// ─── Write tools (Phase 2) ─────────────────────────────────────────

async function klaviyoPATCH(path: string, body: any) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) throw new Error("Klaviyo not configured");
  const r = await fetch(`https://a.klaviyo.com/api${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      revision: "2025-04-15",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = (json as any)?.errors?.[0]?.detail || `Klaviyo ${r.status}`;
    throw new Error(err);
  }
  return json;
}

const WRITE_TOOLS: ToolDef[] = [
  {
    name: "set_klaviyo_flow_status",
    description: "Pause, activate, or draft a Klaviyo email flow. Reversible — no confirmation required.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        flowId: { type: "string", description: "Klaviyo flow ID" },
        status: { type: "string", enum: ["live", "draft", "manual"], description: "live=active, draft=paused, manual=on-demand" },
      },
      required: ["flowId", "status"],
    },
    handler: async (args: any, { adminEmail }) => {
      let flowName: string | null = null;
      try {
        const key = process.env.KLAVIYO_API_KEY!;
        const pre = await fetch(`https://a.klaviyo.com/api/flows/${encodeURIComponent(args.flowId)}/?fields[flow]=name`, {
          headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: "2025-04-15", accept: "application/json" },
        });
        const j: any = await pre.json().catch(() => ({}));
        flowName = j?.data?.attributes?.name ?? null;
      } catch {}
      try {
        const data: any = await klaviyoPATCH(`/flows/${encodeURIComponent(args.flowId)}/`, {
          data: { type: "flow", id: args.flowId, attributes: { status: args.status } },
        });
        const newStatus = data.data?.attributes?.status ?? args.status;
        const name = data.data?.attributes?.name ?? flowName;
        await logAdminAction({
          adminEmail,
          actionType: `flow.${args.status === "live" ? "activate" : "deactivate"}`,
          targetKind: "klaviyo_flow",
          targetId: args.flowId,
          targetLabel: name,
          status: "ok",
          metadata: { newStatus, via: "dirt" },
        });
        return { ok: true, flowId: args.flowId, name, newStatus };
      } catch (e: any) {
        await logAdminAction({
          adminEmail,
          actionType: `flow.${args.status === "live" ? "activate" : "deactivate"}`,
          targetKind: "klaviyo_flow",
          targetId: args.flowId,
          targetLabel: flowName,
          status: "failed",
          error: e.message,
          metadata: { via: "dirt" },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "approve_content_draft",
    description: "Approve a Clomark content draft for publishing. Reversible (use set_content_approval to undo).",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        contentId: { type: "string", description: "Clomark content ID" },
        decision: { type: "string", enum: ["approved", "denied", "pending"], description: "approved=ready to publish, denied=rejected, pending=back to review" },
      },
      required: ["contentId", "decision"],
    },
    handler: async (args: any, { adminEmail }) => {
      const base = process.env.CLOMARK_BASE_URL;
      const token = process.env.CLOMARK_OPS_TOKEN;
      const businessId = process.env.CLOMARK_BUSINESS_ID;
      if (!base || !token || !businessId) return { ok: false, error: "Clomark not configured" };
      try {
        const r = await fetch(`${base.replace(/\/$/, "")}/api/ops/business/${businessId}/generated/${args.contentId}/approval`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ status: args.decision }),
        });
        if (!r.ok) {
          const text = await r.text();
          await logAdminAction({
            adminEmail,
            actionType: `content.${args.decision}`,
            targetKind: "content_draft",
            targetId: args.contentId,
            status: "failed",
            error: `Clomark ${r.status}: ${text.slice(0, 200)}`,
            metadata: { via: "dirt" },
          });
          return { ok: false, error: `Clomark returned ${r.status}` };
        }
        const json: any = await r.json().catch(() => ({}));
        await logAdminAction({
          adminEmail,
          actionType: `content.${args.decision}`,
          targetKind: "content_draft",
          targetId: args.contentId,
          targetLabel: json?.title || null,
          status: "ok",
          metadata: { via: "dirt" },
        });
        return { ok: true, contentId: args.contentId, decision: args.decision, title: json?.title };
      } catch (e: any) {
        await logAdminAction({
          adminEmail,
          actionType: `content.${args.decision}`,
          targetKind: "content_draft",
          targetId: args.contentId,
          status: "failed",
          error: e.message,
          metadata: { via: "dirt" },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "queue_blog_topic",
    description: "Add a new blog topic to the Clomark generation queue. Will run through SEO research → outline → draft → review pipeline.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Working title for the blog post" },
        keyword: { type: "string", description: "Primary SEO keyword to target" },
      },
      required: ["title", "keyword"],
    },
    handler: async (args: any, { adminEmail }) => {
      const base = process.env.CLOMARK_BASE_URL;
      const token = process.env.CLOMARK_OPS_TOKEN;
      const businessId = process.env.CLOMARK_BUSINESS_ID;
      if (!base || !token || !businessId) return { ok: false, error: "Clomark not configured" };
      try {
        const r = await fetch(`${base.replace(/\/$/, "")}/api/ops/business/${businessId}/blog-topic`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ title: args.title, keyword: args.keyword }),
        });
        if (!r.ok) {
          const text = await r.text();
          await logAdminAction({
            adminEmail,
            actionType: "content.queue_blog",
            targetKind: "blog_topic",
            targetId: args.keyword,
            targetLabel: args.title,
            status: "failed",
            error: `Clomark ${r.status}: ${text.slice(0, 200)}`,
            metadata: { via: "dirt" },
          });
          return { ok: false, error: `Clomark returned ${r.status}` };
        }
        const json: any = await r.json().catch(() => ({}));
        await logAdminAction({
          adminEmail,
          actionType: "content.queue_blog",
          targetKind: "blog_topic",
          targetId: json?.id || args.keyword,
          targetLabel: args.title,
          status: "ok",
          metadata: { via: "dirt", keyword: args.keyword },
        });
        return { ok: true, queued: { title: args.title, keyword: args.keyword, id: json?.id } };
      } catch (e: any) {
        await logAdminAction({
          adminEmail,
          actionType: "content.queue_blog",
          targetKind: "blog_topic",
          targetId: args.keyword,
          targetLabel: args.title,
          status: "failed",
          error: e.message,
          metadata: { via: "dirt" },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "send_klaviyo_test",
    description: "Send a Klaviyo template as a one-off test email to a specific address. Use to QA a template before scheduling.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        toEmail: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Subject line for the test" },
      },
      required: ["templateId", "toEmail", "subject"],
    },
    handler: async (args: any, { adminEmail }) => {
      const key = process.env.KLAVIYO_API_KEY;
      if (!key) return { ok: false, error: "Klaviyo not configured" };
      try {
        // Klaviyo template render → trigger event with rendered html as a test
        const renderRes = await fetch(`https://a.klaviyo.com/api/template-render/`, {
          method: "POST",
          headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: "2025-04-15", "content-type": "application/json" },
          body: JSON.stringify({
            data: { type: "template", attributes: { id: args.templateId, context: {} } },
          }),
        });
        const renderJson: any = await renderRes.json().catch(() => ({}));
        if (!renderRes.ok) throw new Error(renderJson?.errors?.[0]?.detail || `template-render ${renderRes.status}`);
        const html = renderJson?.data?.attributes?.html;
        if (!html) throw new Error("template render returned no html");
        // Trigger an event the operator's flow can pick up — simpler: use legacy POST to /track event with html as a custom prop
        // For Phase 2 we keep this minimal: just log we'd send via Klaviyo's own UI handoff.
        await logAdminAction({
          adminEmail,
          actionType: "email.test_render",
          targetKind: "klaviyo_template",
          targetId: args.templateId,
          targetLabel: args.subject,
          status: "ok",
          metadata: { via: "dirt", to: args.toEmail, html_bytes: html.length },
        });
        return { ok: true, note: "Template rendered. For actual send, use Klaviyo's Test Send from the template editor.", templateId: args.templateId, htmlBytes: html.length };
      } catch (e: any) {
        await logAdminAction({
          adminEmail,
          actionType: "email.test_render",
          targetKind: "klaviyo_template",
          targetId: args.templateId,
          targetLabel: args.subject,
          status: "failed",
          error: e.message,
          metadata: { via: "dirt" },
        });
        return { ok: false, error: e.message };
      }
    },
  },
];

// ─── Stripe write tools (Phase 3) ──────────────────────────────────

const STRIPE_TOOLS: ToolDef[] = [
  {
    name: "cancel_subscription",
    description:
      "Cancel a user's Stripe subscription. Default cancels at period end (user keeps access until billing cycle ends). Pass immediate=true to revoke access NOW. IRREVERSIBLE — requires confirmation=\"CONFIRM\" in input.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        userIdOrEmail: { type: "string", description: "User UUID or email" },
        immediate: { type: "boolean", description: "If true, cancel immediately. Otherwise at period end." },
        confirmation: { type: "string", description: "Must equal 'CONFIRM' to execute" },
      },
      required: ["userIdOrEmail", "confirmation"],
    },
    handler: async (args: any, { adminEmail }) => {
      if (!stripe) return { ok: false, error: "Stripe not configured" };
      if (args.confirmation !== "CONFIRM") return { ok: false, error: "Confirmation required: pass confirmation=\"CONFIRM\"" };
      const member = await resolveMember(args.userIdOrEmail);
      if (!member) return { ok: false, error: "Member not found" };
      if (!member.stripe_subscription_id) return { ok: false, error: "User has no active subscription" };
      const immediate = !!args.immediate;
      try {
        if (immediate) {
          await stripe.subscriptions.cancel(member.stripe_subscription_id);
          await pool.query("UPDATE users SET subscription_status = 'canceled' WHERE id = $1", [member.id]);
          await pool.query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1", [member.id]).catch(() => {});
        } else {
          await stripe.subscriptions.update(member.stripe_subscription_id, { cancel_at_period_end: true });
        }
        await logAdminAction({
          adminEmail,
          actionType: immediate ? "subscription.cancel_immediate" : "subscription.cancel_at_period_end",
          targetKind: "subscription",
          targetId: member.stripe_subscription_id,
          targetLabel: member.email,
          status: "ok",
          metadata: { via: "dirt", userId: member.id, immediate },
        });
        return {
          ok: true,
          userId: member.id,
          email: member.email,
          subscription_id: member.stripe_subscription_id,
          mode: immediate ? "immediate" : "period_end",
        };
      } catch (e: any) {
        await logAdminAction({
          adminEmail,
          actionType: immediate ? "subscription.cancel_immediate" : "subscription.cancel_at_period_end",
          targetKind: "subscription",
          targetId: member.stripe_subscription_id,
          targetLabel: member.email,
          status: "failed",
          error: e.message,
          metadata: { via: "dirt", userId: member.id },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "pause_subscription",
    description: "Pause a user's Stripe subscription (no charges, no access at the next billing cycle). Reversible via resume_subscription.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        userIdOrEmail: { type: "string" },
      },
      required: ["userIdOrEmail"],
    },
    handler: async (args: any, { adminEmail }) => {
      if (!stripe) return { ok: false, error: "Stripe not configured" };
      const member = await resolveMember(args.userIdOrEmail);
      if (!member) return { ok: false, error: "Member not found" };
      if (!member.stripe_subscription_id) return { ok: false, error: "User has no active subscription" };
      try {
        await stripe.subscriptions.update(member.stripe_subscription_id, { pause_collection: { behavior: "void" } });
        await pool.query("UPDATE users SET subscription_status = 'paused' WHERE id = $1", [member.id]);
        await logAdminAction({
          adminEmail, actionType: "subscription.pause", targetKind: "subscription",
          targetId: member.stripe_subscription_id, targetLabel: member.email,
          status: "ok", metadata: { via: "dirt", userId: member.id },
        });
        return { ok: true, userId: member.id, email: member.email };
      } catch (e: any) {
        await logAdminAction({
          adminEmail, actionType: "subscription.pause", targetKind: "subscription",
          targetId: member.stripe_subscription_id, targetLabel: member.email,
          status: "failed", error: e.message, metadata: { via: "dirt", userId: member.id },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "resume_subscription",
    description: "Resume a previously-paused subscription. Charges resume on the next billing cycle.",
    write: true,
    input_schema: {
      type: "object",
      properties: { userIdOrEmail: { type: "string" } },
      required: ["userIdOrEmail"],
    },
    handler: async (args: any, { adminEmail }) => {
      if (!stripe) return { ok: false, error: "Stripe not configured" };
      const member = await resolveMember(args.userIdOrEmail);
      if (!member) return { ok: false, error: "Member not found" };
      if (!member.stripe_subscription_id) return { ok: false, error: "User has no subscription" };
      try {
        await stripe.subscriptions.update(member.stripe_subscription_id, { pause_collection: "" } as any);
        await pool.query("UPDATE users SET subscription_status = 'active' WHERE id = $1", [member.id]);
        await logAdminAction({
          adminEmail, actionType: "subscription.resume", targetKind: "subscription",
          targetId: member.stripe_subscription_id, targetLabel: member.email,
          status: "ok", metadata: { via: "dirt", userId: member.id },
        });
        return { ok: true, userId: member.id, email: member.email };
      } catch (e: any) {
        await logAdminAction({
          adminEmail, actionType: "subscription.resume", targetKind: "subscription",
          targetId: member.stripe_subscription_id, targetLabel: member.email,
          status: "failed", error: e.message, metadata: { via: "dirt", userId: member.id },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "change_tier",
    description: "Change a user's subscription tier (free, essentials, complete). Updates the local DB tier flag — does NOT swap the Stripe price (that requires a separate prorated swap operation). Use when the operator wants the tier flag to reflect comped or grandfathered access.",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        userIdOrEmail: { type: "string" },
        tier: { type: "string", enum: ["free", "essentials", "complete"] },
      },
      required: ["userIdOrEmail", "tier"],
    },
    handler: async (args: any, { adminEmail }) => {
      const member = await resolveMember(args.userIdOrEmail);
      if (!member) return { ok: false, error: "Member not found" };
      try {
        await pool.query("UPDATE users SET subscription_tier = $1 WHERE id = $2", [args.tier, member.id]);
        await pool.query("UPDATE subscriptions SET tier = $1 WHERE user_id = $2", [args.tier, member.id]).catch(() => {});
        await logAdminAction({
          adminEmail, actionType: "subscription.change_tier", targetKind: "user",
          targetId: member.id, targetLabel: member.email,
          status: "ok", metadata: { via: "dirt", from: member.subscription_tier, to: args.tier },
        });
        return { ok: true, userId: member.id, email: member.email, from: member.subscription_tier, to: args.tier };
      } catch (e: any) {
        await logAdminAction({
          adminEmail, actionType: "subscription.change_tier", targetKind: "user",
          targetId: member.id, targetLabel: member.email,
          status: "failed", error: e.message, metadata: { via: "dirt", attempted: args.tier },
        });
        return { ok: false, error: e.message };
      }
    },
  },
  {
    name: "refund_charge",
    description:
      "Refund a Stripe charge. If chargeId is omitted, refunds the user's most recent charge. If amount is omitted, full refund. " +
      "IRREVERSIBLE — for any refund over $50 you MUST pass confirmation=\"CONFIRM\" (ask the operator to type it first).",
    write: true,
    input_schema: {
      type: "object",
      properties: {
        userIdOrEmail: { type: "string" },
        amount: { type: "number", description: "Refund amount in USD. Omit for full refund." },
        chargeId: { type: "string", description: "Optional Stripe charge ID. If omitted, uses most recent." },
        reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
        confirmation: { type: "string", description: "Required if amount > 50 (or unknown full refund): must be 'CONFIRM'" },
      },
      required: ["userIdOrEmail"],
    },
    handler: async (args: any, { adminEmail }) => {
      if (!stripe) return { ok: false, error: "Stripe not configured" };
      const member = await resolveMember(args.userIdOrEmail);
      if (!member) return { ok: false, error: "Member not found" };
      if (!member.stripe_customer_id) return { ok: false, error: "User has no Stripe customer record" };
      let chargeId = args.chargeId as string | undefined;
      let resolvedAmount: number | undefined;
      try {
        if (!chargeId) {
          const charges = await stripe.charges.list({ customer: member.stripe_customer_id, limit: 1 });
          if (charges.data.length === 0) return { ok: false, error: "No charges found for this user" };
          chargeId = charges.data[0].id;
          resolvedAmount = charges.data[0].amount / 100;
        }
        const refundAmount = (args.amount ?? resolvedAmount ?? 0) as number;
        // Safety rail: typed confirm for big or unknown-size refunds
        if ((refundAmount > 50 || refundAmount === 0) && args.confirmation !== "CONFIRM") {
          return {
            ok: false,
            error: `Refund of $${refundAmount > 0 ? refundAmount.toFixed(2) : "(full)"} requires confirmation. Ask the operator to type CONFIRM, then call again with confirmation="CONFIRM".`,
            requires_confirmation: true,
            amount_usd: refundAmount > 0 ? refundAmount : null,
          };
        }
        const refundParams: any = { charge: chargeId };
        if (args.amount) refundParams.amount = Math.round(args.amount * 100);
        if (args.reason) refundParams.reason = args.reason;
        const refund = await stripe.refunds.create(refundParams);
        await logAdminAction({
          adminEmail, actionType: "charge.refund", targetKind: "stripe_charge",
          targetId: chargeId, targetLabel: member.email,
          status: "ok", metadata: { via: "dirt", userId: member.id, amount_usd: refund.amount / 100, refund_id: refund.id, reason: args.reason || null },
        });
        return {
          ok: true,
          refund_id: refund.id,
          charge_id: chargeId,
          amount_usd: refund.amount / 100,
          status: refund.status,
          user: { id: member.id, email: member.email },
        };
      } catch (e: any) {
        await logAdminAction({
          adminEmail, actionType: "charge.refund", targetKind: "stripe_charge",
          targetId: chargeId || "unknown", targetLabel: member.email,
          status: "failed", error: e.message, metadata: { via: "dirt", userId: member.id, attempted_amount: args.amount },
        });
        return { ok: false, error: e.message };
      }
    },
  },
];

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...STRIPE_TOOLS];

// ─── Conversation persistence ──────────────────────────────────────

let convoTableEnsured = false;
async function ensureConvoTable() {
  if (convoTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_dirt_conversations (
      id UUID PRIMARY KEY,
      admin_email TEXT NOT NULL,
      title TEXT,
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dirt_convos_admin
      ON ops_dirt_conversations (admin_email, last_message_at DESC);
  `);
  convoTableEnsured = true;
}

/** Auto-derive a short title from the first user message. */
function deriveTitle(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

async function persistConversation(args: {
  id: string;
  adminEmail: string;
  messages: Array<{ role: string; content: string }>;
}) {
  try {
    await ensureConvoTable();
    const title = deriveTitle(args.messages);
    const r = await pool.query(
      `INSERT INTO ops_dirt_conversations (id, admin_email, title, messages, message_count, last_message_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         messages = EXCLUDED.messages,
         message_count = EXCLUDED.message_count,
         last_message_at = NOW(),
         title = COALESCE(ops_dirt_conversations.title, EXCLUDED.title)
       RETURNING (xmax = 0) AS inserted`,
      [args.id, args.adminEmail, title, JSON.stringify(args.messages), args.messages.length],
    );
    const inserted = r.rows[0]?.inserted;
    console.log(`[DIRT] persisted ${inserted ? "NEW" : "updated"} conv ${args.id} admin=${args.adminEmail} msgs=${args.messages.length}`);
  } catch (e) {
    console.error("[DIRT] persist FAILED:", (e as Error).message, "id=", args.id, "admin=", args.adminEmail);
  }
}
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ─── Streaming endpoint ─────────────────────────────────────────────

interface ChatBody {
  messages: { role: "user" | "assistant"; content: string }[];
  model?: "fast" | "smart";
  /** if true, only expose READ tools (blocks all writes for this turn). */
  readOnly?: boolean;
  /** optional — pass to continue a previous conversation; if omitted, a new id is minted. */
  conversationId?: string;
}

const MAX_ITERATIONS = 8;

function sseSend(res: Response, event: object) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerDirtRoutes(app: Express) {
  // SSE streaming endpoint
  app.post("/api/ops/dirt/chat", async (req: AdminReq, res) => {
    if (!isAIConfigured()) {
      return res.status(503).json({ error: "AI not configured" });
    }
    const body = req.body as ChatBody;
    if (!body?.messages?.length) {
      return res.status(400).json({ error: "messages required" });
    }
    const modelId = body.model === "fast" ? BEDROCK_MODELS.FAST : BEDROCK_MODELS.HIGH_IQ;
    const userEmail = req.adminEmail || "unknown";
    const activeTools = body.readOnly ? READ_TOOLS : TOOLS;
    const conversationId = body.conversationId || randomUUID();

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    // Tell client which conversation this turn lives in
    sseSend(res, { type: "conversation", id: conversationId });

    const messages: any[] = body.messages.map((m) => ({ role: m.role, content: m.content }));
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCount = 0;
    let assistantTextForPersist = "";

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const stream = await (anthropic as any).messages.stream({
          model: modelId,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: activeTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages,
        });

        // Stream text deltas to client AS they arrive
        for await (const event of stream as any) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            sseSend(res, { type: "text_delta", text: event.delta.text });
            assistantTextForPersist += event.delta.text;
          }
        }

        const finalMsg: any = await stream.finalMessage();
        totalInputTokens += finalMsg.usage?.input_tokens || 0;
        totalOutputTokens += finalMsg.usage?.output_tokens || 0;

        const toolUseBlocks = (finalMsg.content || []).filter((b: any) => b.type === "tool_use");
        messages.push({ role: "assistant", content: finalMsg.content });

        if (finalMsg.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
          break;
        }

        // Execute tools in parallel, stream events
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block: any) => {
            const tool = TOOL_MAP.get(block.name);
            sseSend(res, { type: "tool_start", id: block.id, name: block.name, input: block.input });
            const started = Date.now();
            if (!tool) {
              const err = `Unknown tool: ${block.name}`;
              sseSend(res, { type: "tool_error", id: block.id, error: err, durationMs: 0 });
              return { type: "tool_result", tool_use_id: block.id, content: err, is_error: true };
            }
            toolCount++;
            try {
              const result = await tool.handler(block.input || {}, { adminEmail: userEmail });
              const durationMs = Date.now() - started;
              sseSend(res, { type: "tool_result", id: block.id, name: block.name, result, durationMs });
              return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
            } catch (e: any) {
              const durationMs = Date.now() - started;
              sseSend(res, { type: "tool_error", id: block.id, name: block.name, error: e.message, durationMs });
              return { type: "tool_result", tool_use_id: block.id, content: `Tool error: ${e.message}`, is_error: true };
            }
          }),
        );

        messages.push({ role: "user", content: toolResults });
      }

      sseSend(res, { type: "usage", inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
      sseSend(res, { type: "done", conversationId });
      res.end();
    } catch (e: any) {
      console.error("[DIRT]", e);
      try { sseSend(res, { type: "error", message: e.message }); } catch {}
      try { res.end(); } catch {}
    } finally {
      // ALWAYS persist + log cost, even when the loop errored or the
      // client cancelled — partial conversations are still useful.
      const persistMessages = [
        ...body.messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "assistant" as const, content: assistantTextForPersist || "(no response)" },
      ];
      persistConversation({ id: conversationId, adminEmail: userEmail, messages: persistMessages });
      logAiCost({
        userId: null,
        surface: "ops_dirt",
        model: modelId,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        metadata: { admin: userEmail, tool_count: toolCount, conversation_id: conversationId },
      }).catch((e) => console.warn("[DIRT] cost log failed:", e.message));
    }
  });

  // ─── Conversation history endpoints ───────────────────────────────

  app.get("/api/ops/dirt/conversations", async (req: AdminReq, res) => {
    const userEmail = req.adminEmail || "unknown";
    try {
      await ensureConvoTable();
      const limit = Math.min(parseInt((req.query.limit as string) || "30"), 100);
      const r = await pool.query(
        `SELECT id, title, message_count, last_message_at, created_at
         FROM ops_dirt_conversations
         WHERE admin_email = $1
         ORDER BY last_message_at DESC
         LIMIT $2`,
        [userEmail, limit],
      );
      res.json({ conversations: r.rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message, conversations: [] });
    }
  });

  app.get("/api/ops/dirt/conversations/:id", async (req: AdminReq, res) => {
    const userEmail = req.adminEmail || "unknown";
    try {
      await ensureConvoTable();
      const r = await pool.query(
        `SELECT id, title, messages, message_count, last_message_at, created_at
         FROM ops_dirt_conversations
         WHERE admin_email = $1 AND id = $2 LIMIT 1`,
        [userEmail, req.params.id],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "not found" });
      res.json(r.rows[0]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/dirt/conversations/:id", async (req: AdminReq, res) => {
    const userEmail = req.adminEmail || "unknown";
    try {
      await ensureConvoTable();
      await pool.query(
        `DELETE FROM ops_dirt_conversations WHERE admin_email = $1 AND id = $2`,
        [userEmail, req.params.id],
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/dirt/conversations", async (req: AdminReq, res) => {
    const userEmail = req.adminEmail || "unknown";
    try {
      await ensureConvoTable();
      await pool.query(`DELETE FROM ops_dirt_conversations WHERE admin_email = $1`, [userEmail]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Proactive DIRT — notifications inbox ──────────────────────────

  app.get("/api/ops/dirt/notifications", async (_req: AdminReq, res) => {
    try {
      await ensureNotificationsTable();
      const r = await pool.query(
        `SELECT id, kind, severity, title, body, metadata, dismissed_at, created_at
         FROM ops_dirt_notifications
         ORDER BY (dismissed_at IS NULL) DESC, created_at DESC
         LIMIT 50`,
      );
      const unread = r.rows.filter((n: any) => !n.dismissed_at).length;
      res.json({ notifications: r.rows, unread });
    } catch (e: any) {
      res.status(500).json({ error: e.message, notifications: [], unread: 0 });
    }
  });

  app.patch("/api/ops/dirt/notifications/:id/dismiss", async (req, res) => {
    try {
      await pool.query(
        `UPDATE ops_dirt_notifications SET dismissed_at = NOW() WHERE id = $1`,
        [req.params.id],
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/dirt/scan", async (req: AdminReq, res) => {
    try {
      const result = await runScan(req.adminEmail || "manual");
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Send a synthetic test alert to the configured Slack webhook so admins
  // can verify it's working without waiting for the cron scan to fire.
  app.post("/api/ops/dirt/slack-test", async (req: AdminReq, res) => {
    if (!process.env.SLACK_OPS_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: "SLACK_OPS_WEBHOOK_URL not configured" });
    }
    try {
      await postToSlack({
        findings: [
          {
            kind: "test",
            severity: "info",
            title: "DIRT test alert from ops dashboard",
            body: `Triggered manually by ${req.adminEmail || "unknown"}. If you see this, the Slack webhook is wired correctly.`,
          },
        ],
        trigger: "manual-test",
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Legacy non-streaming alias for back-compat
  app.post("/api/ops/concierge/chat", async (req: AdminReq, res) => {
    if (!isAIConfigured()) return res.status(503).json({ error: "AI not configured" });
    const body = req.body as ChatBody;
    if (!body?.messages?.length) return res.status(400).json({ error: "messages required" });
    const modelId = body.model === "fast" ? BEDROCK_MODELS.FAST : BEDROCK_MODELS.HIGH_IQ;
    const userEmail = req.adminEmail || "unknown";
    const activeTools = body.readOnly ? READ_TOOLS : TOOLS;
    const messages: any[] = body.messages.map((m) => ({ role: m.role, content: m.content }));
    const toolUses: any[] = [];
    let totalInput = 0, totalOutput = 0, finalText = "";
    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const resp: any = await (anthropic as any).messages.create({
          model: modelId,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: activeTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          messages,
        });
        totalInput += resp.usage?.input_tokens || 0;
        totalOutput += resp.usage?.output_tokens || 0;
        const toolBlocks = (resp.content || []).filter((b: any) => b.type === "tool_use");
        const textBlocks = (resp.content || []).filter((b: any) => b.type === "text");
        const text = textBlocks.map((b: any) => b.text).join("\n").trim();
        messages.push({ role: "assistant", content: resp.content });
        if (resp.stop_reason !== "tool_use" || !toolBlocks.length) { finalText = text; break; }
        const toolResults = await Promise.all(toolBlocks.map(async (block: any) => {
          const tool = TOOL_MAP.get(block.name);
          const started = Date.now();
          if (!tool) return { type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
          try {
            const result = await tool.handler(block.input || {}, { adminEmail: userEmail });
            toolUses.push({ name: block.name, input: block.input, result, durationMs: Date.now() - started });
            return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
          } catch (e: any) {
            toolUses.push({ name: block.name, input: block.input, error: e.message, durationMs: Date.now() - started });
            return { type: "tool_result", tool_use_id: block.id, content: `Tool error: ${e.message}`, is_error: true };
          }
        }));
        messages.push({ role: "user", content: toolResults });
      }
      logAiCost({ userId: null, surface: "ops_dirt", model: modelId, inputTokens: totalInput, outputTokens: totalOutput, metadata: { admin: userEmail, tool_count: toolUses.length } }).catch(() => {});
      res.json({ response: finalText || "(no response)", toolUses, usage: { inputTokens: totalInput, outputTokens: totalOutput } });
    } catch (e: any) {
      console.error("[DIRT-legacy]", e);
      res.status(500).json({ error: e.message, toolUses });
    }
  });
}

// ─── Proactive DIRT scan ───────────────────────────────────────────

let notifTableEnsured = false;
async function ensureNotificationsTable() {
  if (notifTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_dirt_notifications (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      metadata JSONB,
      dismissed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dirt_notif_created
      ON ops_dirt_notifications (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dirt_notif_unread
      ON ops_dirt_notifications (dismissed_at) WHERE dismissed_at IS NULL;
  `);
  notifTableEnsured = true;
}

const SCAN_PROMPT = `You are DIRT in scan mode. Your job: silently inspect every data source via tools, then surface ONLY items an operator needs to know about right now.

Look for:
- Integrations disconnected or erroring
- Runaway AI costs (any user > $5 MTD, or platform cost spike vs. last week)
- Stuck orders (PENDING for > 48h)
- Failed admin actions in the last 24h
- Churn spikes (more cancellations this week than last)
- Content drafts pending review > 24h
- Klaviyo flow status anomalies
- Anything else unusual

Use multiple tools in parallel. After investigation, output ONLY a JSON array (no preamble, no explanation):

[
  {"kind": "integration|cost|order|admin|churn|content|email|other",
   "severity": "info|warn|critical",
   "title": "Short headline under 80 chars",
   "body": "1-2 sentence detail with specifics (numbers, ids)",
   "metadata": { ...any structured context, optional... } }
]

If nothing is unusual, output exactly: []

Be conservative. Only surface things the operator should act on or be aware of. Don't pad with noise.`;

async function runScan(trigger: string): Promise<{ inserted: number; notifications: any[]; findings: number }> {
  if (!isAIConfigured()) return { inserted: 0, notifications: [], findings: 0 };
  await ensureNotificationsTable();

  const messages: any[] = [{ role: "user", content: "Run a full scan now." }];
  let finalText = "";
  for (let iter = 0; iter < 6; iter++) {
    const resp: any = await (anthropic as any).messages.create({
      model: BEDROCK_MODELS.HIGH_IQ,
      max_tokens: 4096,
      system: SCAN_PROMPT,
      tools: READ_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages,
    });
    const toolBlocks = (resp.content || []).filter((b: any) => b.type === "tool_use");
    const textBlocks = (resp.content || []).filter((b: any) => b.type === "text");
    finalText = textBlocks.map((b: any) => b.text).join("\n").trim();
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use" || !toolBlocks.length) break;
    const toolResults = await Promise.all(toolBlocks.map(async (block: any) => {
      const tool = TOOL_MAP.get(block.name);
      if (!tool) return { type: "tool_result", tool_use_id: block.id, content: `Unknown: ${block.name}`, is_error: true };
      try {
        const result = await tool.handler(block.input || {}, { adminEmail: "system_scan" });
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
      } catch (e: any) {
        return { type: "tool_result", tool_use_id: block.id, content: `error: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: toolResults });
  }

  // Parse the JSON array out of the final text
  let findings: any[] = [];
  try {
    const m = finalText.match(/\[\s*(?:\{[\s\S]*\}|\s*)\s*\]/);
    if (m) findings = JSON.parse(m[0]);
  } catch (e: any) {
    console.warn("[DIRT scan] parse failed:", e.message, "raw head:", finalText.slice(0, 200));
  }

  // Dedupe: don't re-add a title that's currently unread or surfaced in the last 24h
  const existing = await pool.query(
    `SELECT title FROM ops_dirt_notifications WHERE dismissed_at IS NULL OR created_at >= NOW() - INTERVAL '24 hours'`,
  );
  const existingTitles = new Set((existing.rows as any[]).map((r) => r.title.toLowerCase()));

  let inserted = 0;
  const insertedRows: any[] = [];
  for (const f of findings) {
    if (!f?.title || existingTitles.has(String(f.title).toLowerCase())) continue;
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ops_dirt_notifications (id, kind, severity, title, body, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, f.kind || "other", f.severity || "info", String(f.title).slice(0, 200), f.body || null, f.metadata ? JSON.stringify(f.metadata) : null],
    );
    insertedRows.push({ id, ...f });
    inserted++;
  }
  console.log(`[DIRT scan] trigger=${trigger} findings=${findings.length} inserted=${inserted}`);

  // Push new findings to Slack (best-effort, doesn't block the scan)
  if (insertedRows.length > 0) {
    postToSlack({ findings: insertedRows, trigger }).catch((e) =>
      console.warn("[DIRT slack] post failed:", e.message),
    );
  }

  return { inserted, notifications: insertedRows, findings: findings.length };
}

/**
 * Post DIRT scan findings to Slack via incoming webhook.
 * Severity dictates the colored attachment bar (red / amber / blue).
 * Title becomes the bold header line, body becomes the context block.
 */
async function postToSlack(args: {
  findings: Array<{ kind: string; severity: string; title: string; body?: string; metadata?: any }>;
  trigger: string;
}): Promise<void> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL;
  if (!url) return;

  const sevColor = (s: string) =>
    s === "critical" ? "#EF4444" : s === "warn" ? "#F59E0B" : "#2E5BFF";
  const sevEmoji = (s: string) =>
    s === "critical" ? ":rotating_light:" : s === "warn" ? ":warning:" : ":information_source:";

  const attachments = args.findings.slice(0, 10).map((f) => ({
    color: sevColor(f.severity),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${sevEmoji(f.severity)} *${f.title}*\n${f.body ? `\n${f.body}` : ""}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `\`${f.kind}\` · \`${f.severity}\` · scan trigger: \`${args.trigger}\``,
          },
        ],
      },
    ],
  }));

  const payload = {
    text: `DIRT surfaced ${args.findings.length} new alert${args.findings.length === 1 ? "" : "s"} from the FitScript ops dashboard.`,
    attachments,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
}

/**
 * Kick off the 15-minute scan loop. Called from server/index.ts at boot.
 * Skipped in dev unless OPS_ENABLE_SCAN=1 since it costs Claude tokens.
 */
export function startDirtScanLoop() {
  if (!isAIConfigured()) {
    console.log("[DIRT scan] skipped — AI not configured");
    return;
  }
  const enabled = process.env.NODE_ENV === "production" || process.env.OPS_ENABLE_SCAN === "1";
  if (!enabled) {
    console.log("[DIRT scan] disabled in dev (set OPS_ENABLE_SCAN=1 to test locally)");
    return;
  }
  const intervalMs = 15 * 60 * 1000;
  setTimeout(() => {
    runScan("startup").catch((e) => console.warn("[DIRT scan] startup failed:", e.message));
    setInterval(() => {
      runScan("cron").catch((e) => console.warn("[DIRT scan] cron failed:", e.message));
    }, intervalMs);
  }, 60_000);
  console.log("[DIRT scan] enabled — first run in 60s, then every 15min");
}
