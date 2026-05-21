/**
 * Ops Concierge — Claude-powered assistant with read-only tool access to
 * every primary data source in the ops dashboard.
 *
 * POST /api/ops/concierge/chat
 *   body: { messages: [{role, content}], model?: "fast"|"smart" }
 *   returns: { messages: [...], usage: {...}, toolUses: [{name, input, durationMs}] }
 *
 * Implementation: standard Claude tool-use loop. The model can request any
 * of the registered READ tools; each tool runs against the live RDS or an
 * existing internal endpoint and returns JSON. The loop runs up to 8
 * iterations; if the model hasn't produced a final assistant text response
 * by then we stop and return what we have.
 *
 * Costs land in `ai_costs` under surface=`ops_concierge`.
 *
 * Phase 1 is READ-ONLY by design — write tools (pause flow, approve
 * draft, refund) land in Phase 2 with audit-log + typed-confirmation.
 */
import type { Express, Request } from "express";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";
import { pool } from "./db";

interface AdminReq extends Request {
  adminEmail?: string;
}

// ─── System prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the FitScript Ops Concierge — Paul's right-hand operator inside the FitScript admin dashboard.

You have read-only access to every primary data source through tools:
- Business KPIs: MRR, ARR, subscribers, churn, signups, lab uploads
- Members: search by email/name, get full profile (LTV, AI cost, Stripe history)
- Orders: Rx prescriptions + lab panels, status-filterable
- Marketing: GA4 traffic, Meta Ads campaigns, first-party attribution, funnel
- Content: Clomark drafts in the publishing pipeline
- Email: Klaviyo campaigns, flows, lists
- System health: which integrations are connected vs broken
- Audit: recent admin actions

How to behave:
- ALWAYS use tools to answer factual questions. Never guess a number from memory.
- Use multiple tools in parallel when the question needs cross-domain data.
- Lead with the answer. Then add a short context line. No filler ("Great question!", "Let me check…").
- Format numbers cleanly: $12.4k, 1,247 users, 3.2x ROAS, 4.1% churn.
- For tables, use markdown tables. Keep columns tight.
- If you suggest an action that requires writing (pause a flow, approve a draft, refund), name it but say it's not yet wired — Phase 2.
- If a tool errors or returns nothing, say what you tried and what you don't know. Don't fabricate.
- When useful, end with a single follow-up suggestion ("Want me to break this down by tier?").

Today is ${new Date().toISOString().slice(0, 10)}. The admin asking you questions is Paul (paulclotar@gmail.com) unless tools tell you otherwise.`;

// ─── Tool registry ─────────────────────────────────────────────────

type ToolHandler = (input: any) => Promise<unknown>;
interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
}

const TOOLS: ToolDef[] = [
  {
    name: "get_snapshot",
    description:
      "Get current business snapshot: MRR, ARR, total users, active subscribers, tier breakdown, signups today/week/month, churn rate, lab uploads, Atlas chats, waitlist.",
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
    description:
      "Search members by email substring, name substring, or filter by tier/status. Returns paginated list with key fields. Use this before get_member when the operator gives a name/email instead of a userId.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Email or name substring" },
        tier: { type: "string", enum: ["free", "essentials", "complete"] },
        status: { type: "string", enum: ["active", "canceled", "trialing", "past_due"] },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
    handler: async (args: { search?: string; tier?: string; status?: string; limit?: number }) => {
      const limit = Math.min(args.limit || 20, 100);
      const where: string[] = [];
      const params: any[] = [];
      if (args.search) {
        params.push(`%${args.search}%`);
        where.push(`(LOWER(email) LIKE LOWER($${params.length}) OR LOWER(first_name||' '||last_name) LIKE LOWER($${params.length}))`);
      }
      if (args.tier) {
        params.push(args.tier);
        where.push(`subscription_tier = $${params.length}`);
      }
      if (args.status) {
        params.push(args.status);
        where.push(`subscription_status = $${params.length}`);
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT id, email, first_name, last_name, subscription_tier, subscription_status,
                created_at, last_active_date, source, stripe_customer_id
         FROM users
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return { count: r.rows.length, members: r.rows };
    },
  },
  {
    name: "get_member",
    description: "Get full profile for a single user by userId (UUID).",
    input_schema: {
      type: "object",
      properties: { userId: { type: "string" } },
      required: ["userId"],
    },
    handler: async (args: { userId: string }) => {
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
    description: "Get daily revenue and active-subscriber counts for the last N days (default 30).",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "1-365, default 30" } },
    },
    handler: async (args: { days?: number }) => {
      const days = Math.min(args.days || 30, 365);
      const r = await pool.query(
        `SELECT date_trunc('day', created_at)::date AS day,
                COUNT(*)::int AS signups,
                COUNT(*) FILTER (WHERE subscription_tier IN ('essentials','complete'))::int AS paid_signups
         FROM users
         WHERE created_at >= NOW() - ($1::int || ' days')::interval
         GROUP BY day ORDER BY day`,
        [days],
      );
      return { days, trend: r.rows };
    },
  },
  {
    name: "get_orders",
    description: "List recent Rx or lab orders. Filterable by category (rx|labs) and status.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["rx", "labs"], description: "rx = prescriptions, labs = lab panels" },
        status: { type: "string", description: "e.g. PENDING, SHIPPED, COMPLETED, CANCELLED" },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
    handler: async (args: { category?: string; status?: string; limit?: number }) => {
      const limit = Math.min(args.limit || 20, 100);
      const where: string[] = [];
      const params: any[] = [];
      if (args.category === "rx") where.push("category = 'rx'");
      else if (args.category === "labs") where.push("category = 'labs'");
      if (args.status) {
        params.push(args.status);
        where.push(`status = $${params.length}`);
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT id, visible_id, email, first_name, last_name, category, product_name,
                status, payment_status, amount, tracking_number, carrier, created_at, updated_at
         FROM orders
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return { count: r.rows.length, orders: r.rows };
    },
  },
  {
    name: "get_marketing_overview",
    description: "GA4 + first-party tracking summary for the last N days (default 30). Returns sessions, users, channel breakdown, top pages.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" } },
    },
    handler: async (args: { days?: number }) => {
      const days = Math.min(args.days || 30, 90);
      const channels = await pool.query(
        `SELECT channel, COUNT(*)::int AS users,
                COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS identified
         FROM visitors
         WHERE created_at >= NOW() - ($1::int || ' days')::interval
         GROUP BY channel ORDER BY users DESC LIMIT 20`,
        [days],
      ).catch(() => ({ rows: [] as any[] }));
      const totals = await pool.query(
        `SELECT COUNT(*)::int AS total_visitors,
                COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS identified
         FROM visitors
         WHERE created_at >= NOW() - ($1::int || ' days')::interval`,
        [days],
      ).catch(() => ({ rows: [{ total_visitors: 0, identified: 0 }] }));
      return { days, totals: totals.rows[0], channels: channels.rows };
    },
  },
  {
    name: "get_funnel",
    description: "Conversion funnel for the last N days (default 30): visitors → quiz started → signup → paid → labs uploaded.",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
    handler: async (args: { days?: number }) => {
      const days = Math.min(args.days || 30, 90);
      try {
        const r = await pool.query(
          `SELECT
            (SELECT COUNT(*)::int FROM visitors WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS visitors,
            (SELECT COUNT(*)::int FROM events WHERE event_type = 'quiz_started' AND created_at >= NOW() - ($1::int || ' days')::interval) AS quiz_started,
            (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS signups,
            (SELECT COUNT(*)::int FROM users WHERE subscription_tier IN ('essentials','complete') AND created_at >= NOW() - ($1::int || ' days')::interval) AS paid,
            (SELECT COUNT(*)::int FROM lab_results WHERE created_at >= NOW() - ($1::int || ' days')::interval) AS labs_uploaded
          `,
          [days],
        );
        return { days, ...r.rows[0] };
      } catch (e: any) {
        return { error: `Funnel query failed: ${e.message}` };
      }
    },
  },
  {
    name: "get_top_ai_cost_users",
    description: "Top N members ranked by AI cost month-to-date. Useful for finding power users or runaway-cost outliers.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 10, max 50" } },
    },
    handler: async (args: { limit?: number }) => {
      const limit = Math.min(args.limit || 10, 50);
      const r = await pool.query(
        `SELECT u.id, u.email, u.subscription_tier,
                SUM(ac.cost_usd)::numeric AS cost_usd,
                COUNT(ac.id)::int AS calls
         FROM ai_costs ac
         JOIN users u ON u.id = ac.user_id
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
    description: "Recent admin actions (pause, refund, send, approve etc.) for context and audit.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 20, max 100" } },
    },
    handler: async (args: { limit?: number }) => {
      const limit = Math.min(args.limit || 20, 100);
      try {
        const r = await pool.query(
          `SELECT id, admin_email, action_type, target_kind, target_id, target_label, status, error, created_at
           FROM admin_actions ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        return { count: r.rows.length, actions: r.rows };
      } catch (e: any) {
        return { count: 0, actions: [], note: "admin_actions table empty or not created yet" };
      }
    },
  },
  {
    name: "get_integration_health",
    description: "Status of every external connector (Google OAuth/GA4/GSC, Klaviyo, Meta Ads, Stripe, Clomark). Surfaces which are red.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const status = {
        google: {
          configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
          connected: false,
          detail: "" as string,
        },
        klaviyo: {
          configured: !!process.env.KLAVIYO_API_KEY,
          connected: !!process.env.KLAVIYO_API_KEY,
          detail: process.env.KLAVIYO_API_KEY ? "key set" : "not configured",
        },
        meta_ads: {
          configured: !!process.env.META_SYSTEM_USER_TOKEN,
          connected: !!process.env.META_SYSTEM_USER_TOKEN,
          detail: process.env.META_SYSTEM_USER_TOKEN ? "token set" : "not configured",
        },
        stripe: {
          configured: !!process.env.STRIPE_SECRET_KEY,
          connected: !!process.env.STRIPE_SECRET_KEY,
          detail: process.env.STRIPE_SECRET_KEY ? `key set (${process.env.STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : "test"})` : "not configured",
        },
        clomark: {
          configured: !!(process.env.CLOMARK_BASE_URL && process.env.CLOMARK_OPS_TOKEN),
          connected: !!(process.env.CLOMARK_BASE_URL && process.env.CLOMARK_OPS_TOKEN && process.env.CLOMARK_BUSINESS_ID),
          detail: process.env.CLOMARK_BUSINESS_ID ? "configured" : "missing business id",
        },
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
      const disconnected = Object.entries(status).filter(([_, v]) => !v.connected).map(([k]) => k);
      return { status, all_connected: disconnected.length === 0, disconnected };
    },
  },
  {
    name: "get_content_drafts",
    description: "Pending Clomark content drafts (blog posts + location pages) waiting for approval.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    handler: async (args: { limit?: number }) => {
      const base = process.env.CLOMARK_BASE_URL;
      const token = process.env.CLOMARK_OPS_TOKEN;
      const businessId = process.env.CLOMARK_BUSINESS_ID;
      if (!base || !token || !businessId) {
        return { error: "Clomark connector not fully configured", drafts: [] };
      }
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
        const flows = (f.data || []).filter((x: any) => x.attributes?.status === "live").slice(0, 20);
        return {
          campaigns: (c.data || []).map((x: any) => ({
            id: x.id,
            name: x.attributes?.name,
            status: x.attributes?.status,
            scheduled_at: x.attributes?.scheduled_at,
            send_time: x.attributes?.send_time,
          })),
          live_flows: flows.map((x: any) => ({ id: x.id, name: x.attributes?.name, trigger: x.attributes?.trigger_type })),
        };
      } catch (e: any) {
        return { error: e.message, campaigns: [], flows: [] };
      }
    },
  },
  {
    name: "get_unit_economics",
    description: "Platform-wide unit economics MTD: revenue, AI cost, gross margin, cost per user. Plus coverage flag (atlas_only vs all_surfaces).",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const r = await pool.query(`
          SELECT
            COALESCE(SUM(cost_usd), 0)::numeric AS cost_mtd,
            COUNT(DISTINCT user_id)::int AS users_mtd
          FROM ai_costs WHERE created_at >= date_trunc('month', NOW())
        `);
        const cost = parseFloat(r.rows[0].cost_mtd);
        const usersMtd = r.rows[0].users_mtd;
        // Revenue MTD = sum of stripe payments captured this month (approximation: paid_signups * tier price)
        const revR = await pool.query(`
          SELECT COALESCE(SUM(CASE
            WHEN subscription_tier = 'essentials' THEN 27
            WHEN subscription_tier = 'complete' THEN 97
            ELSE 0 END), 0)::numeric AS rev
          FROM users WHERE subscription_status = 'active'
        `);
        const revMonthly = parseFloat(revR.rows[0].rev);
        // Detect coverage: are there non-atlas surfaces in ai_costs?
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

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ─── Endpoint ───────────────────────────────────────────────────────

interface ChatBody {
  messages: { role: "user" | "assistant"; content: string }[];
  model?: "fast" | "smart";
}

interface ToolUseRecord {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

const MAX_ITERATIONS = 8;

export function registerConciergeRoutes(app: Express) {
  app.post("/api/ops/concierge/chat", async (req: AdminReq, res) => {
    if (!isAIConfigured()) {
      return res.status(503).json({ error: "AI not configured" });
    }
    const body = req.body as ChatBody;
    if (!body?.messages?.length) {
      return res.status(400).json({ error: "messages required" });
    }
    const modelId = body.model === "fast" ? BEDROCK_MODELS.FAST : BEDROCK_MODELS.HIGH_IQ;
    const userEmail = req.adminEmail || "unknown";

    // Build conversation in Anthropic format. Tool results get appended as we loop.
    const messages: any[] = body.messages.map((m) => ({ role: m.role, content: m.content }));
    const toolUses: ToolUseRecord[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalText = "";

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const resp: any = await (anthropic as any).messages.create({
          model: modelId,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages,
        });

        totalInputTokens += resp.usage?.input_tokens || 0;
        totalOutputTokens += resp.usage?.output_tokens || 0;

        // Collect text + tool_use blocks
        const toolUseBlocks = (resp.content || []).filter((b: any) => b.type === "tool_use");
        const textBlocks = (resp.content || []).filter((b: any) => b.type === "text");
        const textOutput = textBlocks.map((b: any) => b.text).join("\n").trim();

        // Always push the assistant turn to maintain conversation integrity
        messages.push({ role: "assistant", content: resp.content });

        if (resp.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
          finalText = textOutput;
          break;
        }

        // Execute every requested tool in parallel
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block: any) => {
            const tool = TOOL_MAP.get(block.name);
            const started = Date.now();
            if (!tool) {
              const error = `Unknown tool: ${block.name}`;
              toolUses.push({ name: block.name, input: block.input, error, durationMs: 0 });
              return { type: "tool_result", tool_use_id: block.id, content: error, is_error: true };
            }
            try {
              const result = await tool.handler(block.input || {});
              const durationMs = Date.now() - started;
              toolUses.push({ name: block.name, input: block.input, result, durationMs });
              return {
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify(result),
              };
            } catch (e: any) {
              const durationMs = Date.now() - started;
              toolUses.push({ name: block.name, input: block.input, error: e.message, durationMs });
              return {
                type: "tool_result",
                tool_use_id: block.id,
                content: `Tool error: ${e.message}`,
                is_error: true,
              };
            }
          }),
        );

        messages.push({ role: "user", content: toolResults });
      }

      if (!finalText) {
        finalText =
          "I gathered a lot of data but couldn't condense it in time. Try asking a narrower question or specify what you want to see.";
      }

      // Log cost
      logAiCost({
        userId: null,
        surface: "ops_concierge",
        model: modelId,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        metadata: { admin: userEmail, tool_count: toolUses.length, iterations: toolUses.length > 0 ? Math.ceil(toolUses.length / 2) + 1 : 1 },
      }).catch((e) => console.warn("[CONCIERGE] cost log failed:", e.message));

      res.json({
        response: finalText,
        toolUses,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      });
    } catch (e: any) {
      console.error("[CONCIERGE]", e);
      res.status(500).json({ error: e.message, toolUses });
    }
  });
}
