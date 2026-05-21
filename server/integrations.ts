/**
 * Self-serve integration credential management. Lets an admin update
 * service tokens + test connections directly from the /integrations
 * page without shelling into AWS Console.
 *
 * Endpoints:
 *   PATCH /api/ops/integrations/:name     — update creds (writes Secrets Manager + reloads process.env)
 *   POST  /api/ops/integrations/:name/test — live test against the service
 *
 * Phase 1: klaviyo, slack, meta-ads, clomark.
 * Stripe deferred — too dangerous to swap a live key from a chat UI
 * without a stronger confirmation flow.
 */
import type { Express, Request } from "express";
import { writeSecretFields, isSecretsManagerConfigured } from "./lib/secretsManager";
import { logAdminAction } from "./lib/auditLog";

interface AdminReq extends Request {
  adminEmail?: string;
}

interface IntegrationSpec {
  name: string;
  // env var name → label for the form
  fields: Array<{ envKey: string; label: string; placeholder?: string; secret?: boolean }>;
  // run a connection test, return ok or an error message
  test: () => Promise<{ ok: boolean; detail?: string; error?: string }>;
}

// ─── Per-integration specs ─────────────────────────────────────────

const KLAVIYO: IntegrationSpec = {
  name: "klaviyo",
  fields: [
    {
      envKey: "KLAVIYO_API_KEY",
      label: "Private API Key",
      placeholder: "pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      secret: true,
    },
  ],
  test: async () => {
    const key = process.env.KLAVIYO_API_KEY;
    if (!key) return { ok: false, error: "KLAVIYO_API_KEY not set" };
    try {
      const r = await fetch("https://a.klaviyo.com/api/accounts/", {
        headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: "2025-04-15", accept: "application/json" },
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        return { ok: false, error: j?.errors?.[0]?.detail || `Klaviyo ${r.status}` };
      }
      const account = j?.data?.[0]?.attributes;
      const sender = account?.contact_information?.default_sender_email;
      const name = account?.contact_information?.default_sender_name;
      return { ok: true, detail: name ? `${name} · ${sender}` : "Connected" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

const SLACK: IntegrationSpec = {
  name: "slack",
  fields: [
    {
      envKey: "SLACK_OPS_WEBHOOK_URL",
      label: "Incoming Webhook URL",
      placeholder: "https://hooks.slack.com/services/T.../B.../...",
      secret: true,
    },
  ],
  test: async () => {
    const url = process.env.SLACK_OPS_WEBHOOK_URL;
    if (!url) return { ok: false, error: "SLACK_OPS_WEBHOOK_URL not set" };
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "DIRT integration test — webhook reachable. Posted from /integrations.",
        }),
      });
      if (!r.ok) return { ok: false, error: `Slack ${r.status}: ${await r.text()}` };
      return { ok: true, detail: "Webhook is reachable; test message posted" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

const META_ADS: IntegrationSpec = {
  name: "meta-ads",
  fields: [
    {
      envKey: "META_SYSTEM_USER_TOKEN",
      label: "System User Access Token",
      placeholder: "EAA...",
      secret: true,
    },
    {
      envKey: "META_AD_ACCOUNT_ID",
      label: "Ad Account ID",
      placeholder: "1234567890 (numeric, no act_ prefix)",
      secret: false,
    },
  ],
  test: async () => {
    const token = process.env.META_SYSTEM_USER_TOKEN;
    const acct = process.env.META_AD_ACCOUNT_ID;
    if (!token || !acct) return { ok: false, error: "Token or ad account ID missing" };
    const apiVersion = process.env.META_API_VERSION || "v21.0";
    try {
      const r = await fetch(
        `https://graph.facebook.com/${apiVersion}/act_${acct}?fields=id,name,currency&access_token=${token}`,
      );
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        return { ok: false, error: j?.error?.message || `Meta ${r.status}` };
      }
      return { ok: true, detail: `${j.name} · ${j.currency} · act_${acct}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

const CLOMARK: IntegrationSpec = {
  name: "clomark",
  fields: [
    {
      envKey: "CLOMARK_BASE_URL",
      label: "Base URL",
      placeholder: "https://www.clomark.ai",
      secret: false,
    },
    {
      envKey: "CLOMARK_OPS_TOKEN",
      label: "Ops API Token",
      placeholder: "Bearer token from Clomark Deployment secrets",
      secret: true,
    },
    {
      envKey: "CLOMARK_BUSINESS_ID",
      label: "Business ID",
      placeholder: "Business profile UUID in Clomark",
      secret: false,
    },
  ],
  test: async () => {
    const base = process.env.CLOMARK_BASE_URL;
    const token = process.env.CLOMARK_OPS_TOKEN;
    const businessId = process.env.CLOMARK_BUSINESS_ID;
    if (!base || !token || !businessId) return { ok: false, error: "One or more Clomark env vars missing" };
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/api/ops/business/${businessId}/overview`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { ok: false, error: `Clomark ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j: any = await r.json().catch(() => ({}));
      const name = j?.business?.name || "Connected";
      return { ok: true, detail: `${name} · ${businessId.slice(0, 8)}…` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

const SPECS: Record<string, IntegrationSpec> = {
  klaviyo: KLAVIYO,
  slack: SLACK,
  "meta-ads": META_ADS,
  clomark: CLOMARK,
};

// ─── Routes ────────────────────────────────────────────────────────

export function registerIntegrationsRoutes(app: Express) {
  // List the spec (fields + current "is value set" status) for one integration
  app.get("/api/ops/integrations/:name/spec", (req, res) => {
    const spec = SPECS[req.params.name];
    if (!spec) return res.status(404).json({ error: "Unknown integration" });
    res.json({
      name: spec.name,
      fields: spec.fields.map((f) => ({
        envKey: f.envKey,
        label: f.label,
        placeholder: f.placeholder || null,
        secret: !!f.secret,
        // Don't return the actual secret. Just a last-4 hint so the operator knows what's currently set.
        currentTail: process.env[f.envKey]
          ? `…${(process.env[f.envKey] as string).slice(-4)}`
          : null,
      })),
      managedBy: isSecretsManagerConfigured() ? "secrets-manager" : "env-only",
    });
  });

  // Update one or more fields. Body shape: { fields: { ENV_KEY: "new-value", ... } }
  app.patch("/api/ops/integrations/:name", async (req: AdminReq, res) => {
    const spec = SPECS[req.params.name];
    if (!spec) return res.status(404).json({ error: "Unknown integration" });
    if (!isSecretsManagerConfigured()) {
      return res.status(503).json({ error: "AWS Secrets Manager not configured on this server" });
    }
    const body = req.body as { fields?: Record<string, string> };
    if (!body?.fields || typeof body.fields !== "object") {
      return res.status(400).json({ error: "fields object required" });
    }
    // Filter incoming to only known fields for this integration. No surprise writes.
    const allowed = new Set(spec.fields.map((f) => f.envKey));
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.fields)) {
      if (!allowed.has(k)) continue;
      if (typeof v !== "string") continue;
      if (v.trim().length === 0) continue;
      updates[k] = v.trim();
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    try {
      await writeSecretFields(updates);
      await logAdminAction({
        adminEmail: req.adminEmail || "unknown",
        actionType: "integration.update",
        targetKind: "integration",
        targetId: spec.name,
        status: "ok",
        metadata: { keys: Object.keys(updates), via: "integrations-ui" },
      });
      res.json({
        ok: true,
        updated: Object.keys(updates),
        note: "Credentials updated. Running container is using new values immediately.",
      });
    } catch (e: any) {
      await logAdminAction({
        adminEmail: req.adminEmail || "unknown",
        actionType: "integration.update",
        targetKind: "integration",
        targetId: spec.name,
        status: "failed",
        error: e.message,
        metadata: { keys: Object.keys(updates), via: "integrations-ui" },
      });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Live test connection
  app.post("/api/ops/integrations/:name/test", async (req: AdminReq, res) => {
    const spec = SPECS[req.params.name];
    if (!spec) return res.status(404).json({ error: "Unknown integration" });
    try {
      const result = await spec.test();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
