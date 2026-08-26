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
import { listAdminsFromDb } from "./admin-auth";

interface AdminReq extends Request {
  adminEmail?: string;
}

function tail(value: string | undefined, n = 4): string {
  if (!value) return "";
  return value.length > n ? `…${value.slice(-n)}` : value;
}

export function registerSettingsRoutes(app: Express) {
  app.get("/api/ops/settings", async (req: AdminReq, res) => {
    // Pull admins from DB (DB is now the source of truth — env is just bootstrap seed).
    let adminEmails: string[] = [];
    try {
      const dbAdmins = await listAdminsFromDb();
      adminEmails = dbAdmins.map((a) => a.email);
    } catch {
      // Fallback to env if DB is unreachable.
      adminEmails = (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

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
        // Bedrock is the only path — see server/lib/bedrock.ts. Reading env vars
        // here reported "none" whenever credentials came from the task role.
        provider: "AWS Bedrock",
        region: process.env.AWS_REGION || "us-east-1",
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
      metaAds: {
        configured:
          !!process.env.META_SYSTEM_USER_TOKEN && !!process.env.META_AD_ACCOUNT_ID,
        adAccountId: process.env.META_AD_ACCOUNT_ID || null,
        tokenTail: tail(process.env.META_SYSTEM_USER_TOKEN),
        apiVersion: process.env.META_API_VERSION || "v21.0",
        label: "Meta (Facebook + Instagram) ad spend, performance, ROAS on Marketing",
      },
      clomark: {
        configured:
          !!process.env.CLOMARK_BASE_URL && !!process.env.CLOMARK_OPS_TOKEN,
        businessIdConfigured: !!process.env.CLOMARK_BUSINESS_ID,
        baseUrl: process.env.CLOMARK_BASE_URL || null,
        tokenTail: tail(process.env.CLOMARK_OPS_TOKEN),
        businessIdTail: tail(process.env.CLOMARK_BUSINESS_ID, 8),
        label:
          "Clomark content pipeline: keyword research, content drafts, SEO score, AI activity on /content",
      },
      slack: {
        configured: !!process.env.SLACK_OPS_WEBHOOK_URL,
        webhookTail: tail(process.env.SLACK_OPS_WEBHOOK_URL, 12),
        label:
          "Where DIRT posts proactive scan findings (15-min cadence). Set SLACK_OPS_WEBHOOK_URL to enable.",
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
