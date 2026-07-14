# PeptideU section — fitscript-ops

Adds a **company toggle** (FitScript ⇄ PeptideU), a **read-only** connection to
PeptideU's Supabase Postgres, PeptideU analytics views, and a **read-only viewer
role** so Michael/team can see insights without changing anything.

## Access model (extends the existing Google-OAuth auth)

- Login is unchanged: **Google sign-in** (`server/admin-auth.ts`), HMAC session cookie.
- Two roles, resolved per-request from the email:
  - **admin** — email in `ADMIN_EMAILS` / `ops_admins` table. Full access.
  - **viewer** — email in `VIEWER_EMAILS` (env allowlist). Read-only: `opsGate` → `requireAuth`
    blocks every non-GET request with `403 read_only`. The UI shows a "Read-only" badge.
- Admin always wins if an email is in both lists.

## Company toggle

- Sidebar switch (FitScript / PeptideU). The active company follows the URL (`/peptideu*`),
  so nav and content never disagree. Remembered preference redirects on first load.
- PeptideU nav: Overview, Curriculum, Engagement.

## PeptideU pages & API

- `/peptideu` — Overview: MRR/ARR est., premium, conversion, users, 30-day signups chart,
  signup→premium funnel, rank distribution.
- `/peptideu/curriculum` — per-module completion + quiz pass rates (12 modules).
- `/peptideu/engagement` — Ask / COA / Commons / Office Hours / Research Log usage.
- API (auto-gated under `/api/ops/*`): `/api/ops/peptideu/{snapshot,signups,ranks,curriculum,engagement,funnel}`
  in `server/peptideu.ts` (raw parameterized SQL on `peptidePool`).

## Data source

- `server/db.ts` exports a second read-only pool `peptidePool` from `PEPTIDEU_DATABASE_URL`
  (PeptideU Supabase, SSL). Optional — if unset, PeptideU endpoints return 503 and the
  FitScript side is unaffected.
- MRR/ARR are **estimates**: Supabase only stores `entitlement` (free/premium); real plan
  data lives in RevenueCat. Estimate = premium count × yearly plan ($99.99).

## Env / secrets

Local dev vars live in the ops `.env` (symlink → `fitscript/.env`, gitignored):
`PEPTIDEU_DATABASE_URL`, `VIEWER_EMAILS` (comma-separated). `OPS_SESSION_SECRET`,
`ADMIN_EMAILS`, `GOOGLE_CLIENT_*` are already there for the existing auth.

### Before prod (ops.fitscript.me)

The task definition references two new secret keys. Add them to the `prod/ops-secrets`
Secrets Manager secret (the deploy resolves them at task start):

- `PEPTIDEU_DATABASE_URL` — the Supabase pooler connection string (url-encoded password).
- `VIEWER_EMAILS` — comma-separated read-only team emails (e.g. Michael's Google address).

No password to distribute — viewers sign in with Google; being on `VIEWER_EMAILS` makes them read-only.
