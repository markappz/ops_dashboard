/**
 * RP Email MCP — a Model Context Protocol server (streamable HTTP, JSON-RPC 2.0) so Josh's AI
 * agent/builder can drive the email system from whatever tool he works in (Claude, custom
 * agents, anything MCP-capable points at one URL + bearer token).
 *
 *   URL:   https://ops.fitscript.me/api/mcp/rp-email
 *   Auth:  Authorization: Bearer ${RP_EMAIL_MCP_TOKEN}   (unset = endpoint refuses, 503)
 *
 * DELIBERATE SCOPE (Paul's review rule, 2026-10-02): the MCP can research and DRAFT - list
 * segments, preview audience sizes, create/update campaign drafts in the calendar, send tests
 * to a named inbox, read campaign stats. It can NOT mass-send: the only door to customers is
 * ops' Review & send, which shows a human the live recipient count and asks again.
 *
 * Campaign drafts land in ops_email_plans (status 'draft'), so they appear in the email
 * calendar instantly - Josh's agent composes with any builder, pushes HTML here, and a human
 * finishes the job in the UI.
 */
import type { Express, Request, Response } from "express";
import { wallClock } from "./email-scheduler";
import { pool } from "./db";

const PROTOCOL = "2025-03-26";

function rpCfg() {
  const base = process.env.RP_SITE_API_URL;
  const token = process.env.RP_SITE_OPS_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}

async function bridge(path: string, init?: { method?: string; body?: unknown }) {
  const c = rpCfg();
  if (!c) throw new Error("RP bridge is not configured on ops (RP_SITE_API_URL + RP_SITE_OPS_TOKEN).");
  const r = await fetch(`${c.base}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `bridge ${r.status}`);
  return j;
}

const TOOLS = [
  {
    name: "list_segments",
    description: "List Real Peptides email segments with live audience counts (suppressed and unsubscribed contacts already excluded). Use a segment's slug when creating a campaign.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "preview_audience",
    description: "How many contacts a campaign would reach right now. Omit segment to target everyone mailable.",
    inputSchema: { type: "object", properties: { segment: { type: "string", description: "Segment slug from list_segments; omit for everyone." } }, additionalProperties: false },
  },
  {
    name: "create_campaign",
    description: "Create a campaign DRAFT in the ops email calendar. It will NOT send - a human reviews and sends from the dashboard (Review & send shows the live recipient count). Returns the plan id and where to find it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Internal campaign name shown on the calendar." },
        subject: { type: "string" },
        preheader: { type: "string" },
        html: { type: "string", description: "Full email body HTML from any builder. The engine adds brand chrome and the per-recipient unsubscribe footer at send time." },
        html_base64: { type: "string", description: "The same HTML, base64-encoded. PREFER THIS: the dashboard sits behind a WAF that can reject raw HTML in JSON (403). Provide html or html_base64, not both." },
        segment: { type: "string", description: "Segment slug; omit for everyone mailable." },
        send_date: { type: "string", description: "Intended send date YYYY-MM-DD (calendar placement only; sending is still manual)." },
      },
      required: ["title", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: "update_campaign",
    description: "Update a draft campaign's fields. Refuses campaigns that already sent.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: { type: "number" },
        title: { type: "string" }, subject: { type: "string" }, preheader: { type: "string" },
        html: { type: "string" }, html_base64: { type: "string", description: "Base64-encoded HTML; preferred over raw html (WAF)." }, segment: { type: "string" }, send_date: { type: "string" },
      },
      required: ["plan_id"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_campaign",
    description: "Schedule an EXISTING draft campaign to auto-send at a date/time/timezone. Guard rails: fire time must be at least 2 HOURS out (a human veto window — the campaign stays visible in Drafts & scheduled and can be set back to draft with one click until it fires). There is still no instant mass-send tool, by design.",
    inputSchema: { type: "object", properties: {
      id: { type: "number", description: "Draft campaign id (from create_campaign / list_campaigns)" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, 24h, in the given timezone" },
      tz: { type: "string", description: "IANA timezone the time means. Default America/Los_Angeles.", enum: ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York"] },
    }, required: ["id", "date", "time"] },
  },
  {
    name: "list_campaigns",
    description: "Recent Real Peptides campaigns on the calendar with status (draft/approved/scheduled/sent) and, for sent ones, the analytics tag.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Default 20, max 100." } }, additionalProperties: false },
  },
  {
    name: "test_send",
    description: "Send ONE rendered test email to a named inbox (brand chrome applied), exactly as the campaign would look. Use before asking a human to send.",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string" }, html: { type: "string" }, html_base64: { type: "string", description: "Base64-encoded HTML; preferred over raw html (WAF)." }, to: { type: "string", description: "The test inbox." } },
      required: ["subject", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "campaign_stats",
    description: "Engagement and attributed sales for sent campaigns over the last 90 days (opens, clicks, bounces, revenue), from the site's own event ledger.",
    inputSchema: { type: "object", properties: { tag: { type: "string", description: "A campaign's analytics tag; omit to list all 90-day campaigns." } }, additionalProperties: false },
  },
];

/** html_base64 wins over html when both appear - raw HTML in JSON can be eaten by the WAF. */
function resolveHtml(args: Record<string, unknown>): string | undefined {
  if (typeof args.html_base64 === "string" && args.html_base64) {
    return Buffer.from(args.html_base64, "base64").toString("utf8");
  }
  return typeof args.html === "string" ? args.html : undefined;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_segments":
      return bridge("/api/ops-marketing?what=segments");
    case "preview_audience":
      return bridge("/api/ops-marketing", { method: "POST", body: { action: "preview", segment: args.segment } });
    case "create_campaign": {
      const html = resolveHtml(args);
      if (!html) throw new Error("Provide html or html_base64.");
      const { rows } = await pool.query(
        `INSERT INTO ops_email_plans (company, title, subject, preheader, status, send_date, audience_id, html, created_by)
         VALUES ('realpeptides', $1, $2, $3, 'draft', $4, $5, $6, 'mcp:josh') RETURNING id`,
        [String(args.title).trim(), String(args.subject), args.preheader ?? null, args.send_date ?? null, args.segment ?? null, html],
      );
      return {
        plan_id: rows[0].id,
        status: "draft",
        next: "A human reviews and sends it: ops.fitscript.me → Real Peptides → Email → open the plan → Review & send.",
      };
    }
    case "update_campaign": {
      const id = Number(args.plan_id);
      const { rows } = await pool.query("SELECT status FROM ops_email_plans WHERE id = $1 AND company = 'realpeptides'", [id]);
      if (!rows[0]) throw new Error(`No Real Peptides campaign with plan_id ${id}.`);
      if (rows[0].status === "sent") throw new Error("That campaign already sent - create a new draft instead.");
      if (args.html_base64) args = { ...args, html: resolveHtml(args) };
      const sets: string[] = []; const vals: unknown[] = [id];
      const map: Record<string, string> = { title: "title", subject: "subject", preheader: "preheader", html: "html", segment: "audience_id", send_date: "send_date" };
      for (const [k, col] of Object.entries(map)) {
        if (args[k] !== undefined) { vals.push(args[k]); sets.push(`${col} = $${vals.length}`); }
      }
      if (!sets.length) throw new Error("Nothing to update.");
      await pool.query(`UPDATE ops_email_plans SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, vals);
      return { plan_id: id, updated: Object.keys(map).filter((k) => args[k] !== undefined) };
    }
    case "schedule_campaign": {
      const id = Number(args?.id);
      const date = String(args?.date ?? "");
      const time = String(args?.time ?? "").slice(0, 5);
      const tz = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York"].includes(String(args?.tz)) ? String(args?.tz) : "America/Los_Angeles";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("date must be YYYY-MM-DD and time HH:MM");
      const { rows } = await pool.query(`SELECT id, status, subject, html FROM ops_email_plans WHERE id = $1 AND company = 'realpeptides'`, [id]);
      if (!rows[0]) throw new Error("campaign not found");
      if (rows[0].status === "sent" || rows[0].status === "sending") throw new Error("that campaign already sent");
      if (!rows[0].subject || !rows[0].html) throw new Error("the draft needs a subject and HTML before scheduling");
      const vetoFloor = wallClock(tz, new Date(Date.now() + 2 * 3600_000));
      if (`${date} ${time}` < vetoFloor) throw new Error(`needs a 2h human veto window — earliest allowed is ${vetoFloor} (${tz})`);
      // Preflight the audience through the real engine NOW — a resolve that would fail at
      // fire time refuses to schedule at all (lesson of the 10-04 open-180d failure).
      const pre = await bridge("/api/ops-marketing", { method: "POST", body: { action: "preview", segment: rows[0].audience_id || undefined } }) as { recipients: number };
      await pool.query(
        `UPDATE ops_email_plans SET status = 'scheduled', send_date = $2::date, send_time = $3, send_tz = $4, updated_at = NOW() WHERE id = $1`,
        [id, date, time, tz],
      );
      return { scheduled: true, id, recipients: pre.recipients, firesAt: `${date} ${time} ${tz}`, veto: "Paul can set it back to draft in ops → Broadcasts → Drafts & scheduled any time before it fires." };
    }
    case "list_campaigns": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const { rows } = await pool.query(
        `SELECT id AS plan_id, title, subject, status, send_date, audience_id AS segment, resend_broadcast_id AS tag, created_by, updated_at
         FROM ops_email_plans WHERE company = 'realpeptides' ORDER BY updated_at DESC LIMIT $1`,
        [limit],
      );
      return { campaigns: rows };
    }
    case "test_send": {
      const html = resolveHtml(args);
      if (!html) throw new Error("Provide html or html_base64.");
      return bridge("/api/ops-marketing", { method: "POST", body: { action: "test", subject: args.subject, html, to: args.to } });
    }
    case "campaign_stats": {
      const c = rpCfg();
      if (!c) throw new Error("RP bridge is not configured on ops.");
      const r = await fetch(`${c.base}/api/ops-email-summary?days=90`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(60_000) });
      const j = (await r.json()) as { campaigns?: { broadcastId: string }[] };
      if (!r.ok) throw new Error("email summary failed");
      const campaigns = j.campaigns ?? [];
      return args.tag ? { campaigns: campaigns.filter((cp) => cp.broadcastId === args.tag) } : { campaigns };
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

export function registerRpEmailMcp(app: Express) {
  app.post("/api/mcp/rp-email", async (req: Request, res: Response) => {
    const expected = process.env.RP_EMAIL_MCP_TOKEN;
    if (!expected) return res.status(503).json({ error: "RP_EMAIL_MCP_TOKEN is not set on ops - the MCP endpoint is off." });
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented || presented !== expected) return res.status(401).json({ error: "Unauthorized" });

    const msg = req.body;
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => res.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    try {
      switch (msg?.method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "rp-email", version: "1.0.0" },
            instructions: "Real Peptides email: draft campaigns into the ops calendar, preview audiences, test-send, read stats. Mass sending is human-only via the dashboard's Review & send.",
          });
        case "notifications/initialized":
          return res.status(202).end();
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          const { name, arguments: args } = msg.params ?? {};
          try {
            const out = await callTool(String(name), args ?? {});
            console.log(`[OPS][RP-MCP] ${name}`, JSON.stringify(args ?? {}).slice(0, 200));
            return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
          } catch (e: any) {
            return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
          }
        }
        default:
          return fail(-32601, `Method not found: ${msg?.method}`);
      }
    } catch (e: any) {
      return fail(-32603, e.message);
    }
  });
}
