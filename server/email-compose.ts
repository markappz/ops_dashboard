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
 *   html       → clean responsive branded HTML (default, lightweight scaffold)
 *   branded    → editorial-magazine layout — hero image, nav strip, serif headlines
 *   plain-text → actual text/plain output (no HTML at all)
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

// In-memory Unsplash photo URL cache for branded-editorial composer.
// Key = query string ("biomarker,laboratory"), value = resolved CDN URL.
// 7-day TTL; resets on process restart. Avoids hammering Unsplash for
// repeated compositions of the same email.
const unsplashCache = new Map<string, { url: string; at: number }>();
const UNSPLASH_TTL_MS = 1000 * 60 * 60 * 24 * 7;

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

type EmailStyle = "html" | "branded" | "plain-text";

function buildSystemPrompt(profile: BrandProfile, style: EmailStyle): string {
  const voice = profile.brand_voice || "Direct, warm, science-grounded. No marketing-speak.";

  if (style === "plain-text") {
    return `You are composing PLAIN TEXT emails for ${profile.name} — no HTML, no styling.

Output FORMAT — exactly this, no preamble, blocks in this order:

=== SUBJECT ===
<short subject line, under 60 chars>
=== PREHEADER ===
<inbox preview line, under 100 chars>
=== CHANGES ===
<2-5 short bullets describing what changed vs the previous draft. For the FIRST draft: "Initial draft.". For refinements lead each bullet with a verb (Cut / Added / Rewrote / Shortened / Replaced / Tightened).>
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

  // Detect if the font stack starts with a web font (quoted name) so we
  // can pull it from Google Fonts in the head. Apple Mail / iOS Mail
  // render Google Fonts; Gmail/Outlook fall back to the next item in
  // the stack (so the system fonts stay as fallback).
  const fontMatch = profile.font_family.match(/^"([^"]+)"/);
  const webFontName = fontMatch ? fontMatch[1] : null;
  const googleFontLink = webFontName
    ? `<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(webFontName)}:wght@400;500;600;700&display=swap" rel="stylesheet" />`
    : "";
  // CSS font-family lists frequently contain inner double quotes ("Inter",
  // "Segoe UI") which collide with the outer style="..." attribute quotes
  // and silently truncate everything after the family name. Swap inner
  // double quotes for single quotes when interpolating into a style attribute.
  const fontFamilyAttr = profile.font_family.replace(/"/g, "'");

  if (style === "branded") return buildBrandedEditorialPrompt(profile, voice, webFontName, googleFontLink, fontFamilyAttr);

  return `You are a senior email designer + copywriter composing clean, branded HTML emails for ${profile.name}.

You write like a sharp founder, not a marketing intern. Every word earns its place. The output should feel like Ro / Hims / Superhuman — confident, specific, restrained, premium.

Output FORMAT — EVERY response, EVERY turn, must contain ALL FOUR blocks below in this exact order. Never omit CHANGES, even on refinement turns. No preamble, no commentary outside the blocks:

=== SUBJECT ===
<short subject line, under 50 chars, no emojis, no "we miss you" / "come back" cliches>
=== PREHEADER ===
<inbox preview line, under 90 chars, must add new info — don't restate the subject>
=== CHANGES ===
<MANDATORY block. For the FIRST draft in a thread, write exactly: "Initial draft.". For EVERY subsequent draft (refinement), write 2-5 bullets, each beginning with a dash and a past-tense verb (Cut / Added / Rewrote / Shortened / Replaced / Tightened / Removed). Be specific — name the section. Example for a refinement:
- Cut the 3-stat block; replaced with a single hero number.
- Rewrote subject for more contrast.
- Shortened body from 240 → 160 words.
- Removed PDF lab section per request.>
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
${profile.logo_url ? `- Logo URL (MANDATORY embed at top): ${profile.logo_url} (width ${profile.logo_width}px) — this is a WHITE-ON-TRANSPARENT logo, so it MUST sit on a dark background (see header rule below)` : ""}
${profile.footer_text ? `- Footer line: ${profile.footer_text}` : ""}

HTML SCAFFOLD — copy this scaffold EXACTLY, then fill the {{slots}}. Do NOT change the outer chrome (colors, paddings, table structure). Only edit content inside the slots.

\`\`\`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${webFontName ? googleFontLink : ""}
<title>{{TITLE — same as subject}}</title>
<style>
  @media only screen and (max-width: 600px) {
    .px { padding-left: 24px !important; padding-right: 24px !important; }
    .py { padding-top: 32px !important; padding-bottom: 32px !important; }
    .hero-h1 { font-size: 24px !important; line-height: 30px !important; }
    .body-text { font-size: 15px !important; line-height: 24px !important; }
    .cta { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${profile.page_bg_color};font-family:${fontFamilyAttr};color:${profile.text_color};">
<div style="display:none;max-height:0;overflow:hidden;color:transparent;">{{PREHEADER}}</div>
<table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${profile.page_bg_color};">
  <tr><td align="center" style="padding:0;background-color:${profile.page_bg_color};">

    <!-- Logo band (the ONLY dark surface; do not extend this color) -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${profile.accent_color || '#0A1628'};">
      <tr><td align="center" style="padding:32px 24px;background-color:${profile.accent_color || '#0A1628'};">
        <img src="${profile.logo_url}" alt="${profile.name}" width="${profile.logo_width}" height="auto" style="display:block;margin:0 auto;max-width:${profile.logo_width}px;border:0;outline:none;" />
      </td></tr>
    </table>

    <!-- White card — width:100% with max-width:600px so it shrinks below 600px viewports instead of clipping -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;background-color:${profile.bg_color};margin:0 auto;">
      <tr><td class="px py" style="padding:48px 40px;">
        <h1 class="hero-h1" style="margin:0 0 16px 0;font-size:30px;line-height:36px;font-weight:700;color:${profile.text_color};letter-spacing:-0.02em;word-wrap:break-word;overflow-wrap:break-word;">{{HERO_H1 — max 8 words}}</h1>
        <p class="body-text" style="margin:0;font-size:16px;line-height:26px;color:${profile.text_color};word-wrap:break-word;overflow-wrap:break-word;">{{HERO_LEAD — one sharp sentence}}</p>
      </td></tr>

      {{BODY_SECTIONS — 1 to 3 sections max, each is a <tr><td class="px"> with padding 0 40px 32px 40px, body copy class="body-text" 15px/26px ${profile.text_color} with word-wrap:break-word;overflow-wrap:break-word;. Section headlines: h2 18px/24px font-weight 600 ${profile.text_color}, margin 0 0 12px 0, word-wrap:break-word;.}}

      <!-- CTA — .cta class makes it full-width below 600px so the button never clips -->
      <tr><td align="center" class="px" style="padding:8px 40px 48px 40px;">
        <a href="{{CTA_URL}}" class="cta" style="display:inline-block;padding:14px 28px;background-color:${profile.primary_color};color:#FFFFFF;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;font-family:${fontFamilyAttr};">{{CTA_LABEL — 2-4 words}}</a>
      </td></tr>
    </table>

    <!-- Footer — also width:100% max:600 for the same reason -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;margin:0 auto;">
      <tr><td align="center" class="px" style="padding:24px 40px 40px 40px;">
        <p style="margin:0 0 8px 0;font-size:12px;color:#9CA3AF;line-height:18px;">${profile.footer_text || profile.name}</p>
        <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:18px;"><a href="${profile.unsubscribe_text}" style="color:#9CA3AF;text-decoration:underline;">Unsubscribe</a></p>
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>
\`\`\`

SCAFFOLD RULES (no exceptions):
- The frame chrome colors are LOCKED. Do not introduce #000000 / #0a0a0a / #111 / #1a1a1a anywhere in the email. The only dark surface is the logo band (${profile.accent_color || '#0A1628'}).
- Body bg = ${profile.page_bg_color}. Card bg = ${profile.bg_color}. Both literal — do not substitute.
- ONE primary CTA. Secondary text-only link is allowed inside body copy.
- RESPONSIVE: PRESERVE the .px / .py / .hero-h1 / .body-text / .cta class names on the elements they appear in the scaffold. The <style> @media query targets those classes; removing them breaks mobile. When adding new body sections, give the cells class="px" and the body copy class="body-text".
- NEVER use width="600" on a table — use width="100%" with style="max-width:600px" so the card shrinks under 600px viewports.
- NEVER include script, form, or iframe tags.
- Keep total HTML under 80KB.
BODY CONTENT (inside the white card):
- ONE visual focal point per email. Either a quickchart (real data only), a single high-contrast stat block with a REAL number (not "New insights" placeholder text), or a navy/sky accent strip. Never three generic stat boxes in a row.
- CHARTS: only when the user provides real data or the email is inherently measurable. Format: <img src="https://quickchart.io/chart?w=600&h=300&bkg=white&c={URL-encoded Chart.js v3 JSON}" width="600" height="300" alt="..." style="display:block;max-width:100%;height:auto;" /> — primary color ${profile.primary_color} for bars/lines. NEVER fabricate numbers.
- DIVIDERS: 1px <hr style="border:0;border-top:1px solid #E5E7EB;margin:32px 0;"> between sections.
- Sectioning: 1-3 body sections inside the card. Whitespace > density.

PERSONALIZATION (Klaviyo tokens — use unless the user explicitly says no):
- Use {{ first_name|default:"there" }} for greeting (only when a greeting is needed — don't bolt one on if the email opens with a real sentence).
- Use {{ organization.name }} or other Klaviyo profile fields where it would feel personal (last_login, score, etc.). Don't invent token names — only use ones that actually exist in standard Klaviyo profiles: first_name, last_name, email, location.city, location.region, location.country.
- Custom properties (e.g. last lab date, score) appear as {{ person|lookup:'property_name' }} — only use if the user explicitly says the audience has that property set.

VOICE — ${profile.name}:
${voice}

ANTI-PATTERNS — never output any of these:
- "We miss you" / "Come back" / "We noticed you've been away" — passive, beggy, not the FitScript voice.
- Stat boxes labeled "New insights" / "Ready to go" / "Updates" with no real data — placeholder energy.
- Generic platitudes like "the science is clear" or "consistency matters" — show, don't preach.
- Hero copy that's longer than 15 words — get to the point.
- Multiple CTAs competing for attention — one button, one link, that's it.
- Em-dash openings ("So—") or "Hey there!" — cliched startup voice.

LENGTH BUDGET (branded mode):
- Total body copy under 180 words.
- Hero h1: 8 words max.
- Section headlines: 6 words max.
- Body paragraphs: 2-3 sentences each.
- Conclusion: drop the email at the CTA. Don't write "thank you" / "we appreciate you" closers.`;
}

// ─── Branded editorial system prompt ─────────────────────────────
//
// "Top notch" mode: editorial magazine style. Hero image (Unsplash source
// URL — no API key needed), optional nav strip, serif display headlines
// (Playfair Display Google Font), multiple image+text sections, more
// breathing room. Still outputs editable CODE-template HTML for Klaviyo
// (drag-drop isn't writable via the templates API — only CODE is).

function buildBrandedEditorialPrompt(
  profile: BrandProfile,
  voice: string,
  webFontName: string | null,
  googleFontLink: string,
  fontFamilyAttr: string,
): string {
  // Two Google Font links — body sans + display serif. Sans falls back to
  // the profile font_family stack; serif uses Playfair Display.
  const playfairLink = `<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;1,500&display=swap" rel="stylesheet" />`;
  const fontHead = `${googleFontLink}\n${playfairLink}`;
  void webFontName; // included via googleFontLink

  return `You are a senior editorial email designer composing PREMIUM magazine-style branded emails for ${profile.name}.

Reference standard: the editorial emails from brands like Apartamento, Cereal, Monocle, or a luxury travel magazine — full-bleed photography, serif display headlines, restrained color, generous whitespace.

You write like a senior editor + designer, not a marketing intern. Every word and every visual element earns its place.

Output FORMAT — EVERY response, EVERY turn, must contain ALL FOUR blocks below in this exact order. Never omit CHANGES, even on refinement turns. No preamble:

=== SUBJECT ===
<short subject line, under 50 chars, no emojis, no salesy cliches>
=== PREHEADER ===
<inbox preview line, under 90 chars, complementary new info — never restate the subject>
=== CHANGES ===
<MANDATORY block. For the FIRST draft: "Initial draft.". For refinements: 2-5 verb-led bullets (Cut / Added / Rewrote / Shortened / Replaced / Tightened / Removed). Be specific about the section.>
=== HTML ===
<full <!DOCTYPE html>...</html> document>

Brand profile (use EXACTLY these values):
- Primary color (CTA): ${profile.primary_color}
- Accent / dark surface: ${profile.accent_color || '#0A1628'}
- Body text: ${profile.text_color}
- Card bg: ${profile.bg_color}
- Page bg: ${profile.page_bg_color}
- Body font stack (use in style attributes — note single quotes around web fonts to avoid colliding with style="..." attribute quotes): ${fontFamilyAttr}
- Display font (use in style attributes): 'Playfair Display', Georgia, 'Times New Roman', serif  (serif, editorial)
- Google Fonts links (BOTH must appear in <head>):
${fontHead}
${profile.logo_url ? `- Logo: ${profile.logo_url} (width ${profile.logo_width}px) — white-on-transparent; ALWAYS sits on the navy band` : ""}
${profile.footer_text ? `- Footer line: ${profile.footer_text}` : ""}

HTML SCAFFOLD — copy this exactly, fill the {{slots}}. Do NOT change colors, do NOT change table widths, do NOT remove the responsive class names. Only edit content inside the slots.

\`\`\`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${googleFontLink}
${playfairLink}
<title>{{TITLE — same as subject}}</title>
<style>
  @media only screen and (max-width: 600px) {
    .px { padding-left: 24px !important; padding-right: 24px !important; }
    .py { padding-top: 28px !important; padding-bottom: 28px !important; }
    .hero-display { font-size: 30px !important; line-height: 36px !important; }
    .section-h2 { font-size: 22px !important; line-height: 28px !important; }
    .body-text { font-size: 15px !important; line-height: 25px !important; }
    .nav-strip { font-size: 11px !important; letter-spacing: 1.5px !important; }
    .cta { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
    .hero-img { height: auto !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${profile.page_bg_color};font-family:${fontFamilyAttr};color:${profile.text_color};">
<div style="display:none;max-height:0;overflow:hidden;color:transparent;">{{PREHEADER}}</div>
<table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${profile.page_bg_color};">
  <tr><td align="center" style="padding:0;background-color:${profile.page_bg_color};">

    <!-- Logo band + nav strip — the dark editorial header -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${profile.accent_color || '#0A1628'};">
      <tr><td align="center" class="px" style="padding:36px 32px 16px 32px;background-color:${profile.accent_color || '#0A1628'};">
        <img src="${profile.logo_url}" alt="${profile.name}" width="${profile.logo_width}" height="auto" style="display:block;margin:0 auto;max-width:${profile.logo_width}px;border:0;outline:none;" />
      </td></tr>
      {{NAV_STRIP — OPTIONAL: 2-3 short SECTION labels (all caps, letter-spacing). Use ONLY when the email has 2+ distinct content sections that map to navigable areas. Render as a <tr><td align="center" class="nav-strip" style="padding:0 32px 32px 32px;background-color:[accent];font-family:[body font];font-size:13px;letter-spacing:2px;color:#FFFFFF;line-height:1.8;">SECTION ONE &nbsp;&nbsp;·&nbsp;&nbsp; SECTION TWO &nbsp;&nbsp;·&nbsp;&nbsp; SECTION THREE</td></tr>. If only 1 content section, OMIT this entirely.}}
    </table>

    <!-- Hero image — full-width inside the card -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;background-color:${profile.bg_color};margin:0 auto;">
      <tr><td style="padding:0;font-size:0;line-height:0;">
        <img src="UNSPLASH:{{HERO_IMAGE_KEYWORDS — 2-4 lowercase keywords describing the hero visual, comma-separated. Examples: "biomarker,laboratory,blood", "morning,sunrise,fitness", "minimal,architecture,quiet", "autumn,forest,landscape". Pick keywords that match the email's tone — evocative not literal. NEVER write placeholder text here; always provide real keywords.}}" alt="{{HERO_IMAGE_ALT — short description}}" width="600" class="hero-img" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;" />
      </td></tr>

      <!-- Display headline — serif Playfair -->
      <tr><td class="px py" style="padding:48px 48px 24px 48px;">
        <h1 class="hero-display" style="margin:0 0 20px 0;font-family:'Playfair Display', Georgia, 'Times New Roman', serif;font-size:38px;line-height:44px;font-weight:700;color:${profile.text_color};letter-spacing:-0.01em;word-wrap:break-word;overflow-wrap:break-word;">{{HERO_DISPLAY_H1 — max 10 words, editorial tone}}</h1>
        <p class="body-text" style="margin:0;font-size:16px;line-height:27px;color:${profile.text_color};word-wrap:break-word;overflow-wrap:break-word;">{{HERO_LEAD — 1-2 sharp sentences, the editorial standfirst}}</p>
      </td></tr>

      {{BODY_SECTIONS — 1 to 3 editorial sections. Each is a <tr><td class="px" style="padding:0 48px 32px 48px;"> containing:
        - <h2 class="section-h2" style="margin:0 0 14px 0;font-family:'Playfair Display',Georgia,serif;font-size:26px;line-height:32px;font-weight:700;color:${profile.text_color};word-wrap:break-word;">Section title</h2>
        - <p class="body-text" style="margin:0 0 14px 0;font-size:16px;line-height:27px;color:${profile.text_color};word-wrap:break-word;overflow-wrap:break-word;">Body copy paragraph</p>
        Optionally include a secondary image between sections: <tr><td style="padding:8px 0 32px 0;font-size:0;line-height:0;"><img src="UNSPLASH:keywords" alt="..." width="600" class="hero-img" style="display:block;width:100%;max-width:600px;height:auto;" /></td></tr>
        Optionally include a <hr style="border:0;border-top:1px solid #E5E7EB;margin:8px 0 32px 0;"> between sections.
      }}

      <!-- CTA — primary editorial button -->
      <tr><td align="center" class="px" style="padding:16px 48px 56px 48px;">
        <a href="{{CTA_URL}}" class="cta" style="display:inline-block;padding:16px 36px;background-color:${profile.primary_color};color:#FFFFFF;text-decoration:none;border-radius:4px;font-weight:600;font-size:14px;letter-spacing:1px;text-transform:uppercase;font-family:${fontFamilyAttr};">{{CTA_LABEL — 2-4 words, all caps in rendering}}</a>
      </td></tr>
    </table>

    <!-- Footer -->
    <table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;margin:0 auto;">
      <tr><td align="center" class="px" style="padding:32px 48px 48px 48px;">
        <p style="margin:0 0 10px 0;font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:14px;color:#6B7280;line-height:20px;">${profile.footer_text || profile.name}</p>
        <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:18px;font-family:${fontFamilyAttr};">
          <a href="${profile.unsubscribe_text}" style="color:#9CA3AF;text-decoration:underline;">Unsubscribe</a>
        </p>
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>
\`\`\`

EDITORIAL RULES:
- Display headlines use PLAYFAIR DISPLAY serif. Section h2s use Playfair Display too. Body copy uses the sans body stack. This is the magazine contrast.
- ALWAYS include the hero image. NEVER skip it. Pick keywords that evoke the email's mood (not literal). Use lowercase, comma-separated, 2-4 words.
- Image-text rhythm: hero image → display headline → standfirst lead → 1-3 sections (each can include its own image) → CTA → footer.
- Image URLs MUST use the exact pattern src="UNSPLASH:keyword1,keyword2" — the server resolves these to real Unsplash CDN URLs before render and save. NEVER write a real image URL (no http/https, no placeholder.com), NEVER use source.unsplash.com (deprecated).
- Buttons use UPPERCASE text with letter-spacing for the editorial feel. Slight border-radius (4px), not pill-shape.
- Whitespace > density. Section padding is 48px horizontal, 32-48px vertical.
- Colors are LOCKED: page bg ${profile.page_bg_color}, card bg ${profile.bg_color}, accent ${profile.accent_color || '#0A1628'}, body text ${profile.text_color}, CTA ${profile.primary_color}. NO #000000 / #0a0a0a / #111 / #1a1a1a anywhere except the logo band.
- RESPONSIVE: PRESERVE .px / .py / .hero-display / .section-h2 / .body-text / .nav-strip / .cta / .hero-img class names. The @media query targets them.
- NEVER use width="600" on a table — always width="100%" with style="max-width:600px".

PERSONALIZATION (Klaviyo tokens — use unless explicitly told not to):
- {{ first_name|default:"there" }} for greetings (only where genuinely warranted).
- Other Klaviyo standard fields: location.city, location.region, location.country.
- Custom person properties: {{ person|lookup:"property_name" }} — only when the audience has that property set.

VOICE — ${profile.name}:
${voice}

LENGTH BUDGET:
- Total body copy under 220 words (editorial gets a bit more room than html mode).
- Hero display h1: max 10 words.
- Section h2 headlines: max 7 words.
- Body paragraphs: 2-4 sentences each.
- Drop the email at the CTA. No "thanks for reading" / closer fluff.

ANTI-PATTERNS:
- "We miss you" / "Come back" / "We noticed" — passive beggy openers.
- Stat boxes with placeholder text ("New insights" / "Ready to go") — never.
- Generic platitudes ("the science is clear") — show, don't preach.
- Multiple competing CTAs — ONE primary button, ONE optional text link inline.
- Em-dash openings ("So—") or "Hey there!" — startup cliche voice.
- Skipping the hero image — the visual is the point of this mode.`;
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

  // ─── Image resolver — model emits `UNSPLASH:keywords` markers; client
  //     batches them here and we swap in real Unsplash CDN URLs before
  //     the preview iframe + save-to-Klaviyo see the HTML.
  //
  //     Recipients never hit our domain for images; the saved template
  //     points directly at Unsplash CDN. Cached in-memory for 7 days
  //     (per process; resets on restart).
  app.post("/api/ops/email/resolve-images", async (req: AdminReq, res) => {
    const queries: string[] = Array.isArray(req.body?.queries) ? req.body.queries : [];
    if (queries.length === 0) return res.json({ results: {} });
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return res.status(503).json({ error: "UNSPLASH_ACCESS_KEY not configured" });
    const unique = Array.from(new Set(queries.map((q) => String(q).trim()).filter(Boolean)));
    const results: Record<string, string> = {};
    await Promise.all(unique.map(async (q) => {
      const cached = unsplashCache.get(q);
      if (cached && Date.now() - cached.at < UNSPLASH_TTL_MS) {
        results[q] = cached.url;
        return;
      }
      try {
        const r = await fetch(
          `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=1&orientation=landscape&content_filter=high`,
          { headers: { Authorization: `Client-ID ${key}` } },
        );
        if (!r.ok) return;
        const j: any = await r.json();
        const photo = j?.results?.[0];
        // Use the regular-sized URL (1080w) — good balance of quality + weight for email.
        const url = photo?.urls?.regular || photo?.urls?.full;
        if (url) {
          unsplashCache.set(q, { url, at: Date.now() });
          results[q] = url;
        }
      } catch {
        // silently fail — caller falls back to a placeholder
      }
    }));
    res.json({ results });
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
    // Back-compat: legacy clients may still send the old style names.
    const rawStyle = body.style as string | undefined;
    const legacyMap: Record<string, EmailStyle> = {
      "branded-html": "html",
      "minimal-html": "html",
    };
    const style: EmailStyle = (legacyMap[rawStyle as string] ?? (rawStyle as EmailStyle)) || "html";
    if (!["html", "branded", "plain-text"].includes(style)) {
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
      // Klaviyo's app templates list — newly-saved template is at the top
      // (sorted by recent). Klaviyo doesn't expose a stable deep-link to a
      // single template editor that survives unauth probing, so we go to the
      // list which is reliable.
      res.json({
        ok: true,
        templateId,
        klaviyoUrl: "https://www.klaviyo.com/templates/list",
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
