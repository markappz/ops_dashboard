/**
 * Meta Ads connector (Facebook + Instagram).
 *
 * Auth model: long-lived System User token (60-day TTL, renewable). Generated
 * in Meta Business Settings → System Users → assign to ad account → generate
 * token with `ads_read` scope. Simpler than OAuth for a single-tenant internal
 * dashboard.
 *
 * Required env:
 *   META_SYSTEM_USER_TOKEN — the long-lived bearer token
 *   META_AD_ACCOUNT_ID     — the ad account ID (numeric, without the "act_" prefix)
 *
 * Optional:
 *   META_API_VERSION       — defaults to v21.0 (current as of May 2026)
 *
 * Endpoints exposed:
 *   GET /api/ops/meta/status              — connection check
 *   GET /api/ops/meta/campaigns?days=30   — campaigns with insights aggregated
 */
import type { Express } from "express";

const META_GRAPH_BASE = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v21.0";

interface MetaErr extends Error {
  status?: number;
  body?: unknown;
}

export function getCreds(): { token: string; accountId: string; version: string } | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) return null;
  const version = process.env.META_API_VERSION || DEFAULT_API_VERSION;
  return { token, accountId, version };
}

export async function metaFetch<T = any>(path: string, token: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = path.startsWith("http") ? path : `${META_GRAPH_BASE}${path}`;
  const res = await fetch(`${url}${sep}access_token=${encodeURIComponent(token)}`);

  if (res.status === 429 || res.status === 613) {
    // Meta returns 613 for "calls have exceeded limit" — same family as 429.
    // We don't auto-retry here; let the caller decide based on response.
  }

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail =
      body?.error?.message || (typeof body === "string" ? body : JSON.stringify(body));
    const err: MetaErr = new Error(`Meta ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body as T;
}

export interface CampaignInsight {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;       // %
  cpc: number;       // $ per click
  cpm: number;       // $ per 1k impressions
  conversions: number;
  conversionValue: number;
  reach: number;
}

export function parseInsightsRow(row: any): CampaignInsight {
  const spend = parseFloat(row?.spend || "0");
  const impressions = parseInt(row?.impressions || "0");
  const clicks = parseInt(row?.clicks || "0");
  const ctr = parseFloat(row?.ctr || "0");
  const cpc = parseFloat(row?.cpc || "0");
  const cpm = parseFloat(row?.cpm || "0");
  const reach = parseInt(row?.reach || "0");

  // Conversions live inside the `actions` array — filter to purchase-like ones.
  // Meta exposes many action types; the canonical purchase/conversion buckets
  // are: purchase, omni_purchase, offsite_conversion.fb_pixel_purchase.
  const actions: any[] = row?.actions || [];
  let conversions = 0;
  for (const a of actions) {
    if (
      a.action_type === "purchase" ||
      a.action_type === "omni_purchase" ||
      a.action_type === "offsite_conversion.fb_pixel_purchase"
    ) {
      conversions += parseInt(a.value || "0");
    }
  }

  const values: any[] = row?.action_values || [];
  let conversionValue = 0;
  for (const a of values) {
    if (
      a.action_type === "purchase" ||
      a.action_type === "omni_purchase" ||
      a.action_type === "offsite_conversion.fb_pixel_purchase"
    ) {
      conversionValue += parseFloat(a.value || "0");
    }
  }

  return { spend, impressions, clicks, ctr, cpc, cpm, conversions, conversionValue, reach };
}

export function registerMetaAdsRoutes(app: Express) {
  // Connection status — also surfaces ad account name + currency once connected.
  app.get("/api/ops/meta/status", async (_req, res) => {
    const creds = getCreds();
    if (!creds) {
      return res.json({
        configured: false,
        connected: false,
        envHint:
          "Set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID. Generate the token in Meta Business Settings → System Users → assign to ad account → generate with `ads_read` scope.",
      });
    }

    try {
      const data = await metaFetch<{
        id: string;
        name: string;
        currency: string;
        account_status: number;
        timezone_name: string;
      }>(
        `/${creds.version}/act_${creds.accountId}?fields=id,name,currency,account_status,timezone_name`,
        creds.token,
      );
      res.json({
        configured: true,
        connected: true,
        accountId: data.id,
        accountName: data.name,
        currency: data.currency,
        timezone: data.timezone_name,
        status: data.account_status,
      });
    } catch (e: any) {
      res.json({
        configured: true,
        connected: false,
        error: e.message,
      });
    }
  });

  // Campaigns with insights over a date window.
  // One Meta call per campaign for insights would be N+1 — we use level=campaign
  // on the account's insights endpoint instead, which returns one row per
  // campaign in the window. Then we join with the campaign list for name/status/objective.
  app.get("/api/ops/meta/campaigns", async (req, res) => {
    const creds = getCreds();
    if (!creds) {
      return res.status(503).json({
        error: "Meta Ads not configured",
        envHint:
          "Set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID, then restart the dashboard.",
      });
    }

    const days = Math.min(Math.max(parseInt((req.query.days as string) || "30"), 1), 90);
    const datePreset =
      days <= 1
        ? "today"
        : days <= 7
          ? "last_7d"
          : days <= 14
            ? "last_14d"
            : days <= 30
              ? "last_30d"
              : days <= 90
                ? "last_90d"
                : "last_90d";

    try {
      // 1. Campaign metadata
      const campaignList = await metaFetch<{ data: any[] }>(
        `/${creds.version}/act_${creds.accountId}/campaigns?fields=id,name,status,objective,created_time,updated_time&limit=200`,
        creds.token,
      );
      const meta = new Map<string, any>();
      for (const c of campaignList.data || []) {
        meta.set(c.id, {
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective,
          createdAt: c.created_time,
          updatedAt: c.updated_time,
        });
      }

      // 2. Insights at campaign level for the window
      const insightsRes = await metaFetch<{ data: any[] }>(
        `/${creds.version}/act_${creds.accountId}/insights` +
          `?level=campaign&date_preset=${datePreset}` +
          `&fields=campaign_id,spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values` +
          `&limit=200`,
        creds.token,
      );

      const rows = (insightsRes.data || []).map((row) => {
        const m = meta.get(row.campaign_id) || {};
        const insight = parseInsightsRow(row);
        const roas = insight.spend > 0 ? insight.conversionValue / insight.spend : 0;
        const cpa = insight.conversions > 0 ? insight.spend / insight.conversions : 0;
        return {
          campaignId: row.campaign_id,
          name: m.name || `(missing campaign ${row.campaign_id})`,
          status: m.status || null,
          objective: m.objective || null,
          ...insight,
          roas,
          cpa,
        };
      });

      // Drop in any campaigns that exist but have no insights this window
      // (likely paused with zero spend) — useful to see the full inventory.
      for (const [id, m] of meta) {
        if (!rows.find((r) => r.campaignId === id)) {
          rows.push({
            campaignId: id,
            name: m.name,
            status: m.status,
            objective: m.objective,
            spend: 0,
            impressions: 0,
            clicks: 0,
            ctr: 0,
            cpc: 0,
            cpm: 0,
            conversions: 0,
            conversionValue: 0,
            reach: 0,
            roas: 0,
            cpa: 0,
          });
        }
      }

      // Sort: active first, then by spend desc
      rows.sort((a, b) => {
        if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
        if (b.status === "ACTIVE" && a.status !== "ACTIVE") return 1;
        return b.spend - a.spend;
      });

      // Totals
      const totals = rows.reduce(
        (acc, r) => {
          acc.spend += r.spend;
          acc.impressions += r.impressions;
          acc.clicks += r.clicks;
          acc.conversions += r.conversions;
          acc.conversionValue += r.conversionValue;
          return acc;
        },
        { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 },
      );

      res.json({
        timeframe: datePreset,
        accountId: creds.accountId,
        campaigns: rows,
        totals: {
          ...totals,
          ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
          cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
          cpa: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
          roas: totals.spend > 0 ? totals.conversionValue / totals.spend : 0,
        },
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
}
