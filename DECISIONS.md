# Ops Dashboard Decision Log

Record of every important decision so we don't revisit settled questions.

---

## 2026-05-06 — Auth model: Google OAuth + HMAC session cookie + email allowlist

**Decision:** Gate `/api/ops/*` (except `/api/ops/auth/*`) behind a Google sign-in flow. Email allowlist via `ADMIN_EMAILS` env. Session = HMAC-signed httpOnly cookie (`ops_session`), 7-day TTL, no DB row.

**Why this and not alternatives:**
- **vs. password auth:** Paul already uses Google. Zero new credentials to manage. SSO-quality without a vendor.
- **vs. JWT lib (jsonwebtoken):** HMAC via node's `crypto` is one less dep. Format identical in shape (`payload.sig`).
- **vs. DB-backed sessions:** No table, no migration, stateless verify. Logout = clear cookie (not server-side revoke). Acceptable for an internal tool with a tiny user count.
- **vs. tying to FitScript's Cognito:** Cognito is end-user auth for the consumer app. Mixing admin auth into it would muddy roles. Separate flow keeps blast radius small.

**How to apply:** New protected routes go under `/api/ops/*` and inherit gating automatically. Public ingest (tracking pixel, health) stays under `/api/t/*` or `/api/health`. Adding an admin = add their email to `ADMIN_EMAILS` and redeploy.

---

## 2026-05-08 — Klaviyo connector is HTTP-only, key in env

**Decision:** Klaviyo lives under `/api/ops/klaviyo/*` behind the admin gate. Auth uses `KLAVIYO_API_KEY` (private `pk_*`) directly — no Klaviyo OAuth. API revision pinned to `2025-04-15`.

**Why:** Klaviyo's OAuth is for marketplace listings. We're an internal tool; private API keys are the right fit. Pinning the revision means contract drifts surface as our deliberate bump, not as silent breakage. Rate-limit retries are 429-aware with one Retry-After honoring; deeper backoff isn't worth the code until we hit it.

**How to apply:** New Klaviyo endpoints go in `server/klaviyo.ts` and use the existing `klaviyoFetch` wrapper. For server-side autonomy (push events, trigger flows), call `trackKlaviyoEvent()` directly — keep that out of the HTTP API since the dashboard never needs to expose write actions to clients.

---

## 2026-05-08 — Single-port dev via Vite middleware

**Decision:** `npm run dev` runs Express + Vite middleware on one port (5001) in dev. No separate `vite` process, no `/api` proxy in `vite.config.ts` (the entry stays for documentation but isn't used in dev). OAuth callback redirects to `/` and lands on the same React app the user logged in from.

**Why:** Dual-port dev (Express on 5001, Vite on 5173 with proxy) made the OAuth flow awkward — Google's `redirect_uri` had to point at one port, the React app lived on another, and post-login the user landed on the API port with no UI. Single port means the OAuth callback's `res.redirect("/")` lands on the same surface the React app is mounted on.

**How to apply:** Vite is conditionally imported in `server/index.ts` only when `NODE_ENV !== 'production'` so the prod build never bundles it. Vite stays in `devDependencies`. To run prod-style locally, use `npm run build && NODE_ENV=production node dist/index.js`.

---

## 2026-05-06 — Raw SQL only, no Drizzle in this repo

**Decision:** All DB access uses `pool.query()` (raw SQL). `server/schema.ts` exists as a stub; do not grow it.

**Why:** Drizzle ORM crashed in the ops-dashboard runtime previously (logged in cross-project memory `feedback_ops_raw_sql`). Cost a debugging session. Raw SQL is also the pattern already used throughout `server/routes.ts`.

**How to apply:** New endpoints write SQL directly. Schema-of-record lives in the main FitScript repo's Drizzle schema; ops only reads from those tables.
