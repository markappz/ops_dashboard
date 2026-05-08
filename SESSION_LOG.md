# Ops Dashboard Session Log

Running history of every development session. Autom reads this at the start of each session.

---

## 2026-05-06 — Admin auth gate + project memory scaffolds

**Worked on:** P0 security fix — every `/api/ops/*` route was wide open to the public.

**Changed:**
- `server/admin-auth.ts` (new) — Google OAuth login flow (openid/email/profile only), HMAC-signed session cookie (`ops_session`), `requireAdmin` + `opsGate` middleware, `ADMIN_EMAILS` allowlist. No new deps (HMAC via node `crypto`).
- `server/index.ts` — registers `registerAdminAuthRoutes` before mounting `opsGate`. `/api/health` and `/api/t/*` (tracking pixel) stay public; everything else under `/api/ops/*` requires admin session.
- `client/src/App.tsx` — adds `useAdminSession()` hook hitting `/api/ops/auth/me`. Renders `<Login />` when unauthenticated.
- `client/src/pages/login.tsx` (new) — "Sign in with Google" button → `/api/ops/auth/login`.
- `client/src/components/layout/ops-layout.tsx` — admin email + sign-out in top bar.
- `CLAUDE.md`, `SESSION_LOG.md`, `DECISIONS.md` (new) — repo memory per project standard.

**Verified:** `npx tsc --noEmit` shows zero errors in new files. `vite build` + `esbuild server/index.ts` both compile clean.

**Pre-existing TS errors NOT addressed** (not in scope for auth gate, but on the punch list):
- `server/google-auth.ts:277,288,296,307` — `ga4properties.runReport` typings drifted; needs property/dimensions cast fixes.
- `server/routes.ts:406` — `current_period_end` removed from Stripe Subscription; access via `items.data[0]`.
- `shared/schema.ts:2404` — drizzle call signature mismatch (schema is unused in this repo, candidate for deletion).

**Pending — set these env vars before deploying:**
- `OPS_ADMIN_REDIRECT_URI=https://ops.fitscript.me/api/ops/auth/callback`
- `OPS_SESSION_SECRET=<random 32+ byte secret>`
- `ADMIN_EMAILS=paulclotar@gmail.com,...`
- Add the new redirect URI to the Google OAuth client's Authorized Redirect URIs in GCP console.

**Pending — not pushed yet** per "don't push without approval" rule. Need to test with .env locally before pushing.

**Next session:** verify locally with real .env, then push, then move to P1 connectors (Klaviyo first).

---

## 2026-05-06 (continued) — TS cleanup, drizzle removed

**Worked on:** Cleared every pre-existing TypeScript error so we have a clean baseline going forward.

**Changed:**
- Deleted `shared/schema.ts` (2400+ lines of unused Drizzle schema) and `server/schema.ts` (re-export stub). Confirmed via grep that no runtime code imported either — `db` (the drizzle instance) was exported from `server/db.ts` but never used; every consumer imports `pool`.
- `server/db.ts` — removed `drizzle` import + `db` export. Now only exports `pool` and `verifyConnection`.
- `server/routes.ts:406` — Stripe moved `current_period_end` from `Subscription` to `SubscriptionItem` in the 2025 API version. Now reads `sub.items.data[0]?.current_period_end`.
- `server/google-auth.ts:284,303` — googleapis `runReport.limit` expects string, not number. Changed `20` → `"20"`, `15` → `"15"`.
- `client/src/vite-env.d.ts` (new) — ambient declarations for `*.png` / `*.jpg` / `*.svg` imports so `tsc --noEmit` doesn't choke on the logo asset.
- `package.json` — removed `drizzle-orm`, `drizzle-zod`, `zod` (zero usage after schema deletion).

**Verified:** `npx tsc --noEmit` exits 0. `vite build` + `esbuild server/index.ts` both succeed. Server bundle dropped from 137.7kb → 53.6kb after dropping drizzle.
