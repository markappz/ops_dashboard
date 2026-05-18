/**
 * AI Email Composer.
 *
 * POST /api/ops/email/compose            — SSE stream of Claude generating a full email
 * POST /api/ops/email/compose/save       — Save generated HTML as a Klaviyo template (editor_type=CODE)
 *
 * Output contract (Claude is instructed to emit exactly this):
 *
 *   === SUBJECT ===
 *   Your subject line here
 *   === PREHEADER ===
 *   Your inbox preview text here
 *   === HTML ===
 *   <!DOCTYPE html>
 *   ...mobile-responsive table-based HTML...
 *
 * Server streams the raw text; client parses the sections as they arrive
 * and renders the HTML portion into a srcdoc iframe live.
 *
 * Cost is logged to ai_costs with surface `ops_email_compose`.
 */
import type { Express, Request } from "express";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";

interface AdminReq extends Request {
  adminEmail?: string;
}

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-04-15";

const COMPOSER_SYSTEM_PROMPT = `You are an expert email designer composing HTML email campaigns for FitScript, a personalized health-optimization platform.

Output FORMAT — exactly this, no preamble, no commentary:

=== SUBJECT ===
<one short subject line, under 60 chars, no emojis>
=== PREHEADER ===
<one inbox-preview line, under 100 chars, complements subject>
=== HTML ===
<full <!DOCTYPE html>...</html> document>

HTML rules:
- Mobile-responsive using table layout (NOT divs — many email clients strip CSS grid/flex).
- All CSS inline on elements (no <style> blocks in <head> beyond a single media query for max-width).
- One outer 100% container, one inner 600px max-width container centered with align="center".
- System font stack: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif.
- Brand color: FitScript green #0EA57A for buttons and accent text. Background neutral (#F5F7FA outer, #FFFFFF inner). Dark text #1F2937.
- Use real, padded buttons: <a> with display:inline-block, padding, background, color, text-decoration:none, border-radius.
- Include preheader as the first invisible element (display:none, color:transparent) so it doesn't show in body.
- Footer: small grey text with "FitScript • [address placeholder]" and an unsubscribe link as {% unsubscribe %} (Klaviyo merge tag).
- NEVER use external images; if an image is critical, use an https://via.placeholder.com URL or describe with text.
- NEVER include script tags, form tags, or iframes — most clients block them.
- Keep total HTML under 80KB.

Tone: warm, direct, science-grounded. Match what a sharp health-optimization founder would write to their list. No marketing-speak fluff.`;

function buildUserPrompt(args: {
  goal: string;
  audience?: string;
  brandVoice?: string;
  references?: string;
  ctaUrl?: string;
}): string {
  const parts = [`CAMPAIGN GOAL:\n${args.goal}`];
  if (args.audience) parts.push(`\nAUDIENCE:\n${args.audience}`);
  if (args.brandVoice) parts.push(`\nBRAND VOICE NOTES:\n${args.brandVoice}`);
  if (args.references) parts.push(`\nREFERENCES / EXAMPLES:\n${args.references}`);
  if (args.ctaUrl) parts.push(`\nPRIMARY CTA URL:\n${args.ctaUrl}`);
  parts.push(`\nCompose the email now. Output exactly the format specified.`);
  return parts.join("\n");
}

export function registerEmailComposeRoutes(app: Express) {
  // SSE compose stream
  app.post("/api/ops/email/compose", async (req: AdminReq, res) => {
    if (!isAIConfigured()) {
      res.status(503).json({
        error: "AI not configured. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (Bedrock) or ANTHROPIC_API_KEY.",
      });
      return;
    }

    const { goal, audience, brandVoice, references, ctaUrl, model } = req.body ?? {};
    if (!goal || typeof goal !== "string" || goal.trim().length < 10) {
      res.status(400).json({ error: "goal is required (min 10 chars describing the campaign)" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const modelId = model === "fast" ? BEDROCK_MODELS.FAST : BEDROCK_MODELS.HIGH_IQ;
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let fullText = "";

    try {
      // Stream with extended thinking OFF — speed matters for live preview.
      // Cache the system prompt so iterating on the same brief is cheap.
      const stream = (anthropic as any).messages.stream({
        model: modelId,
        max_tokens: 8000,
        system: [
          {
            type: "text",
            text: COMPOSER_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [
          {
            role: "user",
            content: buildUserPrompt({ goal, audience, brandVoice, references, ctaUrl }),
          },
        ],
      });

      stream.on("text", (delta: string) => {
        fullText += delta;
        send("delta", { text: delta });
      });

      const final = await stream.finalMessage();
      const usage = final.usage || {};
      inputTokens = usage.input_tokens || 0;
      outputTokens = usage.output_tokens || 0;
      cacheReadTokens = (usage as any).cache_read_input_tokens || 0;
      cacheWriteTokens = (usage as any).cache_creation_input_tokens || 0;

      send("done", {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        latencyMs: Date.now() - started,
      });
      res.end();
    } catch (e: any) {
      console.error("[OPS EMAIL COMPOSE] stream error:", e?.message || e);
      send("error", { message: e?.message || "compose failed" });
      res.end();
    } finally {
      // Fire-and-forget cost log (never block the response).
      if (inputTokens > 0 || outputTokens > 0) {
        void logAiCost({
          surface: "ops_email_compose",
          model: modelId,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          latencyMs: Date.now() - started,
          metadata: {
            adminEmail: req.adminEmail,
            goalChars: goal.length,
          },
        });
      }
    }
  });

  // Save composed HTML as a Klaviyo template.
  app.post("/api/ops/email/compose/save", async (req: AdminReq, res) => {
    const { name, html, subject, preheader } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name required" });
      return;
    }
    if (!html || typeof html !== "string" || html.length < 100) {
      res.status(400).json({ error: "html required (min 100 chars)" });
      return;
    }

    const key = process.env.KLAVIYO_API_KEY;
    if (!key || !key.startsWith("pk_")) {
      res.status(503).json({ error: "KLAVIYO_API_KEY not configured" });
      return;
    }

    try {
      const klaviyoRes = await fetch(`${KLAVIYO_BASE}/templates/`, {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${key}`,
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          revision: KLAVIYO_REVISION,
        },
        body: JSON.stringify({
          data: {
            type: "template",
            attributes: {
              name,
              editor_type: "CODE",
              html,
              // Plaintext fallback. Klaviyo will auto-generate one if omitted,
              // but a stub from preheader/subject is friendlier.
              text: `${subject || name}\n\n${preheader || ""}\n\nView this email in your inbox.`,
            },
          },
        }),
      });

      const body = await klaviyoRes.json().catch(() => ({}));
      if (!klaviyoRes.ok) {
        return res.status(klaviyoRes.status).json({
          error: `Klaviyo ${klaviyoRes.status}`,
          detail: body,
        });
      }

      const templateId = body?.data?.id;
      console.log(
        `[OPS EMAIL COMPOSE] template saved by ${req.adminEmail} → klaviyo:${templateId}`,
      );

      res.json({
        templateId,
        name: body?.data?.attributes?.name ?? name,
        editorType: body?.data?.attributes?.editor_type ?? "CODE",
        createdAt: body?.data?.attributes?.created ?? null,
      });
    } catch (e: any) {
      console.error("[OPS EMAIL COMPOSE] save error:", e?.message || e);
      res.status(500).json({ error: e?.message || "save failed" });
    }
  });
}
