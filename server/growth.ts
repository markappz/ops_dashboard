/**
 * Per-brand growth models (2026-10-11, Michael's ask): the AI drafts each
 * brand's growth model — drivers, constraints, assumptions, suggested
 * initiatives — from the SAME live numbers the Command Center reads, then
 * Paul/Michael apply judgment: edit assumptions, adopt initiatives, assign an
 * owner and a KPI to each. The model is the map; the initiatives table with
 * owners + KPIs is the part that runs the business.
 *
 * Deliberately NOT a formula ("Grow Fast or Die Slow": judgment over
 * plugging numbers in): generation always returns assumptions WITH how to
 * challenge them, and regeneration never touches adopted initiatives.
 */
import type { Express, Request, Response } from "express";
import { pool } from "./db";
import { listAdminsFromDb } from "./admin-auth";
import { logAdminAction } from "./lib/auditLog";
import { anthropic, BEDROCK_MODELS, isAIConfigured } from "./lib/bedrock";
import { logAiCost } from "./aiCostLogger";
import { getOverviewCached } from "./command-center";
import { google } from "googleapis";
import { getAuthenticatedClient, getConnection } from "./google-auth";
import { emailSummaryFor } from "./brand-email";

const GROWTH_BRANDS = ["fitscript", "peptideu", "pawgen", "realpeptides", "northblu", "reverra"] as const;
type GrowthBrand = (typeof GROWTH_BRANDS)[number];

/** What each brand IS — the model prompt needs business shape, not just numbers. */
const BRAND_CONTEXT: Record<GrowthBrand, string> = {
  fitscript: "FitScript — health-optimization membership app (Wizlo-billed subscriptions, lab panels, supplement orders). Early stage: small paid base, relaunch program running.",
  peptideu: "PeptideU — peptide education app on iOS + Android, $99.99/yr premium subscriptions, ~160-page content library, sweepstakes + community. Revenue is MRR from paying members.",
  pawgen: "pawgen — D2C dog-longevity supplement brand (BARQ MIX blends). Volume content/SEO engine, email flows, affiliate program, 15-18 leads/day.",
  realpeptides: "Real Peptides — research-peptide ecommerce (custom Next.js storefront), retail + wholesale tiers, in-house ESP, call center, ~$550K/30d. The portfolio's revenue engine.",
  northblu: "North Blu — waitlist-stage brand, site + welcome flow live, no commerce yet. Growth means list build and launch readiness.",
  reverra: "Reverra — peptide ORAL STRIPS D2C (49% owned). Lovable-built store doing ~$200K+ lifetime; reverra.com becomes the primary property.",
};

/** KPI metrics the dashboard can fill in live from the Command Center feed. */
const AUTO_METRICS = ["revenue_30d", "orders_30d", "sessions_30d", "leads_30d", "revenue_growth_pct"] as const;

let tablesEnsured = false;
export async function ensureGrowthTables(): Promise<void> {
  if (tablesEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_growth_models (
      id BIGSERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      summary TEXT NOT NULL,
      drivers JSONB NOT NULL DEFAULT '[]',
      constraints JSONB NOT NULL DEFAULT '[]',
      assumptions JSONB NOT NULL DEFAULT '[]',
      suggested_initiatives JSONB NOT NULL DEFAULT '[]',
      guidance TEXT,
      generated_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',      -- active | archived
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ops_growth_models_brand_idx ON ops_growth_models (brand, status);
    CREATE TABLE IF NOT EXISTS ops_growth_initiatives (
      id BIGSERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      model_id BIGINT,
      title TEXT NOT NULL,
      driver TEXT,
      owner TEXT,                                  -- admin email or a name
      kpi_label TEXT,
      kpi_metric TEXT,                             -- one of AUTO_METRICS → filled live; null = manual
      kpi_target NUMERIC,
      kpi_current NUMERIC,                         -- manual KPIs only; auto metrics override on read
      due_label TEXT,                              -- "Q4 2026", "Nov 15" — human text, not a date column
      status TEXT NOT NULL DEFAULT 'active',       -- active | done | dropped
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ops_growth_initiatives_brand_idx ON ops_growth_initiatives (brand, status);
  `);
  tablesEnsured = true;
}

function brandOf(req: Request): GrowthBrand | null {
  const b = String(req.params.brand || "").toLowerCase();
  return (GROWTH_BRANDS as readonly string[]).includes(b) ? (b as GrowthBrand) : null;
}

function vitalsFor(overview: any, brand: string): Record<string, number | null> {
  const v = overview?.brands?.find((x: any) => x.key === brand);
  if (!v?.configured) return {};
  return {
    revenue_30d: v.revenue ?? null,
    orders_30d: v.orders ?? null,
    sessions_30d: v.sessions ?? null,
    leads_30d: v.leads ?? null,
    revenue_growth_pct: v.growth ?? null,
  };
}

async function financeContext(brand: string): Promise<string> {
  const r = await pool.query(
    `SELECT kind, category, SUM(amount_cents)::bigint AS cents
       FROM ops_finance_entries
      WHERE brand = $1 AND deleted_at IS NULL AND entry_date >= now() - interval '90 days'
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`,
    [brand],
  ).catch(() => ({ rows: [] as any[] }));
  if (!r.rows.length) return "No tracked finance entries yet.";
  return r.rows.map((x: any) => `${x.kind}/${x.category}: $${Math.round(Number(x.cents) / 100)}`).join(", ");
}

const MODEL_TOOL = {
  name: "write_growth_model",
  description: "Write the brand's growth model",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string", description: "3-5 sentences: how this brand grows if optimally executed, and what realistically gates it" },
      drivers: {
        type: "array", maxItems: 6,
        items: { type: "object", properties: { name: { type: "string" }, why: { type: "string" }, lever: { type: "string", description: "the concrete lever to pull" } }, required: ["name", "why", "lever"] },
      },
      constraints: {
        type: "array", maxItems: 5,
        items: { type: "object", properties: { name: { type: "string" }, impact: { type: "string" }, mitigation: { type: "string" } }, required: ["name", "impact"] },
      },
      assumptions: {
        type: "array", maxItems: 6,
        description: "The load-bearing beliefs. Each must be challengeable in a meeting.",
        items: { type: "object", properties: { statement: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, how_to_challenge: { type: "string", description: "the test or question that would break this assumption" } }, required: ["statement", "confidence", "how_to_challenge"] },
      },
      suggested_initiatives: {
        type: "array", maxItems: 6,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            driver: { type: "string", description: "which driver this feeds" },
            kpi_label: { type: "string", description: "the number that proves it worked" },
            kpi_metric: { type: "string", enum: [...AUTO_METRICS, "manual"], description: "a live dashboard metric when one fits, else manual" },
            kpi_target: { type: "number" },
            rationale: { type: "string" },
          },
          required: ["title", "driver", "kpi_label", "rationale"],
        },
      },
    },
    required: ["summary", "drivers", "constraints", "assumptions", "suggested_initiatives"],
  },
};

const INTEL_TIMEOUT_MS = 12_000;
function timed<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("intel timeout")), INTEL_TIMEOUT_MS))]);
}

async function gscIntel(brand: string): Promise<string | null> {
  const auth = await getAuthenticatedClient(brand);
  const conn = await getConnection(brand);
  if (!auth || !conn?.gsc_site_url) return null;
  const webmasters = google.webmasters({ version: "v3", auth });
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date(); const d28 = new Date(now.getTime() - 28 * 86400000); const d56 = new Date(now.getTime() - 56 * 86400000);
  const q = (startDate: string, endDate: string, dimensions?: string[]) =>
    webmasters.searchanalytics.query({ siteUrl: conn.gsc_site_url, requestBody: { startDate, endDate, dimensions, rowLimit: dimensions ? 10 : 1 } });
  const [cur, prev, queries] = await Promise.all([q(fmt(d28), fmt(now)), q(fmt(d56), fmt(d28)), q(fmt(d28), fmt(now), ["query"])]);
  const tot = (r: any) => r.data.rows?.[0] ?? { clicks: 0, impressions: 0 };
  const top = (queries.data.rows ?? []).map((r: any) => `${r.keys[0]} (${r.clicks}c/${Math.round(r.position)}pos)`).join(", ");
  return `GSC 28d: ${tot(cur).clicks} clicks / ${tot(cur).impressions} impressions (prev 28d: ${tot(prev).clicks}/${tot(prev).impressions}). Top queries: ${top || "none"}`;
}

async function ga4Intel(brand: string): Promise<string | null> {
  const auth = await getAuthenticatedClient(brand);
  const conn = await getConnection(brand);
  if (!auth || !conn?.ga4_property_id) return null;
  const analyticsData = google.analyticsdata({ version: "v1beta", auth });
  const r = await analyticsData.properties.runReport({
    property: `properties/${conn.ga4_property_id}`,
    requestBody: {
      dateRanges: [{ startDate: "28daysAgo", endDate: "today" }, { startDate: "56daysAgo", endDate: "29daysAgo" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "engagementRate" }],
    },
  });
  const rows = r.data.rows ?? [];
  const v = (i: number, m: number) => rows[i]?.metricValues?.[m]?.value ?? "0";
  return `GA4 28d: ${v(0, 0)} sessions, ${v(0, 1)} users, engagement ${(Number(v(0, 2)) * 100).toFixed(0)}% (prev 28d: ${v(1, 0)} sessions)`;
}

async function emailIntel(brand: string): Promise<string | null> {
  const s = await emailSummaryFor(brand, 30);
  if (!s?.totals) return null;
  const t = s.totals;
  const parts = Object.entries(t).filter(([, val]) => typeof val === "number")
    .slice(0, 8).map(([k, val]) => `${k}=${val}`).join(", ");
  const flows = (s.flows ?? []).slice(0, 5).map((f: any) => f.name ?? f.key).filter(Boolean).join(", ");
  return `Email engine 30d: ${parts}${flows ? `. Active flows: ${flows}` : ""}`;
}

/** Everything ops can reach for this brand, each source best-effort. */
async function brandIntel(brand: GrowthBrand): Promise<string> {
  const settled = await Promise.allSettled([
    timed(gscIntel(brand)), timed(ga4Intel(brand)), timed(emailIntel(brand)),
  ]);
  const lines = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v): v is string => !!v)
    .map((v) => v.slice(0, 700));
  return lines.length ? lines.join("\n") : "No GSC/GA4/email sources connected for this brand.";
}

async function generateModel(brand: GrowthBrand, guidance: string, email: string) {
  const overview = await getOverviewCached().catch(() => null);
  const vitals = vitalsFor(overview, brand);
  const [finance, intel] = await Promise.all([financeContext(brand), brandIntel(brand)]);
  const prior = await pool.query(
    `SELECT title, status, kpi_label FROM ops_growth_initiatives WHERE brand = $1 ORDER BY created_at DESC LIMIT 12`, [brand]);
  const numbers = Object.entries(vitals).filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`).join(", ") || "feed not connected — reason from the business shape";
  const resp: any = await (anthropic as any).messages.create({
    model: BEDROCK_MODELS.HIGH_IQ,
    max_tokens: 3000,
    system: `You build growth models for a multi-brand operator (Paul + Michael). A growth model names the factors that enhance or limit growth so humans can challenge them — it is NOT a forecast formula. Be specific to THIS brand's shape and numbers; never generic SaaS advice. Every assumption must come with the test that would break it. Suggested initiatives must be executable by a small team and each needs the one number that proves it worked. Where a live metric fits the KPI, use it; otherwise mark manual.`,
    tools: [MODEL_TOOL],
    tool_choice: { type: "tool", name: "write_growth_model" },
    messages: [{
      role: "user",
      content: `Brand: ${BRAND_CONTEXT[brand]}\nLive 30-day numbers: ${numbers}\nChannel data:\n${intel}\nTracked finance (90d): ${finance}\nExisting initiatives (don't re-suggest): ${prior.rows.map((r: any) => r.title).join("; ") || "none"}\nOperator guidance: ${guidance?.slice(0, 1000) || "none given"}`,
    }],
  });
  logAiCost({ surface: "ops_growth_model", model: BEDROCK_MODELS.HIGH_IQ, inputTokens: resp.usage?.input_tokens ?? 0, outputTokens: resp.usage?.output_tokens ?? 0 }).catch(() => {});
  const call = resp.content?.find((c: any) => c.type === "tool_use");
  if (!call?.input?.summary) throw new Error("model generation returned nothing usable — try again");
  const m = call.input;
  await pool.query(`UPDATE ops_growth_models SET status = 'archived' WHERE brand = $1 AND status = 'active'`, [brand]);
  const ins = await pool.query(
    `INSERT INTO ops_growth_models (brand, summary, drivers, constraints, assumptions, suggested_initiatives, guidance, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [brand, m.summary, JSON.stringify(m.drivers ?? []), JSON.stringify(m.constraints ?? []),
     JSON.stringify(m.assumptions ?? []), JSON.stringify(m.suggested_initiatives ?? []), guidance || null, email],
  );
  return ins.rows[0].id as number;
}

type GrowthReq = Request & { adminEmail?: string };

export function registerGrowthRoutes(app: Express) {
  app.get("/api/ops/growth/:brand", async (req: GrowthReq, res: Response) => {
    const brand = brandOf(req);
    if (!brand) return res.status(400).json({ error: "unknown brand" });
    try {
      await ensureGrowthTables();
      const [model, initiatives, admins, overview] = await Promise.all([
        pool.query(`SELECT * FROM ops_growth_models WHERE brand = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [brand]),
        pool.query(`SELECT * FROM ops_growth_initiatives WHERE brand = $1 AND status <> 'dropped' ORDER BY status = 'done', created_at`, [brand]),
        listAdminsFromDb().catch(() => []),
        getOverviewCached().catch(() => null),
      ]);
      const vitals = vitalsFor(overview, brand);
      const rows = initiatives.rows.map((i: any) => ({
        ...i,
        kpi_live: i.kpi_metric && i.kpi_metric !== "manual" ? vitals[i.kpi_metric] ?? null : null,
      }));
      res.json({
        model: model.rows[0] ?? null,
        initiatives: rows,
        people: admins.map((a: any) => a.email),
        aiReady: isAIConfigured,
        vitals,
      });
    } catch (e) {
      console.error("[OPS][GROWTH] read failed:", e);
      res.status(500).json({ error: "Failed to load growth model" });
    }
  });

  app.post("/api/ops/growth/:brand/generate", async (req: GrowthReq, res: Response) => {
    const brand = brandOf(req);
    if (!brand) return res.status(400).json({ error: "unknown brand" });
    if (!isAIConfigured) return res.status(503).json({ error: "AI is not configured on this deploy" });
    try {
      await ensureGrowthTables();
      const id = await generateModel(brand, String(req.body?.guidance ?? ""), req.adminEmail ?? "unknown");
      logAdminAction({ adminEmail: req.adminEmail ?? "unknown", actionType: "growth_model_generate", targetKind: "growth_model", targetId: String(id), targetLabel: brand, status: "ok" }).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) {
      console.error("[OPS][GROWTH] generate failed:", e);
      res.status(500).json({ error: (e as Error).message || "Generation failed" });
    }
  });

  app.post("/api/ops/growth/:brand/initiatives", async (req: GrowthReq, res: Response) => {
    const brand = brandOf(req);
    if (!brand) return res.status(400).json({ error: "unknown brand" });
    const b = req.body ?? {};
    if (!b.title || String(b.title).length > 200) return res.status(400).json({ error: "title required (≤200 chars)" });
    if (b.kpi_metric && b.kpi_metric !== "manual" && !(AUTO_METRICS as readonly string[]).includes(b.kpi_metric))
      return res.status(400).json({ error: `kpi_metric must be manual or one of: ${AUTO_METRICS.join(", ")}` });
    try {
      await ensureGrowthTables();
      const r = await pool.query(
        `INSERT INTO ops_growth_initiatives (brand, model_id, title, driver, owner, kpi_label, kpi_metric, kpi_target, due_label, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [brand, b.model_id ?? null, String(b.title).slice(0, 200), b.driver ?? null, b.owner ?? null,
         b.kpi_label ?? null, b.kpi_metric ?? null, b.kpi_target ?? null, b.due_label ?? null, b.notes ?? null,
         req.adminEmail ?? "unknown"],
      );
      logAdminAction({ adminEmail: req.adminEmail ?? "unknown", actionType: "growth_initiative_add", targetKind: "growth_initiative", targetId: String(r.rows[0].id), targetLabel: `${brand}: ${String(b.title).slice(0, 60)}`, status: "ok" }).catch(() => {});
      res.json({ ok: true, initiative: r.rows[0] });
    } catch (e) {
      console.error("[OPS][GROWTH] add failed:", e);
      res.status(500).json({ error: "Failed to add initiative" });
    }
  });

  app.patch("/api/ops/growth/:brand/initiatives/:id", async (req: GrowthReq, res: Response) => {
    const brand = brandOf(req);
    if (!brand) return res.status(400).json({ error: "unknown brand" });
    const allowed = ["title", "driver", "owner", "kpi_label", "kpi_metric", "kpi_target", "kpi_current", "due_label", "status", "notes"] as const;
    const sets: string[] = []; const vals: any[] = [];
    for (const k of allowed) if (k in (req.body ?? {})) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    if (req.body.status && !["active", "done", "dropped"].includes(req.body.status)) return res.status(400).json({ error: "status must be active, done or dropped" });
    vals.push(Number(req.params.id), brand);
    try {
      const r = await pool.query(
        `UPDATE ops_growth_initiatives SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${vals.length - 1} AND brand = $${vals.length} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: "initiative not found" });
      logAdminAction({ adminEmail: req.adminEmail ?? "unknown", actionType: "growth_initiative_update", targetKind: "growth_initiative", targetId: String(r.rows[0].id), targetLabel: brand, status: "ok" }).catch(() => {});
      res.json({ ok: true, initiative: r.rows[0] });
    } catch (e) {
      console.error("[OPS][GROWTH] update failed:", e);
      res.status(500).json({ error: "Failed to update initiative" });
    }
  });
}
