/**
 * Read-only settings surface for the ops dashboard.
 *
 * Returns: admin allowlist, current session info, integration status,
 * and other env-derived metadata so an admin can self-diagnose without
 * shelling into the box.
 *
 * NEVER returns secret values. Only "configured / not configured" flags
 * and the LAST 4 chars of secrets where useful for confirming the right
 * key is loaded (e.g. distinguishing prod vs dev API keys).
 */
import type { Express, Request } from "express";
import { isAIConfigured } from "./lib/bedrock";

interface AdminReq extends Request {
  adminEmail?: string;
}

function tail(value: string | undefined, n = 4): string {
  if (!value) return "";
  return value.length > n ? `…${value.slice(-n)}` : value;
}

export function registerSettingsRoutes(app: Express) {
  app.get("/api/ops/settings", (req: AdminReq, res) => {
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const session = {
      email: req.adminEmail || null,
      // The 'ops_session' cookie is signed with a 7d TTL in admin-auth.ts.
      // We don't read the exp from here (the cookie is httpOnly); just note the TTL contract.
      ttlDays: 7,
    };

    const integrations = {
      database: {
        configured: !!process.env.DATABASE_URL,
        label: "RDS PostgreSQL (shared with FitScript main app)",
      },
      ai: {
        configured: isAIConfigured(),
        provider: process.env.AWS_ACCESS_KEY_ID
          ? "AWS Bedrock"
          : process.env.ANTHROPIC_API_KEY
            ? "Anthropic direct"
            : "none",
        region: process.env.AWS_REGION || null,
        label: "Used by /email/compose and any future AI surfaces in this repo",
      },
      stripe: {
        configured: !!process.env.STRIPE_SECRET_KEY,
        keyMode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
          ? "live"
          : process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
            ? "test"
            : "unknown",
        keyTail: tail(process.env.STRIPE_SECRET_KEY),
        label: "Read-only Stripe API for snapshot, member detail, refund/cancel actions",
      },
      klaviyo: {
        configured: !!process.env.KLAVIYO_API_KEY?.startsWith("pk_"),
        keyTail: tail(process.env.KLAVIYO_API_KEY),
        conversionMetricOverride: process.env.KLAVIYO_CONVERSION_METRIC_NAME || null,
        label: "Campaigns, flows, lists, sends, audit, AI compose → save template",
      },
      googleOAuth: {
        configured:
          !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
        clientIdTail: tail(process.env.GOOGLE_CLIENT_ID, 8),
        label: "Powers admin sign-in + GA4/Search Console data connectors",
      },
    };

    const auth = {
      sessionSecretConfigured: !!process.env.OPS_SESSION_SECRET,
      adminRedirectUri: process.env.OPS_ADMIN_REDIRECT_URI || null,
    };

    res.json({
      session,
      adminEmails,
      integrations,
      auth,
      env: {
        nodeEnv: process.env.NODE_ENV || "development",
        port: process.env.OPS_PORT || "5001",
      },
    });
  });
}
