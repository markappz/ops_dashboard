/**
 * AI Email Composer v2 — brand profiles + style selector + chat mode.
 *
 * Brand profiles (ops_email_brand_profiles)
 *   Reusable color/font/logo bundles. Click a profile → its values get
 *   injected into Claude's system prompt so every email uses the same
 *   brand without re-typing. Default FitScript profile is seeded the
 *   first time the table is accessed.
 *
 * Endpoints
 *   GET  /api/ops/email/brand-profiles                 — list
 *   POST /api/ops/email/brand-profiles                 — create
 *   PATCH /api/ops/email/brand-profiles/:id            — update
 *   DELETE /api/ops/email/brand-profiles/:id           — delete (won't delete default)
 *   POST /api/ops/email/compose/chat                   — multi-turn SSE
 *   POST /api/ops/email/compose                        — legacy one-shot (kept)
 *   POST /api/ops/email/compose/save                   — save final to Klaviyo
 *
 * Style modes
 *   branded-html  → full branded HTML email (logo, buttons, graphics)
 *   minimal-html  → simple HTML, brand colors but minimal styling
 *   plain-text    → actual text/plain output (no HTML at all)
 *
 * Cost is logged to ai_costs with surface `ops_email_compose`.
 */
import type { Express, Request } from "express";
import { randomUUID } from "crypto";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";
import { pool } from "./db";

interface AdminReq extends Request {
  adminEmail?: string;
}

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-04-15";

// ─── Brand profiles ────────────────────────────────────────────────

interface BrandProfile {
  id: string;
  name: string;
  is_default: boolean;
  primary_color: string;
  accent_color: string | null;
  text_color: string;
  bg_color: string;
  page_bg_color: string;
  font_family: string;
  logo_url: string | null;
  logo_width: number;
  footer_text: string | null;
  unsubscribe_text: string;
  brand_voice: string | null;
}

let profilesTableEnsured = false;
async function ensureProfilesTable() {
  if (profilesTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_email_brand_profiles (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT false,
      primary_color TEXT NOT NULL DEFAULT '#2E5BFF',
      accent_color TEXT,
      text_color TEXT NOT NULL DEFAULT '#0A1628',
      bg_color TEXT NOT NULL DEFAULT '#FFFFFF',
      page_bg_color TEXT NOT NULL DEFAULT '#F2F6FC',
      font_family TEXT NOT NULL DEFAULT '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      logo_url TEXT,
      logo_width INTEGER NOT NULL DEFAULT 160,
      footer_text TEXT,
      unsubscribe_text TEXT NOT NULL DEFAULT '{% unsubscribe %}',
      brand_voice TEXT,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_profiles_default
      ON ops_email_brand_profiles (is_default) WHERE is_default = true;
  `);

  // Seed the default FitScript profile if none exists
  const exists = await pool.query(`SELECT 1 FROM ops_email_brand_profiles WHERE is_default = true LIMIT 1`);
  if (exists.rows.length === 0) {
    await pool.query(
      `INSERT INTO ops_email_brand_profiles
       (id, name, is_default, primary_color, accent_color, text_color, bg_color, page_bg_color,
        font_family, logo_url, logo_width, footer_text, brand_voice, created_by)
       VALUES ($1, 'FitScript', true, '#2E5BFF', '#0A1628', '#0A1628', '#FFFFFF', '#F2F6FC',
        $2, 'https://ops.fitscript.me/email-logo.png', 160,
        'FitScript · Optimize what your biology can do.',
        'Direct, science-grounded, warm. No marketing-speak. Reads like a sharp health-optimization founder writing to their list.',
        'system')`,
      [
        randomUUID(),
        '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      ],
    );
    console.log("[OPS][EMAIL] Seeded default FitScript brand profile");
  }
  profilesTableEnsured = true;
}

async function listProfiles(): Promise<BrandProfile[]> {
  await ensureProfilesTable();
  const r = await pool.query(
    `SELECT id, name, is_default, primary_color, accent_color, text_color, bg_color,
            page_bg_color, font_family, logo_url, logo_width, footer_text,
            unsubscribe_text, brand_voice
     FROM ops_email_brand_profiles
     ORDER BY is_default DESC, name ASC`,
  );
  return r.rows;
}

async function getProfile(id: string): Promise<BrandProfile | null> {
  await ensureProfilesTable();
  const r = await pool.query(
    `SELECT id, name, is_default, primary_color, accent_color, text_color, bg_color,
            page_bg_color, font_family, logo_url, logo_width, footer_text,
            unsubscribe_text, brand_voice
     FROM ops_email_brand_profiles WHERE id = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] || null;
}

async function getDefaultProfile(): Promise<BrandProfile> {
  await ensureProfilesTable();
  const r = await pool.query(
    `SELECT id, name, is_default, primary_color, accent_color, text_color, bg_color,
            page_bg_color, font_family, logo_url, logo_width, footer_text,
            unsubscribe_text, brand_voice
     FROM ops_email_brand_profiles WHERE is_default = true LIMIT 1`,
  );
  return r.rows[0];
}

// ─── System prompt builder ─────────────────────────────────────────

type EmailStyle = "branded-html" | "minimal-html" | "plain-text";

function buildSystemPrompt(profile: BrandProfile, style: EmailStyle): string {
  const voice = profile.brand_voice || "Direct, warm, science-grounded. No marketing-speak.";

  if (style === "plain-text") {
    return `You are composing PLAIN TEXT emails for ${profile.name} — no HTML, no styling.

Output FORMAT — exactly this, no preamble:

=== SUBJECT ===
<short subject line, under 60 chars>
=== PREHEADER ===
<inbox preview line, under 100 chars>
=== TEXT ===
<the actual email body, plain text only, line breaks where natural>

Rules:
- NO HTML tags. Period.
- Wrap at ~72 characters for readability in email clients.
- Lead with a real sentence, not a salutation. ("Hi there," is fluff.)
- ONE clear ask per email. State the URL plainly: https://...
- Sign off with "— ${profile.name}" or similar short signature.
- Keep total length under 400 words unless the request demands more.

Voice: ${voice}`;
  }

  const isMinimal = style === "minimal-html";

  // Detect if the font stack starts with a web font (quoted name) so we
  // can pull it from Google Fonts in the head. Apple Mail / iOS Mail
  // render Google Fonts; Gmail/Outlook fall back to the next item in
  // the stack (so the system fonts stay as fallback).
  const fontMatch = profile.font_family.match(/^"([^"]+)"/);
  const webFontName = fontMatch ? fontMatch[1] : null;
  const googleFontLink = webFontName
    ? `<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(webFontName)}:wght@400;500;600;700&display=swap" rel="stylesheet" />`
    : "";

  return `You are an expert email designer composing ${isMinimal ? "minimal" : "fully-branded"} HTML emails for ${profile.name}.

Output FORMAT — exactly this, no preamble, no commentary:

=== SUBJECT ===
<short subject line, under 60 chars, no emojis>
=== PREHEADER ===
<inbox preview line, under 100 chars, complements subject>
=== HTML ===
<full <!DOCTYPE html>...</html> document>

Brand profile (use EXACTLY these values):
- Primary color: ${profile.primary_color}
- Accent/dark color: ${profile.accent_color || profile.primary_color}
- Body text color: ${profile.text_color}
- Card background: ${profile.bg_color}
- Page background: ${profile.page_bg_color}
- Font stack: ${profile.font_family}
${webFontName ? `- Include this Google Font link in <head>: ${googleFontLink}` : ""}
${profile.logo_url ? `- Logo URL (MANDATORY embed at top): ${profile.logo_url} (width ${profile.logo_width}px)` : ""}
${profile.footer_text ? `- Footer line: ${profile.footer_text}` : ""}

HTML rules:
- Mobile-responsive using table layout (NOT divs).
- All CSS inline on elements (no <style> blocks beyond a single media query AND the optional Google Fonts <link>).
- One outer 100% container, one inner 600px max-width container centered with align="center".
${profile.logo_url ? `- MANDATORY: every email starts with this header block (do NOT substitute, do NOT add tagline under it):

<table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
  <tr><td align="center" style="padding: 28px 24px 20px 24px;">
    <img src="${profile.logo_url}" alt="${profile.name}" width="${profile.logo_width}" height="auto" style="display: block; margin: 0 auto; max-width: ${profile.logo_width}px;" />
  </td></tr>
</table>
` : ""}- Buttons: real padded <a> with display:inline-block, padding 14px 24px, background=${profile.primary_color}, color=#FFFFFF, text-decoration:none, border-radius:10px, font-weight:600.
- Preheader: first invisible element (display:none, color:transparent).
- Footer: small grey text with "${profile.footer_text || profile.name}" and an unsubscribe link as ${profile.unsubscribe_text}.
${isMinimal
  ? "- MINIMAL mode: NO body images, NO decorative graphics, NO gradient backgrounds, NO charts. Just clean text in the brand's font with the primary color used sparingly for the CTA and one accent header underline. Keep it simple and high-contrast."
  : `- For body images, prefer text. Do NOT insert placeholder.com URLs.
- CHARTS/GRAPHS: when the user requests a visualization, generate it as a quickchart.io URL — fully renderable image, no JS, works in every email client. Format:
    <img src="https://quickchart.io/chart?w=600&h=300&bkg=white&c={...chart config as URL-encoded JSON...}" width="600" height="300" alt="..." style="display:block; max-width:100%; height:auto;" />
  Use Chart.js v3 syntax. Style with the brand's primary color (${profile.primary_color}) for bars/lines. Always include alt text. If real data isn't available, write a plain text summary instead of fabricated numbers.
- DIVIDERS / accent blocks: feel free to use 1px <hr> in #E5E7EB, or padded sections with background tinted from the page bg color, to break up content visually.`}
- NEVER include script tags, form tags, or iframes.
- Keep total HTML under 80KB.

Voice: ${voice}`;
}

// ─── Endpoints ─────────────────────────────────────────────────────

function sseSend(res: any, event: object) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

interface ComposeChatBody {
  profileId?: string;
  style?: EmailStyle;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model?: "fast" | "smart";
}

export function registerEmailComposeRoutes(app: Express) {
  // ─── Brand profiles CRUD ─────────────────────────────────────────

  app.get("/api/ops/email/brand-profiles", async (_req, res) => {
    try {
      const profiles = await listProfiles();
      res.json({ profiles });
    } catch (e: any) {
      res.status(500).json({ error: e.message, profiles: [] });
    }
  });

  app.post("/api/ops/email/brand-profiles", async (req: AdminReq, res) => {
    try {
      await ensureProfilesTable();
      const b = req.body || {};
      if (!b.name || typeof b.name !== "string") {
        return res.status(400).json({ error: "name required" });
      }
      const id = randomUUID();
      const result = await pool.query(
        `INSERT INTO ops_email_brand_profiles
         (id, name, is_default, primary_color, accent_color, text_color, bg_color, page_bg_color,
          font_family, logo_url, logo_width, footer_text, unsubscribe_text, brand_voice, created_by)
         VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          id,
          b.name,
          b.primary_color || "#2E5BFF",
          b.accent_color || null,
          b.text_color || "#0A1628",
          b.bg_color || "#FFFFFF",
          b.page_bg_color || "#F2F6FC",
          b.font_family || '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
          b.logo_url || null,
          b.logo_width || 160,
          b.footer_text || null,
          b.unsubscribe_text || "{% unsubscribe %}",
          b.brand_voice || null,
          req.adminEmail || "unknown",
        ],
      );
      res.json({ profile: result.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/email/brand-profiles/:id", async (req: AdminReq, res) => {
    try {
      await ensureProfilesTable();
      const b = req.body || {};
      // Build update SET clause from supplied fields only
      const allowed = [
        "name", "primary_color", "accent_color", "text_color", "bg_color", "page_bg_color",
        "font_family", "logo_url", "logo_width", "footer_text", "unsubscribe_text", "brand_voice",
      ];
      const sets: string[] = [];
      const params: any[] = [];
      for (const k of allowed) {
        if (b[k] !== undefined) {
          params.push(b[k]);
          sets.push(`${k} = $${params.length}`);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
      sets.push(`updated_at = NOW()`);
      params.push(req.params.id);
      const r = await pool.query(
        `UPDATE ops_email_brand_profiles SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
      res.json({ profile: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/ops/email/brand-profiles/:id", async (_req, res) => {
    try {
      await ensureProfilesTable();
      const r = await pool.query(
        `DELETE FROM ops_email_brand_profiles WHERE id = $1 AND is_default = false RETURNING id`,
        [_req.params.id],
      );
      if (r.rows.length === 0) {
        return res.status(400).json({ error: "Profile not found or is the default profile (can't delete)" });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Conversational compose (SSE) ────────────────────────────────

  app.post("/api/ops/email/compose/chat", async (req: AdminReq, res) => {
    if (!isAIConfigured()) {
      return res.status(503).json({ error: "AI not configured" });
    }
    const body = req.body as ComposeChatBody;
    if (!body?.messages?.length) {
      return res.status(400).json({ error: "messages required" });
    }
    const style: EmailStyle = (body.style as EmailStyle) || "branded-html";
    if (!["branded-html", "minimal-html", "plain-text"].includes(style)) {
      return res.status(400).json({ error: "invalid style" });
    }

    let profile: BrandProfile;
    try {
      profile = body.profileId
        ? (await getProfile(body.profileId)) || (await getDefaultProfile())
        : await getDefaultProfile();
    } catch (e: any) {
      return res.status(500).json({ error: `Could not load brand profile: ${e.message}` });
    }

    const modelId = body.model === "fast" ? BEDROCK_MODELS.FAST : BEDROCK_MODELS.HIGH_IQ;
    const userEmail = req.adminEmail || "unknown";
    const systemPrompt = buildSystemPrompt(profile, style);

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    sseSend(res, { type: "profile", id: profile.id, name: profile.name, style });

    let totalIn = 0, totalOut = 0;
    try {
      const stream = await (anthropic as any).messages.stream({
        model: modelId,
        max_tokens: 8192,
        system: systemPrompt,
        messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      for await (const event of stream as any) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          sseSend(res, { type: "text_delta", text: event.delta.text });
        }
      }
      const final: any = await stream.finalMessage();
      totalIn = final.usage?.input_tokens || 0;
      totalOut = final.usage?.output_tokens || 0;
      sseSend(res, { type: "usage", inputTokens: totalIn, outputTokens: totalOut });
      sseSend(res, { type: "done" });
      res.end();
      logAiCost({
        userId: null,
        surface: "ops_email_compose",
        model: modelId,
        inputTokens: totalIn,
        outputTokens: totalOut,
        metadata: { admin: userEmail, style, profile: profile.name },
      }).catch(() => {});
    } catch (e: any) {
      console.error("[OPS][EMAIL COMPOSE]", e);
      try { sseSend(res, { type: "error", message: e.message }); } catch {}
      try { res.end(); } catch {}
    }
  });

  // ─── Save final email to Klaviyo ─────────────────────────────────

  app.post("/api/ops/email/compose/save", async (req: AdminReq, res) => {
    const { name, html, subject, preheader, text } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name required" });
    }
    const isPlainText = !html && typeof text === "string" && text.length > 0;
    if (!isPlainText && (!html || typeof html !== "string" || html.length < 100)) {
      return res.status(400).json({ error: "html (≥100 chars) or text required" });
    }

    const key = process.env.KLAVIYO_API_KEY;
    if (!key || !key.startsWith("pk_")) {
      return res.status(503).json({ error: "KLAVIYO_API_KEY not configured" });
    }

    try {
      const attributes: any = {
        name,
        editor_type: "CODE",
        text: text || `${subject || name}\n\n${preheader || ""}\n\nView this email in your inbox.`,
      };
      if (!isPlainText) attributes.html = html;
      else attributes.html = `<!DOCTYPE html><html><body><pre style="font-family: inherit; white-space: pre-wrap;">${text.replace(/</g, "&lt;")}</pre></body></html>`;

      const klaviyoRes = await fetch(`${KLAVIYO_BASE}/templates/`, {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${key}`,
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          revision: KLAVIYO_REVISION,
        },
        body: JSON.stringify({
          data: { type: "template", attributes },
        }),
      });

      const body = await klaviyoRes.json().catch(() => ({}));
      if (!klaviyoRes.ok) {
        const isScopeIssue =
          klaviyoRes.status === 403 ||
          JSON.stringify(body).toLowerCase().includes("scope");
        const friendly = isScopeIssue
          ? "Klaviyo rejected the save — your API key is missing the `Templates:Write` scope. Klaviyo → Settings → API Keys → edit this key → enable Templates:Write. Then save again."
          : `Klaviyo ${klaviyoRes.status}: ${(body as any)?.errors?.[0]?.detail || JSON.stringify(body).slice(0, 200)}`;
        return res.status(klaviyoRes.status).json({ error: friendly, detail: body });
      }

      const templateId = (body as any)?.data?.id;
      res.json({
        ok: true,
        templateId,
        klaviyoUrl: templateId ? `https://www.klaviyo.com/template/${templateId}` : null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
