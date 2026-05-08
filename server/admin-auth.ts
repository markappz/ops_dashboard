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

function getAllowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
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
}

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
  next();
}

/**
 * Top-level gate: blocks every /api/ops/* except /api/ops/auth/*.
 * Keep /api/t/* (tracking pixel ingest) and /api/health public.
 */
export function opsGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/ops/")) return next();
  if (req.path.startsWith("/api/ops/auth/")) return next();
  return requireAdmin(req as AdminRequest, res, next);
}

// ─── Routes ────────────────────────────────────────────────────────

export function registerAdminAuthRoutes(app: Express) {
  // Sanity check at boot — fail loud if misconfigured
  try {
    getSessionSecret();
  } catch (e: any) {
    console.error("[OPS][AUTH]", e.message);
  }
  if (getAllowlist().size === 0) {
    console.warn(
      "[OPS][AUTH] ADMIN_EMAILS is empty — no one can log in until it is set"
    );
  }

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
      if (!getAllowlist().has(email)) {
        console.warn(`[OPS][AUTH] denied login for non-admin: ${email}`);
        return res
          .status(403)
          .send(`Not authorized. ${email} is not on the admin allowlist.`);
      }

      const exp = Date.now() + COOKIE_TTL_MS;
      const token = sign({ email, exp });
      res.cookie(COOKIE_NAME, token, cookieOptions(COOKIE_TTL_MS));
      console.log(`[OPS][AUTH] admin login: ${email}`);
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
    if (!getAllowlist().has(claims.email.toLowerCase())) {
      return res.status(403).json({ error: "not_authorized" });
    }
    res.json({ email: claims.email });
  });

  app.post("/api/ops/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, cookieOptions(0));
    res.json({ ok: true });
  });
}
