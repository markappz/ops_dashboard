/**
 * Google OAuth + Analytics + Search Console
 * Ported from the original ops dashboard (Replit export).
 *
 * Flow:
 *   1. GET /api/ops/google/connect → redirects to Google OAuth
 *   2. GET /api/ops/google/callback → exchanges code, stores tokens, redirects to /settings
 *   3. GET /api/ops/connections → returns connection status
 *   4. GET /api/ops/ga4/* → live GA4 data
 *   5. GET /api/ops/gsc/* → live GSC data
 */
import { google } from "googleapis";
import type { Express } from "express";
import { pool } from "./db";

function getRedirectUri() {
  return process.env.OPS_GOOGLE_REDIRECT_URI || "http://localhost:5001/api/ops/google/callback";
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
  "profile",
];

// ─── Ensure tables ─────────────────────────────────────────────────

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_google_connection (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry TIMESTAMP NOT NULL,
      email TEXT,
      ga4_property_id TEXT,
      gsc_site_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // One Google connection PER COMPANY. This table used to hold a single row and
  // the connect flow DELETEd everything before inserting — so connecting pawgen
  // would have silently disconnected FitScript's GA4 and Search Console.
  await pool.query(
    `ALTER TABLE ops_google_connection ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'fitscript'`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ops_google_connection_company_key ON ops_google_connection(company)`
  );
}

// Companies allowed to hold a connection. The value round-trips through the
// OAuth `state` param, so it is never used in SQL without passing this gate.
const COMPANIES = new Set(["fitscript", "peptideu", "pawgen"]);
export const DEFAULT_COMPANY = "fitscript";
export function normalizeCompany(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  return COMPANIES.has(s) ? s : DEFAULT_COMPANY;
}

// ─── Token management ──────────────────────────────────────────────

// Defaults to fitscript so every existing caller keeps its current behaviour.
export async function getConnection(company: string = DEFAULT_COMPANY) {
  const result = await pool.query(
    "SELECT * FROM ops_google_connection WHERE company = $1 ORDER BY created_at DESC LIMIT 1",
    [normalizeCompany(company)]
  );
  return result.rows[0] || null;
}

export async function getAuthenticatedClient(company: string = DEFAULT_COMPANY) {
  const conn = await getConnection(company);
  if (!conn) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
    expiry_date: new Date(conn.token_expiry).getTime(),
  });

  // Refresh if expiring within 60s
  if (new Date(conn.token_expiry).getTime() < Date.now() + 60000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      await pool.query(
        "UPDATE ops_google_connection SET access_token = $1, refresh_token = COALESCE($2, refresh_token), token_expiry = $3, updated_at = NOW() WHERE id = $4",
        [credentials.access_token, credentials.refresh_token, new Date(credentials.expiry_date!), conn.id]
      );
      client.setCredentials(credentials);
    } catch (err) {
      console.error("[OPS] Failed to refresh Google token:", err);
      return null;
    }
  }

  return client;
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerGoogleAuthRoutes(app: Express) {
  ensureTables().catch(console.error);

  // Connection status
  app.get("/api/ops/connections", async (req, res) => {
    try {
      const company = normalizeCompany(req.query.company);
      const conn = await getConnection(company);
      const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

      res.json({
        company,
        googleConfigured: configured,
        google: conn ? {
          connected: true,
          email: conn.email,
          ga4PropertyId: conn.ga4_property_id,
          gscSiteUrl: conn.gsc_site_url,
          connectedAt: conn.created_at,
        } : { connected: false },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Start OAuth — returns URL for frontend to redirect to
  app.get("/api/ops/google/connect", (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(400).json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not configured" });
    }

    // Which company this connection is for has to survive the round-trip to
    // Google — `state` is the only channel that comes back to the callback.
    const company = normalizeCompany(req.query.company);

    const client = getOAuth2Client();
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "select_account consent",
      scope: SCOPES,
      include_granted_scopes: true,
      state: company,
    });

    // Return URL for AJAX or redirect for direct navigation
    if (req.headers.accept?.includes("application/json")) {
      return res.json({ url });
    }
    res.redirect(url);
  });

  // OAuth callback
  app.get("/api/ops/google/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      if (!code) return res.redirect("/integrations?google_error=no_code");

      const client = getOAuth2Client();
      const { tokens } = await client.getToken(code);

      if (!tokens.access_token) {
        return res.redirect("/integrations?google_error=no_tokens");
      }

      // refresh_token is only returned on the FIRST consent. When the user
      // re-connects without revoking access (or hits `select_account consent`
      // again), Google may omit it. Preserve any existing refresh_token in
      // that case so the connection doesn't silently break later.
      // normalizeCompany() gates this before it reaches SQL — `state` is
      // attacker-influencable in general, so it is never trusted raw.
      const company = normalizeCompany(req.query.state);

      let refreshToken: string | null = tokens.refresh_token || null;
      if (!refreshToken) {
        const existing = await getConnection(company);
        refreshToken = existing?.refresh_token || null;
      }
      if (!refreshToken) {
        return res.redirect(
          "/integrations?google_error=no_refresh_token",
        );
      }

      // Get user email
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email || null;

      const expiry = new Date(tokens.expiry_date || Date.now() + 3600000);

      // Upsert connection (single connection for the ops dashboard).
      // Preserve property/site selections across re-connects so the operator
      // doesn't have to re-pick them.
      // Replace only THIS company's row. The old code deleted every row, so
      // connecting a second brand disconnected the first.
      const existing = await getConnection(company);
      await pool.query("DELETE FROM ops_google_connection WHERE company = $1", [company]);
      await pool.query(
        `INSERT INTO ops_google_connection
         (access_token, refresh_token, token_expiry, email, ga4_property_id, gsc_site_url, company)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tokens.access_token,
          refreshToken,
          expiry,
          email,
          existing?.ga4_property_id || null,
          existing?.gsc_site_url || null,
          company,
        ],
      );

      console.log(`[OPS] Google connected for ${company}: ${email}`);
      res.redirect(`/integrations?google_connected=true&company=${company}`);
    } catch (error: any) {
      console.error("[OPS] Google callback error:", error.message);
      res.redirect("/integrations?google_error=callback_failed");
    }
  });

  // Disconnect
  app.post("/api/ops/google/disconnect", async (req, res) => {
    try {
      const company = normalizeCompany(req.body?.company ?? req.query.company);
      await pool.query("DELETE FROM ops_google_connection WHERE company = $1", [company]);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Save GA4 property / GSC site selection
  app.patch("/api/ops/google/config", async (req, res) => {
    try {
      const { ga4PropertyId, gscSiteUrl } = req.body;
      const company = normalizeCompany(req.body?.company ?? req.query.company);
      const updates: string[] = [];
      const params: any[] = [];
      let i = 1;

      if (ga4PropertyId !== undefined) { updates.push(`ga4_property_id = $${i++}`); params.push(ga4PropertyId); }
      if (gscSiteUrl !== undefined) { updates.push(`gsc_site_url = $${i++}`); params.push(gscSiteUrl); }
      if (updates.length === 0) return res.json({ ok: true });

      updates.push("updated_at = NOW()");
      // WHERE company — without it this rewrote every brand's property selection.
      params.push(company);
      await pool.query(`UPDATE ops_google_connection SET ${updates.join(", ")} WHERE company = $${i}`, params);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── GA4 Data ────────────────────────────────────────────────────

  // List GA4 properties for picker
  app.get("/api/ops/ga4/properties", async (_req, res) => {
    try {
      const auth = await getAuthenticatedClient();
      if (!auth) return res.json({ properties: [] });

      const admin = google.analyticsadmin({ version: "v1beta", auth });
      const response = await admin.accountSummaries.list();
      const properties = (response.data.accountSummaries || []).flatMap((acct: any) =>
        (acct.propertySummaries || []).map((prop: any) => ({
          propertyId: prop.property.replace("properties/", ""),
          displayName: prop.displayName,
          account: acct.displayName,
        }))
      );

      res.json({ properties });
    } catch (error: any) {
      res.json({ properties: [], error: error.message });
    }
  });

  // GA4 overview data
  app.get("/api/ops/ga4/overview", async (req, res) => {
    try {
      const auth = await getAuthenticatedClient();
      if (!auth) return res.json({ connected: false });

      const conn = await getConnection();
      const propertyId = conn?.ga4_property_id;
      if (!propertyId) return res.json({ connected: true, error: "No GA4 property selected. Go to Settings to select one." });

      const analyticsData = google.analyticsdata({ version: "v1beta", auth });
      const range = (req.query.range as string) || "30";
      const startDate = `${range}daysAgo`;

      // Main metrics by date
      const mainReport = await analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: "today" }],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "sessions" },
            { name: "totalUsers" },
            { name: "newUsers" },
            { name: "screenPageViews" },
            { name: "bounceRate" },
            { name: "averageSessionDuration" },
          ],
          orderBys: [{ dimension: { dimensionName: "date" } }],
        },
      });

      const daily = (mainReport.data.rows || []).map((r: any) => ({
        date: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        newUsers: parseInt(r.metricValues[2].value),
        pageViews: parseInt(r.metricValues[3].value),
        bounceRate: parseFloat(r.metricValues[4].value),
        avgDuration: parseFloat(r.metricValues[5].value),
      }));

      const totals = daily.reduce((acc: any, d: any) => ({
        sessions: acc.sessions + d.sessions,
        users: acc.users + d.users,
        newUsers: acc.newUsers + d.newUsers,
        pageViews: acc.pageViews + d.pageViews,
      }), { sessions: 0, users: 0, newUsers: 0, pageViews: 0 });

      // Traffic sources
      const sourcesReport = await analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: "today" }],
          dimensions: [{ name: "sessionDefaultChannelGroup" }],
          metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: "20",
        },
      });

      const sources = (sourcesReport.data.rows || []).map((r: any) => ({
        channel: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        pageViews: parseInt(r.metricValues[2].value),
      }));

      // Top pages
      const pagesReport = await analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate: "today" }],
          dimensions: [{ name: "pagePath" }],
          metrics: [{ name: "screenPageViews" }, { name: "averageSessionDuration" }],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: "15",
        },
      });

      const topPages = (pagesReport.data.rows || []).map((r: any) => ({
        page: r.dimensionValues[0].value,
        views: parseInt(r.metricValues[0].value),
        avgDuration: parseFloat(r.metricValues[1].value),
      }));

      res.json({ connected: true, daily, totals, sources, topPages });
    } catch (error: any) {
      console.error("[OPS] GA4 error:", error.message);
      res.json({ connected: true, error: error.message });
    }
  });

  // ─── GSC Data ────────────────────────────────────────────────────

  // List GSC sites for picker
  app.get("/api/ops/gsc/sites", async (_req, res) => {
    try {
      const auth = await getAuthenticatedClient();
      if (!auth) return res.json({ sites: [] });

      const webmasters = google.webmasters({ version: "v3", auth });
      const response = await webmasters.sites.list();
      const sites = (response.data.siteEntry || []).map((s: any) => ({
        url: s.siteUrl,
        permission: s.permissionLevel,
      }));

      res.json({ sites });
    } catch (error: any) {
      res.json({ sites: [], error: error.message });
    }
  });

  // GSC overview data
  app.get("/api/ops/gsc/overview", async (req, res) => {
    try {
      const auth = await getAuthenticatedClient();
      if (!auth) return res.json({ connected: false });

      const conn = await getConnection();
      const siteUrl = conn?.gsc_site_url;
      if (!siteUrl) return res.json({ connected: true, error: "No GSC site selected. Go to Settings to select one." });

      const webmasters = google.webmasters({ version: "v3", auth });
      const range = parseInt((req.query.range as string) || "30");
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - range * 86400000);
      const fmt = (d: Date) => d.toISOString().split("T")[0];

      // Top queries
      const queriesResp = await webmasters.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ["query"],
          rowLimit: 25,
        },
      });

      const topQueries = (queriesResp.data.rows || []).map((r: any) => ({
        query: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1),
        position: r.position.toFixed(1),
      }));

      // Daily trend
      const dailyResp = await webmasters.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ["date"],
          rowLimit: 1000,
        },
      });

      const daily = (dailyResp.data.rows || []).map((r: any) => ({
        date: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1),
        position: r.position.toFixed(1),
      }));

      const totals = {
        clicks: daily.reduce((s: number, d: any) => s + d.clicks, 0),
        impressions: daily.reduce((s: number, d: any) => s + d.impressions, 0),
        ctr: daily.length > 0 ? (daily.reduce((s: number, d: any) => s + parseFloat(d.ctr), 0) / daily.length) : 0,
        position: daily.length > 0 ? (daily.reduce((s: number, d: any) => s + parseFloat(d.position), 0) / daily.length) : 0,
      };

      // Top pages
      const pagesResp = await webmasters.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ["page"],
          rowLimit: 15,
        },
      });

      const topPages = (pagesResp.data.rows || []).map((r: any) => ({
        page: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(1),
        position: r.position.toFixed(1),
      }));

      res.json({ connected: true, daily, totals, topQueries, topPages });
    } catch (error: any) {
      console.error("[OPS] GSC error:", error.message);
      res.json({ connected: true, error: error.message });
    }
  });
}
