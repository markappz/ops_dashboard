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
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";
import { logAdminAction } from "./lib/auditLog";
import { pool } from "./db";

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
- For \`refund_charge\` over $50, you MUST ask the user to type CONFIRM, and pass it as the \`confirmation\` field. Refuse to call the tool until they do.
- For \`bulk_publish_content\`, surface the count and ask for confirmation.
- All other writes (pause/activate flow, approve/deny content, queue topic) execute immediately — they're reversible.
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

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ─── Streaming endpoint ─────────────────────────────────────────────

interface ChatBody {
  messages: { role: "user" | "assistant"; content: string }[];
  model?: "fast" | "smart";
  /** if true, only expose READ tools (blocks all writes for this turn). */
  readOnly?: boolean;
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

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const messages: any[] = body.messages.map((m) => ({ role: m.role, content: m.content }));
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCount = 0;

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
      sseSend(res, { type: "done" });
      res.end();

      logAiCost({
        userId: null,
        surface: "ops_dirt",
        model: modelId,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        metadata: { admin: userEmail, tool_count: toolCount },
      }).catch((e) => console.warn("[DIRT] cost log failed:", e.message));
    } catch (e: any) {
      console.error("[DIRT]", e);
      sseSend(res, { type: "error", message: e.message });
      res.end();
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
