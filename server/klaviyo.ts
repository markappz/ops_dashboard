/**
 * Klaviyo connector — read-only v1.
 *
 * Auth: KLAVIYO_API_KEY (private key, pk_*) in env. No OAuth — Klaviyo's
 * OAuth is for marketplace listings, not internal tools.
 *
 * Surfaces: account info, campaigns, flows, lists, segments. Campaign-level
 * metrics (opens/clicks/revenue) are intentionally deferred to v1.5 — they
 * require a separate POST /campaign-values-reports/ flow.
 *
 * All routes mount under /api/ops/klaviyo/* so they inherit the admin gate.
 */
import type { Express } from "express";

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
// Pin the revision so contract changes don't silently break us.
// Bump deliberately when we want new endpoint behaviors.
const KLAVIYO_REVISION = "2025-04-15";

interface KlaviyoErr extends Error {
  status?: number;
  body?: unknown;
}

function getKey(): string | null {
  const k = process.env.KLAVIYO_API_KEY;
  if (!k || !k.startsWith("pk_")) return null;
  return k;
}

async function klaviyoFetch<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const key = getKey();
  if (!key) {
    const err: KlaviyoErr = new Error("KLAVIYO_API_KEY not configured");
    err.status = 503;
    throw err;
  }

  const url = path.startsWith("http") ? path : `${KLAVIYO_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      revision: KLAVIYO_REVISION,
      ...(init.headers || {}),
    },
  });

  if (res.status === 429) {
    // Honor Retry-After once. The dashboard isn't latency-critical so a
    // single retry is fine; deeper backoff lives upstream if we ever need it.
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return klaviyoFetch<T>(path, init);
  }

  const text = await res.text();
  const body = text ? safeJson(text) : null;

  if (!res.ok) {
    const err: KlaviyoErr = new Error(
      `Klaviyo ${res.status}: ${typeof body === "object" ? JSON.stringify(body) : text}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerKlaviyoRoutes(app: Express) {
  // Connection status — used by Integrations page.
  app.get("/api/ops/klaviyo/status", async (_req, res) => {
    if (!getKey()) {
      return res.json({
        configured: false,
        connected: false,
      });
    }
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        "/accounts/?fields[account]=contact_information,industry,timezone,locale"
      );
      const account = data.data?.[0];
      const contact = account?.attributes?.contact_information;
      res.json({
        configured: true,
        connected: true,
        accountId: account?.id ?? null,
        organization: contact?.organization_name ?? null,
        defaultSenderEmail: contact?.default_sender_email ?? null,
        defaultSenderName: contact?.default_sender_name ?? null,
        timezone: account?.attributes?.timezone ?? null,
      });
    } catch (e: any) {
      res.json({
        configured: true,
        connected: false,
        error: e.message || "klaviyo request failed",
      });
    }
  });

  // Recent email campaigns. Klaviyo requires filtering campaigns by channel.
  app.get("/api/ops/klaviyo/campaigns", async (_req, res) => {
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        `/campaigns/?filter=${encodeURIComponent('equals(messages.channel,"email")')}` +
          `&sort=-send_time&page[size]=50`
      );
      const campaigns = (data.data || []).map((c) => ({
        id: c.id,
        name: c.attributes?.name ?? "(unnamed)",
        status: c.attributes?.status ?? null,
        archived: !!c.attributes?.archived,
        scheduledAt: c.attributes?.scheduled_at ?? null,
        sendTime: c.attributes?.send_time ?? null,
        createdAt: c.attributes?.created_at ?? null,
        updatedAt: c.attributes?.updated_at ?? null,
      }));
      res.json({ campaigns });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Live + draft flows (most recent first).
  app.get("/api/ops/klaviyo/flows", async (_req, res) => {
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        `/flows/?fields[flow]=name,status,trigger_type,created,updated` +
          `&sort=-updated&page[size]=100`
      );
      const flows = (data.data || []).map((f) => ({
        id: f.id,
        name: f.attributes?.name ?? "(unnamed)",
        status: f.attributes?.status ?? null,
        triggerType: f.attributes?.trigger_type ?? null,
        createdAt: f.attributes?.created ?? null,
        updatedAt: f.attributes?.updated ?? null,
      }));
      res.json({ flows });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Lists (manual audiences).
  app.get("/api/ops/klaviyo/lists", async (_req, res) => {
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        `/lists/?fields[list]=name,created,updated&page[size]=100`
      );
      const lists = (data.data || []).map((l) => ({
        id: l.id,
        name: l.attributes?.name ?? "(unnamed)",
        createdAt: l.attributes?.created ?? null,
        updatedAt: l.attributes?.updated ?? null,
      }));
      res.json({ lists });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Segments (dynamic audiences).
  app.get("/api/ops/klaviyo/segments", async (_req, res) => {
    try {
      const data = await klaviyoFetch<{ data: any[] }>(
        `/segments/?fields[segment]=name,is_active,created,updated&page[size]=100`
      );
      const segments = (data.data || []).map((s) => ({
        id: s.id,
        name: s.attributes?.name ?? "(unnamed)",
        isActive: !!s.attributes?.is_active,
        createdAt: s.attributes?.created ?? null,
        updatedAt: s.attributes?.updated ?? null,
      }));
      res.json({ segments });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
}

/**
 * Utility for other server modules that want to push events into Klaviyo.
 * Not exposed on the HTTP API — call directly from server-side autonomy
 * jobs (e.g. when a churn-risk threshold trips, push an event that a
 * Klaviyo flow can listen for).
 */
export async function trackKlaviyoEvent(opts: {
  email: string;
  metric: string;
  properties?: Record<string, unknown>;
  value?: number;
  time?: Date;
}): Promise<void> {
  const body = {
    data: {
      type: "event",
      attributes: {
        properties: opts.properties || {},
        metric: { data: { type: "metric", attributes: { name: opts.metric } } },
        profile: { data: { type: "profile", attributes: { email: opts.email } } },
        ...(opts.value !== undefined ? { value: opts.value } : {}),
        ...(opts.time ? { time: opts.time.toISOString() } : {}),
      },
    },
  };
  await klaviyoFetch("/events/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
