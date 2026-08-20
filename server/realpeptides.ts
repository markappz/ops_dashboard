/**
 * Real Peptides connector.
 *
 * RP is the one brand with no readable order database: realpeptides.co is
 * WordPress + WooCommerce and no API credentials exist for it. So this module
 * deliberately does NOT pretend to know revenue. It reports the two things that
 * are genuinely observable today:
 *
 *   1. Traffic + attribution, from the first-party pixel already running on
 *      ops.fitscript.me (`site = 'realpeptides'`, set from the browser Origin).
 *      Covers realpeptides.co and the three lead-magnet funnels.
 *   2. Leads, from RP's two email platforms — Moosend and Campaign Refinery.
 *      NOT Klaviyo: that is FitScript's platform, and RP has never used it.
 *
 * Every surface degrades to an explicit "not configured / not installed" state
 * rather than a zero, because a zero here reads as "no traffic" when the truth
 * is "nothing is reporting yet".
 */
import express, { type Express, type Request, type Response } from "express";
import multer from "multer";
import { pool } from "./db";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const SITE = "realpeptides";

function days(v: unknown): number {
  const n = parseInt(String(v ?? "30"), 10);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
}

function fail(res: Response, where: string, e: any) {
  console.error(`[OPS][RP] ${where}:`, e?.message ?? e);
  res.status(500).json({ error: `${where} failed: ${e?.message ?? "unknown error"}` });
}

// ─── Traffic / attribution (first-party pixel) ─────────────────────

/** Groups sessions by one column, newest-heavy first. NULL is kept, never dropped. */
async function groupSessions(column: string, since: number, limit = 12) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(${column}, ''), '(none)') AS key,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY sessions DESC LIMIT $3`,
    [SITE, String(since), limit]
  );
  return rows;
}

async function trafficTotals(since: number) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors,
            COALESCE(SUM(page_count), 0)::int AS page_views
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
    [SITE, String(since)]
  );
  return rows[0];
}

async function trafficDaily(since: number) {
  const { rows } = await pool.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [SITE, String(since)]
  );
  return rows;
}

/**
 * Which RP property the session landed on. The funnels and the store all write
 * site='realpeptides', so the host is the only thing separating them.
 */
async function trafficByProperty(since: number) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(substring(landing_page from '^https?://([^/]+)'), ''), '(unknown)') AS key,
            COUNT(*)::int AS sessions,
            COUNT(DISTINCT visitor_id)::int AS visitors
     FROM visitor_sessions
     WHERE site = $1 AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY sessions DESC LIMIT 20`,
    [SITE, String(since)]
  );
  return rows;
}

// ─── Email platforms (Moosend + Campaign Refinery) ─────────────────

/**
 * Real Peptides does NOT use Klaviyo — that's FitScript's platform. RP's lists
 * live in **Moosend** and **Campaign Refinery**, so both are read here and shown
 * side by side. Each is configured independently: one missing key degrades that
 * card alone, never the tab.
 */

/** Moosend: API key is a query param, and every response wraps data in `Context`. */
async function moosend<T = any>(path: string): Promise<T> {
  const key = process.env.RP_MOOSEND_API_KEY;
  if (!key) throw Object.assign(new Error("RP_MOOSEND_API_KEY not configured"), { status: 503 });

  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.moosend.com/v3${path}${sep}apikey=${encodeURIComponent(key)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Moosend ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  // Moosend answers HTTP 200 with a non-zero Code on failure, so status alone lies.
  if (body?.Code !== 0 && body?.Error) throw new Error(`Moosend: ${body.Error}`);
  return body?.Context as T;
}

async function moosendLists() {
  const ctx = await moosend<{ MailingLists?: any[] }>("/lists.json");
  const lists = (ctx?.MailingLists ?? []).map((l) => ({
    id: l.ID,
    name: l.Name ?? l.ID,
    active: l.ActiveMemberCount ?? 0,
    unsubscribed: l.UnsubscribedMemberCount ?? 0,
    bounced: l.BouncedMemberCount ?? 0,
  }));
  lists.sort((a, b) => b.active - a.active);
  return { lists, totalActive: lists.reduce((s, l) => s + l.active, 0) };
}

/** Campaign Refinery: bearer token, base https://api.campaignrefinery.com. */
async function campaignRefinery<T = any>(path: string): Promise<T> {
  const key = process.env.RP_CAMPAIGN_REFINERY_API_KEY;
  if (!key) throw Object.assign(new Error("RP_CAMPAIGN_REFINERY_API_KEY not configured"), { status: 503 });

  const res = await fetch(`https://api.campaignrefinery.com${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Campaign Refinery ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * CR's response shape isn't published, so read it tolerantly and — if no contact
 * array can be found — report the keys that WERE returned. A first-call mismatch
 * becomes a ten-second fix instead of a silent zero.
 */
function pickArray(body: any): { rows: any[]; shape: string } {
  if (Array.isArray(body)) return { rows: body, shape: "array" };
  for (const k of ["data", "contacts", "results", "items", "records"]) {
    if (Array.isArray(body?.[k])) return { rows: body[k], shape: k };
  }
  const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : typeof body;
  throw new Error(`Campaign Refinery returned an unrecognised shape (top-level keys: ${keys})`);
}

const first = (o: any, keys: string[]) => keys.map((k) => o?.[k]).find((v) => typeof v === "string" && v);

async function campaignRefineryContacts(since: number) {
  const body = await campaignRefinery("/rest/contacts");
  const { rows, shape } = pickArray(body);

  const cutoff = Date.now() - since * 86_400_000;
  const contacts = rows.map((c: any) => ({
    email: first(c, ["email", "email_address", "Email"]) ?? "(no email)",
    created_at: first(c, ["created_at", "created", "subscribed_at", "createdAt"]) ?? null,
  }));
  const recent = contacts.filter((c) => c.created_at && Date.parse(c.created_at) >= cutoff);

  return {
    shape,
    returned: contacts.length,
    // The page total is what CR gave us, not the account total — say so rather
    // than presenting a page size as if it were the list size.
    recentCount: recent.length,
    datedContacts: contacts.filter((c) => c.created_at).length,
    recent: recent.slice(0, 100),
  };
}

// ─── COA tracker (coa.realpeptides.co) ─────────────────────────────

/**
 * The COA tracker is a separate app in a separate AWS account with a private
 * RDS, so ops can't read its database. It exposes a read-only, token-gated
 * summary instead — the same "keys stay in one system" pattern as pawgen's
 * ShippingEasy endpoint.
 */
async function coaSummary() {
  const base = process.env.COA_API_URL || "https://coa.realpeptides.co";
  const token = process.env.COA_OPS_TOKEN;
  if (!token) {
    return {
      configured: false as const,
      hint: "Set COA_OPS_TOKEN here and on the COA tracker (same value) to read coa.realpeptides.co.",
    };
  }

  const r = await fetch(`${base}/api/ops-summary`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`COA tracker ${r.status}: ${text.slice(0, 200)}`);
  return { configured: true as const, ...JSON.parse(text) };
}

/**
 * Forward a COA PDF + test metadata to the tracker. The tracker records the
 * test and vaults the file itself; ops never touches its bucket or database.
 */
async function coaUpload(file: Express.Multer.File, fields: Record<string, string>, by: string) {
  const base = process.env.COA_API_URL || "https://coa.realpeptides.co";
  const token = process.env.COA_OPS_TOKEN;
  if (!token) throw new Error("COA_OPS_TOKEN is not set on ops — uploads need the same token the tracker has.");

  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(file.buffer)], { type: "application/pdf" }), file.originalname);
  for (const k of ["sku_code", "test_date", "lab_name", "purity"]) if (fields[k]) fd.append(k, fields[k]);
  fd.append("uploaded_by", by);

  const r = await fetch(`${base}/api/ops-coa-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(body.error || `COA tracker ${r.status}`);
  return body;
}

/**
 * Generic pass-through to the tracker's API for product management. The
 * tracker accepts COA_OPS_TOKEN in its auth gate, so ops is its UI now. Only
 * these prefixes are reachable; the tracker's login and scan surface is not.
 */
const PROXY_ALLOW = [/^\/skus(\/|$)/, /^\/documents(\/|$)/, /^\/coas(\/|$)/, /^\/lab-tests(\/|$)/, /^\/team(\/|$)/, /^\/notify(\/|$)/];

async function proxyToTracker(req: Request, res: Response) {
  const base = process.env.COA_API_URL || "https://coa.realpeptides.co";
  const token = process.env.COA_OPS_TOKEN;
  if (!token) return res.status(503).json({ error: "COA_OPS_TOKEN is not set on ops." });
  const sub = "/" + String(req.params[0] || "");
  if (!PROXY_ALLOW.some((re) => re.test(sub))) return res.status(404).json({ error: "Not proxied." });

  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: any;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = String(req.headers["content-type"] || "");
    if (ct.startsWith("multipart/form-data") && Buffer.isBuffer(req.body)) {
      headers["content-type"] = ct;
      body = new Uint8Array(req.body);
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body ?? {});
    }
  }
  const upstream = await fetch(`${base}/api${sub}${qs}`, { method: req.method, headers, body, signal: AbortSignal.timeout(60_000), redirect: "follow" });
  res.status(upstream.status);
  for (const h of ["content-type", "content-disposition", "content-length", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerRealPeptidesRoutes(app: Express) {
  /**
   * Pixel-derived marketing. `pixelInstalled` is false until the first event
   * ever arrives from an RP origin — the UI shows install instructions instead
   * of an all-zero dashboard.
   */
  app.get("/api/ops/realpeptides/marketing", async (req, res) => {
    try {
      const since = days(req.query.range);
      const [ever, totals, daily, bySource, byMedium, byCampaign, byLanding, byReferrer, byProperty] =
        await Promise.all([
          pool.query(`SELECT EXISTS(SELECT 1 FROM visitor_sessions WHERE site = $1) AS ok`, [SITE]),
          trafficTotals(since),
          trafficDaily(since),
          groupSessions("utm_source", since),
          groupSessions("utm_medium", since),
          groupSessions("utm_campaign", since),
          groupSessions("landing_page", since),
          groupSessions("referrer", since),
          trafficByProperty(since),
        ]);

      res.json({
        pixelInstalled: ever.rows[0]?.ok === true,
        range: since,
        totals,
        daily,
        bySource,
        byMedium,
        byCampaign,
        byLanding,
        byReferrer,
        byProperty,
      });
    } catch (e) {
      fail(res, "Real Peptides marketing", e);
    }
  });

  /**
   * Leads from RP's two email platforms. **Not Klaviyo** — that's FitScript's.
   * Each source is independent: one missing key or one API outage degrades that
   * card alone. No conversion or revenue figures, because WooCommerce isn't
   * readable and "became a customer" is genuinely unknown.
   */
  app.get("/api/ops/realpeptides/leads", async (req, res) => {
    const since = days(req.query.range);

    const settle = async <T>(fn: () => Promise<T>, envVar: string, hint: string) => {
      if (!process.env[envVar]) return { configured: false as const, hint };
      try {
        return { configured: true as const, ...(await fn()) };
      } catch (e: any) {
        console.error(`[OPS][RP] ${envVar}:`, e?.message ?? e);
        return { configured: true as const, error: String(e?.message ?? e) };
      }
    };

    const [moosendData, crData] = await Promise.all([
      settle(
        moosendLists,
        "RP_MOOSEND_API_KEY",
        "Set RP_MOOSEND_API_KEY — Moosend → Settings → API Key.",
      ),
      settle(
        () => campaignRefineryContacts(since),
        "RP_CAMPAIGN_REFINERY_API_KEY",
        "Set RP_CAMPAIGN_REFINERY_API_KEY — Campaign Refinery → API settings → create an API key.",
      ),
    ]);

    res.json({ range: since, moosend: moosendData, campaignRefinery: crData });
  });

  /** COA freshness, proxied from the COA tracker's own read-only endpoint. */
  app.get("/api/ops/realpeptides/coa", async (_req, res) => {
    try {
      res.json(await coaSummary());
    } catch (e) {
      fail(res, "COA summary", e);
    }
  });

  /** Product management pass-through (add / rename / delete / documents). */
  app.all("/api/ops/realpeptides/coa/api/*", express.raw({ type: "multipart/form-data", limit: "60mb" }), (req, res) => {
    proxyToTracker(req, res).catch((e) => fail(res, "COA tracker", e));
  });

  /** File a new COA: PDF + test date (+ lab, purity). Grant: realpeptides:coa-upload. */
  app.post("/api/ops/realpeptides/coa/upload", upload.single("file"), async (req: any, res) => {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ error: "Choose a PDF first." });
      if (file.mimetype !== "application/pdf" && !/\.pdf$/i.test(file.originalname)) {
        return res.status(400).json({ error: "Only PDF certificates are accepted." });
      }
      if (!req.body?.sku_code) return res.status(400).json({ error: "Pick the product this COA belongs to." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body?.test_date || "")) {
        return res.status(400).json({ error: "Test date must be YYYY-MM-DD." });
      }
      const by = req.adminEmail || "unknown";
      const out = await coaUpload(file, req.body, by);
      console.log(`[OPS][RP] COA uploaded: ${req.body.sku_code} tested ${req.body.test_date} by ${by}`);
      res.json(out);
    } catch (e) {
      fail(res, "COA upload", e);
    }
  });
}
