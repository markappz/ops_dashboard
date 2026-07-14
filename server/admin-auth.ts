/**
 * Ops Dashboard admin authentication.
 *
 * Google OAuth (openid/email/profile only) + HMAC-signed session cookie.
 * Distinct from server/google-auth.ts which stores GA4/GSC data tokens.
 *
 * Required env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — same Google app as data connectors
 *   OPS_ADMIN_REDIRECT_URI                 — e.g. https://ops.fitscript.me/api/ops/auth/callback
 *   OPS_SESSION_SECRET                     — random 32+ byte secret used to sign cookies
 *   ADMIN_EMAILS                           — comma-separated allowlist of admin emails
 */
import crypto from "crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { google } from "googleapis";
import { pool } from "./db";

const COOKIE_NAME = "ops_session";
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_COOKIE = "ops_oauth_state";

function getAdminRedirectUri() {
  return (
    process.env.OPS_ADMIN_REDIRECT_URI ||
    "http://localhost:5001/api/ops/auth/callback"
  );
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getAdminRedirectUri()
  );
}

function getSessionSecret(): string {
  const s = process.env.OPS_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "OPS_SESSION_SECRET is missing or too short (need >=32 chars)"
    );
  }
  return s;
}

// Admin allowlist. DB is authoritative; ENV is bootstrap-only seed for first run.
// In-process cache with 60s TTL keeps auth hot-path off the DB.
let allowlistCache: { emails: Set<string>; at: number } | null = null;
const ALLOWLIST_TTL_MS = 60 * 1000;

function envAllowlist(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Read-only viewers (Michael + team). Env-only allowlist — they sign in with the
// same Google flow but every non-GET request is blocked. Admin always wins over viewer.
export type OpsRole = "admin" | "viewer";

function viewerAllowlist(): Set<string> {
  return new Set(
    (process.env.VIEWER_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function resolveRole(email: string): OpsRole | null {
  const e = email.toLowerCase();
  if (getAllowlist().has(e)) return "admin";
  if (viewerAllowlist().has(e)) return "viewer";
  return null;
}

async function ensureAdminTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_admins (
      email TEXT PRIMARY KEY,
      added_by TEXT,
      added_at TIMESTAMP NOT NULL DEFAULT NOW(),
      note TEXT
    )
  `);
}

async function seedFromEnvIfEmpty(): Promise<void> {
  await ensureAdminTable();
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM ops_admins");
  if (r.rows[0].n > 0) return;
  const seed = envAllowlist();
  if (seed.length === 0) return;
  for (const email of seed) {
    await pool.query(
      `INSERT INTO ops_admins (email, added_by, note) VALUES ($1, 'env-bootstrap', 'Seeded from ADMIN_EMAILS env on first DB read')
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  }
  console.log(`[OPS][AUTH] Seeded ${seed.length} admin email(s) from ADMIN_EMAILS env`);
}

async function loadAllowlistFromDb(): Promise<Set<string>> {
  await seedFromEnvIfEmpty();
  const r = await pool.query("SELECT email FROM ops_admins");
  return new Set(r.rows.map((row: any) => String(row.email).toLowerCase()));
}

function getAllowlist(): Set<string> {
  // Synchronous read of the cache. If cache is empty/stale we kick off an
  // async refresh but fall back to env synchronously so auth never blocks
  // on DB. Subsequent requests get the fresh DB value once the refresh lands.
  const now = Date.now();
  if (allowlistCache && now - allowlistCache.at < ALLOWLIST_TTL_MS) {
    return allowlistCache.emails;
  }
  // Kick off async refresh — non-blocking.
  loadAllowlistFromDb()
    .then((emails) => {
      allowlistCache = { emails, at: Date.now() };
    })
    .catch((e) => {
      console.warn("[OPS][AUTH] allowlist DB refresh failed:", e.message);
    });
  // Use cached value if present, else env fallback for this request.
  if (allowlistCache) return allowlistCache.emails;
  return new Set(envAllowlist());
}

// After write operations, AWAIT a synchronous cache refresh so the next
// auth check sees the new state immediately. (Pure invalidation would
// race the env fallback path in getAllowlist while the async refetch
// is in flight.)
export async function refreshAllowlistCache(): Promise<void> {
  try {
    const emails = await loadAllowlistFromDb();
    allowlistCache = { emails, at: Date.now() };
  } catch (e: any) {
    console.warn("[OPS][AUTH] forced cache refresh failed:", e.message);
    allowlistCache = null;
  }
}

// Exported for the admins-management API.
export async function listAdminsFromDb(): Promise<Array<{ email: string; added_by: string | null; added_at: string; note: string | null }>> {
  await ensureAdminTable();
  await seedFromEnvIfEmpty();
  const r = await pool.query(
    `SELECT email, added_by, added_at, note FROM ops_admins ORDER BY added_at ASC`,
  );
  return r.rows;
}

export async function addAdminToDb(email: string, addedBy: string, note?: string): Promise<void> {
  await ensureAdminTable();
  const e = email.trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("Invalid email");
  await pool.query(
    `INSERT INTO ops_admins (email, added_by, note) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [e, addedBy, note ?? null],
  );
  await refreshAllowlistCache();
}

export async function removeAdminFromDb(email: string): Promise<void> {
  await ensureAdminTable();
  const e = email.trim().toLowerCase();
  await pool.query(`DELETE FROM ops_admins WHERE email = $1`, [e]);
  await refreshAllowlistCache();
}

// ─── Cookie signing ────────────────────────────────────────────────

function b64url(buf: Buffer | string) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac("sha256", getSessionSecret()).update(body).digest()
  );
  return `${body}.${sig}`;
}

function verify(token: string): { email: string; exp: number } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(
    crypto.createHmac("sha256", getSessionSecret()).update(body).digest()
  );
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const decoded = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof decoded.email !== "string" || typeof decoded.exp !== "number") {
      return null;
    }
    if (Date.now() > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

function cookieOptions(maxAgeMs: number) {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

// ─── Middleware ────────────────────────────────────────────────────

export interface AdminRequest extends Request {
  adminEmail?: string;
  role?: OpsRole;
}

/** Admin-only: rejects viewers outright. Use on management endpoints. */
export function requireAdmin(
  req: AdminRequest,
  res: Response,
  next: NextFunction
) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "unauthenticated" });
  const claims = verify(token);
  if (!claims) return res.status(401).json({ error: "invalid_session" });
  if (!getAllowlist().has(claims.email.toLowerCase())) {
    return res.status(403).json({ error: "not_authorized" });
  }
  req.adminEmail = claims.email;
  req.role = "admin";
  next();
}

/**
 * Role-aware auth: admins get full access, viewers are read-only (every
 * non-GET request is blocked 403). Attaches req.role for downstream use.
 */
export function requireAuth(
  req: AdminRequest,
  res: Response,
  next: NextFunction
) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "unauthenticated" });
  const claims = verify(token);
  if (!claims) return res.status(401).json({ error: "invalid_session" });
  const role = resolveRole(claims.email);
  if (!role) return res.status(403).json({ error: "not_authorized" });
  if (req.method !== "GET" && role !== "admin") {
    return res
      .status(403)
      .json({ error: "read_only", message: "Read-only access — this action requires an admin account" });
  }
  req.adminEmail = claims.email;
  req.role = role;
  next();
}

/**
 * Top-level gate: blocks every /api/ops/* except /api/ops/auth/*.
 * Keep /api/t/* (tracking pixel ingest) and /api/health public.
 * Uses role-aware auth so read-only viewers can GET but not mutate.
 */
export function opsGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/ops/")) return next();
  if (req.path.startsWith("/api/ops/auth/")) return next();
  return requireAuth(req as AdminRequest, res, next);
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerAdminAuthRoutes(app: Express) {
  // Sanity check at boot — fail loud if misconfigured
  try {
    getSessionSecret();
  } catch (e: any) {
    console.error("[OPS][AUTH]", e.message);
  }
  // Warm the allowlist cache from DB at boot (also triggers env-seed if empty).
  loadAllowlistFromDb()
    .then((emails) => {
      allowlistCache = { emails, at: Date.now() };
      if (emails.size === 0) {
        console.warn("[OPS][AUTH] No admins configured (DB empty, ADMIN_EMAILS env empty) — no one can log in");
      } else {
        console.log(`[OPS][AUTH] ${emails.size} admin(s) loaded`);
      }
    })
    .catch((e) => {
      console.warn("[OPS][AUTH] could not load admins from DB at boot:", e.message, "— falling back to ADMIN_EMAILS env");
    });

  // Admin management endpoints (gated by requireAdmin — only existing admins can add/remove others)
  app.get("/api/ops/admins", requireAdmin, async (_req, res) => {
    try {
      const admins = await listAdminsFromDb();
      res.json({ admins });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/ops/admins", requireAdmin, async (req: AdminRequest, res) => {
    const { email, note } = req.body ?? {};
    const adminEmail = req.adminEmail || "unknown";
    try {
      await addAdminToDb(String(email || ""), adminEmail, note ? String(note) : undefined);
      // Audit-log the add via a lazy require so we don't import-cycle.
      const { logAdminAction } = await import("./lib/auditLog");
      await logAdminAction({
        adminEmail,
        actionType: "admin.add",
        targetKind: "ops_admin",
        targetId: String(email).toLowerCase(),
        targetLabel: String(email).toLowerCase(),
        status: "ok",
        metadata: { note: note ?? null },
      });
      res.json({ ok: true, email: String(email).toLowerCase() });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/ops/admins/:email", requireAdmin, async (req: AdminRequest, res) => {
    const email = String(req.params.email || "").toLowerCase();
    const adminEmail = req.adminEmail || "unknown";
    // Lockout protection: refuse if this would remove the LAST admin OR if
    // the operator is trying to remove themselves.
    if (email === adminEmail.toLowerCase()) {
      return res.status(400).json({ error: "Cannot remove yourself. Ask another admin to do it." });
    }
    try {
      const admins = await listAdminsFromDb();
      if (admins.length <= 1) {
        return res.status(400).json({ error: "Cannot remove the only admin." });
      }
      await removeAdminFromDb(email);
      const { logAdminAction } = await import("./lib/auditLog");
      await logAdminAction({
        adminEmail,
        actionType: "admin.remove",
        targetKind: "ops_admin",
        targetId: email,
        targetLabel: email,
        status: "ok",
      });
      res.json({ ok: true, email });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/ops/auth/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
    const url = getOAuth2Client().generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email", "profile"],
      state,
    });
    res.redirect(url);
  });

  app.get("/api/ops/auth/callback", async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const stateCookie = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, cookieOptions(0));

    if (!code || !state || state !== stateCookie) {
      return res.status(400).send("invalid oauth state");
    }

    try {
      const oauth = getOAuth2Client();
      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);

      const { data } = await google
        .oauth2({ version: "v2", auth: oauth })
        .userinfo.get();
      const email = (data.email || "").toLowerCase();

      if (!email) return res.status(400).send("missing email from google");
      const role = resolveRole(email);
      if (!role) {
        console.warn(`[OPS][AUTH] denied login for non-allowlisted: ${email}`);
        return res
          .status(403)
          .send(`Not authorized. ${email} is not on the allowlist.`);
      }

      const exp = Date.now() + COOKIE_TTL_MS;
      const token = sign({ email, exp });
      res.cookie(COOKIE_NAME, token, cookieOptions(COOKIE_TTL_MS));
      console.log(`[OPS][AUTH] ${role} login: ${email}`);
      res.redirect("/");
    } catch (e: any) {
      console.error("[OPS][AUTH] callback error:", e.message);
      res.status(500).send("auth failed");
    }
  });

  app.get("/api/ops/auth/me", (req: AdminRequest, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: "unauthenticated" });
    const claims = verify(token);
    if (!claims) return res.status(401).json({ error: "invalid_session" });
    const role = resolveRole(claims.email);
    if (!role) return res.status(403).json({ error: "not_authorized" });
    res.json({ email: claims.email, role });
  });

  app.post("/api/ops/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
    res.json({ ok: true });
  });
}
