/**
 * Clomark connector — pulls marketing pipeline data (keywords, content,
 * SEO score, AI activities) from the Clomark platform's ops API.
 *
 * Auth model: bearer token (CLOMARK_OPS_TOKEN, shared with Clomark).
 *
 * Required env:
 *   CLOMARK_BASE_URL     — e.g. https://app.clomark.com or http://localhost:5000
 *   CLOMARK_OPS_TOKEN    — 32+ char random token, matches the one on Clomark
 *   CLOMARK_BUSINESS_ID  — FitScript's business_profile.id in Clomark's DB
 *                          (set after first call to /api/ops/clomark/discover)
 *
 * Endpoints exposed:
 *   GET /api/ops/clomark/status       — auth + connection check
 *   GET /api/ops/clomark/discover     — find the business by domain (one-time)
 *   GET /api/ops/clomark/overview     — combined snapshot for /content page
 *   GET /api/ops/clomark/keywords     — paginated keyword pipeline
 *   GET /api/ops/clomark/content      — content suggestions + generated content
 *   GET /api/ops/clomark/activities   — recent AI activity log
 */
import type { Express, Request } from "express";

interface ClomarkConfig {
  baseUrl: string;
  token: string;
  businessId: string | null;
  company: string;
}

/**
 * One Clomark business profile per brand. Profile ids aren't secrets — they're
 * row ids in Clomark's DB — so the defaults live here and an env var
 * (CLOMARK_BUSINESS_ID_<COMPANY>) overrides without a code change. FitScript
 * keeps honouring the original CLOMARK_BUSINESS_ID.
 *
 * Verified against Clomark's DB 2026-08-20. PeptideU is a placeholder profile
 * under the demo account until a real one is created.
 */
const COMPANY_BUSINESS: Record<string, string> = {
  fitscript: "533eac81-2538-4ae8-9cc2-b578587cbcad",
  pawgen: "71d86e68-79ef-4ed1-a5be-e77d1c58927d",
  realpeptides: "b68ed2a5-7e8d-4b4c-aae3-424f0f580099",
  peptideu: "c9843d66-dee6-44d0-bcac-5b7da113e69e",
};
export const CLOMARK_COMPANIES = Object.keys(COMPANY_BUSINESS);

function businessIdFor(company: string): string | null {
  const override = process.env[`CLOMARK_BUSINESS_ID_${company.toUpperCase()}`];
  if (override) return override;
  if (company === "fitscript" && process.env.CLOMARK_BUSINESS_ID) return process.env.CLOMARK_BUSINESS_ID;
  return COMPANY_BUSINESS[company] ?? null;
}

function companyOf(req: Request): string {
  const c = String(req.query.company || "fitscript").toLowerCase();
  return c in COMPANY_BUSINESS ? c : "fitscript";
}

function getConfig(company = "fitscript"): ClomarkConfig | null {
  const baseUrl = process.env.CLOMARK_BASE_URL;
  const token = process.env.CLOMARK_OPS_TOKEN;
  if (!baseUrl || !token) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    businessId: businessIdFor(company),
    company,
  };
}

interface ClomarkErr extends Error {
  status?: number;
  body?: unknown;
}

async function clomarkFetch<T = any>(
  path: string,
  cfg: ClomarkConfig,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE" | string; body?: string } = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${cfg.baseUrl}${path}`;
  const res = await fetch(url, {
    method: init.method || "GET",
    body: init.body,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    // Aggressive timeout — a slow Clomark shouldn't stall ops UI.
    signal: AbortSignal.timeout(8000),
  });

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const err: ClomarkErr = new Error(
      `Clomark ${res.status}: ${
        typeof body === "object" ? body?.error || JSON.stringify(body) : body
      }`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export function registerClomarkRoutes(app: Express) {
  // Connection check — does NOT require CLOMARK_BUSINESS_ID, just base + token.
  app.get("/api/ops/clomark/status", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg) {
      return res.json({
        configured: false,
        envHint:
          "Set CLOMARK_BASE_URL and CLOMARK_OPS_TOKEN in ops-dashboard .env, restart, then run /api/ops/clomark/discover to find your business ID.",
      });
    }
    try {
      const data = await clomarkFetch<{ ok: boolean; version: number }>(
        "/api/ops/status",
        cfg,
      );
      res.json({
        configured: true,
        connected: !!data?.ok,
        version: data?.version,
        businessIdConfigured: !!cfg.businessId,
        businessId: cfg.businessId,
        company: cfg.company,
        baseUrl: cfg.baseUrl,
      });
    } catch (e: any) {
      res.json({
        configured: true,
        connected: false,
        error: e.message,
      });
    }
  });

  // One-time discovery: find the business profile ID by domain.
  // Operator runs this once, copies the returned `id`, sets
  // CLOMARK_BUSINESS_ID, restarts. All subsequent calls use the env value.
  app.get("/api/ops/clomark/discover", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg) {
      return res.status(503).json({ error: "Clomark not configured" });
    }
    const domain = (req.query.domain as string) || "fitscript.me";
    try {
      const data = await clomarkFetch<{ business: any }>(
        `/api/ops/business/by-website?domain=${encodeURIComponent(domain)}`,
        cfg,
      );
      res.json({
        found: true,
        business: data.business,
        nextStep: `Set CLOMARK_BUSINESS_ID=${data.business.id} in ops-dashboard .env and restart.`,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({
        found: false,
        error: e.message,
        hint:
          "If 404, check the domain spelling — Clomark normalizes (strips www, lowercases) before matching.",
      });
    }
  });

  // Combined snapshot for the /content page header — fires all data in
  // parallel and returns a single payload to minimize round-trips.
  app.get("/api/ops/clomark/overview", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg || !cfg.businessId) {
      return res.status(503).json({
        error: "Clomark business ID not configured",
        envHint: cfg
          ? "Set CLOMARK_BUSINESS_ID — run /api/ops/clomark/discover to find it."
          : "Set CLOMARK_BASE_URL + CLOMARK_OPS_TOKEN first.",
      });
    }
    try {
      const [keywords, content, score, activities] = await Promise.all([
        clomarkFetch<{ totals: { all: number; byStatus: Record<string, number> } }>(
          `/api/ops/business/${cfg.businessId}/keywords?limit=1`,
          cfg,
        ),
        clomarkFetch<{
          totals: {
            suggestions: { all: number; byStatus: Record<string, number> };
            generated: { all: number; byStatus: Record<string, number> };
          };
        }>(`/api/ops/business/${cfg.businessId}/content?limit=1`, cfg),
        clomarkFetch<{ latest: any; trend: any[] }>(
          `/api/ops/business/${cfg.businessId}/seo-score`,
          cfg,
        ),
        clomarkFetch<{ activities: any[] }>(
          `/api/ops/business/${cfg.businessId}/activities?limit=10`,
          cfg,
        ),
      ]);
      res.json({
        keywords: keywords.totals,
        content: content.totals,
        seoScore: score.latest,
        seoScoreTrend: score.trend,
        recentActivities: activities.activities,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Detail lists — each forwards through to the Clomark API
  app.get("/api/ops/clomark/keywords", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const qs = new URLSearchParams();
      if (req.query.status) qs.set("status", String(req.query.status));
      if (req.query.limit) qs.set("limit", String(req.query.limit));
      const path = `/api/ops/business/${cfg.businessId}/keywords${qs.toString() ? `?${qs}` : ""}`;
      res.json(await clomarkFetch(path, cfg));
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/ops/clomark/content", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const qs = new URLSearchParams();
      if (req.query.status) qs.set("status", String(req.query.status));
      if (req.query.limit) qs.set("limit", String(req.query.limit));
      const path = `/api/ops/business/${cfg.businessId}/content${qs.toString() ? `?${qs}` : ""}`;
      res.json(await clomarkFetch(path, cfg));
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Write operations (Phase A) ────────────────────────────────────

  app.post("/api/ops/clomark/content-suggestions", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/content-suggestions`,
        cfg,
        { method: "POST", body: JSON.stringify(req.body || {}) },
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/ops/clomark/content-suggestions/bulk", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/content-suggestions/bulk`,
        cfg,
        { method: "POST", body: JSON.stringify(req.body || {}) },
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Location-page support
  app.get("/api/ops/clomark/location/options", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg) return res.status(503).json({ error: "Clomark not configured" });
    try {
      const body = await clomarkFetch(`/api/ops/location/options`, cfg);
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/ops/clomark/location/zip-lookup", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg) return res.status(503).json({ error: "Clomark not configured" });
    try {
      const qs = new URLSearchParams();
      if (req.query.city) qs.set("city", String(req.query.city));
      if (req.query.abbr) qs.set("abbr", String(req.query.abbr));
      if (req.query.state) qs.set("state", String(req.query.state));
      const body = await clomarkFetch(`/api/ops/location/zip-lookup?${qs}`, cfg);
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get("/api/ops/clomark/profile-items", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/profile-items`,
        cfg,
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post("/api/ops/clomark/location-page", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/location-page`,
        cfg,
        { method: "POST", body: JSON.stringify(req.body || {}) },
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Generated content view + approval (Phase C) ──────────────────

  app.get("/api/ops/clomark/generated/:contentId", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/generated/${req.params.contentId}`,
        cfg,
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.patch("/api/ops/clomark/generated/:contentId/approval", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/generated/${req.params.contentId}/approval`,
        cfg,
        { method: "PATCH", body: JSON.stringify(req.body || {}) },
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Bulk publish (Phase D) ────────────────────────────────────────

  app.get("/api/ops/clomark/publishing/platforms", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const body = await clomarkFetch(
        `/api/ops/business/${cfg.businessId}/publishing/platforms`,
        cfg,
      );
      res.json(body);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.post(
    "/api/ops/clomark/publishing/:platform/:contentId",
    async (req, res) => {
      const cfg = getConfig(companyOf(req));
      if (!cfg?.businessId) {
        return res.status(503).json({ error: "Clomark business ID not configured" });
      }
      try {
        const body = await clomarkFetch(
          `/api/ops/business/${cfg.businessId}/publishing/${req.params.platform}/${req.params.contentId}`,
          cfg,
          { method: "POST", body: JSON.stringify(req.body || {}) },
        );
        res.json(body);
      } catch (e: any) {
        res.status(e.status || 500).json({ error: e.message });
      }
    },
  );

  app.delete(
    "/api/ops/clomark/content-suggestions/:suggestionId",
    async (req, res) => {
      const cfg = getConfig(companyOf(req));
      if (!cfg?.businessId) {
        return res.status(503).json({ error: "Clomark business ID not configured" });
      }
      try {
        const body = await clomarkFetch(
          `/api/ops/business/${cfg.businessId}/content-suggestions/${req.params.suggestionId}`,
          cfg,
          { method: "DELETE" },
        );
        res.json(body);
      } catch (e: any) {
        res.status(e.status || 500).json({ error: e.message });
      }
    },
  );

  app.get("/api/ops/clomark/activities", async (req, res) => {
    const cfg = getConfig(companyOf(req));
    if (!cfg?.businessId) {
      return res.status(503).json({ error: "Clomark business ID not configured" });
    }
    try {
      const qs = new URLSearchParams();
      if (req.query.limit) qs.set("limit", String(req.query.limit));
      const path = `/api/ops/business/${cfg.businessId}/activities${qs.toString() ? `?${qs}` : ""}`;
      res.json(await clomarkFetch(path, cfg));
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
}
