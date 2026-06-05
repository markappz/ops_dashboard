import type { Express } from "express";
import { pool } from "./db";
import { getAuthenticatedClient, getConnection } from "./google-auth";
import { google } from "googleapis";
import { getCreds as getMetaCreds, metaFetch, parseInsightsRow } from "./meta-ads";

// FitScript-only v1: pulls Klaviyo for the EMAIL report.
// Other sections (traffic, conversion, sales) will land alongside this.

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-04-15";

type Days = 7 | 30 | 90 | 365;
const ALLOWED_DAYS: Days[] = [7, 30, 90, 365];

function timeframeKey(days: Days): string {
  return days === 7
    ? "last_7_days"
    : days === 30
      ? "last_30_days"
      : days === 90
        ? "last_90_days"
        : "last_365_days";
}

// ─── CSV helpers ─────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRows(rows: Array<Array<unknown>>): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

function csvHeaders(res: import("express").Response, filename: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

interface KlaviyoErr extends Error {
  status?: number;
}

function getKey(): string | null {
  const k = process.env.KLAVIYO_API_KEY;
  if (!k || !k.startsWith("pk_")) return null;
  return k;
}

async function kFetch<T = any>(path: string, init: RequestInit = {}, retries = 2): Promise<T> {
  const key = getKey();
  if (!key) {
    const err: KlaviyoErr = new Error("KLAVIYO_API_KEY not configured");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${KLAVIYO_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      revision: KLAVIYO_REVISION,
      ...(init.headers || {}),
    },
  });
  if (res.status === 429 && retries > 0) {
    const retryAfter = Math.min(parseInt(res.headers.get("Retry-After") || "2"), 10);
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return kFetch<T>(path, init, retries - 1);
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const err: KlaviyoErr = new Error(
      `Klaviyo ${res.status}: ${typeof body === "object" ? JSON.stringify(body) : text}`,
    );
    err.status = res.status;
    throw err;
  }
  return body as T;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface MetricRef {
  id: string;
  name: string;
}

async function findMetric(name: string): Promise<MetricRef | null> {
  try {
    const all = await getMetricsList();
    const wanted = name.toLowerCase();
    const m = all.find((x) => x.attributes?.name?.toLowerCase() === wanted);
    return m ? { id: m.id, name: m.attributes?.name || name } : null;
  } catch {
    return null;
  }
}

// Sum daily counts from metric-aggregates over the window.
async function sumMetric(metricId: string, days: Days): Promise<number | null> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const data = await kFetch<{
      data: { attributes?: { data?: Array<{ measurements?: { count?: number[] } }> } };
    }>("/metric-aggregates/", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "metric-aggregate",
          attributes: {
            metric_id: metricId,
            measurements: ["count"],
            interval: "day",
            timezone: "UTC",
            filter: [
              `greater-or-equal(datetime,${start.toISOString()})`,
              `less-than(datetime,${end.toISOString()})`,
            ],
          },
        },
      }),
    });
    const rows = data.data?.attributes?.data || [];
    let total = 0;
    for (const row of rows) {
      const arr = row.measurements?.count || [];
      for (const v of arr) total += Number(v) || 0;
    }
    return total;
  } catch (e) {
    console.warn(`[OPS][REPORTS] sumMetric(${metricId}) failed:`, (e as Error).message);
    return null;
  }
}

// RDS-backed subscriber counts. FitScript's source-of-truth for users.
// Klaviyo doesn't fire a "Subscribed to Email Marketing" event in this account,
// so RDS is more reliable than guessing at metric names.
interface RdsSubscriberStats {
  total: number;
  newInWindow: number;
}

async function rdsSubscribers(days: Days): Promise<RdsSubscriberStats | null> {
  try {
    const cutoff = new Date(Date.now() - days * 86400_000);
    const r = await pool.query<{ total: string; new_in_window: string }>(
      `SELECT
         (SELECT count(*) FROM users WHERE email IS NOT NULL AND email <> '')::text AS total,
         (SELECT count(*) FROM users WHERE email IS NOT NULL AND email <> '' AND created_at >= $1)::text AS new_in_window`,
      [cutoff],
    );
    const row = r.rows[0];
    return {
      total: parseInt(row.total) || 0,
      newInWindow: parseInt(row.new_in_window) || 0,
    };
  } catch (e) {
    console.warn("[OPS][REPORTS] rdsSubscribers failed:", (e as Error).message);
    return null;
  }
}

interface CampaignRow {
  id: string;
  attributes?: { name?: string; send_time?: string | null };
}

interface ValuesReportRow {
  groupings?: Record<string, string>;
  statistics?: Record<string, number>;
}

async function fetchSentCampaignIds(days: Days): Promise<string[]> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  // Klaviyo: send_time is NOT filterable. The filterable fields per their
  // 2025 API revision: archived, created_at, id, messages.channel, name,
  // scheduled_at, status, updated_at. We filter by updated_at as a proxy
  // for "campaigns active in the window" and use status=sent.
  const filter = `and(equals(messages.channel,"email"),greater-or-equal(updated_at,${cutoff}))`;
  try {
    const data = await kFetch<{ data: CampaignRow[] }>(
      `/campaigns/?filter=${encodeURIComponent(filter)}&fields[campaign]=name,send_time&sort=-updated_at&page[size]=100`,
    );
    return (data.data || []).map((c) => c.id);
  } catch (e) {
    console.warn("[OPS][REPORTS] fetchSentCampaignIds failed:", (e as Error).message);
    return [];
  }
}

const ENGAGEMENT_STATS = [
  "delivered",
  "opens_unique",
  "clicks_unique",
  "unsubscribes",
  "spam_complaints",
  "bounced",
  "recipients",
];

const VALUE_STATS = ["conversions", "conversion_value"];

interface AggregateTotals {
  delivered: number;
  opens_unique: number;
  clicks_unique: number;
  unsubscribes: number;
  spam_complaints: number;
  bounced: number;
  recipients: number;
  conversions: number;
  conversion_value: number;
  messagesCounted: number;
  revenueAvailable: boolean;
}

function emptyTotals(): AggregateTotals {
  return {
    delivered: 0,
    opens_unique: 0,
    clicks_unique: 0,
    unsubscribes: 0,
    spam_complaints: 0,
    bounced: 0,
    recipients: 0,
    conversions: 0,
    conversion_value: 0,
    messagesCounted: 0,
    revenueAvailable: false,
  };
}

function addRow(totals: AggregateTotals, stats: Record<string, number> | undefined) {
  if (!stats) return;
  totals.delivered += Number(stats.delivered) || 0;
  totals.opens_unique += Number(stats.opens_unique) || 0;
  totals.clicks_unique += Number(stats.clicks_unique) || 0;
  totals.unsubscribes += Number(stats.unsubscribes) || 0;
  totals.spam_complaints += Number(stats.spam_complaints) || 0;
  totals.bounced += Number(stats.bounced) || 0;
  totals.recipients += Number(stats.recipients) || 0;
  totals.conversions += Number(stats.conversions) || 0;
  totals.conversion_value += Number(stats.conversion_value) || 0;
  totals.messagesCounted += 1;
}

async function aggregateValuesReport(
  reportType: "campaign-values-report" | "flow-values-report",
  reportPath: "/campaign-values-reports/" | "/flow-values-reports/",
  conversionMetricId: string,
  isRevenueMetric: boolean,
  days: Days,
  filter?: string,
): Promise<AggregateTotals> {
  const totals = emptyTotals();
  totals.revenueAvailable = isRevenueMetric;
  const stats = isRevenueMetric ? [...ENGAGEMENT_STATS, ...VALUE_STATS] : ENGAGEMENT_STATS;
  try {
    const body: any = {
      data: {
        type: reportType,
        attributes: {
          statistics: stats,
          timeframe: { key: timeframeKey(days) },
          conversion_metric_id: conversionMetricId,
        },
      },
    };
    if (filter) body.data.attributes.filter = filter;
    const data = await kFetch<{ data: { attributes?: { results?: ValuesReportRow[] } } }>(
      reportPath,
      { method: "POST", body: JSON.stringify(body) },
    );
    for (const row of data.data?.attributes?.results || []) {
      addRow(totals, row.statistics);
    }
  } catch (e) {
    console.warn(`[OPS][REPORTS] ${reportType} failed:`, (e as Error).message);
  }
  return totals;
}

// Cache (report-path + candidate-set hash) → resolved metric for 30 min.
// pickMetricForReport hits /metrics/ + probe POSTs which add latency to every
// email report request. The metric compatibility doesn't change between
// requests, so cache aggressively.
interface ResolvedMetric { id: string; name: string; isRevenueMetric: boolean }
const metricResolveCache = new Map<string, { value: ResolvedMetric | null; at: number }>();
const METRIC_RESOLVE_TTL_MS = 30 * 60_000;

interface KlaviyoMetricRow { id: string; attributes?: { name?: string } }
// Cache of /metrics/ list — request-scoped via parameter, but also module-level
// fallback for picks that don't receive a list.
let metricsListCache: { rows: KlaviyoMetricRow[]; at: number } | null = null;
const METRICS_LIST_TTL_MS = 30 * 60_000;

async function getMetricsList(): Promise<KlaviyoMetricRow[]> {
  if (metricsListCache && Date.now() - metricsListCache.at < METRICS_LIST_TTL_MS) {
    return metricsListCache.rows;
  }
  const data = await kFetch<{ data: KlaviyoMetricRow[] }>("/metrics/");
  metricsListCache = { rows: data.data || [], at: Date.now() };
  return metricsListCache.rows;
}

async function pickMetricForReport(
  reportPath: "/campaign-values-reports/" | "/flow-values-reports/",
  reportType: "campaign-values-report" | "flow-values-report",
  candidates: Array<{ name: string; isRevenue: boolean }>,
): Promise<ResolvedMetric | null> {
  const cacheKey = reportPath + "|" + candidates.map((c) => c.name).join(",");
  const cached = metricResolveCache.get(cacheKey);
  if (cached && Date.now() - cached.at < METRIC_RESOLVE_TTL_MS) {
    return cached.value;
  }
  try {
    const all = await getMetricsList();
    for (const cand of candidates) {
      const m = all.find((x) => x.attributes?.name?.toLowerCase() === cand.name.toLowerCase());
      if (!m) continue;
      // Probe — Klaviyo rejects some metrics per report type. For revenue
      // metrics, probe with conversion_value so we actually validate
      // values-data compatibility (not just engagement acceptance).
      try {
        await kFetch(reportPath, {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: reportType,
              attributes: {
                statistics: cand.isRevenue
                  ? ["conversion_value"]
                  : ["delivered"],
                timeframe: { key: "last_7_days" },
                conversion_metric_id: m.id,
              },
            },
          }),
        });
        const resolved = { id: m.id, name: cand.name, isRevenueMetric: cand.isRevenue };
        metricResolveCache.set(cacheKey, { value: resolved, at: Date.now() });
        return resolved;
      } catch {
        continue;
      }
    }
  } catch (e) {
    console.warn("[OPS][REPORTS] pickMetricForReport failed:", (e as Error).message);
  }
  metricResolveCache.set(cacheKey, { value: null, at: Date.now() });
  return null;
}

const REVENUE_CANDIDATES = [
  { name: "Placed Order", isRevenue: true },
  { name: "Order Placed", isRevenue: true },
  { name: "Lab Order Placed", isRevenue: true },
  { name: "Checkout Completed", isRevenue: true },
];

const ENGAGEMENT_CANDIDATES = [
  { name: "Received Email", isRevenue: false },
  { name: "Opened Email", isRevenue: false },
  { name: "Bounced Email", isRevenue: false },
];

function pickRevenueMetric(
  reportPath: "/campaign-values-reports/" | "/flow-values-reports/",
  reportType: "campaign-values-report" | "flow-values-report",
) {
  return pickMetricForReport(reportPath, reportType, REVENUE_CANDIDATES);
}

function pickEngagementMetric(
  reportPath: "/campaign-values-reports/" | "/flow-values-reports/",
  reportType: "campaign-values-report" | "flow-values-report",
) {
  return pickMetricForReport(reportPath, reportType, ENGAGEMENT_CANDIDATES);
}

function safeRate(num: number, denom: number): number | null {
  if (!denom) return null;
  return Math.round((num / denom) * 10000) / 100; // pct with 2dp
}

// ─── SITE TRAFFIC (GA4) ──────────────────────────────────────────────

interface PageBucket {
  key: string;
  label: string;
  match: (path: string) => boolean;
}

// FitScript URL → bucket mapping. Order matters: first match wins for
// overlapping prefixes (e.g. /onboarding/success → confirmation, not signup).
const PAGE_BUCKETS: PageBucket[] = [
  {
    key: "confirmation",
    label: "Purchase confirmation",
    match: (p) =>
      /\/confirmation\b|\/success\b|\/thanks\b|\/thank-you\b|\/order\/.*\/?$|\/checkout\/.*\/(success|complete)\b/i.test(
        p,
      ),
  },
  {
    key: "checkout",
    label: "Checkout",
    match: (p) => /\/checkout(\/|$)|\/cart(\/|$)/i.test(p),
  },
  {
    key: "signup",
    label: "Account creation",
    match: (p) =>
      /^\/(signup|register|onboarding|application|new|account\/new|join|get-started)(\/|$)/i.test(
        p,
      ),
  },
  {
    key: "product",
    label: "Product pages",
    match: (p) =>
      /^\/(labs|biomarkers|panels|products|product|shop)(\/|$)/i.test(p) &&
      !/^\/(labs|biomarkers|panels|products|shop)\/?$/i.test(p),
  },
  {
    key: "landing",
    label: "Landing page",
    match: (p) => p === "/" || /^\/(home|index)(\/|$)/i.test(p),
  },
];

// Popup view event candidates — try each in order.
const POPUP_EVENT_NAMES = ["popup_view", "popup_shown", "modal_view", "popup_open", "exit_intent"];

interface PageRow {
  page: string;
  views: number;
}

interface BucketResult {
  key: string;
  label: string;
  views: number;
  samplePaths: Array<{ path: string; views: number }>;
}

function bucketPages(rows: PageRow[]): { buckets: BucketResult[]; uncategorized: number } {
  const results: Record<string, BucketResult> = {};
  for (const b of PAGE_BUCKETS) results[b.key] = { key: b.key, label: b.label, views: 0, samplePaths: [] };
  let uncategorized = 0;
  for (const row of rows) {
    const match = PAGE_BUCKETS.find((b) => b.match(row.page));
    if (!match) {
      uncategorized += row.views;
      continue;
    }
    results[match.key].views += row.views;
    if (results[match.key].samplePaths.length < 5) {
      results[match.key].samplePaths.push({ path: row.page, views: row.views });
    }
  }
  return { buckets: PAGE_BUCKETS.map((b) => results[b.key]), uncategorized };
}

async function ga4EventCounts(
  analyticsData: ReturnType<typeof google.analyticsdata>,
  propertyId: string,
  startDate: string,
  endDate: string,
  names: string[],
): Promise<Record<string, number>> {
  if (!names.length) return {};
  try {
    const report = await analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: {
          filter: {
            fieldName: "eventName",
            inListFilter: { values: names },
          },
        },
      },
    });
    const out: Record<string, number> = {};
    for (const row of report.data.rows || []) {
      const name = row.dimensionValues?.[0].value || "";
      const count = parseInt(row.metricValues?.[0].value || "0");
      out[name] = (out[name] || 0) + count;
    }
    return out;
  } catch (e) {
    console.warn("[OPS][REPORTS] ga4EventCounts failed:", (e as Error).message);
    return {};
  }
}

// ─── Meta + first-party helpers (Ads report) ─────────────────────────

interface MetaSummary {
  configured: boolean;
  connected: boolean;
  account_name: string | null;
  currency: string | null;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_pct: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  conversions: number;
  conversion_value_usd: number;
  roas: number | null;
  error?: string;
  hint?: string;
}

async function fetchMetaSummary(days: Days): Promise<MetaSummary> {
  const creds = getMetaCreds();
  if (!creds) {
    return {
      configured: false,
      connected: false,
      account_name: null,
      currency: null,
      spend_usd: 0,
      impressions: 0,
      clicks: 0,
      ctr_pct: null,
      cpc_usd: null,
      cpm_usd: null,
      conversions: 0,
      conversion_value_usd: 0,
      roas: null,
      hint: "Set META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID. Generate in Meta Business Settings → System Users with ads_read scope.",
    };
  }

  // Pick Meta's nearest date_preset matching our window.
  const datePreset =
    days <= 7 ? "last_7d" : days <= 30 ? "last_30d" : days <= 90 ? "last_90d" : "last_year";

  try {
    const [acct, insights] = await Promise.all([
      metaFetch<{ name: string; currency: string }>(
        `/${creds.version}/act_${creds.accountId}?fields=name,currency`,
        creds.token,
      ),
      metaFetch<{ data: Array<Record<string, unknown>> }>(
        `/${creds.version}/act_${creds.accountId}/insights?level=account&date_preset=${datePreset}&fields=spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values`,
        creds.token,
      ),
    ]);

    const row = insights.data?.[0] || {};
    const parsed = parseInsightsRow(row);
    const roas = parsed.spend > 0 ? Math.round((parsed.conversionValue / parsed.spend) * 100) / 100 : null;

    return {
      configured: true,
      connected: true,
      account_name: acct.name,
      currency: acct.currency,
      spend_usd: Math.round(parsed.spend * 100) / 100,
      impressions: parsed.impressions,
      clicks: parsed.clicks,
      ctr_pct: Math.round(parsed.ctr * 100) / 100,
      cpc_usd: parsed.cpc > 0 ? Math.round(parsed.cpc * 100) / 100 : null,
      cpm_usd: parsed.cpm > 0 ? Math.round(parsed.cpm * 100) / 100 : null,
      conversions: parsed.conversions,
      conversion_value_usd: Math.round(parsed.conversionValue * 100) / 100,
      roas,
    };
  } catch (e) {
    console.warn("[OPS][REPORTS] meta summary failed:", (e as Error).message);
    return {
      configured: true,
      connected: false,
      account_name: null,
      currency: null,
      spend_usd: 0,
      impressions: 0,
      clicks: 0,
      ctr_pct: null,
      cpc_usd: null,
      cpm_usd: null,
      conversions: 0,
      conversion_value_usd: 0,
      roas: null,
      error: (e as Error).message,
    };
  }
}

interface ChannelRow {
  channel: string;
  sessions: number;
  users: number;
}

interface FirstPartyChannels {
  totalSessions: number;
  totalUsers: number;
  byChannel: ChannelRow[];
}

async function fetchFirstPartyChannels(cutoff: Date): Promise<FirstPartyChannels> {
  try {
    // Postgres can't resolve a column alias inside an expression in ORDER BY,
    // so order by the raw aggregate expression instead of the `sessions` alias.
    const r = await pool.query<{ channel: string | null; sessions: string; users: string }>(
      `SELECT
         COALESCE(NULLIF(utm_source, ''), 'direct') AS channel,
         COUNT(*)::text AS sessions,
         COUNT(DISTINCT COALESCE(user_id, visitor_id))::text AS users
       FROM visitor_sessions
       WHERE created_at >= $1
       GROUP BY 1
       ORDER BY COUNT(*) DESC
       LIMIT 12`,
      [cutoff],
    );
    const totalRow = await pool.query<{ sessions: string; users: string }>(
      `SELECT COUNT(*)::text AS sessions, COUNT(DISTINCT COALESCE(user_id, visitor_id))::text AS users
       FROM visitor_sessions WHERE created_at >= $1`,
      [cutoff],
    );
    return {
      totalSessions: parseInt(totalRow.rows[0]?.sessions || "0"),
      totalUsers: parseInt(totalRow.rows[0]?.users || "0"),
      byChannel: r.rows.map((row) => ({
        channel: row.channel || "direct",
        sessions: parseInt(row.sessions),
        users: parseInt(row.users),
      })),
    };
  } catch (e) {
    console.warn("[OPS][REPORTS] firstPartyChannels failed:", (e as Error).message);
    return { totalSessions: 0, totalUsers: 0, byChannel: [] };
  }
}

interface AttributionRow {
  source: string;
  medium: string | null;
  events: number;
}

async function fetchFirstPartyAttribution(cutoff: Date): Promise<{ topSources: AttributionRow[] }> {
  try {
    const r = await pool.query<{
      source: string | null;
      medium: string | null;
      events: string;
    }>(
      `SELECT
         COALESCE(NULLIF(utm_source, ''), 'direct') AS source,
         NULL::text AS medium,
         COUNT(*)::text AS events
       FROM touchpoints
       WHERE created_at >= $1
       GROUP BY 1
       ORDER BY COUNT(*) DESC
       LIMIT 10`,
      [cutoff],
    );
    return {
      topSources: r.rows.map((row) => ({
        source: row.source || "direct",
        medium: row.medium,
        events: parseInt(row.events),
      })),
    };
  } catch (e) {
    console.warn("[OPS][REPORTS] firstPartyAttribution failed:", (e as Error).message);
    return { topSources: [] };
  }
}

// Cache the full assembled email-report response for 60s. Klaviyo's
// value-reports endpoint is rate-limited to ~2/min sustained, and a single
// report assembly fires 4 calls (engagement + revenue × campaign + flow) plus
// metric-aggregates for unsubs. Without this, page reloads or React Query
// retries inside a minute would 429-storm. Client already has staleTime:
// 60s in useQuery so this matches user-facing freshness.
const emailReportCache = new Map<string, { value: unknown; at: number }>();
const EMAIL_REPORT_TTL_MS = 60_000;

export function registerReportsRoutes(app: Express) {
  app.get("/api/ops/reports/email", async (req, res) => {
    const rawDays = parseInt(String(req.query.days || "30"));
    const days: Days = (ALLOWED_DAYS.includes(rawDays as Days) ? rawDays : 30) as Days;

    if (!getKey()) {
      return res.json({
        configured: false,
        window_days: days,
        error: "Klaviyo not configured",
      });
    }

    // Serve from cache if fresh (CSV requests bypass — they're usually exports).
    if (req.query.format !== "csv") {
      const cached = emailReportCache.get(`${days}`);
      if (cached && Date.now() - cached.at < EMAIL_REPORT_TTL_MS) {
        return res.json(cached.value);
      }
    }

    // Run independent calls in parallel. RDS is the source-of-truth for
    // subscriber counts; Klaviyo handles engagement + unsubs.
    //
    // CRITICAL: engagement stats and revenue stats need SEPARATE
    // conversion_metric_id queries. If we use a revenue metric like
    // "Lab Order Placed" for engagement, Klaviyo only returns campaigns
    // that have Lab Order Placed conversions — silently dropping every
    // campaign that drove opens/clicks but no orders. Engagement = fallback
    // metric (Received Email), revenue = whichever revenue metric exists.
    const [
      unsubMetric,
      campaignEngagementMetric,
      campaignRevenueMetric,
      flowEngagementMetric,
      flowRevenueMetric,
      rds,
      sentCampaignIds,
    ] = await Promise.all([
      findMetric("Unsubscribed from Email Marketing"),
      pickEngagementMetric("/campaign-values-reports/", "campaign-values-report"),
      pickRevenueMetric("/campaign-values-reports/", "campaign-values-report"),
      pickEngagementMetric("/flow-values-reports/", "flow-values-report"),
      pickRevenueMetric("/flow-values-reports/", "flow-values-report"),
      rdsSubscribers(days),
      fetchSentCampaignIds(days),
    ]);

    const lostInWindow = unsubMetric ? await sumMetric(unsubMetric.id, days) : null;
    const newSubsInWindow = rds?.newInWindow ?? null;

    const campaignFilter = sentCampaignIds.length
      ? `contains-any(campaign_id,[${sentCampaignIds.map((id) => `"${id}"`).join(",")}])`
      : undefined;

    // Engagement queries (no revenue stats requested).
    const [campaignEngagement, flowEngagement] = await Promise.all([
      campaignEngagementMetric && sentCampaignIds.length > 0
        ? aggregateValuesReport(
            "campaign-values-report",
            "/campaign-values-reports/",
            campaignEngagementMetric.id,
            false,
            days,
            campaignFilter,
          )
        : Promise.resolve(emptyTotals()),
      flowEngagementMetric
        ? aggregateValuesReport(
            "flow-values-report",
            "/flow-values-reports/",
            flowEngagementMetric.id,
            false,
            days,
          )
        : Promise.resolve(emptyTotals()),
    ]);

    // Revenue queries (only if a revenue metric exists for this purpose).
    const [campaignRevenue, flowRevenue] = await Promise.all([
      campaignRevenueMetric && sentCampaignIds.length > 0
        ? aggregateValuesReport(
            "campaign-values-report",
            "/campaign-values-reports/",
            campaignRevenueMetric.id,
            true,
            days,
            campaignFilter,
          )
        : Promise.resolve(emptyTotals()),
      flowRevenueMetric
        ? aggregateValuesReport(
            "flow-values-report",
            "/flow-values-reports/",
            flowRevenueMetric.id,
            true,
            days,
          )
        : Promise.resolve(emptyTotals()),
    ]);

    // Merge: engagement counts come from the engagement queries; revenue
    // (conversions + conversion_value) comes from the revenue queries.
    const campaignTotals: AggregateTotals = {
      ...campaignEngagement,
      conversions: campaignRevenue.conversions,
      conversion_value: campaignRevenue.conversion_value,
      revenueAvailable: campaignRevenue.revenueAvailable,
    };
    const flowTotals: AggregateTotals = {
      ...flowEngagement,
      conversions: flowRevenue.conversions,
      conversion_value: flowRevenue.conversion_value,
      revenueAvailable: flowRevenue.revenueAvailable,
    };

    const combined = emptyTotals();
    combined.revenueAvailable = campaignTotals.revenueAvailable || flowTotals.revenueAvailable;
    for (const k of Object.keys(combined) as (keyof AggregateTotals)[]) {
      if (k === "revenueAvailable") continue;
      (combined as any)[k] = (campaignTotals as any)[k] + (flowTotals as any)[k];
    }

    const open_rate = safeRate(combined.opens_unique, combined.delivered);
    const click_rate = safeRate(combined.clicks_unique, combined.delivered);
    const click_to_open_rate = safeRate(combined.clicks_unique, combined.opens_unique);
    const unsubscribe_rate = safeRate(combined.unsubscribes, combined.delivered);
    const bounce_rate = safeRate(combined.bounced, combined.recipients || combined.delivered);
    const spam_rate = safeRate(combined.spam_complaints, combined.delivered);

    const total = rds?.total ?? null;
    const net_growth = newSubsInWindow != null && lostInWindow != null ? newSubsInWindow - lostInWindow : null;
    const growth_rate_pct =
      total != null && net_growth != null && total - net_growth > 0
        ? safeRate(net_growth, total - net_growth)
        : null;
    const revenue_per_subscriber =
      combined.revenueAvailable && total && total > 0
        ? Math.round((combined.conversion_value / total) * 100) / 100
        : null;

    const emailPayload = {
      configured: true,
      window_days: days,
      generated_at: new Date().toISOString(),
      subscribers: {
        total,
        total_estimated: false,
        new_in_window: newSubsInWindow,
        lost_in_window: lostInWindow,
        net_growth,
        growth_rate_pct,
      },
      engagement: {
        messages_sent: combined.messagesCounted,
        campaigns_sent: campaignTotals.messagesCounted,
        flows_active: flowTotals.messagesCounted,
        delivered: combined.delivered,
        opens_unique: combined.opens_unique,
        clicks_unique: combined.clicks_unique,
        unsubscribes: combined.unsubscribes,
        bounced: combined.bounced,
        spam_complaints: combined.spam_complaints,
        open_rate,
        click_rate,
        click_to_open_rate,
        unsubscribe_rate,
        bounce_rate,
        spam_rate,
      },
      revenue: {
        available: combined.revenueAvailable,
        campaigns_attributed_usd: campaignTotals.revenueAvailable
          ? Math.round(campaignTotals.conversion_value * 100) / 100
          : null,
        flows_attributed_usd: flowTotals.revenueAvailable
          ? Math.round(flowTotals.conversion_value * 100) / 100
          : null,
        total_attributed_usd: combined.revenueAvailable
          ? Math.round(combined.conversion_value * 100) / 100
          : null,
        per_subscriber_usd: revenue_per_subscriber,
        conversions: combined.revenueAvailable ? combined.conversions : null,
      },
      meta: {
        campaign_engagement_metric: campaignEngagementMetric?.name || null,
        campaign_revenue_metric: campaignRevenueMetric?.name || null,
        flow_engagement_metric: flowEngagementMetric?.name || null,
        flow_revenue_metric: flowRevenueMetric?.name || null,
        // Back-compat aliases for the existing client + CSV (revenue metric
        // is what the UI labels as "conversion metric" since that's the
        // money-driving signal).
        campaign_conversion_metric:
          campaignRevenueMetric?.name || campaignEngagementMetric?.name || null,
        flow_conversion_metric:
          flowRevenueMetric?.name || flowEngagementMetric?.name || null,
        signup_source: "rds:users",
        unsub_metric_found: !!unsubMetric,
      },
    };

    if (req.query.format === "csv") {
      csvHeaders(res, `email-report-${days}d-${todayStamp()}.csv`);
      const rows: Array<Array<unknown>> = [
        ["section", "metric", "value"],
        ["subscribers", "total", emailPayload.subscribers.total],
        ["subscribers", "new_in_window", emailPayload.subscribers.new_in_window],
        ["subscribers", "lost_in_window", emailPayload.subscribers.lost_in_window],
        ["subscribers", "net_growth", emailPayload.subscribers.net_growth],
        ["subscribers", "growth_rate_pct", emailPayload.subscribers.growth_rate_pct],
        ["engagement", "messages_sent", emailPayload.engagement.messages_sent],
        ["engagement", "delivered", emailPayload.engagement.delivered],
        ["engagement", "opens_unique", emailPayload.engagement.opens_unique],
        ["engagement", "clicks_unique", emailPayload.engagement.clicks_unique],
        ["engagement", "unsubscribes", emailPayload.engagement.unsubscribes],
        ["engagement", "bounced", emailPayload.engagement.bounced],
        ["engagement", "spam_complaints", emailPayload.engagement.spam_complaints],
        ["engagement", "open_rate_pct", emailPayload.engagement.open_rate],
        ["engagement", "click_rate_pct", emailPayload.engagement.click_rate],
        ["engagement", "unsubscribe_rate_pct", emailPayload.engagement.unsubscribe_rate],
        ["engagement", "bounce_rate_pct", emailPayload.engagement.bounce_rate],
        ["revenue", "total_attributed_usd", emailPayload.revenue.total_attributed_usd],
        ["revenue", "campaigns_attributed_usd", emailPayload.revenue.campaigns_attributed_usd],
        ["revenue", "flows_attributed_usd", emailPayload.revenue.flows_attributed_usd],
        ["revenue", "per_subscriber_usd", emailPayload.revenue.per_subscriber_usd],
      ];
      return res.send(csvRows(rows));
    }
    emailReportCache.set(`${days}`, { value: emailPayload, at: Date.now() });
    res.json(emailPayload);
  });

  // ─── ADS + ATTRIBUTION ───────────────────────────────────────────
  app.get("/api/ops/reports/ads", async (req, res) => {
    const rawDays = parseInt(String(req.query.days || "30"));
    const days: Days = (ALLOWED_DAYS.includes(rawDays as Days) ? rawDays : 30) as Days;
    const cutoff = new Date(Date.now() - days * 86400_000);

    // Run Meta + first-party in parallel. Google Ads + Hyros are stubs.
    const [metaData, firstPartyChannels, firstPartyAttribution, rdsSignups] = await Promise.all([
      fetchMetaSummary(days),
      fetchFirstPartyChannels(cutoff),
      fetchFirstPartyAttribution(cutoff),
      rdsSubscribers(days),
    ]);

    // Google Ads + Hyros + Campaign Refiners stubs — connection-state-aware.
    const googleAds = {
      configured: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN && !!process.env.GOOGLE_ADS_CUSTOMER_ID,
      connected: false,
      hint: "Pending Google Ads developer-token approval. Once approved, set GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_CUSTOMER_ID and uses the same OAuth as GA4.",
    };
    const hyros = {
      configured: !!process.env.HYROS_API_KEY,
      connected: false,
      hint: "Set HYROS_API_KEY (Hyros → Settings → API). First-party tracking pixel below offers similar attribution today.",
    };
    const campaignRefiners = {
      configured: !!process.env.CAMPAIGN_REFINERS_API_KEY,
      connected: false,
      hint: "If Campaign Refiners exposes an API, set CAMPAIGN_REFINERS_API_KEY. Otherwise this stays a placeholder.",
    };

    const adsPayload = {
      window_days: days,
      generated_at: new Date().toISOString(),
      meta: metaData,
      google_ads: googleAds,
      hyros,
      campaign_refiners: campaignRefiners,
      first_party: {
        sessions: firstPartyChannels.totalSessions,
        users: firstPartyChannels.totalUsers,
        channels: firstPartyChannels.byChannel,
        top_sources: firstPartyAttribution.topSources,
        signups_in_window: rdsSignups?.newInWindow ?? null,
        note:
          firstPartyChannels.totalSessions === 0
            ? "Pixel is wired but no sessions in this window yet"
            : "First-party tracking — same data Hyros would surface",
      },
    };

    if (req.query.format === "csv") {
      csvHeaders(res, `ads-report-${days}d-${todayStamp()}.csv`);
      const rows: Array<Array<unknown>> = [
        ["section", "metric", "value"],
        ["meta", "connected", adsPayload.meta.connected],
        ["meta", "account_name", adsPayload.meta.account_name],
        ["meta", "spend_usd", adsPayload.meta.spend_usd],
        ["meta", "impressions", adsPayload.meta.impressions],
        ["meta", "clicks", adsPayload.meta.clicks],
        ["meta", "ctr_pct", adsPayload.meta.ctr_pct],
        ["meta", "cpc_usd", adsPayload.meta.cpc_usd],
        ["meta", "cpm_usd", adsPayload.meta.cpm_usd],
        ["meta", "conversions", adsPayload.meta.conversions],
        ["meta", "conversion_value_usd", adsPayload.meta.conversion_value_usd],
        ["meta", "roas", adsPayload.meta.roas],
        ["google_ads", "connected", adsPayload.google_ads.connected],
        ["hyros", "connected", adsPayload.hyros.connected],
        ["first_party", "sessions", adsPayload.first_party.sessions],
        ["first_party", "users", adsPayload.first_party.users],
        ["first_party", "signups_in_window", adsPayload.first_party.signups_in_window],
        [],
        ["channel", "sessions", "users"],
        ...adsPayload.first_party.channels.map((c) => [c.channel, c.sessions, c.users]),
      ];
      return res.send(csvRows(rows));
    }
    res.json(adsPayload);
  });

  // ─── SALES ───────────────────────────────────────────────────────
  app.get("/api/ops/reports/sales", async (req, res) => {
    const rawDays = parseInt(String(req.query.days || "30"));
    const days: Days = (ALLOWED_DAYS.includes(rawDays as Days) ? rawDays : 30) as Days;
    const cutoff = new Date(Date.now() - days * 86400_000);

    try {
      // Window-scoped revenue + orders from lab_orders (clean ledger).
      const windowAgg = await pool.query<{
        revenue_cents: string | null;
        orders: string;
        aov_cents: string | null;
        paying_customers: string;
      }>(
        `SELECT
           COALESCE(SUM(price_cents - COALESCE(discount_cents,0)), 0)::text AS revenue_cents,
           COUNT(*)::text AS orders,
           CASE WHEN COUNT(*) > 0
             THEN ROUND(AVG(price_cents - COALESCE(discount_cents,0)))::text
             ELSE NULL
           END AS aov_cents,
           COUNT(DISTINCT user_id)::text AS paying_customers
         FROM lab_orders
         WHERE paid_at >= $1 AND paid_at < NOW() AND refunded_at IS NULL`,
        [cutoff],
      );

      // New paying customers in window (first paid ever within window).
      const newCustomersAgg = await pool.query<{ new_customers: string }>(
        `SELECT COUNT(DISTINCT lo.user_id)::text AS new_customers
         FROM lab_orders lo
         WHERE lo.paid_at >= $1 AND lo.refunded_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM lab_orders lo2
             WHERE lo2.user_id = lo.user_id
               AND lo2.paid_at < $1
               AND lo2.refunded_at IS NULL
           )`,
        [cutoff],
      );

      // Lifetime stats (all-time, not window-scoped).
      const lifetime = await pool.query<{
        total_customers: string;
        repeat_customers: string;
        avg_ltv_cents: string | null;
        avg_orders_per_customer: string | null;
        avg_days_to_first_purchase: string | null;
      }>(
        `WITH per_customer AS (
           SELECT
             user_id,
             COUNT(*) AS order_count,
             SUM(price_cents - COALESCE(discount_cents,0)) AS lifetime_cents,
             MIN(paid_at) AS first_paid_at
           FROM lab_orders
           WHERE paid_at IS NOT NULL AND refunded_at IS NULL
           GROUP BY user_id
         )
         SELECT
           COUNT(*)::text AS total_customers,
           COUNT(*) FILTER (WHERE order_count > 1)::text AS repeat_customers,
           CASE WHEN COUNT(*) > 0 THEN ROUND(AVG(lifetime_cents))::text ELSE NULL END AS avg_ltv_cents,
           CASE WHEN COUNT(*) > 0 THEN ROUND(AVG(order_count)::numeric, 2)::text ELSE NULL END AS avg_orders_per_customer,
           CASE WHEN COUNT(*) > 0 THEN ROUND(AVG(
             EXTRACT(EPOCH FROM (per_customer.first_paid_at - u.created_at)) / 86400.0
           )::numeric, 1)::text ELSE NULL END AS avg_days_to_first_purchase
         FROM per_customer
         JOIN users u ON u.id = per_customer.user_id`,
      );

      // Daily revenue series for the window (for trend chart).
      const series = await pool.query<{ d: string; revenue_cents: string; orders: string }>(
        `SELECT
           to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS d,
           COALESCE(SUM(price_cents - COALESCE(discount_cents,0)), 0)::text AS revenue_cents,
           COUNT(*)::text AS orders
         FROM lab_orders
         WHERE paid_at >= $1 AND paid_at < NOW() AND refunded_at IS NULL
         GROUP BY 1
         ORDER BY 1`,
        [cutoff],
      );

      // Active subscriptions snapshot (MRR proxy).
      const subs = await pool.query<{ tier: string; period: string | null; count: string }>(
        `SELECT subscription_tier AS tier, subscription_period AS period, COUNT(*)::text AS count
         FROM users
         WHERE subscription_status = 'active' AND subscription_tier <> 'free' AND subscription_tier IS NOT NULL
         GROUP BY 1, 2`,
      );

      // Tier price reference — derived from the May 2026 pricing arc (see memory).
      const TIER_MONTHLY_PRICE: Record<string, number> = {
        fast_start: 20,
        protocol: 99,
        peak: 99,
        apex: 3999,
      };
      let mrr_estimate_usd = 0;
      const subs_breakdown: Array<{ tier: string; period: string | null; count: number; monthly_value: number }> = [];
      for (const row of subs.rows) {
        const count = parseInt(row.count);
        const monthlyEach = TIER_MONTHLY_PRICE[row.tier] || 0;
        // Annual periods bill once but represent ~12x monthly economics.
        const monthly_value = count * monthlyEach;
        mrr_estimate_usd += monthly_value;
        subs_breakdown.push({ tier: row.tier, period: row.period, count, monthly_value });
      }

      const w = windowAgg.rows[0];
      const lt = lifetime.rows[0];
      const newC = parseInt(newCustomersAgg.rows[0]?.new_customers || "0");
      const totalCustomers = parseInt(lt.total_customers);
      const repeatCustomers = parseInt(lt.repeat_customers);
      const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 10000) / 100 : null;

      const salesPayload = {
        window_days: days,
        generated_at: new Date().toISOString(),
        window: {
          customers_paid: parseInt(w.paying_customers),
          new_customers: newC,
          orders: parseInt(w.orders),
          revenue_usd: Math.round(parseInt(w.revenue_cents || "0")) / 100,
          aov_usd: w.aov_cents ? Math.round(parseInt(w.aov_cents)) / 100 : null,
        },
        lifetime: {
          total_customers: totalCustomers,
          repeat_customers: repeatCustomers,
          repeat_rate_pct: repeatRate,
          avg_orders_per_customer: lt.avg_orders_per_customer
            ? parseFloat(lt.avg_orders_per_customer)
            : null,
          avg_ltv_usd: lt.avg_ltv_cents ? Math.round(parseInt(lt.avg_ltv_cents)) / 100 : null,
          avg_days_to_first_purchase: lt.avg_days_to_first_purchase
            ? parseFloat(lt.avg_days_to_first_purchase)
            : null,
        },
        subscriptions: {
          mrr_estimate_usd,
          breakdown: subs_breakdown,
          note: "Estimate: active subs × tier list price. Real receipts live in Stripe.",
        },
        daily_series: series.rows.map((r) => ({
          date: r.d,
          revenue_usd: Math.round(parseInt(r.revenue_cents)) / 100,
          orders: parseInt(r.orders),
        })),
        source: "rds:lab_orders + rds:users + tier pricing",
      };

      if (req.query.format === "csv") {
        csvHeaders(res, `sales-report-${days}d-${todayStamp()}.csv`);
        const rows: Array<Array<unknown>> = [
          ["section", "metric", "value"],
          ["window", "revenue_usd", salesPayload.window.revenue_usd],
          ["window", "orders", salesPayload.window.orders],
          ["window", "customers_paid", salesPayload.window.customers_paid],
          ["window", "new_customers", salesPayload.window.new_customers],
          ["window", "aov_usd", salesPayload.window.aov_usd],
          ["lifetime", "total_customers", salesPayload.lifetime.total_customers],
          ["lifetime", "repeat_customers", salesPayload.lifetime.repeat_customers],
          ["lifetime", "repeat_rate_pct", salesPayload.lifetime.repeat_rate_pct],
          ["lifetime", "avg_orders_per_customer", salesPayload.lifetime.avg_orders_per_customer],
          ["lifetime", "avg_ltv_usd", salesPayload.lifetime.avg_ltv_usd],
          ["lifetime", "avg_days_to_first_purchase", salesPayload.lifetime.avg_days_to_first_purchase],
          ["subscriptions", "mrr_estimate_usd", salesPayload.subscriptions.mrr_estimate_usd],
          [],
          ["tier_breakdown:", "", ""],
          ["tier", "period", "count", "monthly_value_usd"],
          ...salesPayload.subscriptions.breakdown.map((b) => [b.tier, b.period || "", b.count, b.monthly_value]),
          [],
          ["daily_revenue_series:", "", ""],
          ["date", "revenue_usd", "orders"],
          ...salesPayload.daily_series.map((d) => [d.date, d.revenue_usd, d.orders]),
        ];
        return res.send(csvRows(rows));
      }
      res.json(salesPayload);
    } catch (e) {
      console.error("[OPS][REPORTS] sales failed:", (e as Error).message);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ─── CONVERSIONS ─────────────────────────────────────────────────
  app.get("/api/ops/reports/conversions", async (req, res) => {
    const rawDays = parseInt(String(req.query.days || "30"));
    const days: Days = (ALLOWED_DAYS.includes(rawDays as Days) ? rawDays : 30) as Days;

    const auth = await getAuthenticatedClient();
    if (!auth) {
      return res.json({
        connected: false,
        window_days: days,
        error: "Google not connected. Connect GA4 from Integrations.",
      });
    }
    const conn = await getConnection();
    const propertyId = conn?.ga4_property_id;
    if (!propertyId) {
      return res.json({
        connected: true,
        window_days: days,
        error: "No GA4 property selected.",
      });
    }

    const analyticsData = google.analyticsdata({ version: "v1beta", auth });
    const startDate = `${days}daysAgo`;
    const endDate = "today";

    try {
      // GA4 ecommerce events + popup click event names
      const ECOM_EVENTS = [
        "add_to_cart",
        "begin_checkout",
        "purchase",
        "popup_view",
        "popup_shown",
        "popup_click",
        "popup_cta_click",
        "modal_view",
        "modal_click",
      ];

      const [eventCounts, pagesReport, rds] = await Promise.all([
        ga4EventCounts(analyticsData, propertyId, startDate, endDate, ECOM_EVENTS),
        analyticsData.properties.runReport({
          property: `properties/${propertyId}`,
          requestBody: {
            dateRanges: [{ startDate, endDate }],
            dimensions: [{ name: "pagePath" }],
            metrics: [{ name: "screenPageViews" }],
            orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
            limit: "500",
          },
        }),
        rdsSubscribers(days),
      ]);

      const pageRows: PageRow[] = (pagesReport.data.rows || []).map((r) => ({
        page: r.dimensionValues?.[0].value || "",
        views: parseInt(r.metricValues?.[0].value || "0"),
      }));
      const { buckets } = bucketPages(pageRows);
      const viewsByBucket: Record<string, number> = {};
      for (const b of buckets) viewsByBucket[b.key] = b.views;

      const popupViews =
        (eventCounts["popup_view"] || 0) +
        (eventCounts["popup_shown"] || 0) +
        (eventCounts["modal_view"] || 0);
      const popupClicks =
        (eventCounts["popup_click"] || 0) +
        (eventCounts["popup_cta_click"] || 0) +
        (eventCounts["modal_click"] || 0);
      const addToCart = eventCounts["add_to_cart"] || 0;
      const beginCheckout = eventCounts["begin_checkout"] || 0;
      const purchase = eventCounts["purchase"] || 0;
      const newUsers = rds?.newInWindow ?? null;

      const rate = (num: number | null, denom: number): number | null => {
        if (num === null || denom <= 0) return null;
        return Math.round((num / denom) * 10000) / 100;
      };

      const funnels = [
        {
          key: "signup",
          label: "Account creation",
          step_from: { label: "Signup page views", count: viewsByBucket["signup"] || 0, source: "GA4 bucketed" },
          step_to: { label: "Accounts created", count: newUsers, source: "RDS users" },
          rate_pct: rate(newUsers, viewsByBucket["signup"] || 0),
          note:
            (viewsByBucket["signup"] || 0) === 0
              ? "No signup-page traffic recorded yet"
              : null,
        },
        {
          key: "popup",
          label: "Popup conversion",
          step_from: { label: "Popup views", count: popupViews, source: "GA4 events" },
          step_to: { label: "Popup clicks", count: popupClicks, source: "GA4 events" },
          rate_pct: rate(popupClicks, popupViews),
          note:
            popupViews === 0
              ? "Fire popup_view / popup_click GA4 events to populate"
              : null,
        },
        {
          key: "product_to_cart",
          label: "Product → Add to cart",
          step_from: { label: "Product views", count: viewsByBucket["product"] || 0, source: "GA4 bucketed" },
          step_to: { label: "Add-to-cart events", count: addToCart, source: "GA4 events" },
          rate_pct: rate(addToCart, viewsByBucket["product"] || 0),
          note:
            addToCart === 0
              ? "Fire add_to_cart GA4 event from product pages"
              : null,
        },
        {
          key: "cart_to_checkout",
          label: "Cart → Checkout",
          step_from: { label: "Add-to-cart events", count: addToCart, source: "GA4 events" },
          step_to: {
            label: "Checkout starts",
            count: beginCheckout || viewsByBucket["checkout"] || 0,
            source: beginCheckout > 0 ? "GA4 begin_checkout" : "GA4 bucketed checkout page",
          },
          rate_pct: rate(beginCheckout || viewsByBucket["checkout"] || 0, addToCart),
          note: addToCart === 0 ? "Needs add_to_cart events" : null,
        },
        {
          key: "checkout_to_purchase",
          label: "Checkout → Purchase",
          step_from: {
            label: "Checkout starts",
            count: beginCheckout || viewsByBucket["checkout"] || 0,
            source: beginCheckout > 0 ? "GA4 begin_checkout" : "GA4 bucketed checkout page",
          },
          step_to: { label: "Purchases", count: purchase, source: "GA4 purchase event" },
          rate_pct: rate(purchase, beginCheckout || viewsByBucket["checkout"] || 0),
          note:
            purchase === 0
              ? "Fire purchase GA4 event on confirmation page"
              : null,
        },
      ];

      const convPayload = {
        connected: true,
        window_days: days,
        generated_at: new Date().toISOString(),
        funnels,
        meta: {
          ga4_events_found: Object.fromEntries(
            ECOM_EVENTS.map((e) => [e, eventCounts[e] || 0]),
          ),
          bucket_views: viewsByBucket,
        },
      };

      if (req.query.format === "csv") {
        csvHeaders(res, `conversions-report-${days}d-${todayStamp()}.csv`);
        const rows: Array<Array<unknown>> = [
          ["funnel", "step_from", "step_from_count", "step_to", "step_to_count", "rate_pct", "note"],
          ...convPayload.funnels.map((f) => [
            f.label,
            f.step_from.label,
            f.step_from.count,
            f.step_to.label,
            f.step_to.count,
            f.rate_pct,
            f.note || "",
          ]),
          [],
          ["ga4_event", "count"],
          ...Object.entries(convPayload.meta.ga4_events_found).map(([k, v]) => [k, v]),
        ];
        return res.send(csvRows(rows));
      }
      res.json(convPayload);
    } catch (e) {
      console.error("[OPS][REPORTS] conversions failed:", (e as Error).message);
      res.json({ connected: true, window_days: days, error: (e as Error).message });
    }
  });

  // ─── SITE TRAFFIC ────────────────────────────────────────────────
  app.get("/api/ops/reports/traffic", async (req, res) => {
    const rawDays = parseInt(String(req.query.days || "30"));
    const days: Days = (ALLOWED_DAYS.includes(rawDays as Days) ? rawDays : 30) as Days;

    const auth = await getAuthenticatedClient();
    if (!auth) {
      return res.json({
        connected: false,
        window_days: days,
        error: "Google not connected. Connect GA4 from Integrations.",
      });
    }
    const conn = await getConnection();
    const propertyId = conn?.ga4_property_id;
    if (!propertyId) {
      return res.json({
        connected: true,
        window_days: days,
        error: "No GA4 property selected. Pick one in Settings.",
      });
    }

    const analyticsData = google.analyticsdata({ version: "v1beta", auth });
    const startDate = `${days}daysAgo`;
    const endDate = "today";

    try {
      // Three parallel GA4 reports: overview, pages, popup events.
      const [overviewReport, pagesReport, popupCounts] = await Promise.all([
        analyticsData.properties.runReport({
          property: `properties/${propertyId}`,
          requestBody: {
            dateRanges: [{ startDate, endDate }],
            metrics: [
              { name: "sessions" },
              { name: "totalUsers" },
              { name: "newUsers" },
              { name: "screenPageViews" },
              { name: "bounceRate" },
              { name: "averageSessionDuration" },
            ],
          },
        }),
        analyticsData.properties.runReport({
          property: `properties/${propertyId}`,
          requestBody: {
            dateRanges: [{ startDate, endDate }],
            dimensions: [{ name: "pagePath" }],
            metrics: [{ name: "screenPageViews" }],
            orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
            limit: "500",
          },
        }),
        ga4EventCounts(analyticsData, propertyId, startDate, endDate, POPUP_EVENT_NAMES),
      ]);

      const overviewRow = overviewReport.data.rows?.[0];
      const overview = overviewRow
        ? {
            sessions: parseInt(overviewRow.metricValues?.[0].value || "0"),
            users: parseInt(overviewRow.metricValues?.[1].value || "0"),
            new_users: parseInt(overviewRow.metricValues?.[2].value || "0"),
            page_views: parseInt(overviewRow.metricValues?.[3].value || "0"),
            bounce_rate:
              Math.round(parseFloat(overviewRow.metricValues?.[4].value || "0") * 10000) / 100,
            avg_duration_sec:
              Math.round(parseFloat(overviewRow.metricValues?.[5].value || "0") * 10) / 10,
          }
        : { sessions: 0, users: 0, new_users: 0, page_views: 0, bounce_rate: 0, avg_duration_sec: 0 };

      const pageRows: PageRow[] = (pagesReport.data.rows || []).map((r) => ({
        page: r.dimensionValues?.[0].value || "",
        views: parseInt(r.metricValues?.[0].value || "0"),
      }));

      const { buckets, uncategorized } = bucketPages(pageRows);

      const popupTotal = Object.values(popupCounts).reduce((a, b) => a + b, 0);

      const trafficPayload = {
        connected: true,
        window_days: days,
        generated_at: new Date().toISOString(),
        overview,
        buckets,
        popup: {
          total_views: popupTotal,
          by_event: popupCounts,
          tracked_events: POPUP_EVENT_NAMES,
        },
        uncategorized_views: uncategorized,
        total_pages_seen: pageRows.length,
      };

      if (req.query.format === "csv") {
        csvHeaders(res, `traffic-report-${days}d-${todayStamp()}.csv`);
        const rows: Array<Array<unknown>> = [
          ["section", "metric", "value"],
          ["overview", "sessions", trafficPayload.overview.sessions],
          ["overview", "users", trafficPayload.overview.users],
          ["overview", "new_users", trafficPayload.overview.new_users],
          ["overview", "page_views", trafficPayload.overview.page_views],
          ["overview", "bounce_rate_pct", trafficPayload.overview.bounce_rate],
          ["overview", "avg_duration_sec", trafficPayload.overview.avg_duration_sec],
          ["overview", "uncategorized_views", trafficPayload.uncategorized_views],
          ["overview", "total_pages_seen", trafficPayload.total_pages_seen],
          [],
          ["bucket_key", "bucket_label", "views"],
          ...trafficPayload.buckets.map((b) => [b.key, b.label, b.views]),
          [],
          ["popup_event", "count"],
          ...Object.entries(trafficPayload.popup.by_event).map(([k, v]) => [k, v]),
        ];
        return res.send(csvRows(rows));
      }
      res.json(trafficPayload);
    } catch (e) {
      console.error("[OPS][REPORTS] traffic failed:", (e as Error).message);
      res.json({
        connected: true,
        window_days: days,
        error: (e as Error).message,
      });
    }
  });
}
